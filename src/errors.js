/**
 * A failure talking to whichever model plays the "user". `kind` drives the hint
 * shown in the console; the message itself stays in the server log.
 *
 * @typedef {'not_installed' | 'not_signed_in' | 'bad_key' | 'rate_limited' | 'refused' | 'timeout' | 'failed'} UpstreamKind
 */
export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {UpstreamKind} kind
   */
  constructor(message, kind) {
    super(message);
    this.name = 'UpstreamError';
    this.kind = kind;
  }
}

/** Maps an HTTP status from a provider API to an UpstreamKind. */
export function kindForStatus(status) {
  if (status === 401 || status === 403) return 'bad_key';
  if (status === 429) return 'rate_limited';
  return 'failed';
}
