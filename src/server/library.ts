import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config, withEnv } from "./config";
import { es as rawEs, HttpError } from "./elastic";
import { dataWritable, writeJsonAtomic } from "./datastore";
import { dataDir, rawValue } from "./settings";
import { log } from "./log";
import { RecipeSchema, type DashboardSummary, type Recipe } from "../shared/recipe";

/**
 * The dashboards library. Two places can hold it:
 *  - "library": an Elasticsearch index (DASHBOARDS_INDEX, in LIBRARY_ENV). Needs read +
 *    create_doc on the index.
 *  - "server":  files on the app's persistent volume, DATA_DIR/dashboards/<id>.json.
 *    Works with a read-only Elasticsearch key.
 * DASHBOARDS_STORE picks where new dashboards go: auto (Elasticsearch when writable,
 * else the server). Both are listed; an update or fork of a saved dashboard stays where
 * the original is.
 *
 * Every save is a NEW version — versions are never overwritten — so history, rollback
 * and forking from any version come for free, and a concurrent save of the same
 * version fails with a conflict instead of silently overwriting someone else's work.
 */

export type Store = "library" | "server";

type Doc = {
  dashboard_id: string;
  version: number;
  title: string;
  notes: string;
  saved_at: string;
  panel_count: number;
  forked_from_id?: string;
  forked_from_version?: number;
  /** Environment the dashboard opens on by default. */
  env?: string;
  recipe_json: string;
};

function summary(d: Doc, versions: number, store: Store): DashboardSummary {
  return {
    id: d.dashboard_id,
    version: d.version,
    title: d.title,
    notes: d.notes,
    saved_at: d.saved_at,
    panel_count: d.panel_count,
    versions,
    env: d.env,
    store,
    forked_from:
      d.forked_from_id && d.forked_from_version ? { id: d.forked_from_id, version: d.forked_from_version } : undefined,
  };
}

