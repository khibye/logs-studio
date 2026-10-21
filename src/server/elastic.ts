import { config } from "./config";
import { log } from "./log";
import { TIME_RANGES, compareShiftMs, type Annotation, type Compare, type QueryResult, type TimeRangeKey } from "../shared/recipe";

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

/** Not an Elasticsearch / Kibana JSON error: an HTML or empty page from something in between. */
function isGatewayPage(body: any): boolean {
  return typeof body !== "object" || body === null || (!body.error && typeof body.statusCode !== "number");
}

/** Readable text from an HTML / plain error page, for the log. */
function snippet(body: unknown): string | undefined {
  if (typeof body !== "string" || !body.trim()) return undefined;
  return body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
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
  const t0 = Date.now();
  const what = `${method} ${path.split("?")[0]}`;
  try {
    res = await fetch(url, {
      method: viaKibana ? "POST" : method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal,
    });
  } catch (err: any) {
    const ms = Date.now() - t0;
    if (err?.name === "TimeoutError") {
      log.warn("es.timeout", { call: what, via: viaKibana ? "kibana" : "direct", ms, timeoutMs: config.elastic.queryTimeoutMs });
      throw new HttpError(504, `${viaKibana ? "Kibana" : "Elasticsearch"} did not answer in time`);
    }
    if (err?.name === "AbortError") {
      log.debug("es.cancelled", { call: what, ms });
      throw new HttpError(499, "Request cancelled");
    }
    log.warn("es.unreachable", { call: what, target, error: err?.cause?.code ?? err?.message, ms });
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
  const ms = Date.now() - t0;
  // 502/503/504 as an HTML or empty page: a load balancer / ingress / proxy between the app and
  // Elasticsearch gave up (usually its own time limit), not Elasticsearch itself.
  const gateway = status >= 502 && status <= 504 && isGatewayPage(body);
  if (status >= 400 && !(status === 404 && opts.allow404)) {
    log.warn("es.error", {
      call: what,
      via: viaKibana ? "kibana" : "direct",
      status,
      ms,
      error: gateway ? undefined : esReason(body, status),
      gateway: gateway || undefined,
      server: gateway ? res.headers.get("server") ?? undefined : undefined,
      page: gateway ? snippet(body) : undefined,
    });
  } else {
    log.debug("es.call", { call: what, via: viaKibana ? "kibana" : "direct", status, ms, bytes: text.length });
  }
  if (status >= 400) {
    if (status === 404 && opts.allow404 && !(viaKibana && isKibanaError(body))) return body as T;
    let msg = esReason(body, status);
    if (gateway) {
      const secs = Math.round(ms / 1000);
      const via = viaKibana ? "Kibana" : "Elasticsearch";
      msg =
        status === 504
          ? `Gateway timeout (HTTP 504) after ${secs}s: a proxy or load balancer in front of ${via} stopped waiting. ` +
            `The query is probably heavier than that proxy's time limit: try a shorter time range or a lighter query.`
          : `HTTP ${status} from a proxy or load balancer in front of ${via} (after ${secs}s), not from ${via} itself.`;
    } else if (viaKibana && isKibanaError(body)) {
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

export function guardEsql(raw: string, opts: { trusted?: boolean } = {}): string {
  const query = raw.trim().replace(/;+\s*$/, "");
  if (!query) throw new HttpError(400, "Empty query");
  if (query.length > 4000) throw new HttpError(400, "Query is too long (max 4000 characters)");
  const clean = stripComments(query).trim();

  const first = clean.split("|")[0].trim();
  const m = /^FROM\s+([\s\S]+?)(?:\s+METADATA\s+[\s\S]*)?$/i.exec(first);
  if (!m) throw new HttpError(400, "Only queries that start with FROM are allowed");
  // Admin-written queries (e.g. the deploy events query) may read indices outside LOG_INDEX_PATTERNS.
  if (!opts.trusted) {
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
  }

  const max = config.elastic.maxRows;
  const commands = clean.split("|").map((c) => c.trim());
  const last = commands[commands.length - 1];
  const lim = /^LIMIT\s+(\d+)$/i.exec(last);
  if (lim && Number(lim[1]) <= max) return query;
  return `${query}\n| LIMIT ${max}`;
}

const MAX_WINDOW_MS = 400 * 86400e3;

/** The absolute time window a query runs on. */
export function queryWindow(
  range: TimeRangeKey,
  opts: { compare?: Compare; window?: { from: number; to: number } } = {},
): { start: number; end: number } {
  if (opts.window) {
    const { from, to } = opts.window;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_WINDOW_MS)
      throw new HttpError(400, "Invalid time window");
    return { start: from, end: to };
  }
  const dur = TIME_RANGES[range]?.ms ?? TIME_RANGES["24h"].ms;
  const end = Date.now() - (opts.compare ? compareShiftMs(range, opts.compare) : 0);
  return { start: end - dur, end };
}

type EsqlResponse = {
  columns: { name: string; type: string }[];
  values: unknown[][];
  took?: number;
  id?: string;
  is_running?: boolean;
};

/** Environments whose Elasticsearch has no async ES|QL endpoint (before 8.13): sync only. */
const asyncUnsupported = new Set<string>();
const POLL_MS = 5000;

function asyncMissing(err: unknown): boolean {
  return (
    err instanceof HttpError &&
    [400, 404, 405].includes(err.status) &&
    /no handler found|unrecognized|request \[\/?_query\/async/i.test(err.message)
  );
}

/** Frees (or, if still running, cancels) an async query. Best effort. */
function dropAsync(id: string) {
  es(`/_query/async/${encodeURIComponent(id)}`, { method: "DELETE", allow404: true }).catch((err) =>
    log.debug("esql.async_delete_failed", { error: err?.message }),
  );
}

/**
 * Runs ES|QL asynchronously: submit, then poll every few seconds. Each HTTP call is short, so a
 * long query never trips the time limit of Kibana's console proxy or of a gateway / ingress in
 * front of Elasticsearch (those answer HTTP 504). QUERY_TIMEOUT_MS bounds the whole query.
 * Falls back to the plain synchronous endpoint when the cluster has no async ES|QL.
 */
async function esqlCall(body: Record<string, unknown>, signal?: AbortSignal): Promise<EsqlResponse> {
  const envId = config.env.id;
  if (!config.elastic.esqlAsync || asyncUnsupported.has(envId)) {
    return es<EsqlResponse>("/_query?format=json", { body, signal });
  }
  const t0 = Date.now();
  const deadline = t0 + config.elastic.queryTimeoutMs;
  const wait = () => `${Math.max(1, Math.min(POLL_MS, deadline - Date.now()) / 1000).toFixed(0)}s`;

  let res: EsqlResponse;
  try {
    res = await es<EsqlResponse>("/_query/async?format=json", {
      body: { ...body, wait_for_completion_timeout: wait(), keep_alive: "5m" },
      signal,
    });
  } catch (err) {
    if (!asyncMissing(err)) throw err;
    asyncUnsupported.add(envId);
    log.info("esql.async_unsupported", { error: (err as Error).message });
    return es<EsqlResponse>("/_query?format=json", { body, signal });
  }
  if (!res.is_running) {
    if (res.id) dropAsync(res.id);
    return res;
  }

  const id = res.id!;
  let polls = 0;
  try {
    for (;;) {
      if (Date.now() >= deadline) {
        log.warn("esql.timeout", { ms: Date.now() - t0, polls, timeoutMs: config.elastic.queryTimeoutMs });
        throw new HttpError(
          504,
          `The query did not finish within ${Math.round(config.elastic.queryTimeoutMs / 1000)}s (QUERY_TIMEOUT_MS). Try a shorter time range or a lighter query.`,
        );
      }
      polls++;
      res = await es<EsqlResponse>(`/_query/async/${encodeURIComponent(id)}?wait_for_completion_timeout=${wait()}`, { signal });
      if (!res.is_running) {
        log.debug("esql.async_done", { ms: Date.now() - t0, polls });
        return res;
      }
    }
  } finally {
    dropAsync(id); // frees the stored result, or cancels the query if we gave up / the user left
  }
}

/**
 * Runs a guarded ES|QL query. The time window (the dashboard's range, shifted
 * back for comparisons, or an explicit window) is applied as a filter on the
 * time field, so queries never hard-code dates. Queries may use the same
 * ?_tstart / ?_tend parameters Kibana uses, e.g. BUCKET(@timestamp, 50, ?_tstart, ?_tend).
 */
export async function runEsql(
  query: string,
  range: TimeRangeKey,
  opts: {
    signal?: AbortSignal;
    maxRows?: number;
    compare?: Compare;
    window?: { from: number; to: number };
    trusted?: boolean;
  } = {},
): Promise<QueryResult> {
  let guarded = guardEsql(query, { trusted: opts.trusted });
  if (opts.maxRows && opts.maxRows < config.elastic.maxRows) guarded += `\n| LIMIT ${opts.maxRows}`;

  const { start, end } = queryWindow(range, opts);
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const body: any = {
    query: guarded,
    filter: { range: { [config.elastic.timeField]: { gte: startIso, lte: endIso } } },
  };
  if (/\?_tstart|\?_tend/.test(guarded)) body.params = [{ _tstart: startIso }, { _tend: endIso }];
  const t0 = Date.now();
  let res: EsqlResponse;
  try {
    res = await esqlCall(body, opts.signal);
  } catch (err: any) {
    log.info("esql.failed", { ms: Date.now() - t0, error: err.message, query: guarded });
    throw err;
  }
  log.debug("esql", {
    rows: res.values?.length ?? 0,
    cols: res.columns?.length ?? 0,
    ms: Date.now() - t0,
    took: res.took,
    from: startIso,
    to: endIso,
    compare: opts.compare,
    trusted: opts.trusted || undefined,
    query: guarded,
  });
  return {
    columns: res.columns ?? [],
    values: res.values ?? [],
    took: res.took ?? Date.now() - t0,
    truncated: (res.values?.length ?? 0) >= config.elastic.maxRows,
  };
}

/** Deploy / change events for annotations, from the environment's DEPLOY_QUERY. */
export async function deployEvents(
  range: TimeRangeKey,
  opts: { signal?: AbortSignal; window?: { from: number; to: number } } = {},
): Promise<Annotation[]> {
  const q = config.elastic.deployQuery;
  if (!q) return [];
  const res = await runEsql(q, range, { ...opts, trusted: true, maxRows: 300 });
  const ti = res.columns.findIndex((c) => c.type === "date" || c.type === "date_nanos");
  if (ti < 0) throw new HttpError(400, "The deploy query must return a date column (e.g. KEEP @timestamp, …)");
  return res.values
    .filter((row) => row[ti])
    .map((row) => ({
      time: String(row[ti]),
      label: row
        .filter((_, i) => i !== ti)
        .filter((v) => v !== null && v !== undefined && v !== "")
        .map(String)
        .join(" · ")
        .slice(0, 200),
    }))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}
