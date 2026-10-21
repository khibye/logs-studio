import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { log, setLogFormat, setLogLevel } from "./log";
import {
  ENV_INHERITED,
  MAIN_ENV,
  defaultOf,
  parseEnvironments,
  rawValue,
  reloadIfChanged,
  type EnvDef,
} from "./settings";

/**
 * The effective configuration. Built from settings.ts (admin overrides →
 * environment variables → defaults) and rebuilt whenever settings change.
 *
 * There can be several *environments* (each its own Elasticsearch + Kibana).
 * Every request runs inside one of them (see withEnv / the x-env header), and
 * `config.elastic` / `config.kibana` return the current request's environment,
 * so the rest of the code reads `config.elastic.url` etc. without passing the
 * environment around.
 *
 * Environment-only (never editable from the admin panel): PORT, ADMIN_PASSWORD,
 * DATA_DIR, LOG_CONTEXT_FILE.
 */

export { MAIN_ENV };

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

function cleanContext(raw: string | undefined): string {
  const text = (raw ?? "").replace(/\\n/g, "\n").trim();
  return text.length > 6000 ? text.slice(0, 6000) : text;
}

export type Connection = "direct" | "kibana";

/** Builds one environment from a getter for its raw settings. */
function buildEnv(id: string, name: string, v: (key: string) => string | undefined) {
  const esUrl = trimSlash(v("ELASTIC_URL"));
  const kbUrl = trimSlash(v("KIBANA_URL"));
  const mode = v("ELASTIC_CONNECTION") ?? "auto";
  const connection: Connection =
    mode === "direct" ? "direct" : mode === "kibana" ? "kibana" : esUrl ? "direct" : kbUrl ? "kibana" : "direct";

  return {
    id,
    name,
    elastic: {
      /** How Elasticsearch is reached: directly, or through Kibana's console proxy. */
      connection,
      url: esUrl ?? "http://localhost:9200",
      apiKey: v("ELASTIC_API_KEY") ?? "",
      /** Index patterns the model and the dashboards may query. */
      logPatterns: list(v("LOG_INDEX_PATTERNS"), ["logs-*"]),
      timeField: v("TIME_FIELD") || "@timestamp",
      /** What the data means, in your words — given to the model in every conversation. */
      logContext: cleanContext(v("LOG_CONTEXT")),
      /** ES|QL returning deploy / change events (time + description columns). Empty = none. */
      deployQuery: (v("DEPLOY_QUERY") ?? "").trim(),
      // The next three are global (same in every environment).
      dashboardsIndex: rawValue("DASHBOARDS_INDEX") || "ai-dashboards",
      /** Hard cap on rows any query may return. */
      maxRows: Math.max(1, num(rawValue("MAX_ROWS"), 1000)),
      queryTimeoutMs: Math.max(1000, num(rawValue("QUERY_TIMEOUT_MS"), 30000)),
    },
    kibana: {
      /** Address the server uses to call Kibana (proxy, export, version check). */
      url: kbUrl,
      /** Address users' browsers use for "Open in Discover" links. Defaults to KIBANA_URL. */
      publicUrl: trimSlash(v("KIBANA_PUBLIC_URL")) || kbUrl,
      space: v("KIBANA_SPACE") || "",
      /** Kibana API key; defaults to this environment's ELASTIC_API_KEY. */
      apiKey: v("KIBANA_API_KEY") || v("ELASTIC_API_KEY") || "",
      exportEnabled: (rawValue("KIBANA_EXPORT") ?? "auto") !== "off",
    },
  };
}
export type EnvConfig = ReturnType<typeof buildEnv>;

function buildEnvs(): Map<string, EnvConfig> {
  const envs = new Map<string, EnvConfig>();
  envs.set(MAIN_ENV, buildEnv(MAIN_ENV, rawValue("ENV_NAME") || "ראשית", rawValue));
  for (const def of parseEnvironments(rawValue("ENVIRONMENTS"))) {
    if (def.id === MAIN_ENV || envs.has(def.id)) continue;
    const get = (key: string) => {
      const own = def[key as keyof EnvDef];
      if (own) return own;
      if (ENV_INHERITED.has(key)) return rawValue(key);
      return defaultOf(key);
    };
    envs.set(def.id, buildEnv(def.id, def.name, get));
  }
  return envs;
}

