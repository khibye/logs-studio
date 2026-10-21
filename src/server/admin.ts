import { Router, type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { config, rebuildConfig } from "./config";
import { settingsView, storageInfo, updateSettings } from "./settings";
import { getCapabilities } from "./capabilities";
import { listAvailableModels, listModels } from "./llm";
import { log } from "./log";

/**
 * Admin API. Enabled only when ADMIN_PASSWORD is set in the environment.
 * The browser sends the password in the x-admin-password header on each call
 * (kept in sessionStorage) — no server-side sessions.
 */
export const adminRouter = Router();

function same(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!config.adminPassword) {
    res.status(403).json({ error: "פאנל הניהול כבוי. כדי להפעיל אותו מגדירים את משתנה הסביבה ADMIN_PASSWORD." });
    return;
  }
  const given = String(req.headers["x-admin-password"] ?? "");
  if (!given || !same(given, config.adminPassword)) {
    log.warn("admin.login_failed", { ip: req.ip, path: req.path });
    await sleep(600); // slow down guessing
    res.status(401).json({ error: "סיסמה שגויה" });
    return;
  }
  next();
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

adminRouter.use(requireAdmin);

/** Checks the password (the middleware already did). */
adminRouter.post("/login", (_req, res) => {
  res.json({ ok: true });
});

adminRouter.get("/settings", (_req, res) => {
  res.json({ settings: settingsView(), storage: storageInfo() });
});

adminRouter.put(
  "/settings",
  wrap(async (req, res) => {
    const body = z.object({ values: z.record(z.string(), z.string().nullable()) }).parse(req.body);
    try {
      updateSettings(body.values);
    } catch (err: any) {
      log.warn("admin.settings_rejected", { keys: Object.keys(body.values).join(","), fields: err.fields, error: err.message });
      res.status(err.status ?? 500).json({ error: err.message, fields: err.fields });
      return;
    }
    // Keys only — values (which may be secrets) are never logged.
    log.info("admin.settings_saved", {
      changed: Object.entries(body.values)
        .map(([k, v]) => (v === null ? `${k}(reset)` : k))
        .join(","),
      ip: req.ip,
    });
    rebuildConfig();
    res.json({ settings: settingsView(), storage: storageInfo() });
  }),
);

/** Re-checks the connections with the current settings. */
adminRouter.post(
  "/test",
  wrap(async (_req, res) => {
    const [capabilities, models, available] = await Promise.all([
      getCapabilities(true),
      listModels(true),
      listAvailableModels(),
    ]);
    res.json({ capabilities, models, available });
  }),
);
