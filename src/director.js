// Decides, in code, who the user is this session and when they change the subject.
// The model is good at playing a part and bad at being random, so the dice live here.

import { PERSONAS, TOPICS } from './topics.js';

const MIN_TURNS_ON_TOPIC = 2;
const MAX_TURNS_ON_TOPIC = 4;
const UINT32 = 2 ** 32;
const MIX = 0x9e3779b1; // golden-ratio constant, spreads consecutive indices across the seed space

/** Small deterministic PRNG (mulberry32): same seed, same sequence. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

function shuffled(items, seed) {
  const next = random(seed);
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** How many user turns a given topic gets before the user loses interest. */
export function turnsAllowed(seed, topicIndex) {
  const roll = random((seed ^ Math.imul(topicIndex + 1, MIX)) >>> 0)();
  return MIN_TURNS_ON_TOPIC + Math.floor(roll * (MAX_TURNS_ON_TOPIC - MIN_TURNS_ON_TOPIC + 1));
}

/** Accepts only a 32-bit unsigned integer; anything else becomes 0. */
export function cleanSeed(value) {
  return Number.isInteger(value) && value >= 0 && value < UINT32 ? value : 0;
}

/**
 * Plans the user's next turn from a validated transcript.
 * @param {{ role: string, topicIndex?: number }[]} transcript
 * @param {number} seed per-session seed chosen by the browser
 * @returns {{ persona: string, topicIndex: number, newTopic: string | null }}
 *   newTopic is set when the user must open a new subject on this turn.
 */
export function planTurn(transcript, seed) {
  const persona = PERSONAS[seed % PERSONAS.length];
  const askerTurns = transcript.filter((entry) => entry.role === 'asker');
  const current = askerTurns.at(-1)?.topicIndex ?? -1;
  const spent = askerTurns.filter((entry) => entry.topicIndex === current).length;

  const moveOn = current === -1 || spent >= turnsAllowed(seed, current);
  if (!moveOn) return { persona, topicIndex: current, newTopic: null };

  const topicIndex = current + 1;
  const order = shuffled(TOPICS, seed);
  return { persona, topicIndex, newTopic: order[topicIndex % order.length] };
}
