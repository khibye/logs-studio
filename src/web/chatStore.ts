import type { UiMessage } from "./components/Chat";

/**
 * Conversations are kept in THIS browser only (localStorage), for a limited
 * time, so a reload or a quick detour doesn't lose them. The server stays
 * stateless: it never stores a conversation.
 */

const PREFIX = "logs-studio:chat:";
const MAX_SESSIONS = 30;
type Stored = { messages: UiMessage[]; updatedAt: number };

const hours = (h: number) => h * 3600_000;

export function newSessionKey(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function loadChat(key: string | undefined, ttlHours: number): UiMessage[] | null {
  if (!key || ttlHours <= 0) return null;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    if (Date.now() - s.updatedAt > hours(ttlHours)) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return s.messages.map((m) => ({ ...m, streaming: false }));
  } catch {
    return null;
  }
}

export function saveChat(key: string, messages: UiMessage[], ttlHours: number) {
  if (ttlHours <= 0) return;
  try {
    if (!messages.length) {
      localStorage.removeItem(PREFIX + key);
      return;
    }
    const clean = messages.map(({ streaming: _s, ...m }) => m);
    localStorage.setItem(PREFIX + key, JSON.stringify({ messages: clean, updatedAt: Date.now() } satisfies Stored));
  } catch {
    // Storage full or blocked: drop the oldest conversations and try once more.
    pruneChats(ttlHours, 5);
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify({ messages, updatedAt: Date.now() }));
    } catch {}
  }
}

/** Removes expired conversations and keeps at most `keep` of the newest. */
export function pruneChats(ttlHours: number, keep = MAX_SESSIONS) {
  try {
    const items: { k: string; at: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      try {
        items.push({ k, at: (JSON.parse(localStorage.getItem(k) ?? "{}") as Stored).updatedAt ?? 0 });
      } catch {
        items.push({ k, at: 0 });
      }
    }
    items.sort((a, b) => b.at - a.at);
    items.forEach((it, i) => {
      if (i >= keep || ttlHours <= 0 || Date.now() - it.at > hours(ttlHours)) localStorage.removeItem(it.k);
    });
  } catch {}
}
