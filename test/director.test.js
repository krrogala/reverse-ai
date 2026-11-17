import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSeed, planTurn, turnsAllowed } from '../src/director.js';
import { COMPLICATIONS, CONSTRAINTS, PERSONAS, TOPICS } from '../src/topics.js';

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
  for (const pool of [COMPLICATIONS, CONSTRAINTS]) {
    assert.ok(pool.length >= 40);
    assert.equal(new Set(pool).size, pool.length);
  }
});

test('a new topic comes with a complication and a constraint from the pools', () => {
  const plan = planTurn([], 42);
  assert.ok(COMPLICATIONS.includes(plan.complication));
  assert.ok(CONSTRAINTS.includes(plan.constraint));
});

test('a turn that stays on the subject carries no complication or constraint', () => {
  const staying = simulate(7, 30).filter((plan) => plan.newTopic === null);
  assert.ok(staying.length > 0);
  assert.ok(staying.every((plan) => plan.complication === null && plan.constraint === null));
});

test('the same subject is dressed differently across sessions and topics', () => {
  const combos = new Set();
  const complications = new Set();
  const constraints = new Set();
  for (let seed = 1; seed <= 300; seed += 1) {
    for (const plan of simulate((seed * 2654435761) >>> 0, 12).filter((p) => p.newTopic !== null)) {
      combos.add(`${plan.newTopic}|${plan.complication}|${plan.constraint}`);
      complications.add(plan.complication);
      constraints.add(plan.constraint);
    }
  }
  assert.equal(complications.size, COMPLICATIONS.length);
  assert.equal(constraints.size, CONSTRAINTS.length);
  assert.ok(combos.size > 1000, `only ${combos.size} distinct combinations`);
});

test('the complication and constraint are not locked to each other', () => {
  const pairs = new Set();
  for (let seed = 0; seed < 2000; seed += 1) {
    const plan = planTurn([], (seed * 2654435761) >>> 0);
    pairs.add(`${plan.complication}|${plan.constraint}`);
  }
  assert.ok(pairs.size > 1000, `only ${pairs.size} distinct pairs`);
});

test('the picks are independent of how long the topic lasts', () => {
  const lengthsByComplication = new Map();
  for (let i = 0; i < 5000; i += 1) {
    const seed = (i * 2654435761) >>> 0;
    const { complication } = planTurn([], seed);
    const lengths = lengthsByComplication.get(complication) ?? new Set();
    lengthsByComplication.set(complication, lengths.add(turnsAllowed(seed, 0)));
  }
  assert.equal(lengthsByComplication.size, COMPLICATIONS.length);
  assert.ok([...lengthsByComplication.values()].every((lengths) => lengths.size === 3));
});
