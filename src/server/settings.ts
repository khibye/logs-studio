import "dotenv/config";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { log } from "./log";

/**
 * Runtime settings, editable from the admin panel.
 *
 * Every setting has an environment variable of the same name. The effective
 * value is: admin override (settings.json) → environment variable → default.
 * Removing an override falls back to the environment again, so the env /
 * .env file stays the base configuration and the file only holds changes.
 *
 * The file lives in DATA_DIR (default ./data). Put it on a persistent volume,
 * otherwise overrides are lost when the pod restarts (the app keeps working
 * on the environment values). It is re-read when it changes on disk, so
 * replicas sharing one volume pick up each other's changes.
 */

export type SettingKind = "string" | "url" | "secret" | "number" | "boolean" | "list" | "text" | "enum" | "environments";
export type SettingGroup = "elastic" | "kibana" | "envs" | "llm" | "app";

export type SettingDef = {
  key: string;
  group: SettingGroup;
  kind: SettingKind;
  label: string;
  help?: string;
  default?: string;
  options?: string[];
  min?: number;
};

export const MAIN_ENV = "main";

export const SETTINGS: SettingDef[] = [
  // ---- Main environment: Elasticsearch ----
  { key: "ENV_NAME", group: "elastic", kind: "string", default: "ראשית", label: "שם הסביבה", help: "השם שמופיע בבורר הסביבות." },
  {
    key: "ELASTIC_CONNECTION",
    group: "elastic",
    kind: "enum",
    options: ["auto", "direct", "kibana"],
    default: "auto",
    label: "אופן החיבור לנתונים",
    help: "direct: ישירות ל-Elasticsearch. kibana: דרך Kibana (כשיש רק כתובת Kibana; דורש הרשאת Dev Tools). auto: ישיר אם הוגדרה כתובת Elasticsearch, אחרת דרך Kibana.",
  },
  { key: "ELASTIC_URL", group: "elastic", kind: "url", label: "כתובת Elasticsearch", help: "ריק = אין גישה ישירה. ב-Kibana: תפריט העזרה ← Connection details." },
  { key: "ELASTIC_API_KEY", group: "elastic", kind: "secret", label: "API key", help: "בפורמט Encoded. משמש גם לחיבור דרך Kibana." },
  { key: "LOG_INDEX_PATTERNS", group: "elastic", kind: "list", default: "logs-*", label: "אינדקסים מותרים", help: "מופרד בפסיקים. אינדקס אחד = המודל עובד רק עליו." },
  { key: "TIME_FIELD", group: "elastic", kind: "string", default: "@timestamp", label: "שדה הזמן" },
  {
    key: "LOG_CONTEXT",
    group: "elastic",
    kind: "text",
    label: "תיאור הנתונים למודל",
    help: "מה כל שדה אומר, איך מזהים שגיאה, יחידות מידה. נשלח למודל בכל שיחה.",
  },
  {
    key: "DEPLOY_QUERY",
    group: "elastic",
    kind: "text",
    label: "שאילתת פריסות (ES|QL)",
    help: "שאילתה שמחזירה אירועי פריסה או שינוי: עמודת זמן, ועמודות שיוצגו כתיאור. למשל: FROM deploys-* | KEEP @timestamp, service.name, version. מוצגות כקווים על גרפי הזמן.",
  },
  { key: "DASHBOARDS_INDEX", group: "elastic", kind: "string", default: "ai-dashboards", label: "אינדקס הספרייה המשותפת" },
  { key: "MAX_ROWS", group: "elastic", kind: "number", default: "1000", min: 1, label: "מקסימום שורות לשאילתה" },
  {
    key: "QUERY_TIMEOUT_MS",
    group: "elastic",
    kind: "number",
    default: "30000",
    min: 1000,
    label: "זמן המתנה לשאילתה (מילישניות)",
    help: "בחיבור דרך Kibana יש גם מגבלה של Kibana עצמו (בדרך כלל 30 שניות).",
  },

  // ---- Kibana ----
  { key: "KIBANA_URL", group: "kibana", kind: "url", label: "כתובת Kibana", help: "ל-Discover, לחיבור דרך Kibana ולייצוא דשבורדים." },
  { key: "KIBANA_PUBLIC_URL", group: "kibana", kind: "url", label: "כתובת Kibana לדפדפן", help: "רק אם הדפדפן מגיע ל-Kibana בכתובת אחרת מהשרת." },
  { key: "KIBANA_SPACE", group: "kibana", kind: "string", label: "Space" },
  { key: "KIBANA_API_KEY", group: "kibana", kind: "secret", label: "API key ל-Kibana", help: "ריק = אותו מפתח של Elasticsearch." },
  { key: "KIBANA_EXPORT", group: "kibana", kind: "enum", options: ["auto", "off"], default: "auto", label: "ייצוא לדשבורד Kibana", help: "auto: פעיל רק ב-9.4 ומעלה." },

  // ---- More environments ----
  {
    key: "ENVIRONMENTS",
    group: "envs",
    kind: "environments",
    label: "סביבות נוספות",
    help: "כל סביבה היא Elasticsearch + Kibana נפרדים. שדות שנשארים ריקים באינדקסים, שדה הזמן ותיאור הנתונים לוקחים את הערך של הסביבה הראשית.",
  },

  // ---- LLM ----
  { key: "LLM_BASE_URL", group: "llm", kind: "url", label: "כתובת ה-API", help: "תואם OpenAI, למשל https://host/v1" },
  { key: "LLM_API_KEY", group: "llm", kind: "secret", label: "API key" },
  { key: "LLM_MODEL", group: "llm", kind: "string", label: "מודל ברירת מחדל" },
  {
    key: "LLM_MODELS",
    group: "llm",
    kind: "list",
    label: "מודלים לבחירה בצ'אט",
    help: "ריק = כל המודלים שהמפתח מחזיר (בלי מודלי embedding וכד'). אפשר לצמצם לרשימה מופרדת בפסיקים.",
  },
  { key: "LLM_STREAM", group: "llm", kind: "boolean", default: "true", label: "Streaming", help: "לכבות אם השרת מתקשה עם streaming של tool calls." },
  { key: "LLM_MAX_STEPS", group: "llm", kind: "number", default: "14", min: 1, label: "מקסימום צעדים לשאלה" },
  { key: "LLM_TEMPERATURE", group: "llm", kind: "number", default: "0.2", min: 0, label: "Temperature" },

  // ---- App ----
  {
    key: "LIBRARY_ENV",
    group: "app",
    kind: "string",
    default: MAIN_ENV,
    label: "סביבת הספרייה המשותפת",
    help: 'מזהה הסביבה שבה נשמרים הדשבורדים (באינדקס הספרייה). כל הסביבות משתמשות באותה ספרייה. "main" = הסביבה הראשית.',
  },
  {
    key: "CHAT_RETENTION_HOURS",
    group: "app",
    kind: "number",
    default: "24",
    min: 0,
    label: "שמירת שיחות בדפדפן (שעות)",
    help: "0 = לא נשמרות. השיחות נשמרות רק בדפדפן של כל משתמש.",
  },
  {
    key: "LOG_LEVEL",
    group: "app",
    kind: "enum",
    options: ["error", "warn", "info", "debug"],
    default: "info",
    label: "רמת לוגים",
    help: "info: כל בקשה, כל שיחה וכל צעד של המודל. debug: גם כל שאילתה ל-Elasticsearch וכל קריאה למודל, עם זמנים. מפתחות וסיסמאות לא נכתבים ללוג.",
  },
  {
    key: "LOG_FORMAT",
    group: "app",
    kind: "enum",
    options: ["text", "json"],
    default: "text",
    label: "פורמט לוגים",
    help: "json: אובייקט אחד בכל שורה, למערכות איסוף לוגים",
  },
  {
    key: "APP_BASIC_AUTH",
    group: "app",
    kind: "secret",
    label: "סיסמת כניסה לאפליקציה",
    help: 'בפורמט user:password. ריק = בלי סיסמה. שימי לב: טעות כאן נועלת גם את פאנל הניהול (תיקון: מחיקת settings.json).',
  },
];

