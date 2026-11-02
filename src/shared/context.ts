import { z } from "zod";

/**
 * The investigation context of a conversation / dashboard: what a template sets, minus the
 * focus filters (kept separately in `scope`, so they can also be used without a template).
 */
export const ContextSchema = z.object({
  template: z.object({ id: z.string().max(80).optional(), name: z.string().max(80) }).optional(),
  indices: z.array(z.string().max(200)).max(10).optional(),
  text: z.string().max(4000).optional(),
});
export type Context = z.infer<typeof ContextSchema>;

export function isEmptyContext(c: Context | undefined): boolean {
  return !c || (!c.template && !c.indices?.length && !c.text);
}
