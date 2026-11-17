// HTTP server: serves the console UI and relays each turn to `claude -p`.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ClaudeError, runClaude } from './claude.js';
import { SYSTEM_PROMPT, TOKEN_LIMIT, buildPrompt, parseReply, validateTranscript } from './persona.js';

const PUBLIC_DIR = new URL('../public/', import.meta.url);
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CONCURRENT_TURNS = 2;
const DEFAULT_PORT = 4517;
const HOST = '127.0.0.1';

const UPSTREAM_HINTS = {
  not_installed: 'The claude CLI was not found. Install Claude Code, or set CLAUDE_BIN.',
  not_signed_in: 'The claude CLI is not signed in. Run "claude auth login" in a terminal, then retry.',
  timeout: 'The user took too long to type. Retry.',
  failed: 'The user could not be reached. Retry.',
};

/**
 * Only the local console may talk to this server. Checking Host defeats DNS
 * rebinding (a hostile site re-resolving its own name to 127.0.0.1), and
 * checking Origin rejects cross-site requests outright.
 */
function isLocalRequest(req) {
  const port = req.socket.localPort;
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(req.headers.host ?? '')) return false;
  const { origin } = req.headers;
  return origin === undefined || allowedHosts.some((host) => origin === `http://${host}`);
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

async function serveStatic(res, entry) {
  const body = await readFile(new URL(entry.file, PUBLIC_DIR));
  res.writeHead(200, {
    'content-type': entry.type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  });
  res.end(body);
}

/**
 * @param {{ askClaude?: (prompt: string, system: string) => Promise<string>, log?: (line: string) => void }} [deps]
 */
export function createApp({ askClaude, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const ask =
    askClaude ??
    ((prompt, system) =>
      runClaude({
        prompt,
        system,
        bin: process.env.CLAUDE_BIN || 'claude',
        model: process.env.REVERSE_AI_MODEL || 'sonnet',
      }));
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
      const raw = await ask(buildPrompt(transcript.value), SYSTEM_PROMPT);
      const reply = parseReply(raw);
      // There is nothing to rate or regenerate before the first response.
      if (transcript.value.length > 0) return sendJson(res, 200, reply);
      if (reply.message === '') throw new Error('The user opened the session without a prompt.');
      return sendJson(res, 200, { ...reply, rating: null, note: '', action: 'continue' });
    } catch (error) {
      const kind = error instanceof ClaudeError ? error.kind : 'failed';
      log(`turn failed (${kind}): ${error instanceof Error ? error.message : String(error)}`);
      return sendJson(res, 502, { error: UPSTREAM_HINTS[kind] });
    }
  }

  return createServer(async (req, res) => {
    try {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Forbidden.' });
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && pathname === '/api/turn') return await handleTurn(req, res);
      if (req.method === 'GET' && pathname === '/api/config') {
        return sendJson(res, 200, { tokenLimit: TOKEN_LIMIT });
      }
      if (req.method === 'GET' && Object.hasOwn(STATIC_FILES, pathname)) {
        return await serveStatic(res, STATIC_FILES[pathname]);
      }
      return sendJson(res, 404, { error: 'Not found.' });
    } catch (error) {
      log(`request failed: ${error instanceof Error ? error.stack : String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error.' });
      else res.end();
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;
  createApp().listen(port, HOST, () => {
    process.stderr.write(`Human-1 console: http://${HOST}:${port}\n`);
  });
}
