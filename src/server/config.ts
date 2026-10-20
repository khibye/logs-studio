import "dotenv/config";
import { rawValue, reloadIfChanged } from "./settings";

/**
 * The effective configuration. Built from settings.ts (admin overrides →
 * environment → defaults) and rebuilt in place whenever settings change, so
 * every module reads current values through `config.x.y` at call time.
 *
 * Environment-only (never editable from the admin panel): PORT, ADMIN_PASSWORD,
 * DATA_DIR, LOG_CONTEXT_FILE.
 */

function list(v: string | undefined, fallback: string[] = []): string[] {
  const items = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : fallback;
}

function trimSlash(u: string | undefined): string | undefined {
  return u ? u.replace(/\/+$/, "") : undefined;
}

function logContext(): string {
  const text = (rawValue("LOG_CONTEXT") ?? "").replace(/\\n/g, "\n").trim();
  return text.length > 6000 ? text.slice(0, 6000) : text;
}

export type Connection = "direct" | "kibana";

function build() {
  const v = rawValue;
  const esUrl = trimSlash(v("ELASTIC_URL"));
  const kbUrl = trimSlash(v("KIBANA_URL"));
  const mode = v("ELASTIC_CONNECTION") ?? "auto";
  const connection: Connection =
    mode === "direct" ? "direct" : mode === "kibana" ? "kibana" : esUrl ? "direct" : kbUrl ? "kibana" : "direct";

  return {
    port: Number(process.env.PORT ?? 8787),

    /** Optional "user:password" — protects the whole app with HTTP basic auth. */
    basicAuth: v("APP_BASIC_AUTH") || undefined,

    /** Enables the admin panel. Environment only. */
    adminPassword: process.env.ADMIN_PASSWORD || undefined,

    elastic: {
      /** How Elasticsearch is reached: directly, or through Kibana's console proxy. */
      connection,
      url: esUrl ?? "http://localhost:9200",
      apiKey: v("ELASTIC_API_KEY") ?? "",
      /** Index patterns the model and the dashboards may query. */
      logPatterns: list(v("LOG_INDEX_PATTERNS"), ["logs-*"]),
      timeField: v("TIME_FIELD") || "@timestamp",
      /** What the data means, in your words — given to the model in every conversation. */
      logContext: logContext(),
      dashboardsIndex: v("DASHBOARDS_INDEX") || "ai-dashboards",
      /** Hard cap on rows any query may return. */
      maxRows: Math.max(1, num(v("MAX_ROWS"), 1000)),
      queryTimeoutMs: Math.max(1000, num(v("QUERY_TIMEOUT_MS"), 30000)),
    },

    kibana: {
      /** Address the server uses to call Kibana (proxy, export, version check). */
      url: kbUrl,
      /** Address users' browsers use for "Open in Discover" links. Defaults to KIBANA_URL. */
      publicUrl: trimSlash(v("KIBANA_PUBLIC_URL")) || kbUrl,
      space: v("KIBANA_SPACE") || "",
      /** Kibana API key; defaults to ELASTIC_API_KEY. */
      apiKey: v("KIBANA_API_KEY") || v("ELASTIC_API_KEY") || "",
      exportEnabled: (v("KIBANA_EXPORT") ?? "auto") !== "off",
    },

    /** Conversations are kept in the user's browser (never on the server) for this many hours. 0 = not kept. */
    chatRetentionHours: Math.max(0, num(v("CHAT_RETENTION_HOURS"), 24)),

    llm: {
      baseUrl: trimSlash(v("LLM_BASE_URL")) ?? "",
      apiKey: v("LLM_API_KEY") || "none",
      /** Default model. */
      model: v("LLM_MODEL") ?? "",
      /** Optional allow-list of models offered in the chat. Empty = whatever the key lists. */
      models: list(v("LLM_MODELS")),
      stream: (v("LLM_STREAM") ?? "true") !== "false",
      maxSteps: Math.max(1, num(v("LLM_MAX_STEPS"), 14)),
      temperature: num(v("LLM_TEMPERATURE"), 0.2),
    },
  };
}

export type Config = ReturnType<typeof build>;
export const config: Config = build();

const listeners: (() => void)[] = [];

/** Run `fn` after every configuration change (cache invalidation). */
export function onConfigChange(fn: () => void) {
  listeners.push(fn);
}

/** Recomputes the configuration in place after settings changed. */
export function rebuildConfig() {
  Object.assign(config, build());
  for (const fn of listeners) fn();
}

// Pick up changes written by another replica sharing the same volume.
setInterval(() => {
  if (reloadIfChanged()) rebuildConfig();
}, 10_000).unref();

export function kibanaBase(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return config.kibana.space ? `${url}/s/${encodeURIComponent(config.kibana.space)}` : url;
}
