import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config } from "./config";
import { HttpError, runEsql } from "./elastic";
import { getCapabilities } from "./capabilities";
import { getDashboard, listDashboards, listVersions, saveDashboard } from "./library";
import { exportToKibana } from "./kibanaExport";
import { runAgent } from "./agent";
import { listModels, resolveModel } from "./llm";
import { adminRouter } from "./admin";
import { RecipeSchema, TIME_RANGE_KEYS, type ChatEvent, type TimeRangeKey } from "../shared/recipe";

/**
 * Stateless server: no sessions, no database, nothing kept between requests.
 * Conversations live in the browser, recipes live in URLs / JSON files / the
 * ai-dashboards index, data lives in Elasticsearch.
 */
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

// Optional basic auth — read on every request, so changing it in the admin panel applies at once.
app.use((req, res, next) => {
  if (!config.basicAuth || req.path === "/api/health") return next();
  const expected = "Basic " + Buffer.from(config.basicAuth).toString("base64");
  if (req.headers.authorization === expected) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="Logs Studio"').status(401).send("Authentication required");
});

const RangeSchema = z.enum(TIME_RANGE_KEYS as [TimeRangeKey, ...TimeRangeKey[]]).default("24h");

type Handler = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

async function requireLibrary(mode: "read" | "write") {
  const caps = await getCapabilities();
  const ok = mode === "read" ? caps.library.read : caps.library.write;
  if (!ok) throw new HttpError(403, caps.library.reason ?? `The dashboards library is not available for ${mode}`);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get(
  "/api/capabilities",
  route(async (req, res) => {
    res.json(await getCapabilities(req.query.refresh === "1"));
  }),
);

app.get(
  "/api/models",
  route(async (req, res) => {
    res.json(await listModels(req.query.refresh === "1"));
  }),
);

app.use("/api/admin", adminRouter);

app.post(
  "/api/query",
  route(async (req, res) => {
    const body = z.object({ esql: z.string().min(1).max(4000), time_range: RangeSchema }).parse(req.body);
    const ctrl = new AbortController();
    res.on("close", () => !res.writableEnded && ctrl.abort());
    res.json(await runEsql(body.esql, body.time_range, { signal: ctrl.signal }));
  }),
);

app.post(
  "/api/chat",
  route(async (req, res) => {
    const body = z
      .object({
        messages: z
          .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20000) }))
          .min(1)
          .max(60),
        recipe: z.unknown().optional(),
        time_range: RangeSchema,
        model: z.string().max(200).optional(),
      })
      .parse(req.body);
    const parsed = body.recipe ? RecipeSchema.safeParse(body.recipe) : null;
    const model = await resolveModel(body.model); // before streaming, so a bad model is a normal 400

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const ctrl = new AbortController();
    res.on("close", () => !res.writableEnded && ctrl.abort());
    const emit = (e: ChatEvent) => {
      if (!res.writableEnded) res.write(JSON.stringify(e) + "\n");
    };
    try {
      await runAgent({
        messages: body.messages.slice(-30),
        recipe: parsed?.success ? parsed.data : null,
        range: body.time_range,
        model,
        signal: ctrl.signal,
        emit,
      });
    } catch (err: any) {
      if (!ctrl.signal.aborted) {
        const status = err?.status ? ` (HTTP ${err.status})` : "";
        emit({ type: "error", message: `${err?.message ?? "Unexpected error"}${status}` });
      }
    }
    emit({ type: "done" });
    res.end();
  }),
);

app.get(
  "/api/dashboards",
  route(async (req, res) => {
    await requireLibrary("read");
    res.json(await listDashboards(typeof req.query.q === "string" ? req.query.q : undefined));
  }),
);

app.get(
  "/api/dashboards/:id/versions",
  route(async (req, res) => {
    await requireLibrary("read");
    res.json(await listVersions(String(req.params.id)));
  }),
);

app.get(
  "/api/dashboards/:id",
  route(async (req, res) => {
    await requireLibrary("read");
    const v = req.query.version ? Number(req.query.version) : undefined;
    res.json(await getDashboard(String(req.params.id), Number.isFinite(v) ? v : undefined));
  }),
);

app.post(
  "/api/dashboards",
  route(async (req, res) => {
    await requireLibrary("write");
    const body = z.object({ recipe: RecipeSchema, mode: z.enum(["new", "update", "fork"]) }).parse(req.body);
    res.json(await saveDashboard(body.recipe, body.mode));
  }),
);

app.post(
  "/api/export/kibana",
  route(async (req, res) => {
    const caps = await getCapabilities();
    if (!caps.kibanaExport.enabled) throw new HttpError(403, caps.kibanaExport.reason ?? "Kibana export is not available");
    const body = z.object({ recipe: RecipeSchema }).parse(req.body);
    res.json(await exportToKibana(body.recipe));
  }),
);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Serve the built web app in production.
const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = [path.join(here, "web"), path.join(here, "../../dist/web")].find((d) => existsSync(d));
if (webDir) {
  app.use(express.static(webDir, { index: false, maxAge: "1h" }));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(webDir, "index.html")));
}

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  }
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: err?.message ?? "Unexpected error" });
});

app.listen(config.port, () => {
  console.log(`Logs Studio listening on http://localhost:${config.port}`);
  console.log(
    config.elastic.connection === "kibana"
      ? `  Elasticsearch: through Kibana at ${config.kibana.url}  ·  patterns: ${config.elastic.logPatterns.join(", ")}`
      : `  Elasticsearch: ${config.elastic.url}  ·  patterns: ${config.elastic.logPatterns.join(", ")}`,
  );
  console.log(`  LLM: ${config.llm.baseUrl || "(not set)"}  ·  model: ${config.llm.model || "(not set)"}`);
  console.log(`  Admin panel: ${config.adminPassword ? "enabled" : "disabled (set ADMIN_PASSWORD)"}`);
});