const DEF = new Map(SETTINGS.map((d) => [d.key, d]));

export function defaultOf(key: string): string | undefined {
  return DEF.get(key)?.default;
}

/** Fields an additional environment can set. Same names and meaning as the main environment's settings. */
export const ENV_FIELDS = [
  "ELASTIC_CONNECTION",
  "ELASTIC_URL",
  "ELASTIC_API_KEY",
  "KIBANA_URL",
  "KIBANA_PUBLIC_URL",
  "KIBANA_SPACE",
  "KIBANA_API_KEY",
  "LOG_INDEX_PATTERNS",
  "TIME_FIELD",
  "LOG_CONTEXT",
  "DEPLOY_QUERY",
] as const;
/** Left empty in an additional environment → taken from the main environment. */
export const ENV_INHERITED = new Set(["LOG_INDEX_PATTERNS", "TIME_FIELD", "LOG_CONTEXT", "DEPLOY_QUERY"]);

export type EnvDef = { id: string; name: string } & Partial<Record<(typeof ENV_FIELDS)[number], string>>;

/** Parses the ENVIRONMENTS setting (a JSON array). Never throws: a bad value means "no extra environments". */
export function parseEnvironments(raw: string | undefined): EnvDef[] {
  if (!raw?.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e.id === "string" && typeof e.name === "string")
      .map((e) => {
        const out: EnvDef = { id: e.id, name: e.name };
        for (const f of ENV_FIELDS) if (typeof e[f] === "string" && e[f] !== "") out[f] = e[f];
        return out;
      });
  } catch (err: any) {
    log.warn("settings.environments_invalid_json", { error: err.message });
    return [];
  }
}

