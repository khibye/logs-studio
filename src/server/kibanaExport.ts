import { config, kibanaBase } from "./config";
import { HttpError, runEsql } from "./elastic";
import { log } from "./log";
import type { Panel, Recipe } from "../shared/recipe";

/**
 * EXPERIMENTAL — converts a recipe into a real Kibana dashboard through the
 * Kibana Dashboards API (technical preview in 9.4, GA in 9.5). Only switched on
 * when Kibana reports 9.4+. The panel shapes follow Elastic's published
 * examples; check them against your Kibana version's API spec before relying
 * on this (the conversion is isolated in this one file).
 *
 * The recipe stays the source of truth: exporting again overwrites the same
 * Kibana dashboard (same id), it never edits the recipe.
 */

const GRID_COLS = 48;
const WIDTH: Record<Panel["width"], number> = { full: 48, half: 24, third: 16 };
const HEIGHT: Record<Panel["type"], number> = { metric: 7, line: 14, area: 14, bar: 14, hbar: 14, table: 16, text: 8 };
const NUMERIC = new Set(["long", "integer", "double", "float", "unsigned_long", "half_float", "scaled_float", "counter_long", "counter_double", "counter_integer"]);

async function columnTypes(esql: string): Promise<Map<string, string>> {
  const res = await runEsql(esql, "24h", { maxRows: 1 });
  return new Map(res.columns.map((c) => [c.name, c.type]));
}

async function panelConfig(p: Panel): Promise<Record<string, unknown> | null> {
  if (p.type === "text" || !p.esql) return null;
  const data_source = { type: "esql", query: p.esql };
  const types = await columnTypes(p.esql);

  if (p.type === "metric") {
    return { title: p.title, type: "metric", data_source, metrics: [{ type: "primary", column: p.y![0] }] };
  }
  if (p.type === "table") {
    const cols = [...types.entries()];
    return {
      title: p.title,
      type: "data_table",
      data_source,
      metrics: cols.filter(([, t]) => NUMERIC.has(t)).map(([c]) => ({ column: c })),
      rows: cols.filter(([, t]) => !NUMERIC.has(t)).map(([c]) => ({ column: c })),
    };
  }
  const temporal = types.get(p.x!) === "date" || types.get(p.x!) === "date_nanos";
  const layerType = p.type === "hbar" ? "bar_horizontal" : p.type;
  return {
    title: p.title,
    type: "xy",
    ...(temporal ? { axis: { x: { scale: "temporal" } } } : {}),
    layers: [
      {
        type: layerType,
        data_source,
        x: { column: p.x },
        y: (p.y ?? []).map((c) => ({ column: c })),
        ...(p.series ? { breakdown_by: { column: p.series } } : {}),
      },
    ],
  };
}

export async function exportToKibana(recipe: Recipe): Promise<{ url: string; id: string; skipped: string[] }> {
  if (!config.kibana.url) throw new HttpError(400, "KIBANA_URL is not set");
  const panels: unknown[] = [];
  const skipped: string[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const p of recipe.panels) {
    const cfg = await panelConfig(p);
    if (!cfg) {
      skipped.push(p.title);
      continue;
    }
    const w = WIDTH[p.width];
    const h = HEIGHT[p.type];
    if (x + w > GRID_COLS) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    panels.push({ type: "vis", grid: { x, y, w, h }, config: cfg });
    x += w;
    rowH = Math.max(rowH, h);
  }

  const id = `ai-${recipe.id ?? crypto.randomUUID()}`;
  const base = kibanaBase(config.kibana.url)!;
  const res = await fetch(`${base}/api/dashboards/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: {
      Authorization: `ApiKey ${config.kibana.apiKey}`,
      "Content-Type": "application/json",
      "kbn-xsrf": "true",
    },
    body: JSON.stringify({ title: recipe.title, description: recipe.notes, panels }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text();
    log.warn("kibana.export_failed", { id, status: res.status, error: text.slice(0, 500) });
    throw new HttpError(res.status, `Kibana rejected the dashboard (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  log.info("kibana.exported", { id, panels: panels.length, skipped: skipped.length || undefined });
  const publicBase = kibanaBase(config.kibana.publicUrl) ?? base;
  return { id, url: `${publicBase}/app/dashboards#/view/${encodeURIComponent(id)}`, skipped };
}
