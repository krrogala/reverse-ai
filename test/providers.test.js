import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { UpstreamError } from '../src/errors.js';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { createGeminiProvider, createOpenAIProvider, createOpenRouterProvider } from '../src/providers/http.js';
import { PROVIDER_NAMES, createProvider } from '../src/providers/index.js';

const expectKind = (kind) => (error) => error instanceof UpstreamError && error.kind === kind;

/** A fetch stand-in that records the request and answers with the given status and body. */
function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { impl, calls };
}

const fakeAnthropic = (respond) => {
  const requests = [];
  return {
    requests,
    client: { beta: { messages: { create: async (request) => (requests.push(request), respond(request)) } } },
  };
};

test('createProvider defaults to the claude CLI', () => {
  const provider = createProvider({});
  assert.equal(provider.name, 'claude-cli');
  assert.equal(provider.model, 'sonnet');
});

test('createProvider rejects unknown providers and names the valid ones', () => {
  assert.throws(() => createProvider({ REVERSE_AI_PROVIDER: 'skynet' }), /claude-cli, anthropic, openai, gemini, openrouter/);
  assert.deepEqual(PROVIDER_NAMES, ['claude-cli', 'anthropic', 'openai', 'gemini', 'openrouter']);
});

test('createProvider fails fast when a key or model is missing', () => {
  assert.throws(() => createProvider({ REVERSE_AI_PROVIDER: 'openai', REVERSE_AI_MODEL: 'm' }), /OPENAI_API_KEY/);
  assert.throws(() => createProvider({ REVERSE_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }), /REVERSE_AI_MODEL/);
  assert.throws(() => createProvider({ REVERSE_AI_PROVIDER: 'gemini', REVERSE_AI_MODEL: 'm' }), /GEMINI_API_KEY/);
  assert.throws(() => createProvider({ REVERSE_AI_PROVIDER: 'openrouter', REVERSE_AI_MODEL: 'm' }), /OPENROUTER_API_KEY/);
});

test('createProvider rejects model names that could be read as flags or paths', () => {
  for (const model of ['--dangerously-skip-permissions', 'a b', 'x;y', '../x?key=1']) {
    assert.throws(() => createProvider({ REVERSE_AI_MODEL: model }), /REVERSE_AI_MODEL may only contain/, model);
  }
  assert.equal(createProvider({ REVERSE_AI_MODEL: 'vendor/model-1.5:free' }).model, 'vendor/model-1.5:free');
});

test('createProvider builds each API provider from its environment', () => {
  const env = { REVERSE_AI_MODEL: 'some-model', OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'k', OPENROUTER_API_KEY: 'k' };
  for (const name of ['openai', 'gemini', 'openrouter']) {
    const provider = createProvider({ ...env, REVERSE_AI_PROVIDER: name });
    assert.equal(provider.name, name);
    assert.equal(provider.model, 'some-model');
  }
});

test('anthropic provider sends a low-effort request with refusal fallbacks and joins text blocks', async () => {
  const { client, requests } = fakeAnthropic(() => ({
    stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"message":' }, { type: 'text', text: '"hi"}' }],
  }));
  const provider = createAnthropicProvider({ client });
  assert.equal(await provider.ask('PROMPT', 'SYSTEM'), '{"message":"hi"}');
  assert.equal(provider.model, 'claude-opus-5-5');
  assert.deepEqual(requests[0].messages, [{ role: 'user', content: 'PROMPT' }]);
  assert.equal(requests[0].system, 'SYSTEM');
  assert.deepEqual(requests[0].output_config, { effort: 'low' });
  assert.equal(requests[0].fallbacks, 'default');
  assert.deepEqual(requests[0].betas, ['server-side-fallback-2026-07-01']);
});

test('anthropic provider omits model-gated options for models that reject them', async () => {
  const { client, requests } = fakeAnthropic(() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] }));
  await createAnthropicProvider({ client, model: 'claude-haiku-5-5' }).ask('p', 's');
  await createAnthropicProvider({ client, model: 'claude-haiku-4-5' }).ask('p', 's');
  assert.equal(requests[0].fallbacks, undefined);
  assert.deepEqual(requests[0].output_config, { effort: 'low' });
  assert.equal(requests[1].output_config, undefined);
});

