import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { config } from "./config";
import { HttpError, deployEvents, runEsql } from "./elastic";
import { systemPrompt } from "./prompt";
import { llmClient } from "./llm";
import { log } from "./log";
import { logFieldsSafe, matchCount } from "./schema";
import { ScopeSchema, type Scope } from "../shared/scope";
import { TemplateSchema } from "../shared/template";
import type { Context } from "../shared/context";
import { checkIndices } from "./elastic";
import {
  PANEL_TYPES,
  PanelSchema,
  RecipeSchema,
  TIME_RANGE_KEYS,
  type ChatEvent,
  type ChatMessage,
  type Panel,
  type QueryResult,
  type Recipe,
  type TimeRangeKey,
} from "../shared/recipe";

const NUMERIC = new Set([
  "long", "integer", "double", "float", "unsigned_long", "half_float", "scaled_float",
  "counter_long", "counter_double", "counter_integer",
]);

/** JSON schema of one panel, shared by add_panel and set_dashboard. */
const PANEL_JSON = {
  type: "object",
  properties: {
    id: { type: "string", description: "Keep existing ids unchanged; new panels: short slug" },
    title: { type: "string" },
    type: { type: "string", enum: [...PANEL_TYPES] },
    esql: { type: "string", description: "Required for all types except text" },
    text: { type: "string", description: "Only for text panels" },
    x: { type: "string", description: "Result column for x / category" },
    y: { type: "array", items: { type: "string" }, description: "Value column(s). metric uses y[0]" },
    series: { type: "string", description: "Optional breakdown column" },
    unit: { type: "string", description: "Optional unit suffix, e.g. ms or %" },
    width: { type: "string", enum: ["full", "half", "third"] },
    description: { type: "string" },
  },
  required: ["title", "type", "width"],
} as const;

const ALL_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_indices",
      description: "List indices that have documents in the current time range, with document counts.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_fields",
      description: "List field names and their ES|QL types for an index pattern.",
      parameters: {
        type: "object",
        properties: {
          index_pattern: { type: "string", description: "e.g. logs-* or logs-nginx*" },
          contains: { type: "string", description: "Optional substring filter on field names, e.g. 'status' or 'service'" },
        },
        required: ["index_pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_esql",
      description:
        "Run an ES|QL query. By default the dashboard's time range is applied automatically. Pass from/to (ISO 8601) to run it on an exact window instead, e.g. around a spike or the window just before it. Returns columns and up to 30 rows.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          from: { type: "string", description: "Optional window start, ISO 8601 (replaces the dashboard range)" },
          to: { type: "string", description: "Optional window end, ISO 8601" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_panel",
      description:
        "Add ONE panel to the dashboard, or replace the panel with the same id. The query runs right away: the panel appears for the user immediately and its data comes back to you (so a panel is also a query — no need to run it separately first). Creates the dashboard if there is none yet. Errors are returned so you can fix them.",
      parameters: {
        type: "object",
        properties: {
          panel: PANEL_JSON,
          dashboard_title: { type: "string", description: "Only when creating the dashboard, or to rename it" },
          notes: { type: "string", description: "Optional: 1-4 sentences on what the dashboard investigates. No live numbers." },
        },
        required: ["panel"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_panel",
      description: "Remove one panel from the dashboard by id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_dashboard",
      description:
        "REPLACE the whole dashboard at once (send every panel that should remain). Only for reorganizing — reordering or changing many panels. To add or change one panel, use add_panel. Each query is test-run; errors are returned so you can fix them.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          notes: { type: "string", description: "1-4 sentences: what this dashboard investigates and why. No live numbers." },
          time_range: { type: "string", enum: TIME_RANGE_KEYS, description: "Default time range for the dashboard" },
          panels: {
            type: "array",
            items: PANEL_JSON,
          },
        },
        required: ["title", "notes", "panels"],
        additionalProperties: false,
      },
    },
  },
];

function cap(s: string, n = 12000): string {
  return s.length > n ? s.slice(0, n) + `… [truncated ${s.length - n} chars]` : s;
}

function preview(res: QueryResult, rows = 30) {
  return {
    columns: res.columns.map((c) => `${c.name}:${c.type}`),
    rows: res.values.slice(0, rows),
    row_count: res.values.length,
    ...(res.values.length > rows ? { note: `showing first ${rows} rows` } : {}),
  };
}

function slug(s: string, i: number): string {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  return base || `p${i + 1}`;
}

