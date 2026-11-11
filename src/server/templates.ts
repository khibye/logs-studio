import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dataWritable, writeJsonAtomic } from "./datastore";
import path from "node:path";
import { config, withEnv } from "./config";
import { HttpError, checkIndices, es as rawEs } from "./elastic";
import { getCapabilities } from "./capabilities";
import { dataDir, rawValue } from "./settings";
import { log } from "./log";
import { TemplateSchema, type Template } from "../shared/template";

/**
 * Templates (starting points for an investigation) live in one of two places:
 *  - "library": the shared dashboards index in Elasticsearch, as documents with ids
 *    tpl__<id>__v<n> (needs read + create_doc there, like dashboards). Never overwritten;
 *    deleting adds a "deleted" version.
 *  - "server":  DATA_DIR/templates.json on the app's persistent volume. Works with a
 *    read-only Elasticsearch key. Anyone who can use the app can add / edit / delete.
 * TEMPLATES_STORE picks where new templates go: auto (library when writable, else server).
 */

export type Store = "library" | "server";
export type TemplatesInfo = {
  templates: Template[];
  /** Where a new template will be saved, and why not elsewhere. */
  saveTo: Store | null;
  stores: { library: { read: boolean; write: boolean; reason?: string }; server: { write: boolean; reason?: string } };
  errors: string[];
};

const PREFIX = "tpl:";

// ---------------------------------------------------------------------------
// Server store (JSON file)
// ---------------------------------------------------------------------------

const file = path.join(dataDir, "templates.json");
type FileShape = { version: 1; templates: Template[] };

function readFileStore(): Template[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<FileShape>;
  return (parsed.templates ?? []).flatMap((t) => {
    const r = TemplateSchema.safeParse(t);
    return r.success ? [{ ...r.data, store: "server" as const }] : [];
  });
}

function writeFileStore(list: Template[]) {
  const body: FileShape = { version: 1, templates: list.map(({ store: _s, ...t }) => t) };
  writeJsonAtomic(file, body);
}

// ---------------------------------------------------------------------------
// Library store (Elasticsearch, LIBRARY_ENV)
// ---------------------------------------------------------------------------

function es<T = any>(p: string, opts?: Parameters<typeof rawEs>[1]): Promise<T> {
  return withEnv(config.libraryEnv, () => rawEs<T>(p, opts));
}
const idx = () => encodeURIComponent(config.elastic.dashboardsIndex);

type Doc = {
  dashboard_id: string;
  version: number;
  title: string;
  notes: string;
  saved_at: string;
  panel_count: number;
  recipe_json: string;
};

async function libraryDocs(query: unknown): Promise<Doc[]> {
  const res = await es(`/${idx()}/_search`, {
    body: { size: 1000, query, sort: [{ version: { order: "desc", unmapped_type: "long" } }] },
  });
  return (res.hits?.hits ?? []).map((h: any) => h._source as Doc).filter((d: Doc) => d.dashboard_id?.startsWith(PREFIX));
}

function fromDoc(d: Doc): Template | null {
  try {
    const raw = JSON.parse(d.recipe_json);
    if (raw?.deleted) return null;
    const r = TemplateSchema.safeParse(raw);
    if (!r.success) return null;
    return { ...r.data, id: d.dashboard_id.slice(PREFIX.length), version: d.version, store: "library", updated_at: d.saved_at };
  } catch {
    return null;
  }
}

async function readLibraryStore(): Promise<Template[]> {
  const docs = await libraryDocs({ prefix: { dashboard_id: PREFIX } });
  const latest = new Map<string, Doc>();
  for (const d of docs) {
    const cur = latest.get(d.dashboard_id);
    if (!cur || d.version > cur.version) latest.set(d.dashboard_id, d);
  }
  return [...latest.values()].map(fromDoc).filter(Boolean) as Template[];
}

async function libraryLatest(id: string): Promise<Doc | undefined> {
  const docs = await libraryDocs({ term: { dashboard_id: PREFIX + id } });
  return docs.filter((d) => d.dashboard_id === PREFIX + id).sort((a, b) => b.version - a.version)[0];
}

async function libraryPut(id: string, version: number, body: unknown, title: string, notes: string) {
  const doc: Doc = {
    dashboard_id: PREFIX + id,
    version,
    title,
    notes,
    saved_at: new Date().toISOString(),
    panel_count: 0,
    recipe_json: JSON.stringify(body),
  };
  try {
    await es(`/${idx()}/_create/${encodeURIComponent(`tpl__${id}__v${version}`)}?refresh=wait_for`, { method: "PUT", body: doc });
  } catch (err) {
    if (err instanceof HttpError && err.status === 409)
      throw new HttpError(409, "מישהו שמר את התבנית הזו הרגע. כדאי לטעון מחדש ולנסות שוב.");
    throw err;
  }
}

