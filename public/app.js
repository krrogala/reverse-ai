// Human-1 console. The "user" is Claude (via the server); the model is whoever is typing.

const CHARS_PER_TOKEN = 4;
const MAX_ENTRIES_SENT = 40;
const SLOW_MS = 30_000;
const VERY_SLOW_MS = 60_000;
const REFUSAL_TEXT = "I'm sorry, but I can't help with that request.";

const $ = (id) => document.getElementById(id);
const ui = {
  thread: $('thread'),
  composer: $('composer'),
  response: $('response'),
  send: $('send'),
  decline: $('decline'),
  tokens: $('tokens'),
  latency: $('latency'),
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  newSession: $('new-session'),
  factLimit: $('fact-limit'),
  satisfaction: $('metric-satisfaction'),
  regens: $('metric-regens'),
  medianLatency: $('metric-latency'),
  tokensGenerated: $('metric-tokens'),
  refusals: $('metric-refusals'),
};

let state = newState();
let tokenLimit = 120;
let latencyTimer = null;

function newState() {
  // session guards against a slow reply landing in a session that was since reset.
  return { session: Symbol('session'), transcript: [], waiting: false, error: null, promptAt: null, attempt: 1 };
}

const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderAsker(entry) {
  const nodes = [];
  if (entry.action === 'regenerate') nodes.push(el('div', 'event', 'User clicked Regenerate'));
  if (entry.text) {
    const msg = el('div', 'msg asker');
    msg.append(el('div', 'msg-label', 'User'), el('div', 'msg-body', entry.text));
    nodes.push(msg);
  }
  return nodes;
}

function renderHuman(entry) {
  const msg = el('div', `msg human${entry.rejected ? ' rejected' : ''}`);
  const label = el('div', 'msg-label', 'Human-1');
  const attempt = entry.attempt > 1 ? ` · attempt ${entry.attempt}` : '';
  label.append(el('span', 'meta', `${seconds(entry.latencyMs)} · ${estimateTokens(entry.text)} tokens${attempt}`));

  const foot = el('div', 'msg-foot');
  if (entry.truncated) foot.append(el('span', 'chip warn', 'Stopped: max tokens reached'));
  if (entry.rating === 'up') foot.append(el('span', 'chip up', '▲ User rated: helpful'));
  if (entry.rating === 'down') {
    foot.append(el('span', 'chip down', `▼ User rated: unhelpful${entry.note ? ` — “${entry.note}”` : ''}`));
  }
  if (entry.rejected) foot.append(el('span', 'chip rejected', 'Response discarded'));

  msg.append(label, el('div', 'msg-body', entry.text));
  if (foot.childElementCount > 0) msg.append(foot);
  return [msg];
}

