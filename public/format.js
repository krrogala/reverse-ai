// Pure formatting helpers shared by the console. No DOM access, so they are unit-testable in Node.

export const CHARS_PER_TOKEN = 4;
const SLOW_RESPONSE_MS = 30_000;
const STARE_MS = 60_000;
const SNAP_MS = 3_000;
const HEAVY_BACKSPACES = 15;

export const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);
export const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
export const isSlow = (ms) => ms >= SLOW_RESPONSE_MS;

const pad2 = (value) => String(value).padStart(2, '0');

/** 62400 -> "01:02.4" */
export function stopwatch(ms) {
  const tenths = Math.floor(ms / 100);
  return `${pad2(Math.floor(tenths / 600))}:${pad2(Math.floor(tenths / 10) % 60)}.${tenths % 10}`;
}

/** 6486000 -> "1:48:06" */
export function countdown(ms) {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 3600)}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)}`;
}

/** 15120000 -> "4h 12m"; 47000 -> "47s" */
export function ago(ms) {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The handwritten remark the human leaves on their own answer, if it earned one. */
export function marginNote(entry) {
  if (entry.declined) return '';
  if (entry.truncated) return 'ran out of room';
  if (entry.latencyMs >= STARE_MS) return 'stared at this one for a minute';
  const drafts = entry.drafts?.length ?? 0;
  if (drafts >= 2) return `take ${drafts + 1}`;
  if (drafts === 0 && entry.latencyMs < SNAP_MS) return 'wrote it fast before I could doubt it';
  if ((entry.backspaces ?? 0) >= HEAVY_BACKSPACES) return 'fought the backspace key';
  return '';
}

/** What the human mutters about the clock while the user waits. */
export function clockRemark(elapsedMs) {
  if (elapsedMs >= STARE_MS) return 'they have definitely noticed';
  if (elapsedMs >= SLOW_RESPONSE_MS) return 'this is taking a while';
  return 'they’re watching the clock';
}

export function sessionMetrics(transcript) {
  const humans = transcript.filter((entry) => entry.role === 'human');
  const rated = humans.filter((entry) => entry.rating);
  const helpful = rated.filter((entry) => entry.rating === 'up').length;
  return {
    satisfaction: rated.length ? Math.round((helpful / rated.length) * 100) : null,
    regenerations: humans.filter((entry) => entry.rejected).length,
    medianLatencyMs: median(humans.map((entry) => entry.latencyMs)),
    tokensOut: humans.reduce((sum, entry) => sum + estimateTokens(entry.text), 0),
    refusals: humans.filter((entry) => entry.declined).length,
    turns: transcript.filter((entry) => entry.role === 'asker' && entry.text).length,
  };
}

function describeHuman(entry) {
  const facts = [seconds(entry.latencyMs), `${estimateTokens(entry.text)} tokens`];
  if (entry.attempt > 1) facts.push(`attempt ${entry.attempt}`);
  if (entry.declined) facts.push('declined');
  if (entry.truncated) facts.push('max tokens reached');
  if (entry.rating) facts.push(entry.rating === 'up' ? 'rated helpful' : `rated unhelpful${entry.note ? `: ${entry.note}` : ''}`);
  if (entry.rejected) facts.push('discarded');
  return facts.join(', ');
}

/** Plain-text export of the session. */
export function transcriptText(transcript, sessionId) {
  const lines = [`Human-1 console transcript, session ${sessionId}`, ''];
  for (const entry of transcript) {
    if (entry.role === 'human') {
      lines.push(`HUMAN-1 (${describeHuman(entry)}):`, entry.text, '');
      continue;
    }
    if (entry.action === 'regenerate') lines.push('[User clicked Regenerate]', '');
    if (entry.text) lines.push('USER:', entry.text, '');
  }
  return lines.join('\n');
}
