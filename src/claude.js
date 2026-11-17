// Thin wrapper around `claude -p`: one prompt in, one text result out.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpstreamError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_CHARS = 1_000_000;

let privateCwd = null;

/** A directory only this user can write to, so nothing planted in shared /tmp is read as project context. */
function workingDirectory() {
  privateCwd ??= mkdtempSync(join(tmpdir(), 'human-1-'));
  return privateCwd;
}

function buildArgs(model, system) {
  // No tools, no MCP, no user settings: the model can only produce text, and
  // the user's own hooks/CLAUDE.md stay out of the persona.
  return [
    '-p',
    '--model', model,
    '--system-prompt', system,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--output-format', 'json',
  ];
}

function readResult(stdout, exitCode, stderr) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    const detail = stderr.trim().slice(0, 300) || `exit code ${exitCode}`;
    throw new UpstreamError(`claude returned no usable output (${detail})`, 'failed');
  }
  const result = typeof envelope.result === 'string' ? envelope.result : '';
  if (envelope.is_error) {
    const kind = /authenticate|auth login|sign in|not logged in|\/login/i.test(result) ? 'not_signed_in' : 'failed';
    throw new UpstreamError(result || 'claude reported an error', kind);
  }
  return result;
}

/**
 * Runs one non-interactive Claude turn.
 * @param {{ prompt: string, system: string, bin?: string, model?: string, timeoutMs?: number }} options
 * @returns {Promise<string>} the model's text result
 */
export function runClaude({ prompt, system, bin = 'claude', model = 'sonnet', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    // Args are passed as an array (no shell), and the prompt goes over stdin.
    const child = spawn(bin, buildArgs(model, system), {
      cwd: workingDirectory(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(reject, new UpstreamError(`claude did not answer within ${timeoutMs / 1000}s`, 'timeout'));
    }, timeoutMs);

    // Decode as a stream so a multibyte character split across chunks survives.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS) {
        child.kill('SIGKILL');
        settle(reject, new UpstreamError('claude produced too much output', 'failed'));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
    });

    child.on('error', (error) => {
      const missing = error.code === 'ENOENT';
      const message = missing ? `could not find the "${bin}" command` : `could not start claude: ${error.message}`;
      settle(reject, new UpstreamError(message, missing ? 'not_installed' : 'failed'));
    });

    child.on('close', (exitCode) => {
      try {
        settle(resolve, readResult(stdout, exitCode, stderr));
      } catch (error) {
        settle(reject, error);
      }
    });

    // The child may exit before reading stdin (e.g. bad flags); that surfaces via 'close'.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