function maskEnvironments(raw: string): string {
  const envs = parseEnvironments(raw).map((e) => {
    const copy: EnvDef = { ...e };
    for (const f of ENV_FIELDS) if (DEF.get(f)?.kind === "secret" && copy[f]) copy[f] = mask(copy[f]);
    return copy;
  });
  return envs.length ? JSON.stringify(envs) : "";
}

// ---------------------------------------------------------------------------

export const dataDir = path.resolve(process.env.DATA_DIR || "./data");
export const settingsFile = path.join(dataDir, "settings.json");

type FileShape = { version: 1; updated_at: string; values: Record<string, string> };

let overrides: Record<string, string> = {};
let fileMtime = 0;
let fileError: string | undefined;
let updatedAt: string | undefined;

function readFile() {
  try {
    if (!existsSync(settingsFile)) {
      overrides = {};
      fileMtime = 0;
      updatedAt = undefined;
      fileError = undefined;
      return;
    }
    const st = statSync(settingsFile);
    const parsed = JSON.parse(readFileSync(settingsFile, "utf8")) as Partial<FileShape>;
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.values ?? {})) if (DEF.has(k) && typeof v === "string") values[k] = v;
    overrides = values;
    fileMtime = st.mtimeMs;
    updatedAt = parsed.updated_at;
    fileError = undefined;
  } catch (err: any) {
    // Keep the last good values; never crash the app over a bad file.
    fileError = `Could not read ${settingsFile}: ${err.message}`;
    log.warn("settings.file_unreadable", { file: settingsFile, error: err.message });
  }
}
readFile();

/** Re-reads the file if another process / replica changed it. Returns true if it changed. */
export function reloadIfChanged(): boolean {
  try {
    const m = existsSync(settingsFile) ? statSync(settingsFile).mtimeMs : 0;
    if (m === fileMtime) return false;
  } catch {
    return false;
  }
  readFile();
  return true;
}

let contextFileCache: { at: number; text?: string } = { at: 0 };

