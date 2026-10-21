import type {
  Capabilities,
  ChatEvent,
  ChatMessage,
  DashboardSummary,
  Annotation,
  Compare,
  ModelsInfo,
  QueryResult,
  Recipe,
  TimeRangeKey,
} from "../shared/recipe";

export class ApiError extends Error {
  constructor(public status: number, message: string, public fields?: Record<string, string>) {
    super(message);
  }
}

/** The environment every API call runs against (sent as the x-env header). */
let currentEnv = "";
export function setApiEnv(id: string) {
  currentEnv = id;
}
const envHeader = (): Record<string, string> => (currentEnv ? { "x-env": currentEnv } : {});

const NETWORK_ERROR = /network ?error|failed to fetch|load failed|networkerror/i;

/** Turns the browser's bare "network error" into something actionable. */
function networkError(e: any, midStream = false): never {
  if (e?.name === "AbortError" || !NETWORK_ERROR.test(String(e?.message ?? ""))) throw e;
  throw new ApiError(
    0,
    midStream
      ? "החיבור לשרת של האפליקציה נקטע באמצע התשובה. בדרך כלל זה פרוקסי או Ingress לפני האפליקציה שסוגר בקשות ארוכות (proxy-read-timeout). אפשר לנסות שוב."
      : "אין תקשורת עם השרת של האפליקציה (network error). ייתכן שהשרת הופעל מחדש או שפרוקסי בדרך סגר את הבקשה. אפשר לנסות שוב.",
  );
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...envHeader(), ...(init?.headers ?? {}) },
    });
  } catch (e) {
    networkError(e);
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    // The request id matches the server log line for this call (LOG_LEVEL=info or debug).
    const req = res.headers.get("x-request-id");
    throw new ApiError(res.status, `${body?.error ?? `שגיאה ${res.status}`}${req ? ` · req ${req}` : ""}`, body?.fields);
  }
  return body as T;
}

export const api = {
  models: (refresh = false) => call<ModelsInfo>(`/api/models${refresh ? "?refresh=1" : ""}`),

  capabilities: (refresh = false) => call<Capabilities>(`/api/capabilities${refresh ? "?refresh=1" : ""}`),

  /** `env` overrides the current environment (side-by-side comparison); `compare` runs it on an earlier period. */
  query: (esql: string, time_range: TimeRangeKey, opts: { signal?: AbortSignal; compare?: Compare; env?: string } = {}) =>
    call<QueryResult>("/api/query", {
      method: "POST",
      body: JSON.stringify({ esql, time_range, compare: opts.compare }),
      signal: opts.signal,
      headers: opts.env ? { "x-env": opts.env } : undefined,
    }),

  annotations: (time_range: TimeRangeKey, env?: string) =>
    call<{ enabled: boolean; events: Annotation[]; error?: string }>(`/api/annotations?time_range=${time_range}`, {
      headers: env ? { "x-env": env } : undefined,
    }),

  /** Capabilities of a specific environment (admin page status per environment). */
  capabilitiesFor: (env: string, refresh = false) =>
    call<Capabilities>(`/api/capabilities${refresh ? "?refresh=1" : ""}`, { headers: { "x-env": env } }),

  listDashboards: (q?: string) =>
    call<DashboardSummary[]>(`/api/dashboards${q ? `?q=${encodeURIComponent(q)}` : ""}`),

  versions: (id: string) => call<DashboardSummary[]>(`/api/dashboards/${encodeURIComponent(id)}/versions`),

  getDashboard: (id: string, version?: number) =>
    call<Recipe>(`/api/dashboards/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`),

  saveDashboard: (recipe: Recipe, mode: "new" | "update" | "fork") =>
    call<Recipe>("/api/dashboards", { method: "POST", body: JSON.stringify({ recipe, mode }) }),

  exportKibana: (recipe: Recipe) =>
    call<{ url: string; id: string; skipped: string[] }>("/api/export/kibana", {
      method: "POST",
      body: JSON.stringify({ recipe }),
    }),
};

// ---- Admin (password sent on each call; kept in sessionStorage by the page) ----

export type SettingView = {
  key: string;
  group: "elastic" | "kibana" | "envs" | "llm" | "app";
  kind: "string" | "url" | "secret" | "number" | "boolean" | "list" | "text" | "enum" | "environments";
  label: string;
  help?: string;
  default?: string;
  options?: string[];
  min?: number;
  value: string;
  fallback: string;
  source: "admin" | "env" | "file" | "default" | "unset";
  isSet: boolean;
};
export type StorageInfo = {
  file: string;
  exists: boolean;
  writable: boolean;
  overrides: number;
  updated_at?: string;
  error?: string;
};
export type AdminSettings = { settings: SettingView[]; storage: StorageInfo };

const adminHeaders = (password: string) => ({ "x-admin-password": password });

export const adminApi = {
  login: (password: string) => call<{ ok: true }>("/api/admin/login", { method: "POST", headers: adminHeaders(password) }),
  settings: (password: string) => call<AdminSettings>("/api/admin/settings", { headers: adminHeaders(password) }),
  save: (password: string, values: Record<string, string | null>) =>
    call<AdminSettings>("/api/admin/settings", {
      method: "PUT",
      headers: adminHeaders(password),
      body: JSON.stringify({ values }),
    }),
  test: (password: string) =>
    call<{ capabilities: Capabilities; models: ModelsInfo; available: { models: string[]; error?: string } }>("/api/admin/test", {
      method: "POST",
      headers: adminHeaders(password),
    }),
};

/** Streams the agent's events (newline-delimited JSON). */
export async function streamChat(
  body: { messages: ChatMessage[]; recipe: Recipe | null; time_range: TimeRangeKey; model?: string },
  onEvent: (e: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...envHeader() },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    networkError(e);
  }
  if (!res.ok || !res.body) {
    let msg = `שגיאה ${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {}
    throw new ApiError(res.status, msg);
  }
  let sawDone = false;
  const handle = (e: ChatEvent) => {
    if (e.type === "done") sawDone = true;
    onEvent(e);
  };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (signal.aborted) throw e;
      networkError(e, true);
    }
    const { value, done } = chunk;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handle(JSON.parse(line) as ChatEvent);
    }
  }
  if (buf.trim()) handle(JSON.parse(buf) as ChatEvent);
  // The server always ends with "done"; a stream that just stops was closed by something in between.
  if (!sawDone && !signal.aborted) networkError(new TypeError("network error"), true);
}
