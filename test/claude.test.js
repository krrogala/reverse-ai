import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runClaude } from '../src/claude.js';
import { UpstreamError } from '../src/errors.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

async function withMode(mode, fn) {
  const previous = process.env.FAKE_CLAUDE_MODE;
  process.env.FAKE_CLAUDE_MODE = mode;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.FAKE_CLAUDE_MODE;
    else process.env.FAKE_CLAUDE_MODE = previous;
  }
}

const expectKind = (kind) => (error) => error instanceof UpstreamError && error.kind === kind;

test('runClaude sends the prompt on stdin and locks the model down to text only', async () => {
  const raw = await withMode('ok', () => runClaude({ bin: FAKE, prompt: 'hello; rm -rf /', system: 'SYS', model: 'haiku' }));
  const { args, prompt } = JSON.parse(raw);
  assert.equal(prompt, 'hello; rm -rf /');
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'SYS');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('hello; rm -rf /'));
});

test('runClaude reports a missing binary', async () => {
  await assert.rejects(runClaude({ bin: '/nonexistent/claude', prompt: 'x', system: 's' }), expectKind('not_installed'));
});

test('runClaude reports an expired login', async () => {
  await assert.rejects(withMode('auth', () => runClaude({ bin: FAKE, prompt: 'x', system: 's' })), expectKind('not_signed_in'));
});

test('runClaude recognises the logged-out message a fresh container gives', async () => {
  await assert.rejects(withMode('loggedout', () => runClaude({ bin: FAKE, prompt: 'x', system: 's' })), expectKind('not_signed_in'));
});

test('runClaude reports upstream errors', async () => {
  await assert.rejects(withMode('error', () => runClaude({ bin: FAKE, prompt: 'x', system: 's' })), expectKind('failed'));
});

test('runClaude reports non-JSON output', async () => {
  await assert.rejects(withMode('garbage', () => runClaude({ bin: FAKE, prompt: 'x', system: 's' })), /boom/);
});

test('runClaude kills a hung process', async () => {
  await assert.rejects(
    withMode('hang', () => runClaude({ bin: FAKE, prompt: 'x', system: 's', timeoutMs: 300 })),
    expectKind('timeout'),
  );
});