/** Validates a dashboard proposed by the model and test-runs each query. */
async function validateDashboard(
  args: any,
  draft: Recipe | null,
  range: TimeRangeKey,
  scope: Scope,
  context: Context | undefined,
  signal: AbortSignal,
) {
  const errors: string[] = [];
  const rawPanels: any[] = Array.isArray(args?.panels) ? args.panels : [];
  const seen = new Set<string>();
  const panels: Panel[] = [];

  rawPanels.forEach((raw, i) => {
    let id = typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 40) : slug(String(raw?.title ?? ""), i);
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const parsed = PanelSchema.safeParse({ ...raw, id, width: raw?.width ?? "half" });
    if (!parsed.success) {
      errors.push(`panel ${i + 1} "${raw?.title ?? id}": ${parsed.error.issues.map((x) => x.message).join("; ")}`);
    } else panels.push(parsed.data);
  });
  if (errors.length) return { errors };

  const checks = await Promise.all(panels.map((p) => checkPanel(p, range, scope, signal)));
  const results = new Map<string, QueryResult>();
  checks.forEach((c, i) => {
    if (c.problem) errors.push(c.problem);
    else if (c.result) results.set(panels[i].id, c.result);
  });
  if (errors.length) return { errors };

  const recipe = RecipeSchema.parse({
    ...(draft ?? {}),
    title: String(args.title ?? draft?.title ?? "דשבורד"),
    notes: String(args.notes ?? draft?.notes ?? ""),
    time_range: TIME_RANGE_KEYS.includes(args.time_range) ? args.time_range : draft?.time_range ?? range,
    scope: scope.length ? scope : undefined,
    context: context ?? draft?.context,
    panels,
  });
  return { recipe, results };
}

/**
 * Runs a panel's query exactly as the dashboard will (same range, focus, row cap), and checks
 * that the columns it names exist. The result is sent to the browser with the dashboard, so
 * the panel doesn't run the same query again.
 */
async function checkPanel(
  p: Panel,
  range: TimeRangeKey,
  scope: Scope,
  signal: AbortSignal,
): Promise<{ problem?: string; result?: QueryResult }> {
  if (p.type === "text") return {};
  try {
    const res = await runEsql(p.esql!, range, { signal, scope });
    const types = new Map(res.columns.map((c) => [c.name, c.type]));
    const problems: string[] = [];
    for (const col of [p.x, ...(p.y ?? []), p.series].filter(Boolean) as string[]) {
      if (!types.has(col)) problems.push(`column "${col}" is not in the result (columns: ${[...types.keys()].join(", ")})`);
    }
    for (const col of p.y ?? []) {
      const t = types.get(col);
      if (t && !NUMERIC.has(t) && p.type !== "table") problems.push(`value column "${col}" is ${t}, it must be numeric`);
    }
    if (p.type === "metric" && res.values.length === 0) problems.push("metric query returned no rows");
    return problems.length ? { problem: `panel "${p.title}": ${problems.join("; ")}` } : { result: res };
  } catch (err: any) {
    return { problem: `panel "${p.title}": query failed — ${err.message}` };
  }
}

type ToolCall = { id: string; name: string; arguments: string };

/** Tools that change the dashboard: run one at a time, in order. The rest run in parallel. */
const MUTATING = new Set(["add_panel", "remove_panel", "set_dashboard", "propose_template"]);

/** Optional explicit window from tool arguments (ISO strings). */
function windowArg(args: any): { from: number; to: number } | undefined {
  if (!args?.from && !args?.to) return undefined;
  const from = Date.parse(String(args.from ?? ""));
  const to = args.to ? Date.parse(String(args.to)) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new HttpError(400, "from/to must be ISO 8601 dates");
  return { from, to };
}

const PROPOSE_TEMPLATE_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "propose_template",
    description:
      "Propose a TEMPLATE: a reusable starting point for investigations (indices + focus filters + an explanation for future conversations). The app checks that it matches log lines and shows it to the user, who decides whether to save it. Only after you verified the indices, field names and values with queries.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name, e.g. 'WebUI'" },
        description: { type: "string", description: "One sentence for the template list" },
        indices: { type: "array", items: { type: "string" }, description: "Index patterns that hold this data, as specific as possible" },
        scope: {
          type: "array",
          description: "Focus filters. values: exact values or patterns with * (e.g. *webui*). exclude: true = NOT",
          items: {
            type: "object",
            properties: {
              field: { type: "string" },
              values: { type: "array", items: { type: "string" } },
              exclude: { type: "boolean" },
            },
            required: ["field", "values"],
          },
        },
        context: {
          type: "string",
          description: "For future conversations: what this system is, the important fields and what they mean, how errors look. No live numbers.",
        },
        questions: { type: "array", items: { type: "string" }, description: "2-4 useful first questions" },
      },
      required: ["name", "indices", "scope", "context"],
      additionalProperties: false,
    },
  },
};

