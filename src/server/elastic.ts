import { config } from "./config";
import { TIME_RANGES, type QueryResult, type TimeRangeKey } from "../shared/recipe";

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

function esReason(body: any, status: number): string {
  // Kibana's own errors (console proxy): { statusCode, error, message }
  if (typeof body?.statusCode === "number" && typeof body?.message === "string") return body.message;
  const e = body?.error;
  if (typeof e === "string") return e;
  if (e?.reason) {
    const cause = e.caused_by?.reason ? ` (${e.caused_by.reason})` : "";
    return `${e.type ? e.type + ": " : ""}${e.reason}${cause}`;
  }
  if (e?.root_cause?.[0]?.reason) return e.root_cause[0].reason;
  return `Elasticsearch returned HTTP ${status}`;
}

/** A response produced by Kibana itself, not forwarded from Elasticsearch. */
function isKibanaError(body: any): boolean {
  return typeof body?.statusCode === "number" && typeof body?.message === "string" && !body?.error?.type;
}

/**
 * Thin fetch wrapper around the Elasticsearch REST API, authenticated with the API key.
 *
 * In "kibana" mode (only a Kibana address is available) every call goes through
 * Kibana's console proxy — the same endpoint Dev Tools uses:
 *   POST <kibana>/api/console/proxy?path=<es path>&method=<METHOD>
 * The API key then also needs the Dev Tools privilege in Kibana.
 */
export async function es<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal; allow404?: boolean } = {},
): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const viaKibana = config.elastic.connection === "kibana";
  const timeout = AbortSignal.timeout(config.elastic.queryTimeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let url: string;
  let headers: Record<string, string>;
  let target: string;
  if (viaKibana) {
    if (!config.kibana.url) throw new HttpError(500, "Connection is set to go through Kibana, but KIBANA_URL is not set");
    const apiKey = config.elastic.apiKey || config.kibana.apiKey;
    url = `${config.kibana.url}/api/console/proxy?path=${encodeURIComponent(path.replace(/^\//, ""))}&method=${method}`;
    headers = {
      Authorization: `ApiKey ${apiKey}`,
      "Content-Type": "application/json",
      "kbn-xsrf": "true",
      "x-elastic-internal-origin": "Kibana",
    };
    target = `Kibana at ${config.kibana.url}`;
  } else {
    url = config.elastic.url + path;
    headers = { Authorization: `ApiKey ${config.elastic.apiKey}`, "Content-Type": "application/json" };
    target = `Elasticsearch at ${config.elastic.url}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: viaKibana ? "POST" : method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal,
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError") throw new HttpError(504, `${viaKibana ? "Kibana" : "Elasticsearch"} did not answer in time`);
    if (err?.name === "AbortError") throw new HttpError(499, "Request cancelled");
    throw new HttpError(502, `Cannot reach ${target}: ${err?.cause?.code ?? err?.message}`);
  }
  const text = await res.text();
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  // Some Kibana versions report the upstream status in a header.
  const status = Number(res.headers.get("x-console-proxy-status-code")) || res.status;
  if (status >= 400) {
    if (status === 404 && opts.allow404 && !(viaKibana && isKibanaError(body))) return body as T;
    let msg = esReason(body, status);
    if (viaKibana && isKibanaError(body)) {
      if (status === 401) msg = `Kibana rejected the API key (401): ${msg}`;
      else if (status === 403)
        msg = `Kibana refused the console proxy (403): ${msg}. The API key needs the Dev Tools privilege in Kibana.`;
      else if (status === 404) msg = `Kibana console proxy not found (404) at ${config.kibana.url}: ${msg}`;
    }
    throw new HttpError(status, msg, body);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// ES|QL guardrails. The API key's own privileges are the real boundary; these
// checks keep the model (and anyone using the app) inside the intended indices
// and stop a single query from pulling huge result sets.
// ---------------------------------------------------------------------------

function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

function sourceAllowed(source: string): boolean {
  let s = source.trim().replace(/^"(.*)"$/, "$1").replace(/^`(.*)`$/, "$1");
  if (s.startsWith("-")) return true; // exclusions only narrow the selection
  if (!s || s.startsWith(".")) return false;
  return config.elastic.logPatterns.some((p) => globToRegex(p).test(s));
}

function stripComments(q: string): string {
  return q.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

export function guardEsql(raw: string): string {
  const query = raw.trim().replace(/;+\s*$/, "");
  if (!query) throw new HttpError(400, "Empty query");
  if (query.length > 4000) throw new HttpError(400, "Query is too long (max 4000 characters)");
  const clean = stripComments(query).trim();

  const first = clean.split("|")[0].trim();
  const m = /^FROM\s+([\s\S]+?)(?:\s+METADATA\s+[\s\S]*)?$/i.exec(first);
  if (!m) throw new HttpError(400, "Only queries that start with FROM are allowed");
  const sources = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  const blocked = sources.filter((s) => !sourceAllowed(s));
  if (blocked.length)
    throw new HttpError(
      400,
      `Index pattern not allowed: ${blocked.join(", ")}. Allowed: ${config.elastic.logPatterns.join(", ")}`,
    );

  for (const j of clean.matchAll(/\bLOOKUP\s+JOIN\s+([^\s|]+)/gi)) {
    if (!sourceAllowed(j[1])) throw new HttpError(400, `LOOKUP JOIN on ${j[1]} is not allowed`);
  }

  const max = config.elastic.maxRows;
  const commands = clean.split("|").map((c) => c.trim());
  const last = commands[commands.length - 1];
  const lim = /^LIMIT\s+(\d+)$/i.exec(last);
  if (lim && Number(lim[1]) <= max) return query;
  return `${query}\n| LIMIT ${max}`;
}

function rangeFilter(range: TimeRangeKey) {
  const from = TIME_RANGES[range]?.from ?? "now-24h";
  return { range: { [config.elastic.timeField]: { gte: from, lte: "now" } } };
}

const DURATION_MS: Record<TimeRangeKey, number> = {
  "15m": 15 * 60e3,
  "1h": 60 * 60e3,
  "12h": 12 * 3600e3,
  "24h": 24 * 3600e3,
  "7d": 7 * 86400e3,
  "30d": 30 * 86400e3,
};

/**
 * Runs a guarded ES|QL query. The dashboard's time range is applied as a DSL
 * filter, so queries never hard-code dates. Queries may also use the same
 * ?_tstart / ?_tend parameters Kibana uses, e.g. BUCKET(@timestamp, 50, ?_tstart, ?_tend).
 */
export async function runEsql(
  query: string,
  range: TimeRangeKey,
  opts: { signal?: AbortSignal; maxRows?: number } = {},
): Promise<QueryResult> {
  let guarded = guardEsql(query);
  if (opts.maxRows && opts.maxRows < config.elastic.maxRows) guarded += `\n| LIMIT ${opts.maxRows}`;

  const body: any = { query: guarded, filter: rangeFilter(range) };
  if (/\?_tstart|\?_tend/.test(guarded)) {
    const end = Date.now();
    const start = end - (DURATION_MS[range] ?? DURATION_MS["24h"]);
    body.params = [{ _tstart: new Date(start).toISOString() }, { _tend: new Date(end).toISOString() }];
  }
  const t0 = Date.now();
  const res = await es<{ columns: { name: string; type: string }[]; values: unknown[][]; took?: number }>(
    "/_query?format=json",
    { body, signal: opts.signal },
  );
  return {
    columns: res.columns ?? [],
    values: res.values ?? [],
    took: res.took ?? Date.now() - t0,
    truncated: (res.values?.length ?? 0) >= config.elastic.maxRows,
  };
}
