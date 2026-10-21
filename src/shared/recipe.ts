import { z } from "zod";

/**
 * A "recipe" is the whole definition of a dashboard: panels, each with its own
 * ES|QL query and how to draw it. It holds NO data — data is always fetched live.
 * It is the single source of truth, whether it lives in a URL, a JSON file or the
 * ai-dashboards index.
 */

export const PANEL_TYPES = ["metric", "line", "area", "bar", "hbar", "table", "text"] as const;
export type PanelType = (typeof PANEL_TYPES)[number];

export const TIME_RANGES = {
  "15m": { label: "15 דקות אחרונות", from: "now-15m", ms: 15 * 60e3, prevLabel: "מרבע השעה הקודמת" },
  "1h": { label: "שעה אחרונה", from: "now-1h", ms: 3600e3, prevLabel: "מהשעה הקודמת" },
  "12h": { label: "12 שעות אחרונות", from: "now-12h", ms: 12 * 3600e3, prevLabel: "מ-12 השעות הקודמות" },
  "24h": { label: "24 שעות אחרונות", from: "now-24h", ms: 24 * 3600e3, prevLabel: "מאתמול" },
  "7d": { label: "7 ימים אחרונים", from: "now-7d", ms: 7 * 86400e3, prevLabel: "מהשבוע הקודם" },
  "30d": { label: "30 ימים אחרונים", from: "now-30d", ms: 30 * 86400e3, prevLabel: "מ-30 הימים הקודמים" },
} as const;

/** "previous" = the same-length period just before; "week" = the same time a week earlier. */
export type Compare = "previous" | "week";
export const WEEK_MS = 7 * 86400e3;
/** How far back a comparison is shifted. */
export function compareShiftMs(range: TimeRangeKey, compare: Compare): number {
  return compare === "week" ? WEEK_MS : TIME_RANGES[range].ms;
}
/** Time charts compare with last week when the range fits in a week, otherwise with the previous period. */
export function chartCompare(range: TimeRangeKey): Compare {
  return TIME_RANGES[range].ms <= WEEK_MS ? "week" : "previous";
}

export type Annotation = { time: string; label: string };
export type TimeRangeKey = keyof typeof TIME_RANGES;
export const TIME_RANGE_KEYS = Object.keys(TIME_RANGES) as TimeRangeKey[];

export const PanelSchema = z
  .object({
    id: z.string().min(1).max(40),
    title: z.string().min(1).max(120),
    type: z.enum(PANEL_TYPES),
    /** ES|QL query. Required for every type except "text". */
    esql: z.string().max(4000).optional(),
    /** Static explanation, only for "text" panels. Never hard-coded numbers. */
    text: z.string().max(4000).optional(),
    /** Result column for the X axis / category. */
    x: z.string().max(200).optional(),
    /** Result column(s) for the value(s). metric uses y[0]. */
    y: z.array(z.string().max(200)).max(6).optional(),
    /** Optional breakdown column — one series per distinct value. */
    series: z.string().max(200).optional(),
    unit: z.string().max(20).optional(),
    width: z.enum(["full", "half", "third"]).default("half"),
    description: z.string().max(300).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.type === "text") {
      if (!p.text) ctx.addIssue({ code: "custom", message: "text panel needs `text`" });
      return;
    }
    if (!p.esql) ctx.addIssue({ code: "custom", message: `${p.type} panel needs \`esql\`` });
    if (p.type === "metric" && !p.y?.length)
      ctx.addIssue({ code: "custom", message: "metric panel needs y[0] (the value column)" });
    if (["line", "area", "bar", "hbar"].includes(p.type)) {
      if (!p.x) ctx.addIssue({ code: "custom", message: `${p.type} panel needs \`x\`` });
      if (!p.y?.length) ctx.addIssue({ code: "custom", message: `${p.type} panel needs \`y\`` });
      if (p.series && (p.y?.length ?? 0) > 1)
        ctx.addIssue({ code: "custom", message: "use either `series` or several `y` columns, not both" });
    }
  });
export type Panel = z.infer<typeof PanelSchema>;

export const RefSchema = z.object({ id: z.string().min(1).max(80), version: z.number().int().positive() });
export type Ref = z.infer<typeof RefSchema>;

export const RecipeSchema = z.object({
  schema: z.literal(1).default(1),
  /** Set only once the recipe is saved in the ai-dashboards index. */
  id: z.string().max(80).optional(),
  version: z.number().int().positive().optional(),
  forked_from: RefSchema.optional(),
  title: z.string().min(1).max(120),
  /** Short summary written by the model: what was analysed and why. Gives a new chat its context. */
  notes: z.string().max(2000).default(""),
  time_range: z.enum(TIME_RANGE_KEYS as [TimeRangeKey, ...TimeRangeKey[]]).default("24h"),
  /** Environment the dashboard opens on by default. The same dashboard can run on any environment. */
  env: z.string().max(40).optional(),
  panels: z.array(PanelSchema).max(24),
});
export type Recipe = z.infer<typeof RecipeSchema>;

export function emptyRecipe(): Recipe {
  return { schema: 1, title: "דשבורד חדש", notes: "", time_range: "24h", panels: [] };
}

/** The part of a recipe that defines content (used to tell whether a draft changed). */
export function contentKey(r: Recipe | null): string {
  if (!r) return "";
  return JSON.stringify({ t: r.title, n: r.notes, tr: r.time_range, p: r.panels });
}

export type DashboardSummary = {
  id: string;
  version: number;
  title: string;
  notes: string;
  saved_at: string;
  panel_count: number;
  versions: number;
  forked_from?: Ref;
  env?: string;
};

export type Capabilities = {
  elastic: { ok: boolean; version?: string; error?: string; via: "direct" | "kibana" };
  llm: { configured: boolean; model?: string };
  logs: { read: boolean; patterns: string[]; reason?: string };
  library: { read: boolean; write: boolean; index: string; reason?: string; env?: string };
  discover: { enabled: boolean; baseUrl?: string; reason?: string; warning?: string };
  chat: { retentionHours: number };
  admin: { enabled: boolean };
  /** The environment these capabilities describe, and all environments to choose from. */
  env: { id: string; name: string };
  environments: { id: string; name: string }[];
  deploys: { enabled: boolean };
  kibanaExport: { enabled: boolean; experimental: true; reason?: string; kibanaVersion?: string };
};

export type QueryResult = {
  columns: { name: string; type: string }[];
  values: unknown[][];
  took?: number;
  truncated?: boolean;
};

/** Events streamed from POST /api/chat (one JSON object per line). */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; summary: string }
  | { type: "tool_end"; id: string; ok: boolean; summary: string }
  | { type: "recipe"; recipe: Recipe }
  | { type: "error"; message: string }
  /** Keep-alive while the model or Elasticsearch is busy, so proxies don't close an idle stream. */
  | { type: "ping" }
  | { type: "done" };

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ModelsInfo = { models: string[]; default: string; error?: string };