const LIST_DEPLOYS_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "list_deploys",
    description:
      "List deploy / change events (time + description) in the dashboard range, or in an explicit from/to window. Use it when explaining a change: did a deploy happen just before?",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Optional window start, ISO 8601" },
        to: { type: "string", description: "Optional window end, ISO 8601" },
      },
      additionalProperties: false,
    },
  },
};

/** Tools offered in this environment (list_deploys only when a deploy query is configured). */
function toolsFor(): ChatCompletionTool[] {
  return [...ALL_TOOLS, PROPOSE_TEMPLATE_TOOL, ...(config.elastic.deployQuery ? [LIST_DEPLOYS_TOOL] : [])];
}

function toolSummary(name: string, args: any): string {
  switch (name) {
    case "list_indices":
      return "list_indices";
    case "get_fields":
      return `get_fields · ${args?.index_pattern ?? ""}${args?.contains ? ` (${args.contains})` : ""}`;
    case "run_esql":
      return `run_esql${args?.from ? " (window)" : ""} · ${String(args?.query ?? "").replace(/\s+/g, " ").slice(0, 70)}`;
    case "list_deploys":
      return `list_deploys${args?.from ? " (window)" : ""}`;
    case "set_dashboard":
      return `set_dashboard · ${Array.isArray(args?.panels) ? args.panels.length : 0} panels`;
    case "add_panel":
      return `add_panel · ${args?.panel?.title ?? ""}`;
    case "remove_panel":
      return `remove_panel · ${args?.id ?? ""}`;
    case "propose_template":
      return `propose_template · ${args?.name ?? ""}`;
    default:
      return name;
  }
}

