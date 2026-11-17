// Human-1 console. The "user" is an LLM (via the server); the model is whoever is typing.

import {
  CHARS_PER_TOKEN,
  ago,
  clockRemark,
  countdown,
  estimateTokens,
  seconds,
  sessionMetrics,
  stopwatch,
  transcriptText,
} from './format.js';
import { el, renderThread } from './render.js';
import { createVitals } from './vitals.js';

const MAX_ENTRIES_SENT = 40;
const SLOW_MS = 30_000;
const VERY_SLOW_MS = 60_000;
const POOR_SATISFACTION = 50;
const TICK_MS = 100;
const VITALS_TICK_MS = 500;
const REVOKE_DELAY_MS = 1000;
const SPARK_SLOTS = 9;
const REFUSAL_TEXT = "I'm sorry, but I can't help with that request.";

const $ = (id) => document.getElementById(id);
const ui = {
  sidebar: $('sidebar'),
  menu: $('menu'),
  thread: $('thread'),
  composer: $('composer'),
  response: $('response'),
  send: $('send'),
  decline: $('decline'),
  tokens: $('tokens'),
  tokenBar: $('token-bar'),
  latency: $('latency'),
  clockRemark: $('clock-remark'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  statusAttempt: $('status-attempt'),
  sessionInfo: $('session-info'),
  factLimit: $('fact-limit'),
  userBackend: $('user-backend'),
  logCup: $('log-cup'),
};

const vitals = createVitals();
let state = newState();
let tokenLimit = 120;
let openDrafts = new Set();

function newState() {
  return {
    // token guards against a slow reply landing in a session that was since reset.
    token: Symbol('session'),
    id: `0x${Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0')}`,
    transcript: [],
    waiting: false,
    error: null,
    promptAt: null,
    attempt: 1,
  };
}

const awaitingHuman = () => !state.waiting && !state.error && state.promptAt !== null;

function renderStatus() {
  const regenerating = state.attempt > 1;
  const [dot, text] = state.error
    ? ['err', 'User disconnected']
    : state.waiting
      ? ['wait pulse', 'User is typing']
      : !awaitingHuman()
        ? ['', 'Idle']
        : regenerating
          ? ['retry pulse', 'Regenerating response']
          : ['ok', 'Awaiting model output'];
  ui.statusDot.className = `dot ${dot}`;
  ui.statusText.textContent = text;
  ui.statusAttempt.hidden = !(awaitingHuman() && regenerating);
  ui.statusAttempt.textContent = `attempt ${state.attempt}`;

  ui.response.disabled = !awaitingHuman();
  ui.decline.disabled = !awaitingHuman();
  ui.composer.classList.toggle('idle', !awaitingHuman());
}

function renderBudget() {
  const used = estimateTokens(ui.response.value);
  const over = used > tokenLimit;
  ui.tokens.textContent = `${used} / ${tokenLimit} tokens${over ? ' · will be cut off' : ''}`;
  ui.tokens.parentElement.classList.toggle('over', over);
  ui.tokenBar.style.width = `${Math.min(100, (used / tokenLimit) * 100)}%`;
  ui.send.disabled = !awaitingHuman() || ui.response.value.trim() === '';
}

function renderMetrics() {
  const metrics = sessionMetrics(state.transcript);
  const satisfaction = $('metric-satisfaction');
  satisfaction.textContent = metrics.satisfaction === null ? '—' : `${metrics.satisfaction}%`;
  satisfaction.classList.toggle('poor', metrics.satisfaction !== null && metrics.satisfaction < POOR_SATISFACTION);
  $('metric-regens').textContent = String(metrics.regenerations);
  $('metric-latency').textContent = metrics.medianLatencyMs === null ? '—' : seconds(metrics.medianLatencyMs);
  $('metric-tokens').textContent = String(metrics.tokensOut);
  $('metric-refusals').textContent = String(metrics.refusals);
  ui.sessionInfo.textContent = `Session ${state.id} · ${metrics.turns} turn${metrics.turns === 1 ? '' : 's'}`;
}

function renderVitals() {
  const snap = vitals.snapshot();
  $('vital-wpm').textContent = String(snap.wpm);
  $('mini-wpm').textContent = String(snap.wpm);
  $('vital-peak').textContent = String(snap.peak);
  $('vital-backspaces').textContent = String(snap.backspaces);
  $('metric-drafts').textContent = String(snap.draftsDeleted);
  $('vital-stretched').textContent = ago(snap.sinceOpenedMs);
  const posture = $('vital-posture');
  posture.textContent = snap.posture.label;
  posture.className = `posture ${snap.posture.tone}`;

  // Always draw every slot so the chart keeps its shape before there is any history.
  const tallest = Math.max(1, ...snap.bars);
  const offset = SPARK_SLOTS - snap.bars.length;
  const bars = Array.from({ length: SPARK_SLOTS }, (_, slot) => {
    const wpm = snap.bars[slot - offset];
    const bar = el('div', snap.liveBar && slot === SPARK_SLOTS - 1 ? 'live' : '');
    bar.style.height = wpm === undefined ? '2px' : `${Math.max(6, (wpm / tallest) * 100)}%`;
    return bar;
  });
  $('vital-spark').replaceChildren(...bars);

  const { caffeine } = snap;
  const remaining = caffeine === null ? '—' : countdown(caffeine.remainingMs);
  $('vital-caffeine').textContent = remaining;
  $('mini-caffeine').textContent = caffeine === null ? '' : `☕ ${remaining}`;
  $('vital-caffeine-bar').style.width = caffeine === null ? '0%' : `${(caffeine.remainingMs / caffeine.windowMs) * 100}%`;
  $('vital-last-cup').textContent =
    caffeine === null ? 'No cup logged' : caffeine.remainingMs === 0 ? 'Worn off' : `Last cup ${ago(caffeine.sinceMs)} ago`;
}

function renderClock() {
  const elapsed = state.promptAt === null ? 0 : Date.now() - state.promptAt;
  ui.latency.textContent = `TTFT ${stopwatch(elapsed)}`;
  ui.latency.className = `ttft${elapsed > VERY_SLOW_MS ? ' very-slow' : elapsed > SLOW_MS ? ' slow' : ''}`;
  ui.clockRemark.textContent = state.promptAt === null ? '' : clockRemark(elapsed);
}

function render() {
  const nodes = renderThread(
    { ...state, awaitingHuman: awaitingHuman() },
    { openDrafts, toggleDrafts, onRetry: requestTurn },
  );
  ui.thread.replaceChildren(...nodes);
  ui.thread.scrollTop = ui.thread.scrollHeight;
  renderStatus();
  renderBudget();
  renderMetrics();
  renderVitals();
  renderClock();
}

function toggleDrafts(index) {
  const next = new Set(openDrafts);
  if (!next.delete(index)) next.add(index);
  openDrafts = next;
  const { scrollTop } = ui.thread;
  render();
  ui.thread.scrollTop = scrollTop;
}

/** Applies the user's verdict to the latest Human-1 response, returning a new transcript. */
function applyFeedback(transcript, reply) {
  const lastIndex = transcript.length - 1;
  const last = transcript[lastIndex];
  if (!last || last.role !== 'human') return transcript;
  const judged = { ...last, rating: reply.rating, note: reply.note, rejected: reply.action === 'regenerate' };
  return [...transcript.slice(0, lastIndex), judged];
}

async function fetchTurn(transcript) {
  const res = await fetch('/api/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The user only remembers recent history; this also keeps long sessions under the server's cap.
    body: JSON.stringify({ transcript: transcript.slice(-MAX_ENTRIES_SENT) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

async function requestTurn() {
  const { token } = state;
  state = { ...state, waiting: true, error: null };
  render();
  const askedAt = Date.now();
  try {
    const reply = await fetchTurn(state.transcript);
    if (state.token !== token) return;
    state = {
      ...state,
      waiting: false,
      transcript: [
        ...applyFeedback(state.transcript, reply),
        { role: 'asker', text: reply.message, action: reply.action, composedMs: Date.now() - askedAt },
      ],
      promptAt: Date.now(),
      attempt: reply.action === 'regenerate' ? state.attempt + 1 : 1,
    };
    render();
    ui.response.focus();
  } catch (error) {
    if (state.token !== token) return;
    state = { ...state, waiting: false, error: error instanceof Error ? error.message : 'Request failed.' };
    render();
  }
}

function returnResponse(rawText, declined) {
  if (!awaitingHuman()) return;
  const text = rawText.trim();
  if (text === '') return;

  const maxChars = tokenLimit * CHARS_PER_TOKEN;
  const truncated = text.length > maxChars;
  const effort = vitals.finishResponse(text, !declined);
  const entry = {
    role: 'human',
    text: truncated ? text.slice(0, maxChars) : text,
    latencyMs: Date.now() - state.promptAt,
    truncated,
    attempt: state.attempt,
    declined,
    drafts: effort.drafts,
    backspaces: effort.backspaces,
  };
  state = { ...state, transcript: [...state.transcript, entry], promptAt: null };
  ui.response.value = '';
  requestTurn();
}

function newSession() {
  state = newState();
  openDrafts = new Set();
  vitals.resetSession();
  ui.response.value = '';
  closeDrawer();
  requestTurn();
}

function exportTranscript() {
  const blob = new Blob([transcriptText(state.transcript, state.id)], { type: 'text/plain' });
  const link = el('a');
  link.href = URL.createObjectURL(blob);
  link.download = `human-1-session-${state.id}.txt`;
  link.click();
  // Revoking in the same tick can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(link.href), REVOKE_DELAY_MS);
}

function closeDrawer() {
  ui.sidebar.classList.remove('open');
  ui.menu.setAttribute('aria-expanded', 'false');
}

ui.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  returnResponse(ui.response.value, false);
});
ui.response.addEventListener('input', () => {
  vitals.input(ui.response.value);
  renderBudget();
});
ui.response.addEventListener('keydown', (event) => {
  vitals.keydown(event.key);
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    returnResponse(ui.response.value, false);
  }
});
ui.decline.addEventListener('click', () => returnResponse(REFUSAL_TEXT, true));
ui.logCup.addEventListener('click', () => {
  vitals.logCup();
  renderVitals();
});
ui.menu.addEventListener('click', () => {
  const open = ui.sidebar.classList.toggle('open');
  ui.menu.setAttribute('aria-expanded', String(open));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
});
for (const button of document.querySelectorAll('[data-action="new-session"]')) button.addEventListener('click', newSession);
for (const button of document.querySelectorAll('[data-action="export"]')) button.addEventListener('click', exportTranscript);

async function init() {
  try {
    const config = await (await fetch('/api/config')).json();
    if (Number.isInteger(config.tokenLimit)) tokenLimit = config.tokenLimit;
    if (config.provider) ui.userBackend.textContent = `user: ${config.provider}${config.model ? ` · ${config.model}` : ''}`;
  } catch {
    // Keep the built-in defaults; they are cosmetic and the turn request will surface real outages.
  }
  ui.factLimit.textContent = String(tokenLimit);
  setInterval(() => {
    if (!document.hidden) renderClock();
  }, TICK_MS);
  setInterval(() => {
    if (!document.hidden) renderVitals();
  }, VITALS_TICK_MS);
  requestTurn();
}

init();
