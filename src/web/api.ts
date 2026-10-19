import type {
  Capabilities,
  ChatEvent,
  ChatMessage,
  DashboardSummary,
  QueryResult,
  Recipe,
  TimeRangeKey,
} from "../shared/recipe";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
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
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `שגיאה ${res.status}`);
  return body as T;
}

export const api = {
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

/** Streams the agent's events (newline-delimited JSON). */
export async function streamChat(
  body: { messages: ChatMessage[]; recipe: Recipe | null; time_range: TimeRangeKey },
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
