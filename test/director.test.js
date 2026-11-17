import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSeed, planTurn, turnsAllowed } from '../src/director.js';
import { PERSONAS, TOPICS } from '../src/topics.js';

const asker = (topicIndex) => ({ role: 'asker', text: 'q', topicIndex });
const human = () => ({ role: 'human', text: 'a' });

/** Plays a whole session against the planner, answering every turn, and returns the plans. */
function simulate(seed, turns) {
  const plans = [];
  let transcript = [];
  for (let i = 0; i < turns; i += 1) {
    const plan = planTurn(transcript, seed);
    plans.push(plan);
    transcript = [...transcript, asker(plan.topicIndex), human()];
  }
  return plans;
}

test('cleanSeed accepts 32-bit unsigned integers and zeroes everything else', () => {
  assert.equal(cleanSeed(0), 0);
  assert.equal(cleanSeed(4294967295), 4294967295);
  for (const bad of [-1, 4294967296, 1.5, '7', null, undefined, NaN]) assert.equal(cleanSeed(bad), 0);
});

test('a new session opens with a topic and a persona from the pools', () => {
  const plan = planTurn([], 42);
  assert.equal(plan.topicIndex, 0);
  assert.ok(TOPICS.includes(plan.newTopic));
  assert.ok(PERSONAS.includes(plan.persona));
});

test('planning is deterministic for a seed and stable within a session', () => {
  assert.deepEqual(simulate(99, 20), simulate(99, 20));
  assert.equal(new Set(simulate(99, 20).map((plan) => plan.persona)).size, 1);
});

test('every topic lasts between two and four user turns, never longer', () => {
  for (const seed of [1, 2, 3, 500, 123456789]) {
    const perTopic = new Map();
    for (const plan of simulate(seed, 60)) perTopic.set(plan.topicIndex, (perTopic.get(plan.topicIndex) ?? 0) + 1);
    const lengths = [...perTopic.values()].slice(0, -1); // the last topic may be cut short by the simulation ending
    assert.ok(lengths.every((n) => n >= 2 && n <= 4), `seed ${seed}: ${lengths}`);
    assert.ok(new Set(lengths).size > 1, `seed ${seed} should vary topic lengths`);
  }
});

test('turnsAllowed stays in range and uses the whole range', () => {
  const seen = new Set();
  for (let seed = 0; seed < 50; seed += 1) for (let topic = 0; topic < 10; topic += 1) seen.add(turnsAllowed(seed, topic));
  assert.deepEqual([...seen].sort(), [2, 3, 4]);
});

test('a new topic is announced exactly on the turn the subject changes', () => {
  const plans = simulate(7, 30);
  plans.forEach((plan, i) => {
    const changed = i === 0 || plan.topicIndex !== plans[i - 1].topicIndex;
    assert.equal(plan.newTopic !== null, changed);
  });
});

test('a session does not repeat a topic until the pool is exhausted', () => {
  const topics = simulate(31337, 400)
    .map((plan) => plan.newTopic)
    .filter(Boolean)
    .slice(0, TOPICS.length);
  assert.equal(new Set(topics).size, topics.length);
});

test('different sessions get different openers, orders and personas', () => {
  const seeds = Array.from({ length: 200 }, (_, i) => (i * 2654435761) >>> 0);
  const openers = new Set(seeds.map((seed) => planTurn([], seed).newTopic));
  const personas = new Set(seeds.map((seed) => planTurn([], seed).persona));
  assert.ok(openers.size > TOPICS.length * 0.6, `only ${openers.size} distinct openers in 200 sessions`);
  assert.equal(personas.size, PERSONAS.length);
});

test('Regenerate clicks count towards the limit, so the user cannot loop on one prompt forever', () => {
  const stuck = Array.from({ length: 4 }, () => [asker(0), human()]).flat();
  assert.equal(planTurn(stuck, 5).topicIndex, 1);
});

test('the pools are large and free of duplicates', () => {
  assert.ok(TOPICS.length >= 90);
  assert.equal(new Set(TOPICS).size, TOPICS.length);
  assert.equal(new Set(PERSONAS).size, PERSONAS.length);
});
