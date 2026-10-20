import { useEffect, useMemo, useState, type FormEvent } from "react";
import { adminApi, ApiError, type AdminSettings, type SettingView } from "../api";
import { Icon } from "./icons";
import { CapsList } from "./Header";
import type { Capabilities, ModelsInfo } from "../../shared/recipe";

const PW_KEY = "logs-studio:admin";

const GROUPS: { id: SettingView["group"]; title: string; hint?: string }[] = [
  { id: "elastic", title: "Elasticsearch" },
  { id: "kibana", title: "Kibana" },
  { id: "llm", title: "מודל AI" },
  { id: "app", title: "אפליקציה" },
];

const SOURCE_LABEL: Record<SettingView["source"], string> = {
  admin: "הוגדר כאן",
  env: "ממשתנה סביבה",
  file: "מקובץ LOG_CONTEXT_FILE",
  default: "ברירת מחדל",
  unset: "לא מוגדר",
};

function readPw(): string {
  try {
    return sessionStorage.getItem(PW_KEY) ?? "";
  } catch {
    return "";
  }
}
function writePw(pw: string) {
  try {
    if (pw) sessionStorage.setItem(PW_KEY, pw);
    else sessionStorage.removeItem(PW_KEY);
  } catch {}
}

/** What the editor shows for a setting before any edit. Secrets start empty (type to replace). */
const initial = (s: SettingView) => (s.kind === "secret" ? "" : s.value);

