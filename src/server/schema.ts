import { config } from "./config";
import { HttpError, runEsql } from "./elastic";
import { log } from "./log";
import { FIELD_RE, type Scope } from "../shared/scope";
import type { TimeRangeKey } from "../shared/recipe";

/**
 * The fields of LOG_INDEX_PATTERNS, cached per environment. Given to the model up front
 * (so it doesn't spend steps on list_indices / get_fields) and used by the focus bar.
 */
export type Field = { name: string; type: string };
const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; key: string; fields: Field[] }>();

export async function logFields(refresh = false): Promise<Field[]> {
  const env = config.env.id;
  const key = config.elastic.logPatterns.join(",");
  const hit = cache.get(env);
  if (!refresh && hit && hit.key === key && Date.now() - hit.at < TTL_MS) return hit.fields;
  const res = await runEsql(`FROM ${key} | LIMIT 0`, "24h");
  const fields = res.columns.map((c) => ({ name: c.name, type: c.type })).sort((a, b) => a.name.localeCompare(b.name));
  cache.set(env, { at: Date.now(), key, fields });
  log.debug("schema.loaded", { fields: fields.length });
  return fields;
}

/** Same as logFields, but never throws (the chat must work even if this fails). */
export async function logFieldsSafe(): Promise<Field[] | null> {
  try {
    return await logFields();
  } catch (err: any) {
    log.warn("schema.failed", { error: err?.message });
    return null;
  }
}

/** Common names for "where did this log come from", most useful first. */
const AUTO_SCOPE = [
  "kubernetes.namespace",
  "kubernetes.namespace_name",
  "k8s.namespace.name",
  "kubernetes.pod.name",
  "kubernetes.pod_name",
  "k8s.pod.name",
  "kubernetes.deployment.name",
  "k8s.deployment.name",
  "kubernetes.container.name",
  "kubernetes.container_name",
  "k8s.container.name",
  "container.name",
  "service.name",
  "app",
  "kubernetes.labels.app",
  "host.name",
  "cloud.region",
  "log.level",
];

/** Fields offered in the focus bar: SCOPE_FIELDS, or the common ones that exist. */
export async function scopeFields(): Promise<{ suggested: string[]; fields: Field[] }> {
  const fields = await logFields();
  const names = new Set(fields.map((f) => f.name));
  const configured = config.elastic.scopeFields;
  const suggested = configured.length ? configured : AUTO_SCOPE.filter((f) => names.has(f)).slice(0, 6);
  return { suggested, fields };
}

const VALUE_TYPES = new Set(["keyword", "ip", "long", "integer", "short", "byte", "boolean", "version", "unsigned_long"]);

/** Most common values of a field (for the focus bar's suggestions), narrowed by the rest of the scope. */
export async function topValues(
  field: string,
  opts: { q?: string; range: TimeRangeKey; scope?: Scope; signal?: AbortSignal },
): Promise<{ values: { value: string; count: number }[]; reason?: string }> {
  if (!FIELD_RE.test(field)) throw new HttpError(400, "Invalid field name");
  const fields = await logFields();
  const f = fields.find((x) => x.name === field);
  if (!f) return { values: [], reason: "השדה לא קיים באינדקסים" };
  if (!VALUE_TYPES.has(f.type)) return { values: [], reason: `שדה מסוג ${f.type}: אין הצעות, אפשר להקליד ערך` };
  const col = "`" + field.replace(/`/g, "``") + "`";
  const q = (opts.q ?? "").replace(/[*?"\\]/g, "").trim().toLowerCase().slice(0, 100);
  const where = [`${col} IS NOT NULL`];
  if (q) where.push(f.type === "keyword" ? `TO_LOWER(${col}) LIKE "*${q}*"` : `TO_STRING(${col}) LIKE "*${q}*"`);
  const query = `FROM ${config.elastic.logPatterns.join(", ")} | WHERE ${where.join(" AND ")} | STATS count = COUNT(*) BY ${col} | SORT count DESC | LIMIT 30`;
  const res = await runEsql(query, opts.range, {
    signal: opts.signal,
    scope: (opts.scope ?? []).filter((s) => s.field !== field),
  });
  const vi = res.columns.findIndex((c) => c.name === field);
  const ci = res.columns.findIndex((c) => c.name === "count");
  return {
    values: res.values
      .filter((r) => r[vi] !== null && r[vi] !== undefined)
      .map((r) => ({ value: String(r[vi]), count: Number(r[ci]) || 0 })),
  };
}

/** Compact field list for the system prompt (aggregatable / filterable types first). */
export function fieldsForPrompt(fields: Field[], maxChars = 9000): { text: string; complete: boolean } {
  const order = (t: string) => (t === "keyword" || t === "date" || t === "ip" ? 0 : t === "text" ? 2 : 1);
  const sorted = [...fields].sort((a, b) => order(a.type) - order(b.type) || a.name.localeCompare(b.name));
  const out: string[] = [];
  let len = 0;
  for (const f of sorted) {
    const s = `${f.name}:${f.type}`;
    if (len + s.length + 2 > maxChars) break;
    out.push(s);
    len += s.length + 2;
  }
  return { text: out.sort().join(", "), complete: out.length === fields.length };
}
