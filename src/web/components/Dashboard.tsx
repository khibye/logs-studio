import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "./icons";
import { Menu } from "./Menu";
import { PanelView } from "./Panel";
import { savedHash } from "../route";
import type { RecentItem } from "../share";
import type { Annotation, Capabilities, DashboardSummary, Recipe, TimeRangeKey } from "../../shared/recipe";

const PREV_KEY = "logs-studio:compare-prev";
const DEPLOYS_KEY = "logs-studio:show-deploys";
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {}
}

function Toggle({ on, onChange, children, title }: { on: boolean; onChange: (v: boolean) => void; children: React.ReactNode; title?: string }) {
  return (
    <button type="button" className={`toggle ${on ? "on" : ""}`} aria-pressed={on} onClick={() => onChange(!on)} title={title}>
      <span className="toggle-box" aria-hidden="true">
        {on && <Icon.Check size={12} />}
      </span>
      {children}
    </button>
  );
}

export type Origin = "new" | "link" | "file" | "library";

export type DashboardActions = {
  setTitle: (t: string) => void;
  removePanel: (id: string) => void;
  update: () => void;
  saveNew: () => void;
  copyLink: () => void;
  copyShortLink: () => void;
  exportJson: () => void;
  importJson: (file: File) => void;
  exportKibana: () => void;
  /** Send a question to the chat (panel / point analysis). */
  ask: (text: string) => void;
};

function StatusPill({ recipe, dirty, origin }: { recipe: Recipe; dirty: boolean; origin: Origin }) {
  let text: string;
  let tone: "ok" | "warn" | "neutral";
  if (recipe.id && recipe.version) {
    text = dirty ? `שונה מגרסה ${recipe.version} · לא נשמר` : `גרסה ${recipe.version} · שמור בספרייה`;
    tone = dirty ? "warn" : "ok";
  } else if (origin === "link" || origin === "file") {
    text = `${origin === "link" ? "נפתח מקישור" : "נטען מקובץ"}${dirty ? " · שונה" : ""}`;
    tone = dirty ? "warn" : "neutral";
  } else {
    text = "טיוטה · הקישור בשורת הכתובת שומר אותה";
    tone = "warn";
  }
  return <span className={`pill ${tone}`}>{text}</span>;
}

function Versions({ recipe }: { recipe: Recipe }) {
  const [items, setItems] = useState<DashboardSummary[] | null>(null);
  const [error, setError] = useState<string>();
  return (
    <Menu
      label={
        <>
          <Icon.History size={16} /> גרסאות
        </>
      }
      onOpen={() => {
        setItems(null);
        setError(undefined);
        api.versions(recipe.id!).then(setItems, (e) => setError(e.message));
      }}
    >
      {(close) => (
        <div className="menu-list">
          {error && <div className="menu-note bad">{error}</div>}
          {!items && !error && <div className="menu-note">טוען…</div>}
          {items?.map((v) => (
            <a
              key={v.version}
              className={`menu-item ${v.version === recipe.version ? "current" : ""}`}
              href={savedHash(v.id, v.version)}
              onClick={close}
            >
              <span>גרסה {v.version}</span>
              <span className="muted">{new Date(v.saved_at).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}</span>
            </a>
          ))}
        </div>
      )}
    </Menu>
  );
}

