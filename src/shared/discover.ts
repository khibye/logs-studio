import { TIME_RANGES, type TimeRangeKey } from "./recipe";

/** Minimal rison encoding for the shapes Discover's URL state needs. */
function risonString(s: string): string {
  return "'" + s.replace(/!/g, "!!").replace(/'/g, "!'") + "'";
}

/**
 * Link that opens a panel's ES|QL query in Kibana Discover (ES|QL mode).
 * `baseUrl` already includes the space prefix when one is configured.
 */
export function discoverUrl(baseUrl: string, esql: string, range: TimeRangeKey): string {
  const from = TIME_RANGES[range]?.from ?? "now-24h";
  const g = `(time:(from:${from},to:now))`;
  const a = `(dataSource:(type:esql),query:(esql:${risonString(esql.trim())}))`;
  return `${baseUrl.replace(/\/$/, "")}/app/discover#/?_g=${encodeURIComponent(g)}&_a=${encodeURIComponent(a)}`;
}
