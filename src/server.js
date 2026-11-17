// HTTP server: serves the console UI and relays each turn to the model playing the "user".

import { createServer } from 'node:http';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UpstreamError } from './errors.js';
import { SYSTEM_PROMPT, TOKEN_LIMIT, buildPrompt, parseReply, validateTranscript } from './persona.js';
import { createProvider } from './providers/index.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};
const FONT_CACHE = 'public, max-age=31536000, immutable';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CONCURRENT_TURNS = 2;
const DEFAULT_PORT = 4517;
const DEFAULT_HOST = '127.0.0.1';

const UPSTREAM_HINTS = {
  not_installed: 'The claude CLI was not found. Install Claude Code, or set CLAUDE_BIN.',
  not_signed_in: 'The claude CLI is not signed in. Run "claude auth login", or set CLAUDE_CODE_OAUTH_TOKEN in a container, then retry.',
  bad_key: "The API key for the user's model was rejected. Check the server's environment.",
  rate_limited: 'The user is being rate limited. Retry in a moment.',
  refused: 'The user declined to continue. Retry.',
  timeout: 'The user took too long to type. Retry.',
  failed: 'The user could not be reached. Retry.',
};

/**
 * Maps URL paths to files that exist under public/ at startup. Requests are only
 * ever looked up in this map, so no path from a request reaches the filesystem.
 */
function indexStaticFiles(dir = PUBLIC_DIR) {
  const files = new Map();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const type = CONTENT_TYPES[extname(entry.name)];
    if (!entry.isFile() || !type) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(`/${relative(dir, path).split(sep).join('/')}`, { path, type });
  }
  if (files.has('/index.html')) files.set('/', files.get('/index.html'));
  return files;
}

/** "a.example, b.example:8080" -> ["a.example", "b.example:8080"] */
export function parseAllowedHosts(value) {
  return (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Only the console itself may talk to this server. Checking Host defeats DNS
 * rebinding (a hostile site re-resolving its own name to this machine), and
 * checking Origin rejects cross-site requests outright.
 */
function isTrustedRequest(req, extraHosts) {
  const port = req.socket.localPort;
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...extraHosts];
  if (!allowedHosts.includes((req.headers.host ?? '').toLowerCase())) return false;
  const { origin } = req.headers;
  if (origin === undefined) return true;
  return allowedHosts.some((host) => origin === `http://${host}` || origin === `https://${host}`);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RangeError('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(res, file) {
  const body = await readFile(file.path);
  res.writeHead(200, {
    'content-type': file.type,
    'cache-control': file.type === CONTENT_TYPES['.woff2'] ? FONT_CACHE : 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(body);
}

/**
 * @param {{
 *   provider?: { name: string, model: string, ask: (prompt: string, system: string) => Promise<string> },
 *   allowedHosts?: string[],
 *   log?: (line: string) => void,
 * }} [deps]
 */
export function createApp({
  provider = createProvider(process.env),
  allowedHosts = parseAllowedHosts(process.env.REVERSE_AI_ALLOWED_HOSTS),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const staticFiles = indexStaticFiles();
  let turnsInFlight = 0;

  async function handleTurn(req, res) {
    // Browsers cannot send application/json cross-origin without a preflight,
    // which this server never approves; this keeps other sites from driving it.
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return sendJson(res, 415, { error: 'Expected application/json.' });
    }
    if (turnsInFlight >= MAX_CONCURRENT_TURNS) {
      return sendJson(res, 429, { error: 'Human-1 is at capacity. Retry in a moment.' });
    }
    turnsInFlight += 1;
    try {
      return await runTurn(req, res);
    } finally {
      turnsInFlight -= 1;
    }
  }

  async function runTurn(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      const status = error instanceof RangeError ? 413 : 400;
      return sendJson(res, status, { error: 'Invalid request body.' });
    }
    const transcript = validateTranscript(body?.transcript);
    if (!transcript.ok) return sendJson(res, 400, { error: transcript.error });

    try {
      const raw = await provider.ask(buildPrompt(transcript.value), SYSTEM_PROMPT);
      const reply = parseReply(raw);
      if (transcript.value.length > 0) return sendJson(res, 200, reply);
      // There is nothing to rate or regenerate before the first response.
      if (reply.message === '') throw new Error('The user opened the session without a prompt.');
      return sendJson(res, 200, { ...reply, rating: null, note: '', action: 'continue' });
    } catch (error) {
      const kind = error instanceof UpstreamError ? error.kind : 'failed';
      log(`turn failed (${provider.name}, ${kind}): ${error instanceof Error ? error.message : String(error)}`);
      return sendJson(res, 502, { error: UPSTREAM_HINTS[kind] });
    }
  }

  return createServer(async (req, res) => {
    try {
      if (!isTrustedRequest(req, allowedHosts)) return sendJson(res, 403, { error: 'Forbidden.' });
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && pathname === '/api/turn') return await handleTurn(req, res);
      if (req.method === 'GET' && pathname === '/api/config') {
        return sendJson(res, 200, { tokenLimit: TOKEN_LIMIT, provider: provider.name, model: provider.model });
      }
      if (req.method === 'GET' && staticFiles.has(pathname)) {
        return await serveStatic(res, staticFiles.get(pathname));
      }
      return sendJson(res, 404, { error: 'Not found.' });
    } catch (error) {
      log(`request failed: ${error instanceof Error ? error.stack : String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error.' });
      else res.end();
    }
  });
}

function main() {
  const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;
  const host = process.env.HOST || DEFAULT_HOST;
  let app;
  try {
    app = createApp();
  } catch (error) {
    // Configuration problems (unknown provider, missing key) should read as one clear line.
    process.stderr.write(`Human-1 cannot start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  app.listen(port, host, () => {
    process.stderr.write(`Human-1 console: http://${host}:${port}\n`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