export function Dashboard(props: {
  recipe: Recipe | null;
  dirty: boolean;
  origin: Origin;
  caps: Capabilities | null;
  range: TimeRangeKey;
  tick: number;
  saving: boolean;
  recent: RecentItem[];
  actions: DashboardActions;
}) {
  const { recipe, dirty, origin, caps, range, tick, saving, recent, actions } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const canWrite = Boolean(caps?.library.write);
  const canRead = Boolean(caps?.library.read);
  const libReason = caps?.library.reason ?? "הספרייה לא זמינה";
  const inLibrary = Boolean(recipe?.id && recipe?.version);
  const hasPanels = Boolean(recipe && recipe.panels.length > 0);
  const envs = caps?.environments ?? [];
  const envId = caps?.env.id;

  // ---- View options (per browser; not part of the dashboard) ----
  const [comparePrev, setComparePrev] = useState(() => readFlag(PREV_KEY, true));
  const [showDeploys, setShowDeploys] = useState(() => readFlag(DEPLOYS_KEY, true));
  const [compareEnvId, setCompareEnvId] = useState("");
  const compareEnv = envs.find((e) => e.id === compareEnvId && e.id !== envId) ?? null;

  // ---- Deploy annotations for the current environment ----
  const [annotations, setAnnotations] = useState<{ events: Annotation[]; error?: string }>({ events: [] });
  const deploysOn = Boolean(caps?.deploys.enabled);
  useEffect(() => {
    if (!deploysOn || !hasPanels) {
      setAnnotations({ events: [] });
      return;
    }
    let live = true;
    api.annotations(range).then(
      (r) => live && setAnnotations({ events: r.events, error: r.error }),
      (e) => live && setAnnotations({ events: [], error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [deploysOn, envId, range, tick, hasPanels]);

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="application/json,.json"
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) actions.importJson(f);
        e.target.value = "";
      }}
    />
  );

  if (!recipe || !hasPanels) {
    return (
      <section className="board" aria-label="דשבורד">
        {fileInput}
        <div className="empty">
          <h1>דשבורד חדש</h1>
          <p>
            כתבי בצ'אט מה לבדוק בלוגים. המודל יחקור את הנתונים ויבנה כאן דשבורד חי: כל פאנל הוא שאילתת ES|QL שרצה מחדש בכל רענון.
          </p>
          <div className="empty-actions">
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              <Icon.Upload size={16} /> ייבוא מקובץ JSON
            </button>
            {canRead && (
              <a className="btn" href="#/library">
                הדשבורדים בספרייה
              </a>
            )}
          </div>
          {recent.length > 0 && (
            <div className="recent">
              <h2>עבדת עליהם לאחרונה בדפדפן הזה</h2>
              <ul>
                {recent.slice(0, 6).map((r) => (
                  <li key={r.key}>
                    <a href={r.hash}>{r.title}</a>
                    <span className="muted">
                      {r.panels} פאנלים · {new Date(r.at).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="board" aria-label="דשבורד">
      {fileInput}
      <div className="board-head">
        <div className="board-title">
          <label htmlFor="dash-title" className="sr-only">
            שם הדשבורד
          </label>
          <input
            id="dash-title"
            className="title-input"
            value={recipe.title}
            onChange={(e) => actions.setTitle(e.target.value)}
            maxLength={120}
          />
          <div className="board-meta">
            <StatusPill recipe={recipe} dirty={dirty} origin={origin} />
            <span className="muted">{recipe.panels.length} פאנלים · ES|QL · חי</span>
            {recipe.forked_from && (
              <a className="muted" href={savedHash(recipe.forked_from.id, recipe.forked_from.version)}>
                עותק של גרסה {recipe.forked_from.version} של דשבורד אחר
              </a>
            )}
          </div>
          {recipe.notes && <p className="notes">{recipe.notes}</p>}
        </div>

        <div className="board-actions">
          {inLibrary && canRead && <Versions recipe={recipe} />}

          {inLibrary && (
            <button
              type="button"
              className={`btn ${dirty ? "primary" : ""}`}
              onClick={actions.update}
              disabled={!canWrite || !dirty || saving}
              title={!canWrite ? libReason : !dirty ? "אין שינויים לשמור" : `שומר גרסה ${recipe.version! + 1}`}
            >
              <Icon.Save size={16} /> עדכן
            </button>
          )}

          <button
            type="button"
            className={`btn ${!inLibrary && canWrite ? "primary" : ""}`}
            onClick={actions.saveNew}
            disabled={!canWrite || saving}
            title={!canWrite ? libReason : inLibrary ? "שמירה כדשבורד חדש; המקור לא משתנה" : "שמירה בספרייה המשותפת"}
          >
            {inLibrary ? <Icon.Fork size={16} /> : <Icon.Save size={16} />}
            {inLibrary ? "שמור כעותק" : "שמור בספרייה"}
          </button>

          <button type="button" className={`btn ${!canWrite ? "primary" : ""}`} onClick={actions.copyLink}>
            <Icon.Link size={16} /> העתק קישור
          </button>

          <Menu label={<>עוד <Icon.Chevron size={14} /></>} ariaLabel="פעולות נוספות">
            {(close) => (
              <div className="menu-list">
                <button
                  type="button"
                  className="menu-item"
                  disabled={!inLibrary || dirty}
                  title={!inLibrary ? "זמין אחרי שמירה בספרייה" : dirty ? "יש שינויים שלא נשמרו" : undefined}
                  onClick={() => {
                    actions.copyShortLink();
                    close();
                  }}
                >
                  <Icon.Link size={15} /> העתק קישור קצר (מהספרייה)
                </button>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    actions.exportJson();
                    close();
                  }}
                >
                  <Icon.Download size={15} /> ייצוא לקובץ JSON
                </button>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    fileRef.current?.click();
                    close();
                  }}
                >
                  <Icon.Upload size={15} /> ייבוא מקובץ JSON
                </button>
                <div className="menu-sep" />
                <button
                  type="button"
                  className="menu-item"
                  disabled={!caps?.kibanaExport.enabled || saving}
                  onClick={() => {
                    actions.exportKibana();
                    close();
                  }}
                >
                  <Icon.External size={15} /> ייצוא לדשבורד של Kibana
                  <span className="tag">ניסיוני</span>
                </button>
                {!caps?.kibanaExport.enabled && (
                  <div className="menu-note">
                    <bdi dir="ltr">{caps?.kibanaExport.reason ?? "Not available"}</bdi>
                  </div>
                )}
              </div>
            )}
          </Menu>
        </div>
      </div>

      <div className="view-bar" role="toolbar" aria-label="אפשרויות תצוגה">
        <Toggle
          on={comparePrev && !compareEnv}
          onChange={(v) => {
            setComparePrev(v);
            writeFlag(PREV_KEY, v);
          }}
          title={compareEnv ? "כבוי בזמן השוואה בין סביבות" : undefined}
        >
          השוואה לתקופה קודמת
        </Toggle>
        {deploysOn && (
          <Toggle
            on={showDeploys}
            onChange={(v) => {
              setShowDeploys(v);
              writeFlag(DEPLOYS_KEY, v);
            }}
            title={annotations.error}
          >
            פריסות{annotations.error ? " (שגיאה)" : ` (${annotations.events.length})`}
          </Toggle>
        )}
        {envs.length > 1 && (
          <label className="select small">
            <Icon.Server size={14} />
            <span>השוואה לסביבה:</span>
            <select value={compareEnv?.id ?? ""} onChange={(e) => setCompareEnvId(e.target.value)}>
              <option value="">ללא</option>
              {envs
                .filter((e) => e.id !== envId)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>

      <div className={`grid ${compareEnv ? "comparing" : ""}`}>
        {recipe.panels.map((p) => (
          <PanelView
            key={p.id}
            panel={p}
            range={range}
            tick={tick}
            discoverBase={caps?.discover.enabled ? caps.discover.baseUrl : undefined}
            envId={envId}
            envName={caps?.env.name}
            compareEnv={compareEnv}
            comparePrev={comparePrev}
            annotations={showDeploys ? annotations.events : undefined}
            multiEnv={envs.length > 1}
            onAsk={actions.ask}
            onRemove={() => actions.removePanel(p.id)}
          />
        ))}
      </div>
    </section>
  );
}
