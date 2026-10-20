/**
 * A tiny fake Elasticsearch for local development and tests — NOT a real ES|QL engine.
 * It understands just enough of the query shape (STATS … BY …, KEEP, LIMIT 0,
 * METADATA _index) to return plausible columns and rows, and keeps the
 * ai-dashboards index in memory.
 *
 *   MOCK_ES_PORT=9200  MOCK_WRITE=1 (grant create_doc on the dashboards index)
 *   MOCK_NO_INDEX=1    (pretend the dashboards index does not exist)
 */
import express from "express";

const app = express();
app.use(express.json({ limit: "5mb" }));
const PORT = Number(process.env.MOCK_ES_PORT ?? 9200);
const WRITE = process.env.MOCK_WRITE === "1";
const NO_INDEX = process.env.MOCK_NO_INDEX === "1";
const DASH = process.env.DASHBOARDS_INDEX ?? "ai-dashboards";

const FIELDS: [string, string][] = [
  ["@timestamp", "date"],
  ["service.name", "keyword"],
  ["http.response.status_code", "long"],
  ["http.request.method", "keyword"],
  ["url.path", "keyword"],
  ["event.duration", "long"],
  ["log.level", "keyword"],
  ["message", "text"],
  ["host.name", "keyword"],
];
const TAG = process.env.MOCK_TAG ?? ""; // e.g. "stg-" to tell a second mock environment apart
const SERVICES = ["checkout-api", "cart-svc", "user-svc", "search-api", "payments-gw"].map((s) => TAG + s);
const PATHS = ["/api/checkout/pay", "/api/checkout/confirm", "/api/cart", "/api/user/profile", "/api/search"];

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function typeOfField(f: string) {
  return FIELDS.find(([n]) => n === f)?.[1] ?? "keyword";
}
function valuesFor(field: string, n: number): string[] {
  if (field.includes("service")) return SERVICES.slice(0, n);
  if (field.includes("path") || field.includes("endpoint")) return PATHS.slice(0, n);
  if (field.includes("level")) return ["error", "warn", "info"].slice(0, n);
  if (field.includes("status")) return ["500", "502", "503", "504"].slice(0, n);
  if (field.includes("_index")) return [".ds-logs-app-default-2026.10.19-000001", ".ds-logs-nginx-default-2026.10.19-000001"];
  return Array.from({ length: n }, (_, i) => `${field}-${i + 1}`);
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", q = false;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q && ch === "(") depth++;
    if (!q && ch === ")") depth--;
    if (!q && depth === 0 && ch === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function esql(query: string) {
  if (/nonexistent_field/.test(query)) {
    return { status: 400, body: { error: { type: "verification_exception", reason: "Found 1 problem\nline 1:20: Unknown column [nonexistent_field]" } } };
  }
  const cmds = query.split("|").map((c) => c.trim());
  const limit0 = cmds.some((c) => /^LIMIT\s+0$/i.test(c));
  if (limit0) return { status: 200, body: { columns: FIELDS.map(([name, type]) => ({ name, type })), values: [] } };

  const stats = cmds.find((c) => /^STATS\s/i.test(c));
  const keep = cmds.find((c) => /^KEEP\s/i.test(c));
  const limits = cmds.map((c) => /^LIMIT\s+(\d+)$/i.exec(c)).filter(Boolean).map((m) => Number(m![1]));
  const limit = limits.length ? Math.min(...limits) : 1000;

  if (stats) {
    const m = /^STATS\s+([\s\S]+?)(?:\s+BY\s+([\s\S]+))?$/i.exec(stats)!;
    const aggs = splitTop(m[1]).map((a, i) => {
      const am = /^([\w.@]+)\s*=\s*([\s\S]+)$/.exec(a);
      return am ? { name: am[1], expr: am[2] } : { name: a, expr: a, i };
    });
    const by = m[2] ? splitTop(m[2]).map((b) => {
      const bm = /^([\w.@]+)\s*=\s*([\s\S]+)$/.exec(b);
      return bm ? { name: bm[1], expr: bm[2] } : { name: b, expr: b };
    }) : [];
    const columns = [
      ...aggs.map((a) => ({ name: a.name, type: /AVG|PERCENTILE|\/|ROUND/i.test(a.expr) ? "double" : "long" })),
      ...by.map((b) => ({ name: b.name, type: /BUCKET|DATE_TRUNC/i.test(b.expr) ? "date" : typeOfField(b.expr) })),
    ];
    const timeBy = by.find((b) => /BUCKET|DATE_TRUNC/i.test(b.expr));
    const catBy = by.filter((b) => b !== timeBy);
    const times: (string | null)[] = timeBy
      ? Array.from({ length: 24 }, (_, i) => new Date(Date.now() - (23 - i) * 3600e3).toISOString().replace(/:\d\d\.\d+Z$/, ":00.000Z"))
      : [null];
    const cats: (string | null)[] = catBy.length ? valuesFor(catBy[0].expr, timeBy ? 3 : 6) : [null];
    const values: unknown[][] = [];
    for (const t of times) {
      for (const [ci, c] of cats.entries()) {
        const spike = t && times.indexOf(t) >= 14 && times.indexOf(t) <= 17 && ci === 0 ? 8 : 1;
        const row: unknown[] = aggs.map((a, ai) => {
          const base = /COUNT/i.test(a.expr) ? Math.round((40 + rand() * 30) * spike * (timeBy ? 1 : 30 / (ci + 1))) : Math.round((120 + rand() * 80) * 100) / 100;
          return ai === 0 ? base : Math.round(base * 0.3);
        });
        if (timeBy) row.push(t);
        for (const _ of catBy) row.push(c);
        values.push(row);
      }
    }
    const reordered = values.map((r) => {
      // columns order: aggs, then BY in declared order
      const out = r.slice(0, aggs.length);
      let k = aggs.length;
      for (const b of by) out.push(b === timeBy ? r[k++] : r[k++]);
      return out;
    });
    return { status: 200, body: { columns, values: reordered.slice(0, limit), took: 12 } };
  }

  const cols = keep
    ? keep.replace(/^KEEP\s+/i, "").split(",").map((s) => s.trim())
    : FIELDS.map(([n]) => n);
  const n = Math.min(limit, 25);
  const values = Array.from({ length: n }, (_, i) =>
    cols.map((c) => {
      const t = typeOfField(c);
      if (t === "date") return new Date(Date.now() - i * 37e3).toISOString();
      if (c.includes("status")) return [500, 502, 503, 504][i % 4];
      if (t === "long") return Math.round(rand() * 900);
      if (c.includes("service")) return SERVICES[i % 3];
      if (c.includes("path")) return PATHS[i % 4];
      if (c === "message") return ["upstream timeout: payments-gw", "connection pool exhausted", "NullPointerException in OrderMapper"][i % 3];
      return `${c}-${i}`;
    }),
  );
  return { status: 200, body: { columns: cols.map((c) => ({ name: c, type: typeOfField(c) })), values, took: 8 } };
}

// ---- in-memory dashboards index ----
const docs = new Map<string, any>();

app.get("/", (_req, res) => {
  res.json({ name: "mock", version: { number: process.env.MOCK_ES_VERSION ?? "9.2.0" }, tagline: "You Know, for Search" });
});

app.post("/_security/user/_has_privileges", (req, res) => {
  const index: Record<string, Record<string, boolean>> = {};
  for (const e of req.body.index ?? []) {
    for (const name of e.names) {
      index[name] = {};
      for (const p of e.privileges) index[name][p] = name === DASH ? p === "read" || WRITE : p === "read";
    }
  }
  res.json({ username: "mock-key", has_all_requested: false, index });
});

app.post("/_query", (req, res) => {
  const out = esql(String(req.body.query ?? ""));
  res.status(out.status).json(out.body);
});

const idxGuard = (req: express.Request, res: express.Response) => {
  if (NO_INDEX || req.params.index !== DASH) {
    res.status(404).json({ error: { type: "index_not_found_exception", reason: `no such index [${req.params.index}]` } });
    return false;
  }
  return true;
};

app.post("/:index/_search", (req, res) => {
  if (!idxGuard(req, res)) return;
  const q = req.body.query ?? {};
  let hits = [...docs.values()];
  if (q.match_phrase?.dashboard_id) hits = hits.filter((d) => d.dashboard_id === q.match_phrase.dashboard_id);
  if (q.multi_match?.query) {
    const s = String(q.multi_match.query).toLowerCase();
    hits = hits.filter((d) => `${d.title} ${d.notes}`.toLowerCase().includes(s));
  }
  const sortField = Object.keys(req.body.sort?.[0] ?? { saved_at: 1 })[0];
  hits.sort((a, b) => (a[sortField] < b[sortField] ? 1 : -1));
  res.json({ hits: { total: { value: hits.length }, hits: hits.slice(0, req.body.size ?? 10).map((d) => ({ _source: d })) } });
});

app.get("/:index/_doc/:id", (req, res) => {
  if (!idxGuard(req, res)) return;
  const d = docs.get(req.params.id);
  if (!d) return res.status(404).json({ found: false });
  res.json({ found: true, _source: d });
});

app.put("/:index/_create/:id", (req, res) => {
  if (!idxGuard(req, res)) return;
  if (!WRITE) return res.status(403).json({ error: { type: "security_exception", reason: "action [indices:data/write/index] is unauthorized" } });
  if (docs.has(req.params.id)) return res.status(409).json({ error: { type: "version_conflict_engine_exception", reason: "document already exists" } });
  docs.set(req.params.id, req.body);
  res.status(201).json({ result: "created", _id: req.params.id });
});

// Like Elasticsearch: unknown paths (e.g. Kibana's /app/discover) → "no handler found".
app.use((req, res) => {
  res.status(400).json({
    error: { type: "illegal_argument_exception", reason: `no handler found for uri [${req.path}] and method [${req.method}]` },
    status: 400,
  });
});

app.listen(PORT, () => console.log(`mock elasticsearch on http://localhost:${PORT} (write=${WRITE})`));

// ---- fake Kibana (version probe + Dashboards API) ----
const kibana = express();
kibana.use(express.json({ limit: "5mb" }));
const KIBANA_VERSION = process.env.MOCK_KIBANA_VERSION ?? "9.2.0";
kibana.get(["/api/status", "/s/:space/api/status"], (_req, res) => {
  res.json({ version: { number: KIBANA_VERSION } });
});
kibana.put(["/api/dashboards/:id", "/s/:space/api/dashboards/:id"], (req, res) => {
  if (req.headers["kbn-xsrf"] !== "true") return res.status(400).json({ message: "missing kbn-xsrf" });
  console.log("kibana dashboard", req.params.id, JSON.stringify(req.body).slice(0, 2000));
  res.json({ id: req.params.id });
});
// Console proxy (what Dev Tools uses): forwards to the mock Elasticsearch above.
kibana.post("/api/console/proxy", async (req, res) => {
  if (req.headers["kbn-xsrf"] === undefined) return res.status(400).json({ statusCode: 400, error: "Bad Request", message: "Request must contain a kbn-xsrf header." });
  if (!String(req.headers.authorization ?? "").startsWith("ApiKey "))
    return res.status(401).json({ statusCode: 401, error: "Unauthorized", message: "Unauthorized" });
  if (process.env.MOCK_NO_DEVTOOLS === "1")
    return res.status(403).json({ statusCode: 403, error: "Forbidden", message: "Forbidden" });
  const p = String(req.query.path ?? "");
  const method = String(req.query.method ?? "GET").toUpperCase();
  const r = await fetch(`http://localhost:${PORT}/${p.replace(/^\//, "")}`, {
    method,
    headers: { "content-type": "application/json", authorization: String(req.headers.authorization) },
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(req.body ?? {}),
  });
  res.status(r.status).setHeader("content-type", "application/json").send(await r.text());
});
const KPORT = Number(process.env.MOCK_KIBANA_PORT ?? 5601);
kibana.listen(KPORT, () => console.log(`mock kibana ${KIBANA_VERSION} on http://localhost:${KPORT}`));
