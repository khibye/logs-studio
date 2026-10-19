import "dotenv/config";
import { readFileSync } from "node:fs";

function list(v: string | undefined, fallback: string[]): string[] {
  const items = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

/** Free-text description of the data for the model: LOG_CONTEXT, or a file named by LOG_CONTEXT_FILE. */
function logContext(): string {
  let text = process.env.LOG_CONTEXT ?? "";
  if (process.env.LOG_CONTEXT_FILE) {
    try {
      text = readFileSync(process.env.LOG_CONTEXT_FILE, "utf8");
    } catch (err: any) {
      console.warn(`LOG_CONTEXT_FILE could not be read: ${err.message}`);
    }
  }
  text = text.replace(/\\n/g, "\n").trim();
  return text.length > 6000 ? text.slice(0, 6000) : text;
}

function trimSlash(u: string | undefined): string | undefined {
  return u ? u.replace(/\/+$/, "") : undefined;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),

  /** Optional "user:password" — protects the whole app with HTTP basic auth. */
  basicAuth: process.env.APP_BASIC_AUTH || undefined,

  elastic: {
    url: trimSlash(process.env.ELASTIC_URL) ?? "http://localhost:9200",
    apiKey: process.env.ELASTIC_API_KEY ?? "",
    /** Index patterns the model and the dashboards may query. */
    logPatterns: list(process.env.LOG_INDEX_PATTERNS, ["logs-*"]),
    timeField: process.env.TIME_FIELD || "@timestamp",
    /** What the data means, in your words — given to the model in every conversation. */
    logContext: logContext(),
    dashboardsIndex: process.env.DASHBOARDS_INDEX || "ai-dashboards",
    /** Hard cap on rows any query may return. */
    maxRows: Number(process.env.MAX_ROWS ?? 1000),
    queryTimeoutMs: Number(process.env.QUERY_TIMEOUT_MS ?? 30000),
  },

  kibana: {
    /** Address the server uses to call Kibana (export, version check). */
    url: trimSlash(process.env.KIBANA_URL),
    /** Address users' browsers use for "Open in Discover" links. Defaults to KIBANA_URL. */
    publicUrl: trimSlash(process.env.KIBANA_PUBLIC_URL || process.env.KIBANA_URL),
    space: process.env.KIBANA_SPACE || "",
    /** Kibana API key; defaults to ELASTIC_API_KEY. */
    apiKey: process.env.KIBANA_API_KEY || process.env.ELASTIC_API_KEY || "",
    exportEnabled: (process.env.KIBANA_EXPORT ?? "auto") !== "off",
  },

  /** Conversations are kept in the user's browser (never on the server) for this many hours. 0 = not kept. */
  chatRetentionHours: Math.max(0, Number(process.env.CHAT_RETENTION_HOURS ?? 24)),

  llm: {
    baseUrl: trimSlash(process.env.LLM_BASE_URL) ?? "",
    apiKey: process.env.LLM_API_KEY ?? "none",
    model: process.env.LLM_MODEL ?? "",
    stream: (process.env.LLM_STREAM ?? "true") !== "false",
    maxSteps: Number(process.env.LLM_MAX_STEPS ?? 14),
    temperature: Number(process.env.LLM_TEMPERATURE ?? 0.2),
  },
};

export function kibanaBase(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return config.kibana.space ? `${url}/s/${encodeURIComponent(config.kibana.space)}` : url;
}
