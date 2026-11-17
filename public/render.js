// Builds the conversation thread. Everything user- or model-supplied goes in via textContent.

import { estimateTokens, isSlow, marginNote, seconds } from './format.js';

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const icon = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function renderDivider(waiting) {
  const row = el('div', 'divider');
  row.append(icon('tpl-regen'), el('span', '', `User clicked Regenerate${waiting ? ' · waiting on you' : ''}`));
  return row;
}

function renderAsker(entry, waitingOnHuman) {
  const nodes = [];
  if (entry.action === 'regenerate') nodes.push(renderDivider(waitingOnHuman && !entry.text));
  if (!entry.text) return nodes;

  const meta = el('div', 'asker-meta');
  if (entry.composedMs) meta.append(el('span', 'mono', `composed in ${seconds(entry.composedMs)}`));
  meta.append(el('b', '', 'USER'), icon('tpl-user'));
  const row = el('div', 'asker');
  row.append(meta, el('div', 'bubble', entry.text));
  nodes.push(row);
  return nodes;
}

function renderMeta(entry) {
  const meta = el('div', 'human-meta');
  meta.append(el('b', '', 'HUMAN-1'), ' · ', el('span', isSlow(entry.latencyMs) ? 'slow' : '', seconds(entry.latencyMs)));
  meta.append(` · ${plural(estimateTokens(entry.text), 'token')}`);
  if (entry.attempt > 1) meta.append(` · attempt ${entry.attempt}`);
  if (entry.declined) meta.append(' · ', el('span', 'declined', 'declined'));
  return meta;
}

function renderNote(entry, index, ui) {
  const note = el('div', `note${entry.rejected ? ' discarded' : ''}`);
  const drafts = entry.drafts ?? [];
  const showDrafts = ui.openDrafts.has(index);
  if (showDrafts) note.append(...drafts.map((draft) => el('p', 'draft', draft)));
  note.append(el('p', '', entry.text));
  if (entry.truncated) note.append(el('div', 'cutoff', '[stopped: max tokens reached]'));

  const remark = entry.rejected ? '' : marginNote(entry);
  // The remark sits inside the note when there is a footer for it, and in the margin otherwise.
  if (drafts.length > 0) {
    const foot = el('div', 'note-foot');
    const toggle = el('button', '', `${showDrafts ? 'Hide' : 'Show'} ${plural(drafts.length, 'deleted draft')}`);
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(showDrafts));
    toggle.addEventListener('click', () => ui.toggleDrafts(index));
    foot.append(toggle);
    if (remark) foot.append(el('span', 'hand', remark));
    note.append(foot);
  }
  if (entry.rating === 'up') note.append(el('span', 'stamp helpful', 'HELPFUL'));
  return { note, marginRemark: drafts.length > 0 ? '' : remark };
}

function renderVerdict(entry) {
  if (entry.rating !== 'down' && !entry.rejected) return null;
  const row = el('div', 'verdict');
  if (entry.rating === 'down') {
    row.append(el('span', 'stamp unhelpful', 'UNHELPFUL'));
    if (entry.note) row.append(el('span', 'hand', `“${entry.note.toLowerCase()}”`));
  }
  if (entry.rejected) row.append(el('span', 'aside', `response discarded`));
  return row;
}

function renderHuman(entry, index, ui) {
  const logo = icon('tpl-logo');
  if (entry.rejected) logo.classList.add('dim');
  const { note, marginRemark } = renderNote(entry, index, ui);
  const noteRow = el('div', 'note-row');
  noteRow.append(note);
  if (marginRemark) noteRow.append(el('span', 'margin-note', `← ${marginRemark}`));

  const body = el('div', 'human-body');
  body.append(renderMeta(entry), noteRow);
  const verdict = renderVerdict(entry);
  if (verdict) body.append(verdict);

  const row = el('div', `human${ui.humanCount++ % 2 ? ' alt' : ''}`);
  row.append(logo, body);
  return [row];
}

function renderTyping() {
  const meta = el('div', 'asker-meta');
  meta.append(el('b', '', 'USER'), icon('tpl-user'));
  const bubble = el('div', 'bubble typing');
  bubble.setAttribute('role', 'status');
  bubble.setAttribute('aria-label', 'User is typing');
  bubble.append(el('i'), el('i'), el('i'));
  const row = el('div', 'asker');
  row.append(meta, bubble);
  return row;
}

function renderFault(message, onRetry) {
  const box = el('div', 'fault');
  box.setAttribute('role', 'alert');
  const retry = el('button', 'btn', 'Retry');
  retry.type = 'button';
  retry.addEventListener('click', onRetry);
  box.append(el('span', '', message), retry);
  return box;
}

/**
 * @param {{ transcript: object[], waiting: boolean, error: string | null, awaitingHuman: boolean }} state
 * @param {{ openDrafts: Set<number>, toggleDrafts: (index: number) => void, onRetry: () => void }} handlers
 */
export function renderThread(state, handlers) {
  const ui = { ...handlers, humanCount: 0 };
  const last = state.transcript.length - 1;
  const nodes = state.transcript.flatMap((entry, index) =>
    entry.role === 'asker' ? renderAsker(entry, state.awaitingHuman && index === last) : renderHuman(entry, index, ui),
  );
  if (state.waiting) nodes.push(renderTyping());
  if (state.error) nodes.push(renderFault(state.error, handlers.onRetry));
  return nodes;
}