/** LOG_CONTEXT_FILE content (re-read at most every 10 s). */
function contextFromFile(): string | undefined {
  const f = process.env.LOG_CONTEXT_FILE;
  if (!f) return undefined;
  if (Date.now() - contextFileCache.at < 10_000) return contextFileCache.text;
  try {
    contextFileCache = { at: Date.now(), text: readFileSync(f, "utf8") };
  } catch (err: any) {
    log.warn("settings.log_context_file_unreadable", { file: f, error: err.message });
    contextFileCache = { at: Date.now(), text: undefined };
  }
  return contextFileCache.text;
}

/** Value without admin overrides: environment (or LOG_CONTEXT_FILE) → default. */
function baseValue(key: string): string | undefined {
  if (key === "LOG_CONTEXT") {
    const fromFile = contextFromFile();
    if (fromFile !== undefined) return fromFile;
  }
  const env = process.env[key];
  if (env !== undefined && env !== "") return env;
  return DEF.get(key)?.default;
}

/** Effective raw value of a setting, or undefined if unset everywhere. */
export function rawValue(key: string): string | undefined {
  if (key in overrides) return overrides[key];
  return baseValue(key);
}

export type SettingSource = "admin" | "env" | "file" | "default" | "unset";

function sourceOf(key: string): SettingSource {
  if (key in overrides) return "admin";
  if (key === "LOG_CONTEXT" && process.env.LOG_CONTEXT_FILE) return "file";
  const env = process.env[key];
  if (env !== undefined && env !== "") return "env";
  return DEF.get(key)?.default !== undefined ? "default" : "unset";
}

export function mask(v: string | undefined): string {
  if (!v) return "";
  return v.length > 10 ? `••••${v.slice(-4)}` : "••••";
}

export type SettingView = SettingDef & {
  /** Effective value; masked for secrets. */
  value: string;
  /** Value from the environment / file / default (what "reset" falls back to); masked for secrets. */
  fallback: string;
  source: SettingSource;
  isSet: boolean;
};

export function settingsView(): SettingView[] {
  return SETTINGS.map((d) => {
    const eff = rawValue(d.key) ?? "";
    const fb = baseValue(d.key) ?? "";
    const secret = d.kind === "secret";
    const show = (v: string) => (secret ? mask(v) : d.kind === "environments" ? maskEnvironments(v) : v);
    return {
      ...d,
      value: show(eff),
      fallback: show(fb),
      source: sourceOf(d.key),
      isSet: eff !== "",
    };
  });
}

