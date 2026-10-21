import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * Structured logging to stdout (what `kubectl logs` shows).
 *
 *   LOG_LEVEL   error | warn | info (default) | debug
 *   LOG_FORMAT  text (default) | json   — json is one object per line, for log collectors
 *
 * info  : every API request (status, duration), chat start/end, every tool step, saves, setting changes
 * debug : every Elasticsearch call, every ES|QL query with its window and row count, every model call
 *         (model, step, finish reason, tool calls, tokens when reported), capability probes
 *
 * Secrets are never logged: no API keys, Authorization headers, passwords or setting values.
 * Every line inside a request carries its request id and environment, so one request can be followed.
 */

export type Level = "error" | "warn" | "info" | "debug";
const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let threshold: Level = normalise(process.env.LOG_LEVEL) ?? "info";
let format: "text" | "json" = process.env.LOG_FORMAT === "json" ? "json" : "text";

function normalise(v: string | undefined): Level | undefined {
  const l = (v ?? "").toLowerCase();
  return l in RANK ? (l as Level) : l === "verbose" || l === "trace" ? "debug" : undefined;
}

export function setLogLevel(v: string | undefined) {
  threshold = normalise(v) ?? "info";
}
export function setLogFormat(v: string | undefined) {
  format = v === "json" ? "json" : "text";
}
export function logLevel(): Level {
  return threshold;
}

type Ctx = { reqId: string; env?: string };
const reqContext = new AsyncLocalStorage<Ctx>();

/** Runs a request with its own id (and later its environment) attached to every log line. */
export function withRequest<T>(fn: () => T): T {
  return reqContext.run({ reqId: randomBytes(3).toString("hex") }, fn);
}
export function setLogEnv(env: string) {
  const ctx = reqContext.getStore();
  if (ctx) ctx.env = env;
}
export function requestId(): string | undefined {
  return reqContext.getStore()?.reqId;
}

export type Fields = Record<string, unknown>;

/** Single-line, length-capped rendering of a value for text logs. */
function fmt(v: unknown): string {
  if (v === undefined) return "";
  let s = typeof v === "string" ? v : v instanceof Error ? v.message : JSON.stringify(v);
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 1500) s = s.slice(0, 1500) + `…(+${s.length - 1500})`;
  return /[\s="]/.test(s) ? JSON.stringify(s) : s;
}

function write(level: Level, msg: string, fields?: Fields) {
  if (RANK[level] > RANK[threshold]) return;
  const ctx = reqContext.getStore();
  const time = new Date().toISOString();
  let line: string;
  if (format === "json") {
    const obj: Record<string, unknown> = { time, level, msg };
    if (ctx?.reqId) obj.req = ctx.reqId;
    if (ctx?.env) obj.env = ctx.env;
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (v === undefined) continue;
      obj[k] = v instanceof Error ? { message: v.message, stack: v.stack } : v;
    }
    line = JSON.stringify(obj);
  } else {
    const tag = ctx ? ` [${ctx.reqId}${ctx.env ? ` ${ctx.env}` : ""}]` : "";
    const rest = Object.entries(fields ?? {})
      .filter(([k, v]) => v !== undefined && k !== "stack")
      .map(([k, v]) => `${k}=${fmt(v)}`)
      .join(" ");
    line = `${time} ${level.toUpperCase().padEnd(5)}${tag} ${msg}${rest ? " " + rest : ""}`;
    const stack = fields?.stack ?? (fields?.err instanceof Error ? fields.err.stack : undefined);
    if (stack && level === "error") line += `\n${stack}`;
  }
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  debug: (msg: string, fields?: Fields) => write("debug", msg, fields),
  /** Avoid building expensive debug fields when debug is off. */
  isDebug: () => RANK[threshold] >= RANK.debug,
};

/** Host only (no credentials, path or query) — safe to log. */
export function safeHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return "(invalid url)";
  }
}
