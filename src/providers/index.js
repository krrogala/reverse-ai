// Picks which model plays the "user", from environment variables.

import { runClaude } from '../claude.js';
import { DEFAULT_ANTHROPIC_MODEL, createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider, createOpenAIProvider, createOpenRouterProvider } from './http.js';

const DEFAULT_PROVIDER = 'claude-cli';
const DEFAULT_CLI_MODEL = 'sonnet';
const MODEL_PATTERN = /^[\w.:/][\w.:/-]*$/;

function required(env, name, provider) {
  const value = env[name];
  if (!value) throw new Error(`REVERSE_AI_PROVIDER=${provider} needs ${name} to be set.`);
  return value;
}

// Each factory validates its own configuration so a bad setup fails at startup, not on the first turn.
const FACTORIES = {
  'claude-cli': (env) => {
    const model = env.REVERSE_AI_MODEL || DEFAULT_CLI_MODEL;
    const bin = env.CLAUDE_BIN || 'claude';
    return { name: 'claude-cli', model, ask: (prompt, system) => runClaude({ prompt, system, bin, model }) };
  },
  anthropic: (env) => createAnthropicProvider({ model: env.REVERSE_AI_MODEL || DEFAULT_ANTHROPIC_MODEL }),
  openai: (env) =>
    createOpenAIProvider({
      apiKey: required(env, 'OPENAI_API_KEY', 'openai'),
      model: required(env, 'REVERSE_AI_MODEL', 'openai'),
    }),
  gemini: (env) =>
    createGeminiProvider({
      apiKey: required(env, 'GEMINI_API_KEY', 'gemini'),
      model: required(env, 'REVERSE_AI_MODEL', 'gemini'),
    }),
  openrouter: (env) =>
    createOpenRouterProvider({
      apiKey: required(env, 'OPENROUTER_API_KEY', 'openrouter'),
      model: required(env, 'REVERSE_AI_MODEL', 'openrouter'),
    }),
};

export const PROVIDER_NAMES = Object.keys(FACTORIES);

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ name: string, model: string, ask: (prompt: string, system: string) => Promise<string> }}
 */
export function createProvider(env) {
  const name = env.REVERSE_AI_PROVIDER || DEFAULT_PROVIDER;
  if (!Object.hasOwn(FACTORIES, name)) {
    throw new Error(`Unknown REVERSE_AI_PROVIDER "${name}". Use one of: ${PROVIDER_NAMES.join(', ')}.`);
  }
  // The model name ends up in a URL path or a command line, so keep it to a plain identifier.
  if (env.REVERSE_AI_MODEL && !MODEL_PATTERN.test(env.REVERSE_AI_MODEL)) {
    throw new Error('REVERSE_AI_MODEL may only contain letters, digits and . _ : / - and must not start with "-".');
  }
  return FACTORIES[name](env);
}
