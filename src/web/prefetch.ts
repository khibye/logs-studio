import type { QueryResult, TimeRangeKey } from "../shared/recipe";

/**
 * Panel results the server already has: while the model adds a panel, the server runs its
 * query (to check it) and sends the result along. The panel shows that instead of running the
 * same query again. Each result is used once and only shortly after it arrived.
 */
const MAX_AGE_MS = 120_000;
const store = new Map<string, { at: number; result: QueryResult }>();
const key = (env: string, esql: string, range: TimeRangeKey, scope: string) => `${env}\u0000${range}\u0000${scope}\u0000${esql}`;

export function putPanelData(env: string, esql: string, range: TimeRangeKey, scope: string, result: QueryResult) {
  if (store.size > 100) store.clear();
  store.set(key(env, esql, range, scope), { at: Date.now(), result });
}

export function takePanelData(env: string, esql: string, range: TimeRangeKey, scope: string): QueryResult | undefined {
  const k = key(env, esql, range, scope);
  const hit = store.get(k);
  if (!hit) return undefined;
  store.delete(k);
  return Date.now() - hit.at < MAX_AGE_MS ? hit.result : undefined;
}
