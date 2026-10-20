import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { config } from "./config";
import { HttpError, runEsql } from "./elastic";
import { systemPrompt } from "./prompt";
import { llmClient } from "./llm";
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

const tools: ChatCompletionTool[] = [
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
      description: "Run an ES|QL query (time range filter applied automatically). Returns columns and up to 30 rows.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_dashboard",
      description:
        "Create or REPLACE the whole dashboard. Send every panel that should remain. Each query is test-run; errors are returned so you can fix them.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          notes: { type: "string", description: "1-4 sentences: what this dashboard investigates and why. No live numbers." },
          time_range: { type: "string", enum: TIME_RANGE_KEYS, description: "Default time range for the dashboard" },
          panels: {
            type: "array",
            items: {
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
            },
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
async function validateDashboard(args: any, draft: Recipe | null, range: TimeRangeKey, signal: AbortSignal) {
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

  const checks = await Promise.all(
    panels.map(async (p) => {
      if (p.type === "text") return null;
      try {
        const res = await runEsql(p.esql!, range, { signal, maxRows: 50 });
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
        return problems.length ? `panel "${p.title}": ${problems.join("; ")}` : null;
      } catch (err: any) {
        return `panel "${p.title}": query failed — ${err.message}`;
      }
    }),
  );
  for (const c of checks) if (c) errors.push(c);
  if (errors.length) return { errors };

  const recipe = RecipeSchema.parse({
    ...(draft ?? {}),
    title: String(args.title ?? draft?.title ?? "דשבורד"),
    notes: String(args.notes ?? draft?.notes ?? ""),
    time_range: TIME_RANGE_KEYS.includes(args.time_range) ? args.time_range : draft?.time_range ?? range,
    panels,
  });
  return { recipe };
}

type ToolCall = { id: string; name: string; arguments: string };

function toolSummary(name: string, args: any): string {
  switch (name) {
    case "list_indices":
      return "list_indices";
    case "get_fields":
      return `get_fields · ${args?.index_pattern ?? ""}${args?.contains ? ` (${args.contains})` : ""}`;
    case "run_esql":
      return `run_esql · ${String(args?.query ?? "").replace(/\s+/g, " ").slice(0, 70)}`;
    case "set_dashboard":
      return `set_dashboard · ${Array.isArray(args?.panels) ? args.panels.length : 0} panels`;
    default:
      return name;
  }
}

export async function runAgent(input: {
  messages: ChatMessage[];
  recipe: Recipe | null;
  range: TimeRangeKey;
  model: string;
  signal: AbortSignal;
  emit: (e: ChatEvent) => void;
}) {
  const { range, model, signal, emit } = input;
  const client = llmClient();

  let draft = input.recipe;
  const convo: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(draft, range) },
    ...input.messages.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam),
  ];

  async function execTool(call: ToolCall): Promise<unknown> {
    let args: any = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return { error: "Arguments were not valid JSON" };
    }
    emit({ type: "tool_start", id: call.id, name: call.name, summary: toolSummary(call.name, args) });
    try {
      let result: unknown;
      let ok = true;
      let end = "";
      switch (call.name) {
        case "list_indices": {
          const q = `FROM ${config.elastic.logPatterns.join(", ")} METADATA _index | STATS docs = COUNT(*) BY _index | SORT docs DESC | LIMIT 100`;
          const res = await runEsql(q, range, { signal });
          result = preview(res, 100);
          end = `${res.values.length} indices`;
          break;
        }
        case "get_fields": {
          const res = await runEsql(`FROM ${args.index_pattern} | LIMIT 0`, range, { signal });
          const needle = String(args.contains ?? "").toLowerCase();
          const fields = res.columns
            .filter((c) => !needle || c.name.toLowerCase().includes(needle))
            .map((c) => `${c.name}:${c.type}`);
          result = { field_count: fields.length, fields: fields.slice(0, 400) };
          end = `${fields.length} fields`;
          break;
        }
        case "run_esql": {
          const res = await runEsql(String(args.query ?? ""), range, { signal, maxRows: 200 });
          result = preview(res);
          end = `${res.values.length} rows`;
          break;
        }
        case "set_dashboard": {
          const v = await validateDashboard(args, draft, range, signal);
          if (v.errors) {
            ok = false;
            result = { ok: false, errors: v.errors, hint: "Fix these and call set_dashboard again with all panels." };
            end = `${v.errors.length} errors, fixing`;
          } else {
            draft = v.recipe!;
            emit({ type: "recipe", recipe: draft });
            result = { ok: true, panels: draft.panels.length };
            end = `dashboard updated · ${draft.panels.length} panels`;
          }
          break;
        }
        default:
          ok = false;
          result = { error: `Unknown tool ${call.name}` };
          end = "unknown tool";
      }
      emit({ type: "tool_end", id: call.id, ok, summary: end });
      return result;
    } catch (err: any) {
      if (signal.aborted) throw err;
      emit({ type: "tool_end", id: call.id, ok: false, summary: err.message.slice(0, 160) });
      return { error: err.message };
    }
  }

  for (let step = 0; step < config.llm.maxSteps; step++) {
    const { text, toolCalls } = await complete(client, model, convo, signal, emit);
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
    if (!toolCalls.length) return;
    for (const call of toolCalls) {
      const result = await execTool(call);
      convo.push({ role: "tool", tool_call_id: call.id, content: cap(JSON.stringify(result)) });
    }
  }
  emit({ type: "text", delta: "\n\n(הגעתי למגבלת הצעדים לשאלה אחת. אפשר להמשיך בהודעה נוספת.)" });
}

async function complete(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  signal: AbortSignal,
  emit: (e: ChatEvent) => void,
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const base = { model, messages, tools, temperature: config.llm.temperature };

  if (!config.llm.stream) {
    const res = await client.chat.completions.create({ ...base, stream: false }, { signal });
    const msg = res.choices[0]?.message;
    const text = msg?.content ?? "";
    if (text) emit({ type: "text", delta: text });
    const toolCalls = (msg?.tool_calls ?? [])
      .filter((t: any) => t.type === "function" || t.function)
      .map((t: any, i: number) => ({ id: t.id || `call_${Date.now()}_${i}`, name: t.function.name, arguments: t.function.arguments ?? "" }));
    return { text, toolCalls };
  }

  const stream = await client.chat.completions.create({ ...base, stream: true }, { signal });
  let text = "";
  const calls = new Map<number, ToolCall>();
  for await (const chunk of stream) {
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
  return { text, toolCalls };
}
