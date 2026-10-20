import "dotenv/config";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

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

export type SettingKind = "string" | "url" | "secret" | "number" | "boolean" | "list" | "text" | "enum";
export type SettingGroup = "elastic" | "kibana" | "llm" | "app";

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

export const SETTINGS: SettingDef[] = [
  // ---- Elasticsearch ----
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
    key: "CHAT_RETENTION_HOURS",
    group: "app",
    kind: "number",
    default: "24",
    min: 0,
    label: "שמירת שיחות בדפדפן (שעות)",
    help: "0 = לא נשמרות. השיחות נשמרות רק בדפדפן של כל משתמש.",
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
    console.warn(fileError);
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
    console.warn(`LOG_CONTEXT_FILE could not be read: ${err.message}`);
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
    return {
      ...d,
      value: secret ? mask(eff) : eff,
      fallback: secret ? mask(fb) : fb,
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
