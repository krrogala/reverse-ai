// The Claude API, through the official SDK.

import Anthropic from '@anthropic-ai/sdk';
import { UpstreamError } from '../errors.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const TIMEOUT_MS = 90_000;
const MAX_TOKENS = 16_000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Models whose safety refusals can be re-run on a fallback model by the API itself.
const SERVER_FALLBACK_MODELS = new Set([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);
// Models that accept output_config.effort. A one-line chat message needs very little thinking.
const EFFORT_MODELS = new Set([...SERVER_FALLBACK_MODELS, 'claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-4-8']);

function buildRequest(model, prompt, system) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: prompt }],
    ...(EFFORT_MODELS.has(model) ? { output_config: { effort: 'low' } } : {}),
    ...(SERVER_FALLBACK_MODELS.has(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
  };
}

function toUpstreamError(error) {
  if (error instanceof UpstreamError) return error;
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new UpstreamError(error.message, 'bad_key');
  }
  if (error instanceof Anthropic.RateLimitError) return new UpstreamError(error.message, 'rate_limited');
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new UpstreamError(error.message, 'timeout');
  const message = error instanceof Error ? error.message : String(error);
  return new UpstreamError(message, 'failed');
}

/**
 * @param {{ model?: string, client?: Pick<Anthropic, 'beta'> }} [options]
 *   Credentials come from the environment (ANTHROPIC_API_KEY and friends) unless a client is injected.
 */
export function createAnthropicProvider({ model = DEFAULT_ANTHROPIC_MODEL, client } = {}) {
  const api = client ?? new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 1 });
  return {
    name: 'anthropic',
    model,
    async ask(prompt, system) {
      try {
        const response = await api.beta.messages.create(buildRequest(model, prompt, system));
        if (response.stop_reason === 'refusal') {
          throw new UpstreamError(`refused (${response.stop_details?.category ?? 'no category'})`, 'refused');
        }
        return response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
      } catch (error) {
        throw toUpstreamError(error);
      }
    },
  };
}
