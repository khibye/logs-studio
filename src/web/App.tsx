import { useCallback, useEffect, useRef, useState } from "react";
import { api, setApiEnv, streamChat } from "./api";
import { Header } from "./components/Header";
import { Chat, type UiMessage } from "./components/Chat";
import { Dashboard, type Origin } from "./components/Dashboard";
import { Library } from "./components/Library";
import { Admin } from "./components/Admin";
import { navigate, replaceUrl, savedHash, useRoute, withSession } from "./route";
import { loadChat, newSessionKey, pruneChats, saveChat } from "./chatStore";
import {
  SAFE_LINK_LENGTH,
  appUrl,
  decodeRecipe,
  downloadJson,
  encodeRecipe,
  forgetRecent,
  loadRecent,
  parseRecipeFile,
  rememberRecent,
} from "./share";
import { contentKey, type Capabilities, type ModelsInfo, type Recipe, type TimeRangeKey } from "../shared/recipe";

type Toast = { text: string; tone: "ok" | "bad"; href?: string; hrefLabel?: string };

const newKey = () => Math.random().toString(36).slice(2, 10);

const ENV_KEY = "logs-studio:env";
const MAIN_ENV = "main";
function readEnvPref(): string {
  try {
    return localStorage.getItem(ENV_KEY) || MAIN_ENV;
  } catch {
    return MAIN_ENV;
  }
}
function writeEnvPref(id: string) {
  try {
    localStorage.setItem(ENV_KEY, id);
  } catch {}
}

