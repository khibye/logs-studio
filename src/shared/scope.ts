import { z } from "zod";

/**
 * "Focus" filters the user sets up front (namespace, pod name prefix, service…).
 * They are added to EVERY query — the model's, the panels', Discover links — as an
 * ES|QL WHERE right after FROM, so the model doesn't have to discover them and
 * dashboards stay scoped when re-run.
 *
 * Values: exact match, or a pattern with * (checkout-* = starts with "checkout-").
 * Several values of one field = any of them. `exclude` turns the filter into NOT.
 */
export const FIELD_RE = /^[A-Za-z_@][\w.@\-]*$/;

export const ScopeFilterSchema = z.object({
  field: z.string().min(1).max(200).regex(FIELD_RE, "invalid field name"),
  values: z.array(z.string().min(1).max(300)).min(1).max(20),
  exclude: z.boolean().optional(),
});
export type ScopeFilter = z.infer<typeof ScopeFilterSchema>;
export const ScopeSchema = z.array(ScopeFilterSchema).max(10);
export type Scope = ScopeFilter[];

/** ES|QL string literal. */
function lit(s: string): string {
  // eslint-disable-next-line no-control-regex
  return `"${s.replace(/[\u0000-\u001f]/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** ES|QL identifier (backticks keep dots and dashes safe). */
function ident(f: string): string {
  return "`" + f.replace(/`/g, "``") + "`";
}

/** The WHERE condition for one filter. */
function condition(f: ScopeFilter): string {
  const col = ident(f.field);
  const exact = f.values.filter((v) => !v.includes("*"));
  const patterns = f.values.filter((v) => v.includes("*"));
  const parts: string[] = [];
  if (exact.length === 1) parts.push(`${col} == ${lit(exact[0])}`);
  else if (exact.length > 1) parts.push(`${col} IN (${exact.map(lit).join(", ")})`);
  for (const p of patterns) parts.push(`${col} LIKE ${lit(p)}`);
  const any = parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
  return f.exclude ? `NOT (${any})` : any;
}

/** "WHERE …" for the whole scope, or "" when empty. */
export function scopeWhere(scope: Scope | undefined): string {
  if (!scope?.length) return "";
  return `WHERE ${scope.map(condition).join(" AND ")}`;
}

/** Index of the first "|" that is not inside a quoted string or a comment. */
function firstPipe(q: string): number {
  let quote = "";
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "`") quote = c;
    else if (c === "/" && q[i + 1] === "/") {
      const nl = q.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl;
    } else if (c === "/" && q[i + 1] === "*") {
      const end = q.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (c === "|") return i;
  }
  return -1;
}

/** Inserts the scope's WHERE right after the FROM command. */
export function applyScope(esql: string, scope: Scope | undefined): string {
  const where = scopeWhere(scope);
  if (!where) return esql;
  const q = esql.trim().replace(/;+\s*$/, "");
  const i = firstPipe(q);
  if (i < 0) return `${q}\n| ${where}`;
  return `${q.slice(0, i).trimEnd()}\n| ${where}\n${q.slice(i)}`;
}

/** Short human label, e.g. "kubernetes.namespace: payments" / "pod ≠ test-*". */
export function scopeLabel(f: ScopeFilter): string {
  return `${f.field} ${f.exclude ? "≠" : "="} ${f.values.join(" | ")}`;
}
