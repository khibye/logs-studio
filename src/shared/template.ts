import { z } from "zod";
import { ScopeSchema } from "./scope";
import type { Context } from "./context";
export { ContextSchema, isEmptyContext, type Context } from "./context";
import { TIME_RANGE_KEYS, type TimeRangeKey } from "./recipe";

/**
 * A template is a reusable STARTING POINT for an investigation — not a dashboard:
 * which indices to look at, the focus filters (namespace / pod / service…), and an
 * explanation for the model. Starting a chat from a template saves the model all the
 * "where is the data and what is it called" exploration.
 */
export const TemplateSchema = z.object({
  /** Set once saved. */
  id: z.string().max(80).optional(),
  version: z.number().int().positive().optional(),
  /** Where it is saved: the shared library (Elasticsearch) or the app server's data folder. */
  store: z.enum(["library", "server"]).optional(),
  updated_at: z.string().max(40).optional(),

  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(""),
  /** Index patterns to query (each must be within LOG_INDEX_PATTERNS). Empty = all allowed. */
  indices: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  scope: ScopeSchema.default([]),
  /** For the model: what this system is, which fields matter, how errors look. */
  context: z.string().max(4000).default(""),
  /** Suggested first questions, shown as chips in a new chat. */
  questions: z.array(z.string().trim().min(1).max(300)).max(6).default([]),
  time_range: z.enum(TIME_RANGE_KEYS as [TimeRangeKey, ...TimeRangeKey[]]).optional(),
  env: z.string().max(40).optional(),
});
export type Template = z.infer<typeof TemplateSchema>;

export function contextFromTemplate(t: Template): Context {
  return {
    template: { id: t.id, name: t.name },
    indices: t.indices.length ? t.indices : undefined,
    text: t.context || undefined,
  };
}