function toRecipe(d: Doc): Recipe {
  const parsed = RecipeSchema.safeParse(JSON.parse(d.recipe_json));
  if (!parsed.success) throw new HttpError(500, `הדשבורד השמור ${d.dashboard_id} (גרסה ${d.version}) פגום`);
  return {
    ...parsed.data,
    id: d.dashboard_id,
    version: d.version,
    forked_from:
      d.forked_from_id && d.forked_from_version ? { id: d.forked_from_id, version: d.forked_from_version } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Elasticsearch store
// ---------------------------------------------------------------------------

/** The library lives in one environment (LIBRARY_ENV), whichever environment the user is looking at. */
function es<T = any>(p: string, opts?: Parameters<typeof rawEs>[1]): Promise<T> {
  return withEnv(config.libraryEnv, () => rawEs<T>(p, opts));
}
const idx = () => encodeURIComponent(config.elastic.dashboardsIndex);
const docId = (id: string, v: number) => encodeURIComponent(`${id}__v${v}`);

async function esSearch(query: unknown, size: number, sortField: "saved_at" | "version"): Promise<Doc[]> {
  try {
    const res = await es(`/${idx()}/_search`, {
      body: {
        size,
        // Templates share the index (ids "tpl:…"); they're not dashboards.
        query: { bool: { must: [query], must_not: [{ prefix: { dashboard_id: "tpl:" } }] } },
        sort: [{ [sortField]: { order: "desc", unmapped_type: sortField === "version" ? "long" : "date" } }],
      },
    });
    return (res.hits?.hits ?? []).map((h: any) => h._source as Doc).filter((d: Doc) => !d.dashboard_id?.startsWith("tpl:"));
  } catch (err) {
    if (err instanceof HttpError && err.status === 404)
      throw new HttpError(404, `האינדקס ${config.elastic.dashboardsIndex} עדיין לא קיים`);
    throw err;
  }
}

async function esVersions(id: string): Promise<Doc[]> {
  const docs = await esSearch({ match_phrase: { dashboard_id: id } }, 500, "version");
  return docs.filter((d) => d.dashboard_id === id).sort((a, b) => b.version - a.version);
}

async function esCreate(doc: Doc) {
  try {
    await es(`/${idx()}/_create/${docId(doc.dashboard_id, doc.version)}?refresh=wait_for`, { method: "PUT", body: doc });
  } catch (err) {
    if (err instanceof HttpError && err.status === 409)
      throw new HttpError(409, "הגרסה הזו נשמרה הרגע על ידי מישהו אחר. טעני מחדש ונסי שוב.");
    if (err instanceof HttpError && err.status === 404)
      throw new HttpError(404, `האינדקס ${config.elastic.dashboardsIndex} עדיין לא קיים`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Server store: DATA_DIR/dashboards/<id>.json = { versions: Doc[] } (newest first)
// ---------------------------------------------------------------------------

const folder = () => path.join(dataDir, "dashboards");
const ID_RE = /^[\w-]{1,80}$/;
const fileOf = (id: string) => {
  if (!ID_RE.test(id)) throw new HttpError(400, "Invalid dashboard id");
  return path.join(folder(), `${id}.json`);
};

function fileVersions(id: string): Doc[] {
  if (!ID_RE.test(id)) return [];
  const f = fileOf(id);
  if (!existsSync(f)) return [];
  const body = JSON.parse(readFileSync(f, "utf8")) as { versions?: Doc[] };
  return (body.versions ?? []).sort((a, b) => b.version - a.version);
}

function fileAll(): { latest: Doc; count: number }[] {
  if (!existsSync(folder())) return [];
  const out: { latest: Doc; count: number }[] = [];
  for (const name of readdirSync(folder())) {
    if (!name.endsWith(".json")) continue;
    try {
      const versions = fileVersions(name.slice(0, -5));
      if (versions[0]) out.push({ latest: versions[0], count: versions.length });
    } catch (err: any) {
      log.warn("library.file_unreadable", { file: name, error: err.message });
    }
  }
  return out;
}

/** Synchronous read-check-write: no other request can interleave inside one process. */
function fileCreate(doc: Doc) {
  const versions = fileVersions(doc.dashboard_id);
  if (versions.some((v) => v.version === doc.version))
    throw new HttpError(409, "הגרסה הזו נשמרה הרגע על ידי מישהו אחר. טעני מחדש ונסי שוב.");
  writeJsonAtomic(fileOf(doc.dashboard_id), { versions: [doc, ...versions] });
}

function matches(d: Doc, q: string): boolean {
  const s = q.trim().toLowerCase();
  return !s || d.title.toLowerCase().includes(s) || (d.notes ?? "").toLowerCase().includes(s);
}

// ---------------------------------------------------------------------------
// Where things go
// ---------------------------------------------------------------------------

export type LibraryState = {
  /** Where new dashboards are saved (null = nowhere). */
  saveTo: Store | null;
  es: { read: boolean; write: boolean; reason?: string };
  server: { write: boolean; reason?: string; dir: string };
};

/** Combines the Elasticsearch privileges (from capabilities) with the data folder. */
export function libraryState(esLib: { read: boolean; write: boolean; reason?: string }): LibraryState {
  const server = dataWritable();
  const pref = (rawValue("DASHBOARDS_STORE") ?? "auto") as "auto" | Store;
  const saveTo: Store | null =
    pref === "library" ? (esLib.write ? "library" : null)
    : pref === "server" ? (server.write ? "server" : null)
    : esLib.write ? "library"
    : server.write ? "server"
    : null;
  return { saveTo, es: esLib, server };
}

async function state(): Promise<LibraryState> {
  const { getCapabilities } = await import("./capabilities");
  const caps = await getCapabilities();
  return libraryState(caps.library.es ?? { read: caps.library.read, write: caps.library.write });
}

/** Which store holds a saved dashboard. */
function storeOf(id: string): Store {
  return fileVersions(id).length ? "server" : "library";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Latest version of every dashboard, from both stores. */
export async function listDashboards(q?: string): Promise<DashboardSummary[]> {
  const st = await state();
  const out: DashboardSummary[] = fileAll()
    .filter((e) => matches(e.latest, q ?? ""))
    .map((e) => summary(e.latest, e.count, "server"));

  if (st.es.read) {
    try {
      const query = q?.trim()
        ? { multi_match: { query: q.trim(), fields: ["title^3", "notes"], fuzziness: "AUTO" } }
        : { match_all: {} };
      const docs = await esSearch(query, 1000, "saved_at");
      const byId = new Map<string, { latest: Doc; count: number }>();
      for (const d of docs) {
        const e = byId.get(d.dashboard_id);
        if (!e) byId.set(d.dashboard_id, { latest: d, count: 1 });
        else {
          e.count++;
          if (d.version > e.latest.version) e.latest = d;
        }
      }
      out.push(...[...byId.values()].map((e) => summary(e.latest, e.count, "library")));
    } catch (err) {
      // The server store still works; only fail if there is nothing else to show.
      if (!out.length && !st.server.write) throw err;
      log.warn("library.es_list_failed", { error: (err as Error).message });
    }
  }
  return out.sort((a, b) => b.saved_at.localeCompare(a.saved_at));
}

export async function listVersions(id: string): Promise<DashboardSummary[]> {
  const local = fileVersions(id);
  if (local.length) return local.map((d) => summary(d, local.length, "server"));
  const docs = await esVersions(id);
  return docs.map((d) => summary(d, docs.length, "library"));
}

export async function getDashboard(id: string, version?: number): Promise<Recipe> {
  const local = fileVersions(id);
  if (local.length) {
    const d = version ? local.find((v) => v.version === version) : local[0];
    if (!d) throw new HttpError(404, `גרסה ${version} של הדשבורד לא נמצאה`);
    return toRecipe(d);
  }
  if (version) {
    const res = await es(`/${idx()}/_doc/${docId(id, version)}`, { allow404: true });
    if (!res?.found) throw new HttpError(404, `גרסה ${version} של הדשבורד לא נמצאה`);
    return toRecipe(res._source as Doc);
  }
  const [latest] = await esVersions(id);
  if (!latest) throw new HttpError(404, "הדשבורד לא נמצא בספרייה");
  return toRecipe(latest);
}

export type SaveMode = "new" | "update" | "fork";

export async function saveDashboard(input: Recipe, mode: SaveMode): Promise<Recipe> {
  const recipe = RecipeSchema.parse(input);
  let id: string;
  let version: number;
  let forked_from = recipe.forked_from;
  let store: Store;

  if (mode === "update") {
    if (!recipe.id || !recipe.version) throw new HttpError(400, "אפשר לעדכן רק דשבורד ששמור בספרייה");
    store = storeOf(recipe.id);
    const [latest] = store === "server" ? fileVersions(recipe.id) : await esVersions(recipe.id);
    if (!latest) throw new HttpError(404, "הדשבורד המקורי כבר לא קיים. אפשר לשמור כדשבורד חדש.");
    if (latest.version !== recipe.version)
      throw new HttpError(
        409,
        `מישהו שמר גרסה ${latest.version} אחרי הגרסה שממנה התחלת (${recipe.version}). אפשר לשמור כעותק, או לטעון את הגרסה האחרונה.`,
      );
    id = recipe.id;
    version = latest.version + 1;
  } else {
    if (mode === "fork") {
      if (!recipe.id || !recipe.version) throw new HttpError(400, "עותק (fork) אפשרי רק מדשבורד ששמור בספרייה");
      forked_from = { id: recipe.id, version: recipe.version };
    }
    const st = await state();
    if (!st.saveTo)
      throw new HttpError(403, `אין איפה לשמור דשבורדים: ${st.es.reason ?? "אין הרשאת כתיבה לאינדקס"}; ${st.server.reason ?? ""}`);
    store = st.saveTo;
    id = randomUUID();
    version = 1;
  }
  if (store === "library" && mode === "update" && !(await state()).es.write)
    throw new HttpError(403, "הדשבורד שמור באלסטיק, ואין למפתח הרשאת כתיבה לשם. אפשר לשמור כעותק.");

  const { id: _i, version: _v, forked_from: _f, ...content } = recipe;
  const doc: Doc = {
    dashboard_id: id,
    version,
    title: recipe.title,
    notes: recipe.notes,
    saved_at: new Date().toISOString(),
    panel_count: recipe.panels.length,
    forked_from_id: forked_from?.id,
    forked_from_version: forked_from?.version,
    env: recipe.env,
    recipe_json: JSON.stringify(content),
  };

  if (store === "server") fileCreate(doc);
  else await esCreate(doc);
  log.info("library.saved", { store, mode, id, version, title: recipe.title, panels: recipe.panels.length, forkedFrom: forked_from?.id });
  return { ...recipe, id, version, forked_from };
}
