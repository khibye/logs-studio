import type { QueryResult } from "../shared/recipe";

/** One CSV cell. Raw values (ISO dates, plain numbers) so the file works in Excel and in scripts. */
function cell(v: unknown, header = false): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  // Spreadsheets run text that starts with these as a formula (CSV injection) — log lines can contain anything.
  if (!header && typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Builds a CSV from one or more query results. With several parts (side-by-side environments)
 * a first "environment" column tells the rows apart.
 */
export function toCsv(parts: { label?: string; data: QueryResult }[]): string {
  const withLabel = parts.length > 1;
  const columns = parts[0]?.data.columns.map((c) => c.name) ?? [];
  const lines = [[...(withLabel ? ["environment"] : []), ...columns].map((h) => cell(h, true)).join(",")];
  for (const { label, data } of parts) {
    // Align by column name in case the environments return columns in a different order.
    const idx = columns.map((name) => data.columns.findIndex((c) => c.name === name));
    for (const row of data.values) {
      const vals = idx.map((i) => (i >= 0 ? row[i] : null));
      lines.push([...(withLabel ? [label ?? ""] : []), ...vals].map((v) => cell(v)).join(","));
    }
  }
  // BOM + CRLF: Excel then opens Hebrew text correctly.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function downloadCsv(baseName: string, csv: string) {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`; // local time
  const name = (baseName.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "data") + `-${stamp}.csv`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