function buildGlobal() {
  return {
    port: Number(process.env.PORT ?? 8787),
    /** Optional "user:password" — protects the whole app with HTTP basic auth. */
    basicAuth: rawValue("APP_BASIC_AUTH") || undefined,
    /** Enables the admin panel. Environment only. */
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
    /** Environment whose Elasticsearch holds the shared dashboards library. */
    libraryEnvSetting: rawValue("LIBRARY_ENV") || MAIN_ENV,
    /** Conversations are kept in the user's browser (never on the server) for this many hours. 0 = not kept. */
    chatRetentionHours: Math.max(0, num(rawValue("CHAT_RETENTION_HOURS"), 24)),
    llm: {
      baseUrl: trimSlash(rawValue("LLM_BASE_URL")) ?? "",
      apiKey: rawValue("LLM_API_KEY") || "none",
      /** Default model. */
      model: rawValue("LLM_MODEL") ?? "",
      /** Optional allow-list of models offered in the chat. Empty = whatever the key lists. */
      models: list(rawValue("LLM_MODELS")),
      stream: (rawValue("LLM_STREAM") ?? "true") !== "false",
      maxSteps: Math.max(1, num(rawValue("LLM_MAX_STEPS"), 14)),
      temperature: num(rawValue("LLM_TEMPERATURE"), 0.2),
    },
  };
}

setLogLevel(rawValue("LOG_LEVEL"));
setLogFormat(rawValue("LOG_FORMAT"));
let G = buildGlobal();
let ENVS = buildEnvs();
const envContext = new AsyncLocalStorage<string>();

function current(): EnvConfig {
  return ENVS.get(envContext.getStore() ?? MAIN_ENV) ?? ENVS.get(MAIN_ENV)!;
}

export const config = {
  get port() {
    return G.port;
  },
  get basicAuth() {
    return G.basicAuth;
  },
  get adminPassword() {
    return G.adminPassword;
  },
  get chatRetentionHours() {
    return G.chatRetentionHours;
  },
  get llm() {
    return G.llm;
  },
  /** The current request's environment. */
  get env() {
    return current();
  },
  get elastic() {
    return current().elastic;
  },
  get kibana() {
    return current().kibana;
  },
  get environments(): EnvConfig[] {
    return [...ENVS.values()];
  },
  /** Where the shared dashboards library lives (falls back to the main environment). */
  get libraryEnv(): string {
    return ENVS.has(G.libraryEnvSetting) ? G.libraryEnvSetting : MAIN_ENV;
  },
};

export function hasEnv(id: string): boolean {
  return ENVS.has(id);
}

/** Runs `fn` (and everything it awaits) against environment `id`. */
export function withEnv<T>(id: string, fn: () => T): T {
  return envContext.run(ENVS.has(id) ? id : MAIN_ENV, fn);
}

const listeners: (() => void)[] = [];

/** Run `fn` after every configuration change (cache invalidation). */
export function onConfigChange(fn: () => void) {
  listeners.push(fn);
}

/** Recomputes the configuration after settings changed. */
export function rebuildConfig() {
  setLogLevel(rawValue("LOG_LEVEL"));
  setLogFormat(rawValue("LOG_FORMAT"));
  G = buildGlobal();
  ENVS = buildEnvs();
  log.info("config.applied", { environments: [...ENVS.keys()].join(","), logLevel: rawValue("LOG_LEVEL") ?? "info" });
  for (const fn of listeners) fn();
}

// Pick up changes written by another replica sharing the same volume.
setInterval(() => {
  if (reloadIfChanged()) {
    log.info("settings.reloaded_from_disk");
    rebuildConfig();
  }
}, 10_000).unref();

export function kibanaBase(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return config.kibana.space ? `${url}/s/${encodeURIComponent(config.kibana.space)}` : url;
}
