import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVitals } from '../public/vitals.js';

/** A controllable clock; localStorage is absent in Node, which exercises the storage fallback. */
function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

test('measures typing speed from first keystroke to submit', () => {
  const time = clock();
  const vitals = createVitals(time.now);
  vitals.input('h');
  time.advance(60_000);
  const text = 'x'.repeat(200); // 40 words in one minute
  vitals.input(text);
  assert.equal(vitals.snapshot().wpm, 40);
  assert.equal(vitals.snapshot().liveBar, true);
  assert.equal(vitals.finishResponse(text, true).wpm, 40);
  const after = vitals.snapshot();
  assert.deepEqual(after.bars, [40]);
  assert.equal(after.liveBar, false);
  assert.equal(after.peak, 40);
});

test('does not report absurd speeds for instant answers', () => {
  const time = clock();
  const vitals = createVitals(time.now);
  vitals.input('x'.repeat(50));
  assert.equal(vitals.finishResponse('x'.repeat(50), true).wpm, 300); // floored to a two-second window
});

test('canned refusals do not count as typing', () => {
  const vitals = createVitals(clock().now);
  assert.equal(vitals.finishResponse('I cannot help with that.', false).wpm, null);
  assert.deepEqual(vitals.snapshot().bars, []);
});

test('counts backspaces and deleted drafts per response and per session', () => {
  const vitals = createVitals(clock().now);
  vitals.keydown('a');
  vitals.keydown('Backspace');
  vitals.keydown('Backspace');
  vitals.input('It is DNS');
  vitals.input('');
  vitals.input('ok');
  vitals.input(''); // too short to be a draft
  vitals.input('Out of memory');
  const first = vitals.finishResponse('Out of memory', true);
  assert.equal(first.backspaces, 2);
  assert.deepEqual(first.drafts, ['It is DNS']);
  const second = vitals.finishResponse('next', true);
  assert.equal(second.backspaces, 0);
  assert.deepEqual(second.drafts, []);
  assert.equal(vitals.snapshot().backspaces, 2);
  assert.equal(vitals.snapshot().draftsDeleted, 1);
});

test('a refusal is not credited with what was typed before it, and an emptied box shows no live speed', () => {
  const vitals = createVitals(clock().now);
  vitals.keydown('Backspace');
  vitals.input('half an answer');
  vitals.input('');
  assert.equal(vitals.snapshot().liveBar, false);
  const refusal = vitals.finishResponse('I cannot help with that.', false);
  assert.deepEqual(refusal, { wpm: null, backspaces: 0, drafts: [] });
});

test('keeps only the most recent bars and resets with the session', () => {
  const time = clock();
  const vitals = createVitals(time.now);
  for (let i = 0; i < 12; i += 1) {
    vitals.input('x');
    time.advance(60_000);
    vitals.finishResponse('x'.repeat(5 * (i + 1)), true);
  }
  assert.equal(vitals.snapshot().bars.length, 9);
  assert.equal(vitals.snapshot().peak, 12);
  vitals.resetSession();
  assert.deepEqual(vitals.snapshot().bars, []);
  assert.equal(vitals.snapshot().peak, 0);
});

test('caffeine counts down a six hour window from the last cup', () => {
  const time = clock();
  const vitals = createVitals(time.now);
  assert.equal(vitals.snapshot().caffeine, null);
  vitals.logCup();
  time.advance(60 * 60_000);
  const { caffeine } = vitals.snapshot();
  assert.equal(caffeine.sinceMs, 60 * 60_000);
  assert.equal(caffeine.remainingMs, 5 * 60 * 60_000);
  time.advance(10 * 60 * 60_000);
  assert.equal(vitals.snapshot().caffeine.remainingMs, 0);
});

test('posture degrades the longer the page stays open', () => {
  const time = clock();
  const vitals = createVitals(time.now);
  assert.equal(vitals.snapshot().posture.label, 'Nominal');
  time.advance(6 * 60_000);
  assert.equal(vitals.snapshot().posture.label, 'Slouching');
  time.advance(20 * 60_000);
  assert.equal(vitals.snapshot().posture.label, 'Degrading');
});