export async function runAgent(input: {
  messages: ChatMessage[];
  recipe: Recipe | null;
  range: TimeRangeKey;
  model: string;
  /** Focus filters set by the user; added to every query. */
  scope: Scope;
  /** Investigation context from a template: indices to use and an explanation. */
  context?: Context;
  signal: AbortSignal;
  emit: (e: ChatEvent) => void;
}) {
  const { range, model, scope, signal, emit } = input;
  const context = input.context;
  let indices: string[] = [];
  try {
    indices = checkIndices(context?.indices);
  } catch (err: any) {
    log.warn("chat.context_indices_rejected", { error: err.message });
  }
  const client = llmClient();
  const started = Date.now();
  let toolCount = 0;
  let toolErrors = 0;
  const last = input.messages[input.messages.length - 1];
  log.info("chat.start", {
    model,
    range,
    messages: input.messages.length,
    dashboard: input.recipe ? `${input.recipe.title} (${input.recipe.panels.length} panels)` : undefined,
    template: context?.template?.name,
    indices: indices.length ? indices.join(",") : undefined,
    scope: scope.length ? scope.map((s) => `${s.field}${s.exclude ? "!=" : "="}${s.values.join("|")}`).join(" ") : undefined,
    question: log.isDebug() ? last?.content?.slice(0, 300) : undefined,
  });

  let draft = input.recipe;
  const scopeKey = JSON.stringify(scope);
  /** Hands a panel's result to the browser so it doesn't run the query again. */
  const emitData = (esql: string, result: QueryResult) =>
    emit({ type: "panel_data", env: config.env.id, esql, range: draft?.time_range ?? range, scope: scopeKey, result });
  let llmMs = 0;
  let toolsMs = 0;
  /**
   * Panel checks by content: several add_panel calls in one step start their queries together
   * (in parallel), while the panels are still added to the dashboard one by one, in order.
   */
  const checks = new Map<string, ReturnType<typeof checkPanel>>();
  const checkOnce = (p: Panel, r: TimeRangeKey) => {
    const k = JSON.stringify([r, p.type, p.esql, p.x, p.y, p.series, p.title]);
    let c = checks.get(k);
    if (!c) {
      c = checkPanel(p, r, scope, signal);
      checks.set(k, c);
    }
    return c;
  };
  const startAddPanelChecks = (calls: ToolCall[]) => {
    for (const call of calls) {
      if (call.name !== "add_panel") continue;
      try {
        const raw = JSON.parse(call.arguments || "{}").panel ?? {};
        const parsed = PanelSchema.safeParse({ ...raw, id: "tmp", width: raw.width ?? "half" });
        if (parsed.success) void checkOnce(parsed.data, draft?.time_range ?? range).catch(() => undefined);
      } catch {
        /* reported when the call runs */
      }
    }
  };
  // The field list goes into the prompt, so the model doesn't spend steps discovering it.
  const fields = await logFieldsSafe(indices);
  const convo: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(draft, range, { scope, fields, context, indices, question: last?.content }) },
    ...input.messages.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam),
  ];

  /** Results of read-only calls in this turn: an identical call is answered from here, not re-run. */
  const seen = new Map<string, unknown>();
  let repeats = 0;

  async function execTool(call: ToolCall): Promise<unknown> {
    let args: any = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return { error: "Arguments were not valid JSON" };
    }
    const key = MUTATING.has(call.name) ? "" : `${call.name}:${JSON.stringify(args).replace(/\s+/g, " ")}`;
    if (key && seen.has(key)) {
      repeats++;
      emit({ type: "tool_start", id: call.id, name: call.name, summary: toolSummary(call.name, args) });
      emit({ type: "tool_end", id: call.id, ok: true, summary: "repeat — same result as before" });
      log.info("chat.tool_repeat", { tool: call.name, repeats });
      return {
        note: "You already made this exact call in this turn. Here is the same result again. Don't repeat calls: use what you have, or move on to add_panel / your answer.",
        result: seen.get(key),
      };
    }
    emit({ type: "tool_start", id: call.id, name: call.name, summary: toolSummary(call.name, args) });
    const t0 = Date.now();
    toolCount++;
    log.debug("chat.tool.start", { tool: call.name, args: call.arguments?.slice(0, 2000) });
    try {
      let result: unknown;
      let ok = true;
      let end = "";
      switch (call.name) {
        case "list_indices": {
          const q = `FROM ${(indices.length ? indices : config.elastic.logPatterns).join(", ")} METADATA _index | STATS docs = COUNT(*) BY _index | SORT docs DESC | LIMIT 100`;
          const res = await runEsql(q, range, { signal, scope });
          result = preview(res, 100);
          end = `${res.values.length} indices`;
          break;
        }
        case "get_fields": {
          const res = await runEsql(`FROM ${args.index_pattern} | LIMIT 0`, range, { signal, noEnvFilter: true });
          const needle = String(args.contains ?? "").toLowerCase();
          const fields = res.columns
            .filter((c) => !needle || c.name.toLowerCase().includes(needle))
            .map((c) => `${c.name}:${c.type}`);
          result = { field_count: fields.length, fields: fields.slice(0, 400) };
          end = `${fields.length} fields`;
          break;
        }
        case "run_esql": {
          const res = await runEsql(String(args.query ?? ""), range, {
            signal,
            maxRows: 200,
            window: windowArg(args),
            scope,
          });
          result = preview(res);
          end = `${res.values.length} rows`;
          break;
        }
        case "list_deploys": {
          const events = await deployEvents(range, { signal, window: windowArg(args) });
          result = { count: events.length, events: events.slice(-60) };
          end = `${events.length} events`;
          break;
        }
        case "set_dashboard": {
          const v = await validateDashboard(args, draft, range, scope, context, signal);
          if (v.errors) {
            ok = false;
            result = { ok: false, errors: v.errors, hint: "Fix these and call set_dashboard again with all panels." };
            end = `${v.errors.length} errors, fixing`;
          } else {
            draft = v.recipe!;
            for (const p of draft.panels) {
              const r = v.results?.get(p.id);
              if (r && p.esql) emitData(p.esql, r);
            }
            emit({ type: "recipe", recipe: draft });
            result = { ok: true, panels: draft.panels.length };
            end = `dashboard updated · ${draft.panels.length} panels`;
          }
          break;
        }
        case "add_panel": {
          const raw = args.panel ?? {};
          const existing = draft?.panels ?? [];
          let id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 40) : slug(String(raw.title ?? ""), existing.length);
          const replacing = existing.some((p) => p.id === id);
          if (!replacing) while (existing.some((p) => p.id === id)) id = `${id}-${existing.length + 1}`;
          const parsed = PanelSchema.safeParse({ ...raw, id, width: raw.width ?? "half" });
          if (!parsed.success) {
            ok = false;
            result = { ok: false, errors: parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`) };
            end = "invalid panel, fixing";
            break;
          }
          const panel = parsed.data;
          const check = await checkOnce(panel, draft?.time_range ?? range);
          if (check.problem) {
            ok = false;
            result = { ok: false, error: check.problem, hint: "Fix the query or the columns and call add_panel again." };
            end = "error, fixing";
            break;
          }
          const panels = replacing ? existing.map((p) => (p.id === id ? panel : p)) : [...existing, panel];
          draft = RecipeSchema.parse({
            ...(draft ?? {}),
            title: String(args.dashboard_title ?? draft?.title ?? panel.title),
            notes: String(args.notes ?? draft?.notes ?? ""),
            time_range: draft?.time_range ?? range,
            scope: scope.length ? scope : undefined,
            context: context ?? draft?.context,
            panels,
          });
          if (check.result && panel.esql) emitData(panel.esql, check.result);
          emit({ type: "recipe", recipe: draft });
          result = {
            ok: true,
            panel_id: id,
            panels_in_dashboard: panels.length,
            ...(check.result ? { data: preview(check.result, 15) } : {}),
          };
          end = `${replacing ? "updated" : "added"} · ${check.result ? `${check.result.values.length} rows` : "text"}`;
          break;
        }
        case "remove_panel": {
          const id = String(args.id ?? "");
          if (!draft?.panels.some((p) => p.id === id)) {
            ok = false;
            result = { ok: false, error: `No panel with id "${id}". Ids: ${(draft?.panels ?? []).map((p) => p.id).join(", ")}` };
            end = "no such panel";
            break;
          }
          draft = { ...draft, panels: draft.panels.filter((p) => p.id !== id) };
          emit({ type: "recipe", recipe: draft });
          result = { ok: true, panels_in_dashboard: draft.panels.length };
          end = "removed";
          break;
        }
        case "propose_template": {
          const parsed = TemplateSchema.safeParse({
            name: args.name,
            description: args.description ?? "",
            indices: args.indices ?? [],
            scope: args.scope ?? [],
            context: args.context ?? "",
            questions: (args.questions ?? []).slice(0, 6),
            time_range: range,
          });
          const scopeOk = ScopeSchema.safeParse(args.scope ?? []);
          if (!parsed.success || !scopeOk.success) {
            ok = false;
            const issues = [...(parsed.success ? [] : parsed.error.issues), ...(scopeOk.success ? [] : scopeOk.error.issues)];
            result = { ok: false, errors: issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
            end = "invalid, fixing";
            break;
          }
          const t = parsed.data;
          t.indices = checkIndices(t.indices);
          const m = await matchCount({ range, scope: t.scope, indices: t.indices, signal });
          if (m.missing.length || m.count === 0) {
            ok = false;
            result = {
              ok: false,
              error: m.missing.length
                ? `These fields don't exist in ${t.indices.join(", ") || "the indices"}: ${m.missing.join(", ")}. Check get_fields.`
                : "These indices + filters match 0 log lines in the time range. Check the field and the values (case, * patterns) with run_esql, then try again.",
            };
            end = m.missing.length ? `unknown field ${m.missing.join(", ")}` : "0 matching lines, fixing";
            break;
          }
          emit({ type: "template", template: t, count: m.count });
          result = { ok: true, matching_lines: m.count, note: "Shown to the user, who can save it or use it now. Tell them briefly what it covers." };
          end = `${m.count.toLocaleString("en-US")} matching lines`;
          break;
        }
        default:
          ok = false;
          result = { error: `Unknown tool ${call.name}` };
          end = "unknown tool";
      }
      emit({ type: "tool_end", id: call.id, ok, summary: end });
      if (!ok) toolErrors++;
      if (key && ok) seen.set(key, result);
      (ok ? log.info : log.warn)("chat.tool", {
        tool: call.name,
        ok,
        ms: Date.now() - t0,
        result: end,
        errors: !ok && call.name === "set_dashboard" ? (result as any)?.errors : undefined,
      });
      return result;
    } catch (err: any) {
      if (signal.aborted) throw err;
      toolErrors++;
      log.warn("chat.tool", { tool: call.name, ok: false, ms: Date.now() - t0, error: err.message });
      emit({ type: "tool_end", id: call.id, ok: false, summary: err.message.slice(0, 160) });
      return { error: err.message };
    }
  }

  const finish = (outcome: string, steps: number) =>
    log.info("chat.end", {
      outcome,
      steps,
      tools: toolCount,
      toolErrors,
      repeats: repeats || undefined,
      ms: Date.now() - started,
      // Where the time went: waiting for the model vs. running tools (Elasticsearch).
      llmMs,
      toolsMs,
      model,
    });
  signal.addEventListener("abort", () => log.info("chat.cancelled", { ms: Date.now() - started, tools: toolCount }), {
    once: true,
  });

  for (let step = 0; step < config.llm.maxSteps; step++) {
    let text: string;
    let toolCalls: ToolCall[];
    const tLlm = Date.now();
    try {
      ({ text, toolCalls } = await complete(client, model, convo, signal, emit, step + 1));
      llmMs += Date.now() - tLlm;
    } catch (err: any) {
      if (!signal.aborted)
        log.error("chat.llm_failed", { step: step + 1, model, status: err?.status, error: err?.message });
      throw err;
    }
    convo.push({
      role: "assistant",
      content: text || null,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map(
              (t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments || "{}" } }) as ChatCompletionMessageToolCall,
            ),
          }
        : {}),
    } as ChatCompletionMessageParam);
    if (!toolCalls.length) {
      finish("answered", step + 1);
      return;
    }
    // Read-only calls run in parallel; calls that change the dashboard run after them, in order.
    const tTools = Date.now();
    startAddPanelChecks(toolCalls);
    const results: unknown[] = new Array(toolCalls.length);
    await Promise.all(
      toolCalls.map(async (call, i) => {
        if (!MUTATING.has(call.name)) results[i] = await execTool(call);
      }),
    );
    for (const [i, call] of toolCalls.entries()) if (MUTATING.has(call.name)) results[i] = await execTool(call);
    toolsMs += Date.now() - tTools;
    toolCalls.forEach((call, i) => convo.push({ role: "tool", tool_call_id: call.id, content: cap(JSON.stringify(results[i])) }));
  }
  log.warn("chat.max_steps_reached", { maxSteps: config.llm.maxSteps, tools: toolCount, toolErrors });
  finish("max_steps", config.llm.maxSteps);
  emit({ type: "text", delta: "\n\n(הגעתי למגבלת הצעדים לשאלה אחת. אפשר להמשיך בהודעה נוספת.)" });
}

