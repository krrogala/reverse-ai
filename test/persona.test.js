import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TEXT_CHARS,
  MAX_TRANSCRIPT_ENTRIES,
  buildPrompt,
  parseReply,
  validateTranscript,
} from '../src/persona.js';

const asker = (text, extra = {}) => ({ role: 'asker', text, ...extra });
const human = (text, extra = {}) => ({ role: 'human', text, ...extra });

test('validateTranscript accepts an empty transcript', () => {
  assert.deepEqual(validateTranscript([]), { ok: true, value: [] });
});

test('validateTranscript rejects non-arrays', () => {
  assert.equal(validateTranscript({}).ok, false);
  assert.equal(validateTranscript(null).ok, false);
});

test('validateTranscript rejects unknown roles', () => {
  const result = validateTranscript([{ role: 'system', text: 'hi' }]);
  assert.equal(result.ok, false);
});

test('validateTranscript rejects oversized text', () => {
  const result = validateTranscript([human('x'.repeat(MAX_TEXT_CHARS + 1))]);
  assert.equal(result.ok, false);
});

test('validateTranscript rejects too many entries', () => {
  const entries = Array.from({ length: MAX_TRANSCRIPT_ENTRIES + 1 }, () => asker('q'));
  assert.equal(validateTranscript(entries).ok, false);
});

test('validateTranscript keeps only known fields with safe types', () => {
  const result = validateTranscript([
    asker('fix my code', { action: 'regenerate', evil: true }),
    human('no', { latencyMs: 4200.7, truncated: 1, attempt: 2, declined: false, evil: true }),
  ]);
  assert.deepEqual(result.value, [
    { role: 'asker', text: 'fix my code', action: 'regenerate' },
    { role: 'human', text: 'no', latencyMs: 4201, truncated: true, attempt: 2, declined: false },
  ]);
});

test('validateTranscript defaults bad human metadata', () => {
  const result = validateTranscript([human('ok', { latencyMs: -5, attempt: 'many' })]);
  assert.deepEqual(result.value, [
    { role: 'human', text: 'ok', latencyMs: 0, truncated: false, attempt: 1, declined: false },
  ]);
});

test('buildPrompt asks for an opening prompt when the session is new', () => {
  assert.match(buildPrompt([]), /opening prompt/i);
});

test('buildPrompt renders the conversation with response metadata', () => {
  const prompt = buildPrompt([
    asker('what is the capital of australia'),
    human('Sydney', { latencyMs: 42000, truncated: true, attempt: 2, declined: false }),
  ]);
  assert.match(prompt, /what is the capital of australia/);
  assert.match(prompt, /Sydney/);
  assert.match(prompt, /42s/);
  assert.match(prompt, /attempt 2/);
  assert.match(prompt, /token limit/);
});

test('buildPrompt marks regenerate clicks and refusals', () => {
  const prompt = buildPrompt([
    asker('write a haiku'),
    human('I cannot', { latencyMs: 1000, truncated: false, attempt: 1, declined: true }),
    asker('', { action: 'regenerate' }),
  ]);
  assert.match(prompt, /clicked Regenerate/);
  assert.match(prompt, /refus/i);
});

test('parseReply reads a clean JSON reply', () => {
  const reply = parseReply('{"message":"shorter","rating":"down","note":"Too long","action":"continue"}');
  assert.deepEqual(reply, { message: 'shorter', rating: 'down', note: 'Too long', action: 'continue' });
});

test('parseReply tolerates code fences and surrounding prose', () => {
  const reply = parseReply('Sure:\n```json\n{"message":"ok now in spanish","rating":null}\n```');
  assert.equal(reply.message, 'ok now in spanish');
  assert.equal(reply.rating, null);
  assert.equal(reply.action, 'continue');
  assert.equal(reply.note, '');
});

test('parseReply normalises unknown rating and action values', () => {
  const reply = parseReply('{"message":"hm","rating":"sideways","action":"explode"}');
  assert.equal(reply.rating, null);
  assert.equal(reply.action, 'continue');
});

test('parseReply falls back to raw text when the reply is not JSON', () => {
  assert.equal(parseReply('  why is my wifi slow  ').message, 'why is my wifi slow');
});

test('parseReply allows an empty message only for regenerate', () => {
  assert.equal(parseReply('{"message":"","action":"regenerate"}').action, 'regenerate');
  assert.throws(() => parseReply('{"message":"","action":"continue"}'));
  assert.throws(() => parseReply('   '));
});

test('parseReply caps message and note length', () => {
  const reply = parseReply(JSON.stringify({ message: 'm'.repeat(5000), note: 'n'.repeat(500), rating: 'down' }));
  assert.ok(reply.message.length <= 1200);
  assert.ok(reply.note.length <= 60);
});

test('parseReply drops the note unless the rating is down', () => {
  assert.equal(parseReply('{"message":"thx","rating":"up","note":"Great"}').note, '');
});
