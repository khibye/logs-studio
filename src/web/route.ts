import { useEffect, useState } from "react";

/**
 * Hash routes — everything the app needs to reopen a view is in the URL:
 *   #/              studio (empty, or a draft that hasn't been put in the URL yet)
 *   #/new           start over: clears the draft and the conversation
 *   #/r/<payload>   a dashboard embedded in the link itself
 *   #/d/<id>?v=<n>  a dashboard from the library (optionally a specific version)
 *   #/library       the dashboards list
 * Any studio route may carry &s=<key>: the id of the conversation kept in this
 * browser (see chatStore.ts), so a reload brings the chat back. The key is
 * meaningless in any other browser.
 */
export type Route =
  | { name: "new"; fresh: boolean; session?: string }
  | { name: "shared"; payload: string; session?: string }
  | { name: "saved"; id: string; version?: number; session?: string }
  | { name: "library" };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, "");
  const q = h.indexOf("?");
  const path = q >= 0 ? h.slice(0, q) : h;
  const params = new URLSearchParams(q >= 0 ? h.slice(q + 1) : "");
  const session = params.get("s") || undefined;
  if (path.startsWith("/library")) return { name: "library" };
  if (path.startsWith("/new")) return { name: "new", fresh: true };
  const shared = /^\/r\/(.+)$/.exec(path);
  if (shared) return { name: "shared", payload: shared[1], session };
  const saved = /^\/d\/(.+)$/.exec(path);
  if (saved) {
    const v = Number(params.get("v"));
    return { name: "saved", id: decodeURIComponent(saved[1]), version: v > 0 ? v : undefined, session };
  }
  return { name: "new", fresh: false, session };
}

export function savedHash(id: string, version?: number) {
  return `#/d/${encodeURIComponent(id)}${version ? `?v=${version}` : ""}`;
}

/** Adds the conversation key to a studio hash. */
export function withSession(hash: string, session?: string) {
  if (!session) return hash;
  return `${hash}${hash.includes("?") ? "&" : "?"}s=${encodeURIComponent(session)}`;
}

/** Re-renders only on real navigation (links, back/forward), not on replaceUrl(). */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function navigate(hash: string) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
}

/** Updates the address bar without triggering navigation (keeps the draft in the URL). */
export function replaceUrl(hash: string) {
  if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);
}
