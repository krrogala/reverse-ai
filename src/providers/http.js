// Providers reached over plain HTTPS: OpenAI, OpenRouter (OpenAI-compatible) and Gemini.

import { UpstreamError, kindForStatus } from '../errors.js';

const TIMEOUT_MS = 90_000;
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Some providers echo part of a rejected key in the error body; keep anything key-shaped out of the log.
const redact = (text) => text.replace(/[A-Za-z0-9_-]{16,}/g, '[redacted]');

async function postJson(fetchImpl, url, headers, body) {
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Reading the body is covered by the same timeout, so it stays inside the try.
    text = await response.text();
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new UpstreamError(error instanceof Error ? error.message : String(error), timedOut ? 'timeout' : 'failed');
  }
  if (!response.ok) {
    throw new UpstreamError(`HTTP ${response.status}: ${redact(text.slice(0, 300))}`, kindForStatus(response.status));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError('provider returned a non-JSON body', 'failed');
  }
}

function requireText(value, provider) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UpstreamError(`${provider} returned no text`, 'failed');
  }
  return value;
}

function createChatCompletionsProvider({ name, baseUrl, apiKey, model, fetchImpl = fetch }) {
  return {
    name,
    model,
    async ask(prompt, system) {
      const data = await postJson(
        fetchImpl,
        `${baseUrl}/chat/completions`,
        { authorization: `Bearer ${apiKey}` },
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        },
      );
      return requireText(data?.choices?.[0]?.message?.content, name);
    },
  };
}

/** @param {{ apiKey: string, model: string, fetchImpl?: typeof fetch }} options */
export const createOpenAIProvider = (options) =>
  createChatCompletionsProvider({ ...options, name: 'openai', baseUrl: OPENAI_BASE_URL });

/** @param {{ apiKey: string, model: string, fetchImpl?: typeof fetch }} options */
export const createOpenRouterProvider = (options) =>
  createChatCompletionsProvider({ ...options, name: 'openrouter', baseUrl: OPENROUTER_BASE_URL });

/** @param {{ apiKey: string, model: string, fetchImpl?: typeof fetch }} options */
export function createGeminiProvider({ apiKey, model, fetchImpl = fetch }) {
  return {
    name: 'gemini',
    model,
    async ask(prompt, system) {
      const data = await postJson(
        fetchImpl,
        `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
        // The key goes in a header, never the URL, so it cannot end up in logs.
        { 'x-goog-api-key': apiKey },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        },
      );
      const parts = data?.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts) ? parts.map((part) => part?.text ?? '').join('') : '';
      return requireText(text, 'gemini');
    },
  };
}
