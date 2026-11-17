// Tracks how the human "model" is performing: typing speed, backspaces,
// deleted drafts, and how long ago they last had coffee.

const CHARS_PER_WORD = 5;
const MIN_TYPING_MS = 2000; // below this a words-per-minute figure is noise
const MIN_DRAFT_CHARS = 6; // clearing fewer characters than this is not a "deleted draft"
const SPARK_BARS = 9;
const CAFFEINE_WINDOW_MS = 6 * 60 * 60 * 1000;
const CUP_KEY = 'human1.lastCupAt';
const POSTURE = [
  { afterMs: 20 * 60_000, label: 'Degrading', tone: 'bad' },
  { afterMs: 5 * 60_000, label: 'Slouching', tone: 'warn' },
  { afterMs: 0, label: 'Nominal', tone: '' },
];

function readLastCup() {
  try {
    const value = Number(localStorage.getItem(CUP_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    // Storage can be blocked (private mode); the caffeine clock just starts empty.
    return null;
  }
}

function writeLastCup(at) {
  try {
    localStorage.setItem(CUP_KEY, String(at));
  } catch {
    // Not persisted; still tracked for this page load.
  }
}

const freshResponse = () => ({ firstKeyAt: null, lastValue: '', backspaces: 0, drafts: [] });

/** @param {() => number} [now] */
export function createVitals(now = Date.now) {
  const openedAt = now();
  let lastCupAt = readLastCup();
  let response = freshResponse();
  let session = { wpmHistory: [], backspaces: 0, draftsDeleted: 0 };

  const liveWpm = (value, at) => {
    if (response.firstKeyAt === null || value === '') return null;
    const elapsed = Math.max(at - response.firstKeyAt, MIN_TYPING_MS);
    return Math.round(value.length / CHARS_PER_WORD / (elapsed / 60_000));
  };

  return {
    /** Call on every keydown in the response box. */
    keydown(key) {
      if (key !== 'Backspace') return;
      response = { ...response, backspaces: response.backspaces + 1 };
      session = { ...session, backspaces: session.backspaces + 1 };
    },

    /** Call whenever the response box's text changes. */
    input(value) {
      const cleared = value.trim() === '' && response.lastValue.trim().length >= MIN_DRAFT_CHARS;
      if (cleared) session = { ...session, draftsDeleted: session.draftsDeleted + 1 };
      response = {
        ...response,
        firstKeyAt: response.firstKeyAt ?? (value ? now() : null),
        drafts: cleared ? [...response.drafts, response.lastValue.trim()] : response.drafts,
        lastValue: value,
      };
    },

    /** Closes out the response being typed and returns what it took to write it. */
    finishResponse(text, typed) {
      const wpm = typed ? liveWpm(text, now()) : null;
      // A canned refusal was not typed, so nothing typed before it is credited to it.
      const stats = typed
        ? { wpm, backspaces: response.backspaces, drafts: response.drafts }
        : { wpm, backspaces: 0, drafts: [] };
      if (wpm !== null) session = { ...session, wpmHistory: [...session.wpmHistory, wpm] };
      response = freshResponse();
      return stats;
    },

    logCup() {
      lastCupAt = now();
      writeLastCup(lastCupAt);
    },

    resetSession() {
      response = freshResponse();
      session = { wpmHistory: [], backspaces: 0, draftsDeleted: 0 };
    },

    snapshot() {
      const at = now();
      const live = liveWpm(response.lastValue, at);
      const bars = [...session.wpmHistory, ...(live === null ? [] : [live])].slice(-SPARK_BARS);
      const sinceCup = lastCupAt === null ? null : at - lastCupAt;
      const posture = POSTURE.find((stage) => at - openedAt >= stage.afterMs);
      return {
        wpm: live ?? session.wpmHistory.at(-1) ?? 0,
        bars,
        liveBar: live !== null,
        peak: Math.max(0, ...session.wpmHistory, live ?? 0),
        backspaces: session.backspaces,
        draftsDeleted: session.draftsDeleted,
        posture,
        sinceOpenedMs: at - openedAt,
        caffeine:
          sinceCup === null
            ? null
            : { sinceMs: sinceCup, remainingMs: Math.max(0, CAFFEINE_WINDOW_MS - sinceCup), windowMs: CAFFEINE_WINDOW_MS },
      };
    },
  };
}
