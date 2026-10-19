import { useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "./icons";
import { Menu } from "./Menu";
import { PanelView } from "./Panel";
import { savedHash } from "../route";
import type { RecentItem } from "../share";
import type { Capabilities, DashboardSummary, Recipe, TimeRangeKey } from "../../shared/recipe";

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

      <div className="grid">
        {recipe.panels.map((p) => (
          <PanelView
            key={p.id}
            panel={p}
            range={range}
            tick={tick}
            discoverBase={caps?.discover.enabled ? caps.discover.baseUrl : undefined}
            onRemove={() => actions.removePanel(p.id)}
          />
        ))}
      </div>
    </section>
  );
}