function Field(props: {
  s: SettingView;
  value: string;
  reset: boolean;
  error?: string;
  onChange: (v: string) => void;
  onReset: () => void;
  onUndoReset: () => void;
}) {
  const { s, value, reset, error, onChange, onReset, onUndoReset } = props;
  const id = `set-${s.key}`;
  const changed = !reset && value !== initial(s);
  const common = {
    id,
    "aria-invalid": Boolean(error) || undefined,
    "aria-describedby": s.help ? `${id}-help` : undefined,
    disabled: reset,
  };

  let input;
  if (s.kind === "text") {
    input = <textarea {...common} className="input area" rows={5} value={value} onChange={(e) => onChange(e.target.value)} />;
  } else if (s.kind === "enum" || s.kind === "boolean") {
    const opts = s.kind === "boolean" ? ["true", "false"] : s.options ?? [];
    input = (
      <select {...common} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else {
    input = (
      <input
        {...common}
        className="input"
        dir="ltr"
        type={s.kind === "secret" ? "password" : s.kind === "number" ? "number" : "text"}
        autoComplete={s.kind === "secret" ? "new-password" : "off"}
        min={s.min}
        step={s.kind === "number" ? "any" : undefined}
        placeholder={s.kind === "secret" ? (s.isSet ? `${s.value} · השאירי ריק כדי לא לשנות` : "לא מוגדר") : s.default}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div className={`field ${changed ? "changed" : ""} ${error ? "has-error" : ""}`}>
      <div className="field-head">
        <label htmlFor={id}>{s.label}</label>
        <code dir="ltr" className="field-key">
          {s.key}
        </code>
      </div>
      {input}
      <div className="field-foot">
        {error ? (
          <span className="field-error" role="alert">
            {error}
          </span>
        ) : s.help ? (
          <span id={`${id}-help`} className="muted">
            {s.help}
          </span>
        ) : (
          <span />
        )}
        <span className="field-source">
          {reset ? (
            <>
              <span className="badge warn">יחזור ל: {s.fallback || "ריק"}</span>
              <button type="button" className="link-btn" onClick={onUndoReset}>
                בטל
              </button>
            </>
          ) : (
            <>
              <span className={`badge ${s.source === "admin" ? "accent" : ""}`}>{changed ? "שונה, לא נשמר" : SOURCE_LABEL[s.source]}</span>
              {s.source === "admin" && !changed && (
                <button type="button" className="link-btn" onClick={onReset} title={`חזרה לערך: ${s.fallback || "ריק"}`}>
                  אפס
                </button>
              )}
            </>
          )}
        </span>
      </div>
    </div>
  );
}

export function Admin(props: { caps: Capabilities | null; onSaved: () => void }) {
  const [pw, setPw] = useState(readPw);
  const [pwInput, setPwInput] = useState("");
  const [data, setData] = useState<AdminSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [resets, setResets] = useState<Set<string>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [test, setTest] = useState<{ capabilities: Capabilities; models: ModelsInfo } | null>(null);
  const [testing, setTesting] = useState(false);
  const enabled = props.caps?.admin?.enabled;

  const load = (password: string) => {
    setError(undefined);
    return adminApi.settings(password).then(
      (d) => {
        setData(d);
        setDraft(Object.fromEntries(d.settings.map((s) => [s.key, initial(s)])));
        setResets(new Set());
        setFieldErrors({});
      },
      (e: ApiError) => {
        if (e.status === 401) {
          writePw("");
          setPw("");
        }
        setError(e.message);
      },
    );
  };

  useEffect(() => {
    if (pw && enabled) load(pw);
  }, [pw, enabled]);

  const changes = useMemo(() => {
    const out: Record<string, string | null> = {};
    if (!data) return out;
    for (const s of data.settings) {
      if (resets.has(s.key)) out[s.key] = null;
      else if ((draft[s.key] ?? "") !== initial(s)) out[s.key] = draft[s.key] ?? "";
    }
    return out;
  }, [data, draft, resets]);
  const changeCount = Object.keys(changes).length;

  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await adminApi.test(pw));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(undefined);
    setFieldErrors({});
    try {
      const d = await adminApi.save(pw, changes);
      setData(d);
      setDraft(Object.fromEntries(d.settings.map((s) => [s.key, initial(s)])));
      setResets(new Set());
      setNotice(`נשמר (${changeCount} שינויים) והוחל מיד.`);
      props.onSaved();
      runTest();
    } catch (e: any) {
      if (e instanceof ApiError && e.fields) setFieldErrors(e.fields);
      setError(e.message);
      if (e.status === 401) {
        writePw("");
        setPw("");
      }
    } finally {
      setBusy(false);
    }
  };

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await adminApi.login(pwInput);
      writePw(pwInput);
      setPw(pwInput);
      setPwInput("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!props.caps) return <main className="admin"><div className="card muted">טוען…</div></main>;

  if (!enabled) {
    return (
      <main className="admin">
        <h1>ניהול</h1>
        <div className="card notice">
          <strong>פאנל הניהול כבוי.</strong>
          <p>
            כדי להפעיל אותו מגדירים בשרת את משתנה הסביבה <code dir="ltr">ADMIN_PASSWORD</code> ומפעילים מחדש. הסיסמה נשארת תמיד
            במשתנה סביבה ולא ניתנת לשינוי מכאן.
          </p>
        </div>
      </main>
    );
  }

  if (!pw) {
    return (
      <main className="admin narrow">
        <h1>ניהול</h1>
        <form className="card login" onSubmit={login}>
          <label htmlFor="admin-pw">סיסמת ניהול</label>
          <input
            id="admin-pw"
            className="input"
            type="password"
            dir="ltr"
            autoComplete="current-password"
            value={pwInput}
            onChange={(e) => setPwInput(e.target.value)}
            autoFocus
          />
          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="btn primary" disabled={!pwInput || busy}>
            כניסה
          </button>
          <p className="muted small">הסיסמה נשמרת רק בלשונית הזו, עד שסוגרים אותה.</p>
        </form>
      </main>
    );
  }

  return (
    <main className="admin">
      <div className="admin-head">
        <div>
          <h1>ניהול</h1>
          <p className="muted">
            הערכים כאן גוברים על משתני הסביבה ומוחלים מיד, בלי הפעלה מחדש. "אפס" מחזיר לערך של משתנה הסביבה.
          </p>
        </div>
        <div className="lib-actions">
          <button type="button" className="btn" onClick={runTest} disabled={testing}>
            <Icon.Refresh size={16} /> {testing ? "בודק…" : "בדוק חיבור"}
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              writePw("");
              setPw("");
              setData(null);
            }}
          >
            יציאה
          </button>
        </div>
      </div>

      {data && (
        <div className={`card storage ${data.storage.writable ? "" : "bad"}`}>
          <div>
            <strong>איפה ההגדרות נשמרות</strong>
            <div dir="ltr" className="mono">
              {data.storage.file}
            </div>
          </div>
          <p>
            {data.storage.writable
              ? "הקובץ נשמר בתוך ה-pod. כדי שההגדרות ישרדו הפעלה מחדש או פריסה חדשה, התיקייה צריכה להיות על volume קבוע (PVC). בלי זה האפליקציה חוזרת למשתני הסביבה אחרי כל הפעלה מחדש."
              : "אין הרשאת כתיבה לתיקייה, ולכן אי אפשר לשמור. צריך להגדיר DATA_DIR לתיקייה שהאפליקציה יכולה לכתוב אליה."}
          </p>
          {data.storage.error && (
            <p className="field-error">
              <bdi dir="ltr">{data.storage.error}</bdi>
            </p>
          )}
          <span className="muted small">
            {data.storage.overrides} ערכים מוגדרים כאן
            {data.storage.updated_at &&
              ` · עודכן ${new Date(data.storage.updated_at).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" })}`}
          </span>
        </div>
      )}

      {test && (
        <section className="card" aria-label="תוצאות בדיקת החיבור">
          <h2 className="section-title">בדיקת חיבור</h2>
          <CapsList caps={test.capabilities} />
          <div className={`cap ${test.models.error ? "bad" : "ok"}`} style={{ marginTop: 8 }}>
            <span className="cap-icon" aria-hidden="true">
              {test.models.error ? <Icon.X size={14} /> : <Icon.Check size={14} />}
            </span>
            <span className="cap-text">
              <span>מודלים זמינים בצ'אט: {test.models.models.length}</span>
              <bdi dir="ltr" className="cap-detail">
                {test.models.error ?? test.models.models.slice(0, 12).join(", ")}
                {test.models.models.length > 12 ? " …" : ""}
              </bdi>
            </span>
          </div>
        </section>
      )}

      {error && !Object.keys(fieldErrors).length && (
        <div className="banner bad" role="alert">
          {error}
        </div>
      )}

      {!data ? (
        <div className="card muted">טוען הגדרות…</div>
      ) : (
        GROUPS.map((g) => (
          <section key={g.id} className="card group" aria-labelledby={`grp-${g.id}`}>
            <h2 id={`grp-${g.id}`} className="section-title">
              {g.title}
            </h2>
            <div className="fields">
              {data.settings
                .filter((s) => s.group === g.id)
                .map((s) => (
                  <Field
                    key={s.key}
                    s={s}
                    value={draft[s.key] ?? ""}
                    reset={resets.has(s.key)}
                    error={fieldErrors[s.key]}
                    onChange={(v) => {
                      setNotice(undefined);
                      setDraft((d) => ({ ...d, [s.key]: v }));
                    }}
                    onReset={() => setResets((r) => new Set(r).add(s.key))}
                    onUndoReset={() =>
                      setResets((r) => {
                        const n = new Set(r);
                        n.delete(s.key);
                        return n;
                      })
                    }
                  />
                ))}
            </div>
          </section>
        ))
      )}

      {data && (
        <div className="savebar" role="region" aria-label="שמירה">
          <span className={changeCount ? "" : "muted"}>
            {notice && !changeCount ? notice : changeCount ? `${changeCount} שינויים שלא נשמרו` : "אין שינויים"}
          </span>
          <div className="lib-actions">
            <button
              type="button"
              className="btn"
              disabled={!changeCount || busy}
              onClick={() => {
                setDraft(Object.fromEntries(data.settings.map((s) => [s.key, initial(s)])));
                setResets(new Set());
                setFieldErrors({});
                setError(undefined);
              }}
            >
              בטל שינויים
            </button>
            <button type="button" className="btn primary" disabled={!changeCount || busy} onClick={save}>
              <Icon.Save size={16} /> {busy ? "שומר…" : "שמור והחל"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