// ---------------------------------------------------------------------------

async function storesInfo(): Promise<TemplatesInfo["stores"] & { saveTo: Store | null }> {
  const caps = (await getCapabilities()).library;
  const lib = caps.es ?? caps;
  const library = { read: lib.read, write: lib.write, reason: lib.write ? undefined : lib.reason };
  const { write, reason } = dataWritable();
  const server = { write, reason };
  const pref = (rawValue("TEMPLATES_STORE") ?? "auto") as "auto" | Store;
  const saveTo: Store | null =
    pref === "library" ? (library.write ? "library" : null)
    : pref === "server" ? (server.write ? "server" : null)
    : library.write ? "library"
    : server.write ? "server"
    : null;
  return { library, server, saveTo };
}

export async function listTemplates(): Promise<TemplatesInfo> {
  const { saveTo, ...stores } = await storesInfo();
  const errors: string[] = [];
  let templates: Template[] = [];
  try {
    templates = readFileStore();
  } catch (err: any) {
    errors.push(`templates.json: ${err.message}`);
  }
  if (stores.library.read) {
    try {
      templates = [...templates, ...(await readLibraryStore())];
    } catch (err: any) {
      if (!(err instanceof HttpError && err.status === 404)) errors.push(`ספרייה: ${err.message}`);
    }
  }
  templates.sort((a, b) => a.name.localeCompare(b.name, "he"));
  return { templates, saveTo, stores, errors };
}

export async function saveTemplate(input: unknown): Promise<Template> {
  const t = TemplateSchema.parse(input);
  t.indices = checkIndices(t.indices);
  const { store: _s, id: _i, version: _v, updated_at: _u, ...content } = t;

  let store: Store;
  if (t.id && t.store) store = t.store;
  else {
    const info = await storesInfo();
    if (!info.saveTo)
      throw new HttpError(403, `אין איפה לשמור תבניות: ${info.library.reason ?? "אין הרשאת כתיבה לספרייה"}; ${info.server.reason ?? ""}`);
    store = info.saveTo;
  }

  if (store === "server") {
    const list = readFileStore();
    const now = new Date().toISOString();
    if (t.id) {
      const i = list.findIndex((x) => x.id === t.id);
      if (i < 0) throw new HttpError(404, "התבנית לא נמצאה (אולי נמחקה)");
      if (t.version && list[i].version && list[i].version !== t.version)
        throw new HttpError(409, "מישהו עדכן את התבנית בינתיים. כדאי לטעון מחדש ולנסות שוב.");
      list[i] = { ...content, id: t.id, version: (list[i].version ?? 1) + 1, updated_at: now };
      writeFileStore(list);
      log.info("template.saved", { store, id: t.id, name: t.name });
      return { ...list[i], store };
    }
    const saved: Template = { ...content, id: randomUUID(), version: 1, updated_at: now };
    writeFileStore([...list, saved]);
    log.info("template.saved", { store, id: saved.id, name: t.name, new: true });
    return { ...saved, store };
  }

  // library
  let id = t.id;
  let version = 1;
  if (id) {
    const latest = await libraryLatest(id);
    if (!latest) throw new HttpError(404, "התבנית לא נמצאה בספרייה");
    if (t.version && latest.version !== t.version)
      throw new HttpError(409, "מישהו עדכן את התבנית בינתיים. כדאי לטעון מחדש ולנסות שוב.");
    version = latest.version + 1;
  } else id = randomUUID();
  await libraryPut(id, version, content, t.name, t.description);
  log.info("template.saved", { store, id, version, name: t.name });
  return { ...content, id, version, store, updated_at: new Date().toISOString() };
}

export async function deleteTemplate(store: Store, id: string): Promise<void> {
  if (store === "server") {
    const list = readFileStore();
    const next = list.filter((t) => t.id !== id);
    if (next.length === list.length) throw new HttpError(404, "התבנית לא נמצאה");
    writeFileStore(next);
  } else {
    const latest = await libraryLatest(id);
    if (!latest) throw new HttpError(404, "התבנית לא נמצאה בספרייה");
    await libraryPut(id, latest.version + 1, { deleted: true }, latest.title, "");
  }
  log.info("template.deleted", { store, id });
}