const MODEL_KEY = "logs-studio:model";
function readModelPref(): string {
  try {
    return localStorage.getItem(MODEL_KEY) ?? "";
  } catch {
    return "";
  }
}
function writeModelPref(m: string) {
  try {
    localStorage.setItem(MODEL_KEY, m);
  } catch {}
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function unreachableCaps(error: string): Capabilities {
  return {
    elastic: { ok: false, error, via: "direct" },
    llm: { configured: false },
    logs: { read: false, patterns: [], reason: error },
    library: { read: false, write: false, index: "ai-dashboards", reason: error },
    discover: { enabled: false },
    chat: { retentionHours: 24 },
    admin: { enabled: false },
    env: { id: MAIN_ENV, name: "" },
    deploys: { enabled: false },
    environments: [],
    kibanaExport: { enabled: false, experimental: true, reason: error },
  };
}

export function App() {
  const route = useRoute();
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [savedKey, setSavedKey] = useState("");
  const [origin, setOrigin] = useState<Origin>("new");
  const [range, setRange] = useState<TimeRangeKey>("24h");
  const [refreshSec, setRefreshSec] = useState(0);
  const [tick, setTick] = useState(0);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [recent, setRecent] = useState(loadRecent);
  const [modelsInfo, setModelsInfo] = useState<ModelsInfo | null>(null);
  const [modelPref, setModelPref] = useState(readModelPref);
  const [studioHash, setStudioHash] = useState("#/");
  const chatCtrl = useRef<AbortController | null>(null);
  const draftKey = useRef(newKey());
  const sessionKey = useRef(newSessionKey());
  const [restored, setRestored] = useState(false);
  const recipeRef = useRef<Recipe | null>(null);
  const loadingRef = useRef(false);
  recipeRef.current = recipe;

  const showToast = useCallback((t: Toast) => setToast(t), []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.href ? 12000 : 5000);
    return () => clearTimeout(id);
  }, [toast]);

  /** Environment for every API call. Chosen in the header; a dashboard can switch it when opened. */
  const [envId, setEnvIdState] = useState(() => {
    const id = readEnvPref();
    setApiEnv(id);
    return id;
  });
  const envRef = useRef(envId);
  const setEnvId = useCallback((id: string) => {
    if (id === envRef.current) return;
    envRef.current = id;
    setApiEnv(id);
    writeEnvPref(id);
    setEnvIdState(id);
    setCaps(null);
    setTick((t) => t + 1); // re-run every panel on the new environment
    setRecipe((cur) => (cur ? { ...cur, env: id } : cur));
  }, []);

  const loadCaps = useCallback((refresh = false) => {
    const asked = envRef.current;
    api.capabilities(refresh).then(
      (c) => {
        if (asked === envRef.current) setCaps(c);
      },
      (e) => {
        if (asked !== envRef.current) return;
        if (e.status === 400 && /Unknown environment/.test(e.message) && asked !== MAIN_ENV) {
          setToast({ tone: "bad", text: `הסביבה "${asked}" לא מוגדרת כאן. עברתי לסביבה הראשית.` });
          setEnvId(MAIN_ENV);
          return;
        }
        setCaps(unreachableCaps(e.message));
      },
    );
  }, [setEnvId]);
  useEffect(() => loadCaps(), [loadCaps, envId]);

  const loadModels = useCallback((refresh = false) => {
    api.models(refresh).then(setModelsInfo, () => setModelsInfo(null));
  }, []);
  useEffect(() => {
    if (caps?.llm.configured) loadModels();
  }, [caps?.llm.configured, caps?.llm.model, loadModels]);

  /** The model used for the next message: the user's pick if still offered, else the server default. */
  const models = modelsInfo?.models ?? (caps?.llm.model ? [caps.llm.model] : []);
  const activeModel = models.includes(modelPref) ? modelPref : modelsInfo?.default || caps?.llm.model || "";

  /** How long conversations are kept in this browser (server setting CHAT_RETENTION_HOURS). */
  const retention = caps?.chat?.retentionHours ?? 24;
  const retentionRef = useRef(retention);
  retentionRef.current = retention;
  useEffect(() => pruneChats(retention), [retention]);

  /** Bring back a conversation kept in this browser, if it hasn't expired. */
  const restoreChat = useCallback((key: string | undefined): boolean => {
    const msgs = loadChat(key, retentionRef.current);
    if (!key || !msgs?.length) return false;
    sessionKey.current = key;
    setMessages(msgs);
    setRestored(true);
    return true;
  }, []);

  /** Replace the current dashboard: restore its conversation if this browser still has it, else start fresh. */
  const openRecipe = useCallback((r: Recipe | null, o: Origin, session?: string) => {
    chatCtrl.current?.abort();
    if (!restoreChat(session)) {
      sessionKey.current = newSessionKey();
      setMessages([]);
      setRestored(false);
    }
    setRecipe(r);
    setSavedKey(r ? contentKey(r) : "");
    setOrigin(o);
    setLoadError(null);
    if (r) setRange(r.time_range);
    if (r?.env) setEnvId(r.env);
    draftKey.current = r?.id ?? newKey();
  }, [restoreChat, setEnvId]);

  // ---- Navigation → state ----
  useEffect(() => {
    const cur = recipeRef.current;
    if (route.name === "library" || route.name === "admin") return;
    if (route.name === "new") {
      if (route.fresh) {
        openRecipe(null, "new");
        replaceUrl("#/");
      } else if (!cur && route.session && route.session !== sessionKey.current) {
        restoreChat(route.session); // a reload during a chat that hasn't produced a dashboard yet
      }
      return;
    }
    if (route.name === "shared") {
      const r = decodeRecipe(route.payload);
      if (!r) {
        openRecipe(null, "new");
        setLoadError("הקישור פגום או חלקי — לא הצלחתי לקרוא ממנו דשבורד.");
        return;
      }
      if (cur && contentKey(cur) === contentKey(r) && cur.id === r.id) return; // same draft (e.g. back from the library)
      openRecipe(r, "link", route.session);
      return;
    }
    if (route.name === "saved") {
      if (cur?.id === route.id && (!route.version || cur.version === route.version)) return;
      setLoading(true);
      loadingRef.current = true;
      setLoadError(null);
      api
        .getDashboard(route.id, route.version)
        .then((r) => openRecipe(r, "library", route.session))
        .catch((e) => {
          openRecipe(null, "new");
          setLoadError(
            e.status === 403
              ? `הדשבורד הזה שמור בספרייה המשותפת, אבל לשרת אין גישה אליה: ${e.message}`
              : `לא הצלחתי לטעון את הדשבורד: ${e.message}`,
          );
        })
        .finally(() => {
          loadingRef.current = false;
          setLoading(false);
        });
    }
  }, [route, openRecipe, restoreChat]);

  const hasChat = messages.length > 0;

  // ---- State → URL (the draft always lives in the address bar) ----
  useEffect(() => {
    if (route.name === "library" || route.name === "admin" || loading || loadingRef.current) return;
    let hash: string;
    if (!recipe) hash = "#/";
    else if (recipe.id && recipe.version && origin === "library" && contentKey(recipe) === savedKey)
      hash = savedHash(recipe.id, recipe.version);
    else hash = `#/r/${encodeRecipe(recipe)}`;
    const full = withSession(hash, hasChat && retention > 0 ? sessionKey.current : undefined);
    replaceUrl(full);
    setStudioHash(full);
    if (recipe && recipe.panels.length) {
      rememberRecent({
        key: draftKey.current,
        title: recipe.title,
        hash: withSession(
          recipe.id && contentKey(recipe) === savedKey ? savedHash(recipe.id, recipe.version) : `#/r/${encodeRecipe(recipe)}`,
          hasChat && retention > 0 ? sessionKey.current : undefined,
        ),
        at: new Date().toISOString(),
        panels: recipe.panels.length,
      });
      setRecent(loadRecent());
    }
  }, [recipe, savedKey, origin, route, loading, hasChat, retention]);

  // ---- Keep the conversation in this browser for a while ----
  useEffect(() => {
    if (busy || !messages.length) return; // save once the answer is complete
    saveChat(sessionKey.current, messages, retention);
  }, [messages, busy, retention]);

  // ---- Auto refresh ----
  useEffect(() => {
    if (!refreshSec) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    }, refreshSec * 1000);
    return () => clearInterval(id);
  }, [refreshSec]);

  const changeRange = (r: TimeRangeKey) => {
    setRange(r);
    setRecipe((cur) => (cur ? { ...cur, time_range: r } : cur));
  };

  // ---- Chat ----
  const send = async (text: string) => {
    const history = [...messages.filter((m) => m.content.trim()), { role: "user" as const, content: text }]
      .slice(-40)
      .map(({ role, content }) => ({ role, content }));
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "", tools: [], streaming: true, model: activeModel }]);
    setBusy(true);
    const ctrl = new AbortController();
    chatCtrl.current = ctrl;
    let lastWasTool = false;
    const patch = (fn: (m: UiMessage) => UiMessage) =>
      setMessages((ms) => {
        const copy = [...ms];
        copy[copy.length - 1] = fn(copy[copy.length - 1]);
        return copy;
      });
    try {
      await streamChat(
        { messages: history, recipe: recipeRef.current, time_range: range, model: activeModel || undefined },
        (ev) => {
          switch (ev.type) {
            case "text": {
              const sep = lastWasTool;
              lastWasTool = false;
              patch((m) => ({ ...m, content: m.content + (sep && m.content ? "\n\n" : "") + ev.delta }));
              break;
            }
            case "tool_start":
              lastWasTool = true;
              patch((m) => ({ ...m, tools: [...(m.tools ?? []), { id: ev.id, summary: ev.summary }] }));
              break;
            case "tool_end":
              patch((m) => ({
                ...m,
                tools: (m.tools ?? []).map((t) => (t.id === ev.id ? { ...t, ok: ev.ok, result: ev.summary } : t)),
              }));
              break;
            case "recipe":
              setRecipe({ ...ev.recipe, env: envRef.current });
              setRange(ev.recipe.time_range);
              break;
            case "error":
              patch((m) => ({ ...m, error: ev.message }));
              break;
          }
        },
        ctrl.signal,
      );
    } catch (e: any) {
      if (!ctrl.signal.aborted) patch((m) => ({ ...m, error: e.message }));
    } finally {
      patch((m) => ({ ...m, streaming: false }));
      setBusy(false);
      chatCtrl.current = null;
    }
  };

  // ---- Saving & sharing ----
  const save = async (mode: "update" | "new" | "fork") => {
    if (!recipe) return;
    setSaving(true);
    try {
      const saved = await api.saveDashboard(recipe, mode);
      setRecipe(saved);
      setSavedKey(contentKey(saved));
      setOrigin("library");
      // The unsaved draft (or the fork's source) gets replaced by the saved dashboard in "recent".
      if (mode !== "update") forgetRecent(draftKey.current);
      draftKey.current = saved.id!;
      showToast({
        tone: "ok",
        text:
          mode === "update"
            ? `נשמרה גרסה ${saved.version}`
            : mode === "fork"
              ? "נשמר כדשבורד חדש. המקור לא השתנה."
              : "הדשבורד נשמר בספרייה",
      });
    } catch (e: any) {
      showToast({ tone: "bad", text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const importFile = async (file: File) => {
    try {
      const r = parseRecipeFile(await file.text());
      openRecipe(r, "file");
      navigate(`#/r/${encodeRecipe(r)}`);
      showToast({ tone: "ok", text: `נטען: ${r.title}` });
    } catch (e: any) {
      showToast({ tone: "bad", text: e.message });
    }
  };

  const actions = {
    setTitle: (t: string) => setRecipe((cur) => (cur ? { ...cur, title: t || " " } : cur)),
    removePanel: (id: string) => setRecipe((cur) => (cur ? { ...cur, panels: cur.panels.filter((p) => p.id !== id) } : cur)),
    update: () => save("update"),
    saveNew: () => save(recipe?.id ? "fork" : "new"),
    copyLink: async () => {
      if (!recipe) return;
      const url = appUrl(`#/r/${encodeRecipe(recipe)}`);
      const ok = await copyText(url);
      if (!ok) return showToast({ tone: "bad", text: "לא הצלחתי להעתיק. אפשר להעתיק משורת הכתובת." });
      showToast(
        url.length > SAFE_LINK_LENGTH
          ? { tone: "bad", text: `הקישור הועתק, אבל הוא ארוך (${url.length} תווים) ועלול להיחתך בצ'אט או במייל. לדשבורד גדול עדיף ייצוא JSON.` }
          : { tone: "ok", text: "הקישור הועתק. הדשבורד כולו נמצא בתוכו, ומי שיפתח אותו יראה אותו חי." },
      );
    },
    copyShortLink: async () => {
      if (!recipe?.id) return;
      const ok = await copyText(appUrl(savedHash(recipe.id, recipe.version)));
      showToast(ok ? { tone: "ok", text: "קישור קצר לגרסה הזו הועתק" } : { tone: "bad", text: "ההעתקה נכשלה" });
    },
    exportJson: () => recipe && downloadJson(recipe),
    ask: (text: string) => {
      if (busy) {
        showToast({ tone: "bad", text: "המודל עדיין עונה על השאלה הקודמת. אפשר לעצור אותו או לחכות." });
        return;
      }
      if (!caps?.llm.configured) {
        showToast({ tone: "bad", text: "המודל לא מוגדר בשרת" });
        return;
      }
      send(text);
    },
    importJson: importFile,
    exportKibana: async () => {
      if (!recipe) return;
      setSaving(true);
      try {
        const res = await api.exportKibana(recipe);
        showToast({
          tone: "ok",
          text: res.skipped.length ? `יוצא ל-Kibana. דולגו פאנלי טקסט: ${res.skipped.join(", ")}` : "יוצא ל-Kibana",
          href: res.url,
          hrefLabel: "פתח ב-Kibana",
        });
      } catch (e: any) {
        showToast({ tone: "bad", text: e.message });
      } finally {
        setSaving(false);
      }
    },
  };

  const dirty = recipe ? contentKey(recipe) !== savedKey : false;
  const view = route.name === "library" ? "library" : route.name === "admin" ? "admin" : "studio";

  return (
    <div className="app">
      <a href="#chat-input" className="skip">
        דלג לשיחה
      </a>
      <Header
        envId={envId}
        onEnv={setEnvId}
        view={view}
        studioHref={studioHash}
        caps={caps}
        range={range}
        refreshSec={refreshSec}
        onRange={changeRange}
        onRefreshSec={setRefreshSec}
        onRefreshNow={() => setTick((t) => t + 1)}
        onRecheck={() => {
          setCaps(null);
          loadCaps(true);
        }}
      />

      {view === "admin" ? (
        <Admin
          caps={caps}
          onSaved={() => {
            loadCaps(true);
            loadModels(true);
          }}
        />
      ) : view === "library" ? (
        <Library caps={caps} recent={recent} onRecentChange={() => setRecent(loadRecent())} onImport={importFile} />
      ) : (
        <main className="studio">
          <Chat
            messages={messages}
            busy={busy}
            hasDashboard={Boolean(recipe?.panels.length)}
            basedOn={recipe?.panels.length ? recipe.title : undefined}
            llm={caps?.llm ?? { configured: true }}
            models={models}
            model={activeModel}
            onModel={(m) => {
              setModelPref(m);
              writeModelPref(m);
            }}
            onSend={send}
            onStop={() => chatCtrl.current?.abort()}
            restored={restored}
            retentionHours={retention}
            onNewChat={() => {
              chatCtrl.current?.abort();
              saveChat(sessionKey.current, [], retention); // forget it here too
              setMessages([]);
              setRestored(false);
            }}
          />
          <div className="board-wrap">
            {loadError && (
              <div className="banner bad" role="alert">
                {loadError}
              </div>
            )}
            {loading ? (
              <div className="board loading-board">טוען דשבורד…</div>
            ) : (
              <Dashboard
                recipe={recipe}
                dirty={dirty}
                origin={origin}
                caps={caps}
                range={range}
                tick={tick}
                saving={saving}
                recent={recent}
                actions={actions}
              />
            )}
          </div>
        </main>
      )}

      {toast && (
        <div className={`toast ${toast.tone}`} role="status">
          <span>{toast.text}</span>
          {toast.href && (
            <a href={toast.href} target="_blank" rel="noreferrer">
              {toast.hrefLabel ?? "פתח"}
            </a>
          )}
          <button type="button" className="icon-btn" aria-label="סגור" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
