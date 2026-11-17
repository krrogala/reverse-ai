import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ago,
  clockRemark,
  countdown,
  estimateTokens,
  marginNote,
  median,
  sessionMetrics,
  stopwatch,
  transcriptText,
} from '../public/format.js';

const human = (extra = {}) => ({ role: 'human', text: 'an answer', latencyMs: 10_000, attempt: 1, ...extra });

test('estimateTokens rounds up at four characters per token', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});

test('stopwatch, countdown and ago format durations', () => {
  assert.equal(stopwatch(0), '00:00.0');
  assert.equal(stopwatch(2_400), '00:02.4');
  assert.equal(stopwatch(62_450), '01:02.4');
  assert.equal(countdown(6_486_000), '1:48:06');
  assert.equal(countdown(0), '0:00:00');
  assert.equal(ago(47_000), '47s');
  assert.equal(ago(47 * 60_000), '47m');
  assert.equal(ago((4 * 60 + 12) * 60_000), '4h 12m');
});

test('median handles empty, odd and even lists without mutating', () => {
  const values = [9, 1, 5];
  assert.equal(median([]), null);
  assert.equal(median(values), 5);
  assert.equal(median([4, 2]), 3);
  assert.deepEqual(values, [9, 1, 5]);
});

test('marginNote picks the remark an answer earned', () => {
  assert.equal(marginNote(human({ declined: true, latencyMs: 500 })), '');
  assert.equal(marginNote(human({ truncated: true })), 'ran out of room');
  assert.equal(marginNote(human({ latencyMs: 61_000 })), 'stared at this one for a minute');
  assert.equal(marginNote(human({ drafts: ['a', 'b'] })), 'take 3');
  assert.equal(marginNote(human({ latencyMs: 1_500 })), 'wrote it fast before I could doubt it');
  assert.equal(marginNote(human({ backspaces: 20 })), 'fought the backspace key');
  assert.equal(marginNote(human()), '');
});

test('clockRemark escalates with the wait', () => {
  assert.match(clockRemark(1_000), /watching the clock/);
  assert.match(clockRemark(31_000), /taking a while/);
  assert.match(clockRemark(61_000), /noticed/);
});

test('sessionMetrics summarises the transcript', () => {
  const transcript = [
    { role: 'asker', text: 'q1', action: 'continue' },
    human({ rating: 'down', rejected: true, latencyMs: 4_000, text: '12345678' }),
    { role: 'asker', text: '', action: 'regenerate' },
    human({ rating: 'up', latencyMs: 8_000, text: '1234' }),
    { role: 'asker', text: 'q2', action: 'continue' },
    human({ declined: true, latencyMs: 6_000, text: '1234' }),
  ];
  assert.deepEqual(sessionMetrics(transcript), {
    satisfaction: 50,
    regenerations: 1,
    medianLatencyMs: 6_000,
    tokensOut: 4,
    refusals: 1,
    turns: 2,
  });
  assert.equal(sessionMetrics([]).satisfaction, null);
});

test('transcriptText exports both sides with verdicts', () => {
  const text = transcriptText(
    [
      { role: 'asker', text: 'capital of peru', action: 'continue' },
      human({ text: 'Lima', rating: 'down', note: 'Too slow', rejected: true, attempt: 2, truncated: true }),
      { role: 'asker', text: '', action: 'regenerate' },
      human({ text: 'no', declined: true, rating: 'up' }),
    ],
    '0x4F',
  );
  assert.match(text, /session 0x4F/);
  assert.match(text, /USER:\ncapital of peru/);
  assert.match(text, /HUMAN-1 \(10\.0s, 1 tokens, attempt 2, max tokens reached, rated unhelpful: Too slow, discarded\):\nLima/);
  assert.match(text, /\[User clicked Regenerate\]/);
  assert.match(text, /declined, rated helpful/);
});
