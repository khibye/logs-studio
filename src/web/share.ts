import LZString from "lz-string";
import { RecipeSchema, type Recipe } from "../shared/recipe";

/** The whole recipe, compressed into the URL. The link IS the saved dashboard. */
export function encodeRecipe(r: Recipe): string {
  return LZString.compressToEncodedURIComponent(JSON.stringify(r));
}

export function decodeRecipe(payload: string): Recipe | null {
  try {
    const json = LZString.decompressFromEncodedURIComponent(payload);
    if (!json) return null;
    const parsed = RecipeSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseRecipeFile(text: string): Recipe {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("הקובץ אינו JSON תקין");
  }
  const parsed = RecipeSchema.safeParse(data);
  if (!parsed.success) throw new Error("הקובץ אינו דשבורד תקין: " + parsed.error.issues[0]?.message);
  return parsed.data;
}

export function appUrl(hash: string): string {
  return `${location.origin}${location.pathname}${hash}`;
}

/** Links longer than this may break in chat apps and email clients. */
export const SAFE_LINK_LENGTH = 8000;

export function downloadJson(r: Recipe) {
  const name = (r.title || "dashboard").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "dashboard";
  const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- "Recently worked on" — a per-browser convenience list, never shared ----

export type RecentItem = { key: string; title: string; hash: string; at: string; panels: number };
const RECENT_KEY = "logs-studio:recent";

export function loadRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as RecentItem[]) : [];
  } catch {
    return [];
  }
}

export function rememberRecent(item: RecentItem) {
  try {
    const list = loadRecent().filter((i) => i.key !== item.key);
    list.unshift(item);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 15)));
  } catch {}
}

export function forgetRecent(key: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(loadRecent().filter((i) => i.key !== key)));
  } catch {}
}
