import { randomUUID } from "node:crypto";
import { config, withEnv } from "./config";
import { es as rawEs, HttpError } from "./elastic";
import { RecipeSchema, type DashboardSummary, type Recipe } from "../shared/recipe";

/**
 * Dashboard library stored in an Elasticsearch index (default: ai-dashboards).
 *
 * Every save is a NEW document — versions are never overwritten:
 *   _id = "<dashboard_id>__v<version>"
 * so history, rollback and forking from any version come for free, and a
 * concurrent save of the same version fails with a conflict instead of
 * silently overwriting someone else's work.
 *
 * Needs only `read` + `create_doc` on the index. Works with or without the
 * recommended mapping (see README): the recipe itself is stored as a JSON
 * string so it never adds fields to the index mapping.
 */

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

/** The library lives in one environment (LIBRARY_ENV), whichever environment the user is looking at. */
function es<T = any>(path: string, opts?: Parameters<typeof rawEs>[1]): Promise<T> {
  return withEnv(config.libraryEnv, () => rawEs<T>(path, opts));
}

const idx = () => encodeURIComponent(config.elastic.dashboardsIndex);
const docId = (id: string, v: number) => encodeURIComponent(`${id}__v${v}`);

function summary(d: Doc, versions = 1): DashboardSummary {
  return {
    id: d.dashboard_id,
    version: d.version,
    title: d.title,
    notes: d.notes,
    saved_at: d.saved_at,
    panel_count: d.panel_count,
    versions,
    env: d.env,
    forked_from:
      d.forked_from_id && d.forked_from_version
        ? { id: d.forked_from_id, version: d.forked_from_version }
        : undefined,
  };
}

function notFoundIndex(err: unknown) {
  return err instanceof HttpError && err.status === 404;
}

async function searchDocs(query: unknown, size: number, sortField: "saved_at" | "version"): Promise<Doc[]> {
  try {
    const res = await es(`/${idx()}/_search`, {
      body: {
        size,
        query,
        sort: [{ [sortField]: { order: "desc", unmapped_type: sortField === "version" ? "long" : "date" } }],
      },
    });
    return (res.hits?.hits ?? []).map((h: any) => h._source as Doc);
  } catch (err) {
    if (notFoundIndex(err)) throw new HttpError(404, `האינדקס ${config.elastic.dashboardsIndex} עדיין לא קיים`);
    throw err;
  }
}

/** Latest version of every dashboard (deduplicated from the most recent saves). */
export async function listDashboards(q?: string): Promise<DashboardSummary[]> {
  const query = q?.trim()
    ? { multi_match: { query: q.trim(), fields: ["title^3", "notes"], fuzziness: "AUTO" } }
    : { match_all: {} };
  const docs = await searchDocs(query, 1000, "saved_at");
  const byId = new Map<string, { latest: Doc; count: number }>();
  for (const d of docs) {
    const e = byId.get(d.dashboard_id);
    if (!e) byId.set(d.dashboard_id, { latest: d, count: 1 });
    else {
      e.count++;
      if (d.version > e.latest.version) e.latest = d;
    }
  }
  return [...byId.values()].map((e) => summary(e.latest, e.count));
}

async function versionsOf(id: string): Promise<Doc[]> {
  const docs = await searchDocs({ match_phrase: { dashboard_id: id } }, 500, "version");
  return docs.filter((d) => d.dashboard_id === id).sort((a, b) => b.version - a.version);
}

export async function listVersions(id: string): Promise<DashboardSummary[]> {
  const docs = await versionsOf(id);
  return docs.map((d) => summary(d, docs.length));
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

export async function getDashboard(id: string, version?: number): Promise<Recipe> {
  if (version) {
    const res = await es(`/${idx()}/_doc/${docId(id, version)}`, { allow404: true });
    if (!res?.found) throw new HttpError(404, `גרסה ${version} של הדשבורד לא נמצאה`);
    return toRecipe(res._source as Doc);
  }
  const [latest] = await versionsOf(id);
  if (!latest) throw new HttpError(404, "הדשבורד לא נמצא בספרייה");
  return toRecipe(latest);
}

export type SaveMode = "new" | "update" | "fork";

export async function saveDashboard(input: Recipe, mode: SaveMode): Promise<Recipe> {
  const recipe = RecipeSchema.parse(input);
  let id: string;
  let version: number;
  let forked_from = recipe.forked_from;

  if (mode === "update") {
    if (!recipe.id || !recipe.version) throw new HttpError(400, "אפשר לעדכן רק דשבורד ששמור בספרייה");
    const [latest] = await versionsOf(recipe.id);
    if (!latest) throw new HttpError(404, "הדשבורד המקורי כבר לא קיים. אפשר לשמור כדשבורד חדש.");
    if (latest.version !== recipe.version)
      throw new HttpError(
        409,
        `מישהו שמר גרסה ${latest.version} אחרי הגרסה שממנה התחלת (${recipe.version}). אפשר לשמור כעותק, או לטעון את הגרסה האחרונה.`,
      );
    id = recipe.id;
    version = latest.version + 1;
  } else if (mode === "fork") {
    if (!recipe.id || !recipe.version) throw new HttpError(400, "עותק (fork) אפשרי רק מדשבורד ששמור בספרייה");
    forked_from = { id: recipe.id, version: recipe.version };
    id = randomUUID();
    version = 1;
  } else {
    id = randomUUID();
    version = 1;
  }

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

  try {
    await es(`/${idx()}/_create/${docId(id, version)}?refresh=wait_for`, { method: "PUT", body: doc });
  } catch (err) {
    if (err instanceof HttpError && err.status === 409)
      throw new HttpError(409, "הגרסה הזו נשמרה הרגע על ידי מישהו אחר. טעני מחדש ונסי שוב.");
    if (notFoundIndex(err)) throw new HttpError(404, `האינדקס ${config.elastic.dashboardsIndex} עדיין לא קיים`);
    throw err;
  }
  return { ...recipe, id, version, forked_from };
}