async function complete(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  signal: AbortSignal,
  emit: (e: ChatEvent) => void,
  step = 1,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const base = { model, messages, tools: toolsFor(), temperature: config.llm.temperature };
  const t0 = Date.now();
  const promptChars = messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
  log.debug("llm.request", { step, model, messages: messages.length, promptChars, stream: config.llm.stream });
  const done = (text: string, toolCalls: ToolCall[], finish?: string | null, usage?: any, firstTokenMs?: number) =>
    log.debug("llm.response", {
      step,
      model,
      ms: Date.now() - t0,
      firstTokenMs,
      finish: finish ?? undefined,
      textChars: text.length,
      toolCalls: toolCalls.map((t) => t.name).join(",") || undefined,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      text: text ? text.slice(0, 300) : undefined,
    });

  if (!config.llm.stream) {
    const res = await client.chat.completions.create({ ...base, stream: false }, { signal });
    const msg = res.choices[0]?.message;
    const text = msg?.content ?? "";
    if (text) emit({ type: "text", delta: text });
    const toolCalls = (msg?.tool_calls ?? [])
      .filter((t: any) => t.type === "function" || t.function)
      .map((t: any, i: number) => ({ id: t.id || `call_${Date.now()}_${i}`, name: t.function.name, arguments: t.function.arguments ?? "" }));
    done(text, toolCalls, res.choices[0]?.finish_reason, res.usage);
    return { text, toolCalls };
  }

  const stream = await client.chat.completions.create({ ...base, stream: true }, { signal });
  let text = "";
  let finish: string | null | undefined;
  let usage: any;
  let firstTokenMs: number | undefined;
  const calls = new Map<number, ToolCall>();
  for await (const chunk of stream) {
    if (firstTokenMs === undefined) firstTokenMs = Date.now() - t0;
    if ((chunk as any).usage) usage = (chunk as any).usage;
    if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
    const delta: any = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    if (delta.content) {
      text += delta.content;
      emit({ type: "text", delta: delta.content });
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const cur = calls.get(i) ?? { id: "", name: "", arguments: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(i, cur);
    }
  }
  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, c]) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }))
    .filter((c) => c.name);
  done(text, toolCalls, finish, usage, firstTokenMs);
  return { text, toolCalls };
}
