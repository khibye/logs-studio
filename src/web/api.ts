import type {
  Capabilities,
  ChatEvent,
  ChatMessage,
  DashboardSummary,
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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `שגיאה ${res.status}`, body?.fields);
  return body as T;
}

export const api = {
  models: (refresh = false) => call<ModelsInfo>(`/api/models${refresh ? "?refresh=1" : ""}`),

  capabilities: (refresh = false) => call<Capabilities>(`/api/capabilities${refresh ? "?refresh=1" : ""}`),

  query: (esql: string, time_range: TimeRangeKey, signal?: AbortSignal) =>
    call<QueryResult>("/api/query", { method: "POST", body: JSON.stringify({ esql, time_range }), signal }),

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
  group: "elastic" | "kibana" | "llm" | "app";
  kind: "string" | "url" | "secret" | "number" | "boolean" | "list" | "text" | "enum";
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
    call<{ capabilities: Capabilities; models: ModelsInfo }>("/api/admin/test", {
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
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `שגיאה ${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {}
    throw new ApiError(res.status, msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as ChatEvent);
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf) as ChatEvent);
}