function renderError(message) {
  const box = el('div', 'event error');
  const retry = el('button', 'btn', 'Retry');
  retry.type = 'button';
  retry.addEventListener('click', requestTurn);
  box.append(el('span', '', message), retry);
  return box;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function renderMetrics() {
  const humans = state.transcript.filter((entry) => entry.role === 'human');
  const rated = humans.filter((entry) => entry.rating);
  const ups = rated.filter((entry) => entry.rating === 'up').length;
  const mid = median(humans.map((entry) => entry.latencyMs));

  ui.satisfaction.textContent = rated.length ? `${Math.round((ups / rated.length) * 100)}%` : '—';
  ui.regens.textContent = String(humans.filter((entry) => entry.rejected).length);
  ui.medianLatency.textContent = mid === null ? '—' : seconds(mid);
  ui.tokensGenerated.textContent = String(humans.reduce((sum, entry) => sum + estimateTokens(entry.text), 0));
  ui.refusals.textContent = String(humans.filter((entry) => entry.declined).length);
}

function renderStatus() {
  const awaitingModel = !state.waiting && !state.error && state.promptAt !== null;
  const [dot, text] = state.error
    ? ['err', 'User disconnected']
    : state.waiting
      ? ['busy', 'User is typing…']
      : awaitingModel
        ? ['ok', state.attempt > 1 ? `Regenerating response (attempt ${state.attempt})` : 'Awaiting model output']
        : ['', 'Idle'];
  ui.statusDot.className = `dot ${dot}`;
  ui.statusText.textContent = text;

  ui.response.disabled = !awaitingModel;
  ui.decline.disabled = !awaitingModel;
}

function renderTokens() {
  const used = estimateTokens(ui.response.value);
  const over = used > tokenLimit;
  ui.tokens.textContent = `${used} / ${tokenLimit} tokens${over ? ' — output will be truncated' : ''}`;
  ui.tokens.classList.toggle('over', over);
  ui.send.disabled = ui.response.disabled || ui.response.value.trim() === '';
}

function render() {
  const nodes = state.transcript.flatMap((entry) => (entry.role === 'asker' ? renderAsker(entry) : renderHuman(entry)));
  if (state.error) nodes.push(renderError(state.error));
  ui.thread.replaceChildren(...nodes);
  ui.thread.scrollTop = ui.thread.scrollHeight;
  renderMetrics();
  renderStatus();
  renderTokens();
}

function tickLatency() {
  if (state.promptAt === null) {
    ui.latency.textContent = '';
    ui.latency.className = 'latency';
    return;
  }
  const elapsed = Date.now() - state.promptAt;
  ui.latency.textContent = `Time to first token: ${seconds(elapsed)}`;
  ui.latency.className = `latency${elapsed > VERY_SLOW_MS ? ' very-slow' : elapsed > SLOW_MS ? ' slow' : ''}`;
}

function startLatencyClock() {
  clearInterval(latencyTimer);
  latencyTimer = setInterval(tickLatency, 100);
  tickLatency();
}

function stopLatencyClock() {
  clearInterval(latencyTimer);
  latencyTimer = null;
  tickLatency();
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
  const session = state.session;
  state = { ...state, waiting: true, error: null };
  render();
  try {
    const reply = await fetchTurn(state.transcript);
    if (state.session !== session) return;
    const regenerating = reply.action === 'regenerate';
    state = {
      ...state,
      waiting: false,
      transcript: [
        ...applyFeedback(state.transcript, reply),
        { role: 'asker', text: reply.message, action: reply.action },
      ],
      promptAt: Date.now(),
      attempt: regenerating ? state.attempt + 1 : 1,
    };
    render();
    startLatencyClock();
    ui.response.focus();
  } catch (error) {
    if (state.session !== session) return;
    state = { ...state, waiting: false, error: error instanceof Error ? error.message : 'Request failed.' };
    render();
  }
}

function returnResponse(rawText, declined) {
  if (state.waiting || state.promptAt === null) return;
  const text = rawText.trim();
  if (text === '') return;

  const maxChars = tokenLimit * CHARS_PER_TOKEN;
  const truncated = text.length > maxChars;
  const entry = {
    role: 'human',
    text: truncated ? text.slice(0, maxChars) : text,
    latencyMs: Date.now() - state.promptAt,
    truncated,
    attempt: state.attempt,
    declined,
  };
  state = { ...state, transcript: [...state.transcript, entry], promptAt: null };
  ui.response.value = '';
  stopLatencyClock();
  requestTurn();
}

ui.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  returnResponse(ui.response.value, false);
});
ui.response.addEventListener('input', renderTokens);
ui.response.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    returnResponse(ui.response.value, false);
  }
});
ui.decline.addEventListener('click', () => returnResponse(REFUSAL_TEXT, true));
ui.newSession.addEventListener('click', () => {
  state = newState();
  ui.response.value = '';
  stopLatencyClock();
  requestTurn();
});

async function init() {
  try {
    const config = await (await fetch('/api/config')).json();
    if (Number.isInteger(config.tokenLimit)) tokenLimit = config.tokenLimit;
  } catch {
    // Keep the built-in default; the limit is cosmetic and the turn request will surface real outages.
  }
  ui.factLimit.textContent = String(tokenLimit);
  requestTurn();
}

init();
