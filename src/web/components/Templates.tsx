import { useEffect, useRef, useState } from "react";
import { api, type TemplatesInfo } from "../api";
import { Icon } from "./icons";
import { ScopeBar } from "./ScopeBar";
import { numberFmt } from "./Chart";
import { TIME_RANGES, TIME_RANGE_KEYS, type Capabilities, type TimeRangeKey } from "../../shared/recipe";
import type { Template } from "../../shared/template";
import type { Context } from "../../shared/context";
import { scopeLabel } from "../../shared/scope";

const STORE_LABEL = { library: "ספרייה משותפת", server: "שרת האפליקציה" } as const;

export function emptyTemplate(): Template {
  return { name: "", description: "", indices: [], scope: [], context: "", questions: [] };
}

function Chips({ t }: { t: Template }) {
  return (
    <div className="tpl-chips" dir="ltr">
      {t.indices.map((i) => (
        <span key={i} className="tpl-chip idx">
          {i}
        </span>
      ))}
      {t.scope.map((f, i) => (
        <span key={i} className={`tpl-chip ${f.exclude ? "not" : ""}`}>
          {scopeLabel(f)}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor (modal)
// ---------------------------------------------------------------------------

export function TemplateEditor(props: {
  initial: Template;
  info: TemplatesInfo | null;
  caps: Capabilities | null;
  envId: string;
  range: TimeRangeKey;
  onClose: () => void;
  onSaved: (t: Template) => void;
}) {
  const { initial, info, caps, envId, onClose, onSaved } = props;
  const [t, setT] = useState<Template>(initial);
  const [indicesText, setIndicesText] = useState(initial.indices.join(", "));
  const [questionsText, setQuestionsText] = useState(initial.questions.join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    dialogRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const indices = indicesText
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
  const range = t.time_range ?? props.range;
  const store = initial.id ? initial.store : info?.saveTo;
  const blocked = !store;

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const questions = questionsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 6);
      const saved = await api.saveTemplate({ ...t, name: t.name.trim(), indices, questions });
      onSaved(saved);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="tpl-title" ref={dialogRef}>
        <div className="modal-head">
          <h2 id="tpl-title">{initial.id ? "עריכת תבנית" : "תבנית חדשה"}</h2>
          <button type="button" className="icon-btn" aria-label="סגור" onClick={onClose}>
            <Icon.X size={16} />
          </button>
        </div>
        <p className="muted small">
          תבנית היא נקודת פתיחה לשיחה: איפה הנתונים, על מה להתמקד, ומה המודל צריך לדעת. שיחה שמתחילה מתבנית לא צריכה לחפש
          את כל זה מחדש.
        </p>

        <label className="field">
          <span className="field-label">שם</span>
          <input className="input" value={t.name} maxLength={80} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder="WebUI" />
        </label>
        <label className="field">
          <span className="field-label">תיאור קצר</span>
          <input
            className="input"
            value={t.description}
            maxLength={500}
            onChange={(e) => setT({ ...t, description: e.target.value })}
            placeholder="לוגים של ה-webui בפרודקשן"
          />
        </label>
        <label className="field">
          <span className="field-label">אינדקסים</span>
          <input
            className="input mono-in"
            dir="ltr"
            value={indicesText}
            onChange={(e) => setIndicesText(e.target.value)}
            placeholder={caps?.logs.patterns.join(", ") || "logs-*"}
          />
          <span className="field-help">
            מופרד בפסיקים. ריק = כל האינדקסים המותרים (<bdi dir="ltr">{caps?.logs.patterns.join(", ")}</bdi>). כדאי לצמצם, למשל{" "}
            <code dir="ltr">logs-webui-*</code>.
          </span>
        </label>
        <div className="field">
          <span className="field-label">מיקוד</span>
          <ScopeBar scope={t.scope} onChange={(scope) => setT({ ...t, scope })} range={range} envId={envId} indices={indices} />
        </div>
        <label className="field">
          <span className="field-label">הסבר למודל</span>
          <textarea
            className="input area"
            rows={4}
            value={t.context}
            maxLength={4000}
            onChange={(e) => setT({ ...t, context: e.target.value })}
            placeholder="מה המערכת עושה, אילו שדות חשובים ומה הם אומרים, איך מזהים שגיאה…"
          />
        </label>
        <label className="field">
          <span className="field-label">שאלות פתיחה</span>
          <textarea
            className="input area short"
            rows={3}
            value={questionsText}
            onChange={(e) => setQuestionsText(e.target.value)}
            placeholder={"שאלה בכל שורה, למשל:\nמה השגיאות הנפוצות היום?\nהאם היו הפעלות מחדש של pods?"}
          />
        </label>
        <label className="field inline">
          <span className="field-label">טווח זמן</span>
          <select
            className="input"
            value={t.time_range ?? ""}
            onChange={(e) => setT({ ...t, time_range: (e.target.value || undefined) as TimeRangeKey | undefined })}
          >
            <option value="">ללא שינוי</option>
            {TIME_RANGE_KEYS.map((k) => (
              <option key={k} value={k}>
                {TIME_RANGES[k].label}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <div className="banner bad" role="alert">
            {error}
          </div>
        )}
        <div className="modal-foot">
          <span className="muted small">
            {store
              ? `יישמר ב${STORE_LABEL[store]}${store === "server" ? " (זמין לכל מי שמשתמש באפליקציה)" : ""}`
              : `אין איפה לשמור: ${info?.stores.library.reason ?? ""} ${info?.stores.server.reason ?? ""}`}
          </span>
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={onClose}>
            ביטול
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={saving || blocked || !t.name.trim()}>
            <Icon.Save size={15} /> {saving ? "שומר…" : "שמור תבנית"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pickers and cards
// ---------------------------------------------------------------------------

/** "Start from a template" — shown in an empty chat. */
export function TemplatePicker(props: { info: TemplatesInfo | null; onStart: (t: Template) => void; onNew: () => void }) {
  const { info, onStart, onNew } = props;
  if (!info) return null;
  return (
    <div className="tpl-picker">
      <div className="tpl-picker-head">
        <span>להתחיל מתבנית</span>
        <button type="button" className="link-btn" onClick={onNew}>
          תבנית חדשה
        </button>
      </div>
      {info.templates.length === 0 ? (
        <p className="muted small">
          עדיין אין תבניות. אפשר לבקש מהמודל: "צור תבנית ללוגים של webui", או ליצור אחת ידנית.
        </p>
      ) : (
        <div className="tpl-list">
          {info.templates.slice(0, 8).map((t) => (
            <button key={`${t.store}-${t.id}`} type="button" className="tpl-item" onClick={() => onStart(t)}>
              <span className="tpl-name">{t.name}</span>
              {t.description && <span className="tpl-desc">{t.description}</span>}
              <Chips t={t} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The model's proposed template, inside its chat message. */
export function TemplateProposal(props: {
  template: Template;
  count: number;
  onSave: () => void;
  onUse: () => void;
}) {
  const { template: t, count, onSave, onUse } = props;
  return (
    <div className="tpl-proposal">
      <div className="tpl-proposal-head">
        <span className="tpl-badge">הצעה לתבנית</span>
        <strong>{t.name}</strong>
        <span className="muted small">
          · <bdi dir="ltr">{numberFmt.format(count)}</bdi> שורות מתאימות
        </span>
      </div>
      {t.description && <div className="small">{t.description}</div>}
      <Chips t={t} />
      {t.context && <div className="tpl-context">{t.context}</div>}
      <div className="tpl-proposal-actions">
        <button type="button" className="btn small primary" onClick={onSave}>
          <Icon.Save size={14} /> שמור כתבנית
        </button>
        <button type="button" className="btn small" onClick={onUse}>
          השתמש בשיחה הזו
        </button>
      </div>
    </div>
  );
}

/** The current conversation's starting point, above the focus bar. */
export function ContextLine(props: { context?: Context; onClear: () => void; onSave: () => void; canSave: boolean; disabled?: boolean }) {
  const { context, onClear, onSave, canSave, disabled } = props;
  const has = Boolean(context?.template || context?.indices?.length || context?.text);
  return (
    <div className="context-line">
      {has ? (
        <>
          <span className="scope-label">תבנית</span>
          <span className="context-chip">
            <span className="context-name">{context?.template?.name ?? "ללא שם"}</span>
            {context?.indices?.length ? (
              <bdi dir="ltr" className="muted">
                {context.indices.join(", ")}
              </bdi>
            ) : null}
            <button type="button" className="scope-x" aria-label="הסר את התבנית מהשיחה" onClick={onClear} disabled={disabled}>
              <Icon.X size={12} />
            </button>
          </span>
        </>
      ) : null}
      {canSave && (
        <button type="button" className="link-btn" onClick={onSave} disabled={disabled}>
          {has ? "שמור כתבנית" : "שמור את המיקוד כתבנית"}
        </button>
      )}
    </div>
  );
}

/** Library page: all templates, with edit / delete / start. */
export function TemplatesSection(props: {
  info: TemplatesInfo | null;
  onStart: (t: Template) => void;
  onEdit: (t: Template) => void;
  onNew: () => void;
  onChanged: () => void;
}) {
  const { info, onStart, onEdit, onNew, onChanged } = props;
  const [error, setError] = useState<string>();
  const remove = async (t: Template) => {
    if (!confirm(`למחוק את התבנית "${t.name}"?`)) return;
    try {
      await api.deleteTemplate(t);
      onChanged();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <section aria-labelledby="lib-templates">
      <div className="section-head">
        <h2 id="lib-templates" className="section-title">
          תבניות
        </h2>
        <button type="button" className="btn small" onClick={onNew} disabled={!info?.saveTo}>
          <Icon.Plus size={14} /> תבנית חדשה
        </button>
      </div>
      <p className="muted small">
        נקודות פתיחה לשיחה: אינדקסים, מיקוד והסבר למודל.{" "}
        {info?.saveTo ? `תבניות חדשות נשמרות ב${STORE_LABEL[info.saveTo]}.` : "אין כרגע איפה לשמור תבניות."}
      </p>
      {(error || (info?.errors.length ?? 0) > 0) && (
        <div className="banner bad" role="alert">
          {error ?? info?.errors.join(" · ")}
        </div>
      )}
      {!info ? (
        <p className="muted">טוען…</p>
      ) : info.templates.length === 0 ? (
        <p className="muted">אין עדיין תבניות.</p>
      ) : (
        <ul className="tpl-rows">
          {info.templates.map((t) => (
            <li key={`${t.store}-${t.id}`} className="tpl-row">
              <div className="tpl-row-main">
                <div>
                  <strong>{t.name}</strong> <span className="muted small">· {STORE_LABEL[t.store ?? "server"]}</span>
                </div>
                {t.description && <div className="muted small">{t.description}</div>}
                <Chips t={t} />
              </div>
              <div className="tpl-row-actions">
                <button type="button" className="btn small primary" onClick={() => onStart(t)}>
                  שיחה חדשה מהתבנית
                </button>
                <button type="button" className="btn small" onClick={() => onEdit(t)}>
                  עריכה
                </button>
                <button type="button" className="btn small ghost" onClick={() => remove(t)} aria-label={`מחק את ${t.name}`}>
                  <Icon.X size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
