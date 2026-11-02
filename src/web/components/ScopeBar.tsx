import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "./icons";
import { numberFmt } from "./Chart";
import { FIELD_RE, type Scope, type ScopeFilter } from "../../shared/scope";
import type { TimeRangeKey } from "../../shared/recipe";

type Fields = { suggested: string[]; fields: { name: string; type: string }[] };

/** Last part of a dotted field name, for compact chips: kubernetes.pod.name → pod.name */
function shortName(field: string): string {
  const parts = field.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : field;
}

function splitValues(s: string): string[] {
  return [...new Set(s.split(",").map((v) => v.trim()).filter(Boolean))].slice(0, 20);
}

/**
 * "Focus" filters set up front (namespace, pod prefix, service…). They're added to every
 * query the model runs and to every panel, so the model doesn't have to look for them.
 */
export function ScopeBar(props: {
  scope: Scope;
  onChange: (s: Scope) => void;
  range: TimeRangeKey;
  envId: string;
  disabled?: boolean;
}) {
  const { scope, onChange, range, envId, disabled } = props;
  const [fields, setFields] = useState<Fields | null>(null);
  const [editing, setEditing] = useState<number | "new" | null>(null);

  useEffect(() => {
    setFields(null);
    api.scopeFields().then(setFields, () => setFields({ suggested: [], fields: [] }));
  }, [envId]);

  const save = (f: ScopeFilter | null) => {
    const next = [...scope];
    if (editing === "new") {
      if (f) next.push(f);
    } else if (editing !== null) {
      if (f) next[editing] = f;
      else next.splice(editing, 1);
    }
    onChange(next);
    setEditing(null);
  };

  return (
    <div className="scope-bar">
      <div className="scope-row">
        <span className="scope-label" title="מסננים שנוספים לכל שאילתה של המודל ולכל פאנל">
          מיקוד
        </span>
        {scope.map((f, i) => (
          <span key={`${f.field}-${i}`} className={`scope-chip ${f.exclude ? "not" : ""}`}>
            <button
              type="button"
              className="scope-chip-main"
              onClick={() => setEditing(i)}
              disabled={disabled}
              title={`${f.field} ${f.exclude ? "לא" : ""} ${f.values.join(", ")} · לחיצה לעריכה`}
              dir="ltr"
            >
              <span className="scope-field">{shortName(f.field)}</span>
              <span className="scope-op">{f.exclude ? "≠" : "="}</span>
              <span className="scope-values">{f.values.join(" | ")}</span>
            </button>
            <button
              type="button"
              className="scope-x"
              aria-label={`הסר מיקוד ${f.field}`}
              onClick={() => onChange(scope.filter((_, j) => j !== i))}
              disabled={disabled}
            >
              <Icon.X size={12} />
            </button>
          </span>
        ))}
        {scope.length < 10 && (
          <button
            type="button"
            className="scope-add"
            onClick={() => setEditing("new")}
            disabled={disabled}
            title="למשל namespace או תחילית של שם pod. המודל וכל הפאנלים יעבדו רק עליהם."
          >
            <Icon.Plus size={13} /> {scope.length ? "עוד" : "הוספת מיקוד"}
          </button>
        )}
      </div>
      {editing !== null && (
        <ScopeForm
          key={String(editing)}
          initial={editing === "new" ? null : scope[editing]}
          fields={fields}
          used={scope.filter((_, i) => i !== editing).map((f) => f.field)}
          scope={scope.filter((_, i) => i !== editing)}
          range={range}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ScopeForm(props: {
  initial: ScopeFilter | null;
  fields: Fields | null;
  used: string[];
  scope: Scope;
  range: TimeRangeKey;
  onSave: (f: ScopeFilter | null) => void;
  onCancel: () => void;
}) {
  const { initial, fields, used, scope, range, onSave, onCancel } = props;
  const options = (fields?.suggested ?? []).filter((f) => !used.includes(f) || f === initial?.field);
  const [field, setField] = useState(initial?.field ?? options[0] ?? "");
  const [other, setOther] = useState(Boolean(initial && !options.includes(initial.field)) || (fields !== null && !options.length));
  const [values, setValues] = useState(initial?.values.join(", ") ?? "");
  const [exclude, setExclude] = useState(Boolean(initial?.exclude));
  const [sugg, setSugg] = useState<{ values: { value: string; count: number }[]; reason?: string; loading?: boolean }>({ values: [] });
  const valueRef = useRef<HTMLInputElement>(null);

  // Once the field list arrives, default to its first suggestion.
  useEffect(() => {
    if (!initial && !field && options[0]) setField(options[0]);
    if (!initial && fields && !options.length) setOther(true);
  }, [fields]); // eslint-disable-line react-hooks/exhaustive-deps

  // Most common values of the chosen field (narrowed by the other filters and what's typed).
  const typed = values.split(",").pop()?.trim() ?? "";
  useEffect(() => {
    if (!field || !FIELD_RE.test(field)) {
      setSugg({ values: [] });
      return;
    }
    const ctrl = new AbortController();
    setSugg((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      api
        .scopeValues(field, typed.replace(/\*/g, ""), range, scope, ctrl.signal)
        .then((r) => setSugg(r))
        .catch((e) => !ctrl.signal.aborted && setSugg({ values: [], reason: e.message }));
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [field, typed, range]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = splitValues(values);
  const fieldOk = FIELD_RE.test(field);
  const canSave = fieldOk && list.length > 0;

  const pick = (v: string) => {
    const parts = values.split(",").map((s) => s.trim());
    parts.pop(); // replace what is being typed
    const next = [...new Set([...parts.filter(Boolean), v])];
    setValues(next.join(", ") + ", ");
    valueRef.current?.focus();
  };

  const submit = () => canSave && onSave({ field, values: list, ...(exclude ? { exclude: true } : {}) });

  return (
    <div
      className="scope-form"
      role="dialog"
      aria-label="מיקוד"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="scope-form-row">
        <label className="scope-form-label" htmlFor="scope-field">
          שדה
        </label>
        {!other ? (
          <select
            id="scope-field"
            className="input"
            dir="ltr"
            value={field}
            onChange={(e) => {
              if (e.target.value === "__other") {
                setOther(true);
                setField("");
              } else setField(e.target.value);
            }}
          >
            {!fields && <option value="">טוען שדות…</option>}
            {options.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            <option value="__other">שדה אחר…</option>
          </select>
        ) : (
          <>
            <input
              id="scope-field"
              className="input mono-in"
              dir="ltr"
              list="scope-all-fields"
              value={field}
              placeholder="kubernetes.namespace"
              onChange={(e) => setField(e.target.value.trim())}
              autoFocus
            />
            <datalist id="scope-all-fields">
              {(fields?.fields ?? []).slice(0, 2000).map((f) => (
                <option key={f.name} value={f.name}>
                  {f.type}
                </option>
              ))}
            </datalist>
          </>
        )}
      </div>
      <div className="scope-form-row">
        <label className="scope-form-label" htmlFor="scope-values">
          ערך
        </label>
        <input
          id="scope-values"
          ref={valueRef}
          className="input mono-in"
          dir="ltr"
          value={values}
          placeholder="payments, checkout-*"
          onChange={(e) => setValues(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          autoFocus={!other}
        />
      </div>
      <div className="scope-hint">
        כמה ערכים: מופרדים בפסיק. <code dir="ltr">*</code> = כל המשך, למשל <code dir="ltr">checkout-*</code> לכל ה-pods של checkout.
      </div>
      {(sugg.values.length > 0 || sugg.reason || sugg.loading) && (
        <div className="scope-sugg" aria-live="polite">
          {sugg.loading && !sugg.values.length && <span className="muted">טוען ערכים…</span>}
          {sugg.reason && !sugg.values.length && <span className="muted">{sugg.reason}</span>}
          {sugg.values.slice(0, 12).map((v) => (
            <button
              key={v.value}
              type="button"
              className={`chip sm ${list.includes(v.value) ? "on" : ""}`}
              onClick={() => pick(v.value)}
              dir="ltr"
              title={`${numberFmt.format(v.count)} שורות`}
            >
              {v.value} <span className="muted">{numberFmt.format(v.count)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="scope-form-foot">
        <label className="check">
          <input type="checkbox" checked={exclude} onChange={(e) => setExclude(e.target.checked)} /> להחריג את הערכים האלה
        </label>
        <span className="grow" />
        {initial && (
          <button type="button" className="btn ghost" onClick={() => onSave(null)}>
            הסר
          </button>
        )}
        <button type="button" className="btn ghost" onClick={onCancel}>
          ביטול
        </button>
        <button type="button" className="btn primary" onClick={submit} disabled={!canSave}>
          {initial ? "עדכן" : "הוסף"}
        </button>
      </div>
    </div>
  );
}