export function storageInfo() {
  let writable = false;
  try {
    mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, `.write-test-${process.pid}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    writable = true;
  } catch {}
  return {
    file: settingsFile,
    exists: existsSync(settingsFile),
    writable,
    overrides: Object.keys(overrides).length,
    updated_at: updatedAt,
    error: fileError,
  };
}

function validate(def: SettingDef, v: string): string | null {
  const s = v.trim();
  switch (def.kind) {
    case "number": {
      const n = Number(s);
      if (s === "" || !Number.isFinite(n)) return "צריך להיות מספר";
      if (def.min !== undefined && n < def.min) return `המינימום הוא ${def.min}`;
      return null;
    }
    case "url":
      if (s === "") return null;
      try {
        const u = new URL(s);
        return u.protocol === "http:" || u.protocol === "https:" ? null : "צריך להתחיל ב-http:// או https://";
      } catch {
        return "כתובת לא תקינה";
      }
    case "boolean":
      return s === "true" || s === "false" ? null : "true או false";
    case "enum":
      return def.options?.includes(s) ? null : `אחד מ: ${def.options?.join(", ")}`;
    case "secret":
      if (def.key === "APP_BASIC_AUTH" && s && !/^[^:]+:.+$/.test(s)) return "בפורמט user:password";
      return null;
    default:
      return null;
  }
}

/**
 * Validates an ENVIRONMENTS value from the admin panel and fills in secrets the
 * browser left empty ("keep the current key") from the current value.
 * Returns [normalised JSON, error].
 */
function normaliseEnvironments(value: string): [string, string | null] {
  if (!value.trim()) return ["", null];
  let arr: any;
  try {
    arr = JSON.parse(value);
  } catch {
    return ["", "JSON לא תקין"];
  }
  if (!Array.isArray(arr)) return ["", "צריך להיות רשימה"];
  if (arr.length > 20) return ["", "עד 20 סביבות"];
  const previous = new Map(parseEnvironments(rawValue("ENVIRONMENTS")).map((e) => [e.id, e]));
  const seen = new Set<string>();
  const out: EnvDef[] = [];
  for (const [i, e] of arr.entries()) {
    const where = `סביבה ${i + 1}${e?.name ? ` (${e.name})` : ""}`;
    if (!e || typeof e !== "object") return ["", `${where}: לא תקינה`];
    const id = String(e.id ?? "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) return ["", `${where}: מזהה צריך להיות באותיות אנגליות קטנות, ספרות, - או _`];
    if (id === MAIN_ENV) return ["", `${where}: המזהה "${MAIN_ENV}" שמור לסביבה הראשית`];
    if (seen.has(id)) return ["", `${where}: המזהה "${id}" כבר קיים`];
    seen.add(id);
    const name = String(e.name ?? "").trim();
    if (!name || name.length > 60) return ["", `${where}: צריך שם (עד 60 תווים)`];
    const env: EnvDef = { id, name };
    for (const key of Object.keys(e)) {
      if (key === "id" || key === "name") continue;
      if (!(ENV_FIELDS as readonly string[]).includes(key)) return ["", `${where}: שדה לא מוכר ${key}`];
    }
    for (const f of ENV_FIELDS) {
      const def = DEF.get(f)!;
      let v = typeof e[f] === "string" ? e[f].trim() : "";
      if (def.kind === "secret" && !v) v = previous.get(id)?.[f] ?? "";
      if (!v) continue;
      const err = validate(def, v);
      if (err) return ["", `${where}: ${def.label}: ${err}`];
      env[f] = def.kind === "url" ? v.replace(/\/+$/, "") : v;
    }
    if (!env.ELASTIC_URL && !env.KIBANA_URL) return ["", `${where}: צריך כתובת Elasticsearch או Kibana`];
    out.push(env);
  }
  return [out.length ? JSON.stringify(out) : "", null];
}

/**
 * Applies changes: a string sets an override, null removes it (back to env).
 * Throws with per-key errors if anything is invalid; nothing is written then.
 */
export function updateSettings(changes: Record<string, string | null>) {
  const errors: Record<string, string> = {};
  const next = { ...overrides };
  for (const [key, value] of Object.entries(changes)) {
    const def = DEF.get(key);
    if (!def) {
      errors[key] = "הגדרה לא מוכרת";
      continue;
    }
    if (value === null) {
      delete next[key];
      continue;
    }
    if (typeof value !== "string" || value.length > 20000) {
      errors[key] = "ערך לא תקין";
      continue;
    }
    if (def.kind === "environments") {
      const [json, err] = normaliseEnvironments(value);
      if (err) errors[key] = err;
      else next[key] = json;
      continue;
    }
    const err = validate(def, value);
    if (err) errors[key] = err;
    else next[key] = def.kind === "url" ? value.trim().replace(/\/+$/, "") : value.trim();
  }
  if (Object.keys(errors).length) {
    const e = new Error("יש הגדרות לא תקינות") as Error & { status: number; fields: Record<string, string> };
    e.status = 400;
    e.fields = errors;
    throw e;
  }

  const body: FileShape = { version: 1, updated_at: new Date().toISOString(), values: next };
  try {
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${settingsFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    renameSync(tmp, settingsFile);
    try {
      chmodSync(settingsFile, 0o600);
    } catch {}
  } catch (err: any) {
    const e = new Error(
      `לא הצלחתי לכתוב את ${settingsFile}: ${err.message}. צריך תיקייה שהאפליקציה יכולה לכתוב אליה (DATA_DIR), עדיף על volume קבוע.`,
    ) as Error & { status: number };
    e.status = 500;
    throw e;
  }
  overrides = next;
  updatedAt = body.updated_at;
  try {
    fileMtime = statSync(settingsFile).mtimeMs;
  } catch {}
}