test('anthropic provider reports refusals and maps SDK errors', async () => {
  const refusing = fakeAnthropic(() => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }));
  await assert.rejects(createAnthropicProvider({ client: refusing.client }).ask('p', 's'), expectKind('refused'));

  const failing = (error) =>
    createAnthropicProvider({ client: fakeAnthropic(() => Promise.reject(error)).client }).ask('p', 's');
  const headers = new Headers();
  await assert.rejects(failing(new Anthropic.AuthenticationError(401, {}, 'no', headers)), expectKind('bad_key'));
  await assert.rejects(failing(new Anthropic.PermissionDeniedError(403, {}, 'no', headers)), expectKind('bad_key'));
  await assert.rejects(failing(new Anthropic.RateLimitError(429, {}, 'slow', headers)), expectKind('rate_limited'));
  await assert.rejects(failing(new Anthropic.APIConnectionTimeoutError()), expectKind('timeout'));
  await assert.rejects(failing(new Anthropic.InternalServerError(500, {}, 'oops', headers)), expectKind('failed'));
  await assert.rejects(failing('weird'), expectKind('failed'));
});

test('openai and openrouter providers speak chat completions to their own hosts', async () => {
  const body = { choices: [{ message: { content: 'next question' } }] };
  for (const [create, host] of [[createOpenAIProvider, 'api.openai.com'], [createOpenRouterProvider, 'openrouter.ai']]) {
    const { impl, calls } = fakeFetch(200, body);
    const provider = create({ apiKey: 'sk-test', model: 'vendor/model', fetchImpl: impl });
    assert.equal(await provider.ask('PROMPT', 'SYSTEM'), 'next question');
    assert.equal(new URL(calls[0].url).host, host);
    assert.ok(calls[0].url.endsWith('/chat/completions'));
    assert.equal(calls[0].headers.authorization, 'Bearer sk-test');
    assert.deepEqual(calls[0].body, {
      model: 'vendor/model',
      messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'PROMPT' }],
    });
  }
});

test('gemini provider keeps the key out of the URL and joins parts', async () => {
  const { impl, calls } = fakeFetch(200, { candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] });
  const provider = createGeminiProvider({ apiKey: 'g-key', model: 'models/x y', fetchImpl: impl });
  assert.equal(await provider.ask('PROMPT', 'SYSTEM'), 'ab');
  assert.ok(!calls[0].url.includes('g-key'));
  assert.ok(calls[0].url.endsWith('/models/models%2Fx%20y:generateContent'));
  assert.equal(calls[0].headers['x-goog-api-key'], 'g-key');
  assert.deepEqual(calls[0].body.systemInstruction, { parts: [{ text: 'SYSTEM' }] });
  assert.deepEqual(calls[0].body.contents, [{ role: 'user', parts: [{ text: 'PROMPT' }] }]);
});

test('http providers map status codes, empty replies and bad bodies', async () => {
  const ask = (status, body) =>
    createOpenAIProvider({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch(status, body).impl }).ask('p', 's');
  await assert.rejects(ask(401, { error: 'bad key' }), expectKind('bad_key'));
  const keyLike = 'k'.repeat(24); // built at runtime so secret scanners do not flag this file
  await assert.rejects(ask(401, `Incorrect API key provided: ${keyLike}`), (error) => {
    return !error.message.includes(keyLike) && error.message.includes('[redacted]');
  });
  await assert.rejects(ask(403, {}), expectKind('bad_key'));
  await assert.rejects(ask(429, {}), expectKind('rate_limited'));
  await assert.rejects(ask(500, 'down'), expectKind('failed'));
  await assert.rejects(ask(200, 'not json'), expectKind('failed'));
  await assert.rejects(ask(200, { choices: [] }), expectKind('failed'));
  const gemini = (body) =>
    createGeminiProvider({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch(200, body).impl }).ask('p', 's');
  await assert.rejects(gemini({ candidates: [] }), expectKind('failed'));
});

test('http providers classify timeouts and network failures', async () => {
  const throwing = (error) => async () => {
    throw error;
  };
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const ask = (fetchImpl) => createOpenAIProvider({ apiKey: 'k', model: 'm', fetchImpl }).ask('p', 's');
  await assert.rejects(ask(throwing(timeout)), expectKind('timeout'));
  await assert.rejects(ask(throwing(new Error('ECONNRESET'))), expectKind('failed'));
});
