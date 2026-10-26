import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config, hasEnv, MAIN_ENV, withEnv } from "./config";
import { HttpError, deployEvents, runEsql } from "./elastic";
import { getCapabilities } from "./capabilities";
import { getDashboard, listDashboards, listVersions, saveDashboard } from "./library";
import { exportToKibana } from "./kibanaExport";
import { runAgent } from "./agent";
import { listModels, resolveModel } from "./llm";
import { adminRouter } from "./admin";
import { log, logLevel, requestId, safeHost, setLogEnv, withRequest } from "./log";
import { RecipeSchema, TIME_RANGE_KEYS, type ChatEvent, type TimeRangeKey } from "../shared/recipe";

/**
 * Stateless server: no sessions, no database, nothing kept between requests.
 * Conversations live in the browser, recipes live in URLs / JSON files / the
 * ai-dashboards index, data lives in Elasticsearch.
 */
const app = express();
app.disable("x-powered-by");

// Request id + one log line per request (info for the API, debug for static files).
app.use((req, res, next) => {
  withRequest(() => {
    const t0 = process.hrtime.bigint();
    const isApi = req.path.startsWith("/api/");
    res.setHeader("x-request-id", requestId() ?? "");
    res.on("finish", () => {
      const fullPath = req.originalUrl.split("?")[0];
      if (fullPath === "/api/health") return;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const fields = {
        status: res.statusCode,
        ms: Math.round(ms),
        ...(isApi && req.query && Object.keys(req.query).length ? { query: req.query } : {}),
      };
      const line = `http ${req.method} ${fullPath}`;
      if (res.statusCode >= 500) log.error(line, fields);
      else if (res.statusCode >= 400) log.warn(line, fields);
      else if (isApi) log.info(line, fields);
      else log.debug(line, fields);
    });
    res.on("close", () => {
      if (!res.writableEnded) log.info(`http ${req.method} ${req.originalUrl.split("?")[0]} cancelled by client`);
    });
    next();
  });
});

app.use(express.json({ limit: "2mb" }));

// Optional basic auth — read on every request, so changing it in the admin panel applies at once.
app.use((req, res, next) => {
  if (!config.basicAuth || req.path === "/api/health") return next();
  const expected = "Basic " + Buffer.from(config.basicAuth).toString("base64");
  if (req.headers.authorization === expected) return next();
  if (req.headers.authorization) log.warn("auth.basic_rejected", { ip: req.ip });
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

// Every API call runs against one environment, chosen by the browser (x-env header).
app.use("/api", (req, res, next) => {
  const id = String(req.headers["x-env"] ?? "") || MAIN_ENV;
  if (!hasEnv(id)) {
    res.status(400).json({ error: `Unknown environment "${id}"` });
    return;
  }
  setLogEnv(id);
  withEnv(id, () => next());
});

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
    const body = z
      .object({
        esql: z.string().min(1).max(4000),
        time_range: RangeSchema,
        /** Run the same query on an earlier period, for comparisons. */
        compare: z.enum(["previous", "week"]).optional(),
        /** For "download CSV": up to EXPORT_MAX_ROWS rows instead of MAX_ROWS. */
        export: z.boolean().optional(),
      })
      .parse(req.body);
    const ctrl = new AbortController();
    res.on("close", () => !res.writableEnded && ctrl.abort());
    const cap = body.export ? Math.max(config.elastic.exportMaxRows, config.elastic.maxRows) : undefined;
    const result = await runEsql(body.esql, body.time_range, { signal: ctrl.signal, compare: body.compare, cap });
    if (body.export) log.info("export.csv", { rows: result.values.length, truncated: result.truncated || undefined });
    res.json(result);
  }),
);

/** Deploy / change events for chart annotations (empty when DEPLOY_QUERY isn't set). */
app.get(
  "/api/annotations",
  route(async (req, res) => {
    const range = RangeSchema.parse(req.query.time_range ?? "24h");
    if (!config.elastic.deployQuery) {
      res.json({ enabled: false, events: [] });
      return;
    }
    try {
      res.json({ enabled: true, events: await deployEvents(range) });
    } catch (err: any) {
      res.json({ enabled: true, events: [], error: err.message });
    }
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
    // Proxies / ingresses in front of the app often close a response that stays silent for 30-60s
    // (the browser then shows "network error"). A small line every 10s keeps the stream alive.
    const heartbeat = setInterval(() => emit({ type: "ping" }), 10_000);
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
        emit({ type: "error", message: `${err?.message ?? "Unexpected error"}${status} · req ${requestId()}` });
      }
    } finally {
      clearInterval(heartbeat);
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
  if (status >= 500) log.error("request.failed", { status, error: err?.message, stack: err?.stack });
  else log.debug("request.rejected", { status, error: err?.message });
  if (res.headersSent) return res.end();
  res.status(status).json({ error: err?.message ?? "Unexpected error" });
});

process.on("unhandledRejection", (reason: any) => {
  log.error("process.unhandled_rejection", { error: reason?.message ?? String(reason), stack: reason?.stack });
});
process.on("uncaughtException", (err) => {
  log.error("process.uncaught_exception", { error: err.message, stack: err.stack });
});

app.listen(config.port, () => {
  log.info("server.started", { port: config.port, logLevel: logLevel(), admin: Boolean(config.adminPassword) });
  for (const env of config.environments) {
    log.info("server.environment", {
      id: env.id,
      name: env.name,
      connection: env.elastic.connection,
      elastic: env.elastic.connection === "direct" ? safeHost(env.elastic.url) : undefined,
      kibana: safeHost(env.kibana.url),
      space: env.kibana.space || undefined,
      indices: env.elastic.logPatterns.join(","),
      apiKey: env.elastic.apiKey ? "set" : "missing",
      deployQuery: env.elastic.deployQuery ? "set" : undefined,
    });
  }
  log.info("server.llm", {
    url: safeHost(config.llm.baseUrl) ?? "(not set)",
    model: config.llm.model || "(not set)",
    models: config.llm.models.length ? config.llm.models.join(",") : "all",
    stream: config.llm.stream,
    maxSteps: config.llm.maxSteps,
  });
});
