import OpenAI from "openai";
import { config, onConfigChange } from "./config";
import { HttpError } from "./elastic";
import type { ModelsInfo } from "../shared/recipe";

/** A client for the current settings (cheap to create; settings can change at runtime). */
export function llmClient(): OpenAI {
  if (!config.llm.baseUrl) throw new HttpError(500, "LLM_BASE_URL is not set");
  return new OpenAI({ baseURL: config.llm.baseUrl, apiKey: config.llm.apiKey, timeout: 120_000 });
}

/** Models that can't chat — hidden from the picker unless listed explicitly in LLM_MODELS. */
const NOT_CHAT = /(embed|whisper|tts|dall-e|image|moderation|rerank|transcri|speech|audio|realtime)/i;

let cache: { at: number; value: ModelsInfo } | null = null;
const TTL_MS = 5 * 60_000;
onConfigChange(() => {
  cache = null;
});

/**
 * Models offered in the chat:
 *  - LLM_MODELS set → exactly that list (works even if the server has no /models endpoint)
 *  - otherwise → GET <LLM_BASE_URL>/models with the key, minus non-chat models
 * The default model (LLM_MODEL) is always first.
 */
export async function listModels(force = false): Promise<ModelsInfo> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const def = config.llm.model;
  let models: string[] = [];
  let error: string | undefined;

  if (config.llm.models.length) {
    models = [...config.llm.models];
  } else if (config.llm.baseUrl) {
    try {
      const ids: string[] = [];
      for await (const m of llmClient().models.list({ timeout: 15_000 })) {
        if (m?.id) ids.push(m.id);
        if (ids.length >= 500) break;
      }
      models = ids.filter((id) => !NOT_CHAT.test(id)).sort((a, b) => a.localeCompare(b));
    } catch (err: any) {
      error = `Could not list models: ${err?.status ? `HTTP ${err.status} ` : ""}${err?.message ?? err}`;
    }
  }

  if (def) models = [def, ...models.filter((m) => m !== def)];
  const value: ModelsInfo = { models, default: def || models[0] || "", error };
  // Don't keep a failure for long — the endpoint may come back.
  cache = { at: error ? Date.now() - TTL_MS + 30_000 : Date.now(), value };
  return value;
}

/** Validates a model requested by the browser; falls back to the default. */
export async function resolveModel(requested: string | undefined): Promise<string> {
  const def = config.llm.model;
  if (!requested || requested === def) {
    if (def) return def;
    const { models } = await listModels();
    if (models[0]) return models[0];
    throw new HttpError(500, "No model configured: set LLM_MODEL");
  }
  const { models } = await listModels();
  if (!models.includes(requested)) throw new HttpError(400, `Model "${requested}" is not available`);
  return requested;
}
