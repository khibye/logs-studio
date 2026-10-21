import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { adminApi, api, ApiError, type AdminSettings, type SettingView } from "../api";
import { Icon } from "./icons";
import type { Capabilities } from "../../shared/recipe";

/**
 * Admin page: three tabs (environments / AI model / general). Each environment
 * is a collapsible card with its live status; rarely-needed fields sit behind
 * "advanced". Values are drafts until "save" — then they apply at once.
 */

const PW_KEY = "logs-studio:admin";
const MAIN = "main";

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

// ---------------------------------------------------------------------------
// Field layout
// ---------------------------------------------------------------------------

/** Per-environment fields (same names for the main environment's settings and inside ENVIRONMENTS). */
const ENV_MAIN_FIELDS = ["ELASTIC_URL", "ELASTIC_API_KEY", "KIBANA_URL", "KIBANA_SPACE"];
const ENV_DATA_FIELDS = ["LOG_INDEX_PATTERNS", "LOG_CONTEXT", "DEPLOY_QUERY"];
const ENV_ADVANCED_FIELDS = ["ELASTIC_CONNECTION", "KIBANA_PUBLIC_URL", "KIBANA_API_KEY", "TIME_FIELD"];
const ENV_FIELDS = [...ENV_MAIN_FIELDS, ...ENV_DATA_FIELDS, ...ENV_ADVANCED_FIELDS];
const ENV_INHERITED = new Set(["LOG_INDEX_PATTERNS", "TIME_FIELD", "LOG_CONTEXT", "DEPLOY_QUERY"]);

const LLM_FIELDS = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_MODELS"];
const LLM_ADVANCED = ["LLM_STREAM", "LLM_MAX_STEPS", "LLM_TEMPERATURE"];
const GENERAL_FIELDS = ["CHAT_RETENTION_HOURS", "APP_BASIC_AUTH", "LIBRARY_ENV", "DASHBOARDS_INDEX", "LOG_LEVEL", "LOG_FORMAT"];
const GENERAL_ADVANCED = ["MAX_ROWS", "QUERY_TIMEOUT_MS", "KIBANA_EXPORT"];

type Tab = "envs" | "llm" | "general";
function tabOf(key: string): Tab {
  if (key === "ENV_NAME" || key === "ENVIRONMENTS" || ENV_FIELDS.includes(key)) return "envs";
  if (key.startsWith("LLM_")) return "llm";
  return "general";
}

/** Shorter labels and help than the server's, for the compact layout. */
const SHORT: Record<string, { label?: string; help?: string }> = {
  ELASTIC_URL: { help: "ריק = חיבור דרך Kibana. ב-Kibana: תפריט העזרה ← Connection details" },
  LOG_INDEX_PATTERNS: { label: "אינדקסים", help: "מופרד בפסיקים, למשל logs-myapp-*" },
  LOG_CONTEXT: { help: "מה כל שדה אומר, איך מזהים שגיאה, יחידות. המודל מקבל את זה בכל שיחה." },
  DEPLOY_QUERY: { label: "פריסות (ES|QL)", help: "מחזירה עמודת זמן ותיאור, למשל: FROM deploys-* | KEEP @timestamp, service.name, version" },
  ELASTIC_CONNECTION: { help: "auto: ישיר אם יש כתובת Elasticsearch, אחרת דרך Kibana (דורש הרשאת Dev Tools)" },
  KIBANA_PUBLIC_URL: { help: "רק אם הדפדפן מגיע ל-Kibana בכתובת אחרת מהשרת" },
  LLM_MODELS: { label: "מודלים שיוצגו בצ'אט", help: "בלי סימון = כל המודלים" },
  APP_BASIC_AUTH: { help: "user:password. טעות כאן נועלת גם את הניהול (תיקון: מחיקת settings.json)" },
  LIBRARY_ENV: { label: "הספרייה נשמרת בסביבה", help: "כל הסביבות משתמשות באותה ספרייה" },
  QUERY_TIMEOUT_MS: { label: "זמן המתנה לשאילתה (ms)" },
};

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function Info({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <span className="info" tabIndex={0} aria-label={text} data-tip={text}>
      ?
    </span>
  );
}

function Field(props: {
  id: string;
  def?: SettingView;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string;
  wide?: boolean;
  /** Overridden in the admin panel (shows "reset"). */
  overridden?: boolean;
  resetPending?: boolean;
  onReset?: () => void;
  onUndoReset?: () => void;
  changed?: boolean;
  children?: ReactNode;
}) {
  const { id, def, value, onChange, placeholder, error, wide, overridden, resetPending, onReset, onUndoReset, changed } = props;
  if (!def) return null;
  const label = SHORT[def.key]?.label ?? def.label;
  const help = SHORT[def.key]?.help ?? def.help;
  const common = { id, disabled: resetPending, "aria-invalid": Boolean(error) || undefined };
  let input: ReactNode = props.children;
  if (!input) {
    if (def.kind === "text") {
      input = (
        <textarea
          {...common}
          className={`input area ${def.key === "DEPLOY_QUERY" ? "mono-in" : ""}`}
          dir={def.key === "DEPLOY_QUERY" ? "ltr" : undefined}
          rows={def.key === "DEPLOY_QUERY" ? 2 : 4}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    } else if (def.kind === "enum" || def.kind === "boolean") {
      const opts = def.kind === "boolean" ? ["true", "false"] : def.options ?? [];
      input = (
        <select {...common} className="input" value={value || def.default || ""} onChange={(e) => onChange(e.target.value)}>
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
          type={def.kind === "secret" ? "password" : def.kind === "number" ? "number" : "text"}
          autoComplete={def.kind === "secret" ? "new-password" : "off"}
          min={def.min}
          step={def.kind === "number" ? "any" : undefined}
          placeholder={placeholder ?? def.default}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
  }
  return (
    <div className={`f ${wide ? "wide" : ""} ${changed ? "changed" : ""} ${error ? "has-error" : ""}`}>
      <div className="f-head">
        <label htmlFor={id}>{label}</label>
        <Info text={help} />
        <span className="f-flags">
          {resetPending ? (
            <>
              <span className="badge warn">יחזור לערך הבסיסי</span>
              <button type="button" className="link-btn" onClick={onUndoReset}>
                בטל
              </button>
            </>
          ) : overridden && !changed ? (
            <button type="button" className="link-btn" onClick={onReset} title={`חזרה ל: ${def.fallback || "ריק"}`}>
              אפס
            </button>
          ) : null}
        </span>
      </div>
      {input}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function Advanced({ children, count }: { children: ReactNode; count: number }) {
  return (
    <details className="adv">
      <summary>
        <Icon.Chevron size={14} /> מתקדם <span className="muted">({count})</span>
      </summary>
      <div className="fgrid">{children}</div>
    </details>
  );
}

function StatusLine({ caps, error }: { caps?: Capabilities | null; error?: string }) {
  if (error) return <span className="env-status bad">{error}</span>;
  if (caps === undefined) return <span className="env-status">לא נבדק</span>;
  if (caps === null) return <span className="env-status">בודק…</span>;
  const ok = caps.elastic.ok && caps.logs.read;
  if (!caps.elastic.ok)
    return (
      <span className="env-status bad">
        <span className="dot" aria-hidden="true" />
        אין חיבור: <bdi dir="ltr">{(caps.elastic.error ?? caps.logs.reason ?? "").slice(0, 140)}</bdi>
      </span>
    );
  const parts = [
    caps.elastic.ok ? `Elasticsearch ${caps.elastic.version ?? ""}${caps.elastic.via === "kibana" ? " (דרך Kibana)" : ""}` : "אין חיבור",
    caps.elastic.ok ? (caps.logs.read ? "לוגים ✓" : "אין הרשאת קריאה ללוגים") : "",
    caps.discover.enabled ? (caps.discover.warning ? "Discover ⚠" : "Discover ✓") : "",
    caps.deploys.enabled ? "פריסות ✓" : "",
  ].filter(Boolean);
  return (
    <span className={`env-status ${ok ? "ok" : "bad"}`} title={caps.elastic.error ?? caps.logs.reason ?? caps.discover.warning}>
      <span className="dot" aria-hidden="true" />
      {parts.join(" · ")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

type EnvObj = Record<string, string>;

function parseEnvs(v: string): EnvObj[] {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
/** Canonical form (fixed key order, no empty fields) so drafts compare cleanly with the saved value. */
function serializeEnvs(envs: EnvObj[]): string {
  if (!envs.length) return "";
  return JSON.stringify(
    envs.map((e) => {
      const out: EnvObj = { id: e.id ?? "", name: e.name ?? "" };
      for (const f of ENV_FIELDS) if (e[f]) out[f] = e[f];
      return out;
    }),
  );
}

function EnvCard(props: {
  title: string;
  subtitle: string;
  isMain: boolean;
  isNew?: boolean;
  open: boolean;
  onToggle: () => void;
  status: ReactNode;
  children: ReactNode;
  onRemove?: () => void;
  changed?: boolean;
}) {
  return (
    <section className={`env ${props.open ? "open" : ""} ${props.changed ? "changed" : ""}`}>
      <button type="button" className="env-head" aria-expanded={props.open} onClick={props.onToggle}>
        <Icon.Chevron size={16} />
        <span className="env-title">
          <strong>{props.title || "סביבה חדשה"}</strong>
          {props.isMain && <span className="badge">ראשית</span>}
          {props.isNew && <span className="badge accent">חדשה</span>}
          {props.changed && !props.isNew && <span className="badge warn">לא נשמר</span>}
        </span>
        <span className="env-sub" dir="ltr">
          {props.subtitle}
        </span>
      </button>
      <div className="env-status-row">{props.status}</div>
      {props.open && (
        <div className="env-body">
          {props.children}
          {props.onRemove && (
            <div className="env-foot">
              <button type="button" className="btn small danger" onClick={props.onRemove}>
                הסר סביבה
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const SECRET_FIELDS = ["ELASTIC_API_KEY", "KIBANA_API_KEY"];
const stripSecrets = (e: EnvObj): EnvObj => {
  const c = { ...e };
  for (const f of SECRET_FIELDS) delete c[f];
  return c;
};

const host = (u?: string) => {
  if (!u) return "";
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

// ---------------------------------------------------------------------------

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
  const [tab, setTab] = useState<Tab>("envs");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [envStatus, setEnvStatus] = useState<Record<string, Capabilities | null | undefined>>({});
  const [envErr, setEnvErr] = useState<Record<string, string>>({});
  const [models, setModels] = useState<{ list: string[]; error?: string; loading: boolean }>({ list: [], loading: false });
  const enabled = props.caps?.admin?.enabled;

  const defs = useMemo(() => new Map((data?.settings ?? []).map((s) => [s.key, s])), [data]);
  const def = (k: string) => defs.get(k);

  /** Editor start value. Secrets start empty ("type to replace"); environments without their secrets. */
  const initial = (s: SettingView): string => {
    if (s.kind === "secret") return "";
    if (s.kind === "environments")
      return serializeEnvs(
        parseEnvs(s.value).map((e) => {
          const c = { ...e };
          for (const f of SECRET_FIELDS) delete c[f];
          return c;
        }),
      );
    return s.value;
  };

  const resetDraft = (d: AdminSettings) => {
    const m = new Map(d.settings.map((s) => [s.key, s]));
    const init = (s: SettingView) => {
      if (s.kind === "secret") return "";
      if (s.kind === "environments")
        return serializeEnvs(
          parseEnvs(s.value).map((e) => {
            return stripSecrets(e);
          }),
        );
      return s.value;
    };
    setDraft(Object.fromEntries(d.settings.map((s) => [s.key, init(s)])));
    setResets(new Set());
    setFieldErrors({});
  };

  const checkEnvs = (ids: string[], refresh = true) => {
    setEnvStatus((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, null])) }));
    setEnvErr({});
    for (const id of ids) {
      api.capabilitiesFor(id, refresh).then(
        (c) => setEnvStatus((s) => ({ ...s, [id]: c })),
        (e) => setEnvErr((s) => ({ ...s, [id]: e.message })),
      );
    }
  };

  const loadModels = () => {
    setModels((m) => ({ ...m, loading: true }));
    adminApi.test(pw).then(
      (r) => setModels({ list: r.available.models, error: r.available.error, loading: false }),
      (e) => setModels({ list: [], error: e.message, loading: false }),
    );
  };

  const savedEnvIds = (d: AdminSettings | null) => [
    MAIN,
    ...parseEnvs(d?.settings.find((s) => s.key === "ENVIRONMENTS")?.value ?? "").map((e) => e.id),
  ];

  const load = (password: string) => {
    setError(undefined);
    return adminApi.settings(password).then(
      (d) => {
        setData(d);
        resetDraft(d);
        const ids = savedEnvIds(d);
        if (ids.length === 1) setOpen(new Set([MAIN]));
        checkEnvs(ids, false);
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

  useEffect(() => {
    if (tab === "llm" && data && !models.list.length && !models.loading && !models.error) loadModels();
  }, [tab, data]);

  // ---- Changes ----
  const changes = useMemo(() => {
    const out: Record<string, string | null> = {};
    if (!data) return out;
    for (const s of data.settings) {
      if (resets.has(s.key)) out[s.key] = null;
      else if ((draft[s.key] ?? "") !== initial(s)) out[s.key] = draft[s.key] ?? "";
    }
    return out;
  }, [data, draft, resets, defs]);
  const changeCount = Object.keys(changes).length;
  const changedTabs = new Set(Object.keys(changes).map(tabOf));

  const set = (key: string, v: string) => {
    setNotice(undefined);
    setDraft((d) => ({ ...d, [key]: v }));
  };

  const save = async () => {
    setBusy(true);
    setError(undefined);
    setFieldErrors({});
    try {
      const d = await adminApi.save(pw, changes);
      setData(d);
      resetDraft(d);
      setNotice(`נשמר (${changeCount} שינויים) והוחל מיד.`);
      props.onSaved();
      checkEnvs(savedEnvIds(d));
      if (Object.keys(changes).some((k) => k.startsWith("LLM_"))) loadModels();
    } catch (e: any) {
      if (e instanceof ApiError && e.fields) {
        setFieldErrors(e.fields);
        const firstTab = tabOf(Object.keys(e.fields)[0]);
        setTab(firstTab);
      }
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

  // ---- Early states ----
  if (!props.caps)
    return (
      <main className="admin">
        <div className="card muted">טוען…</div>
      </main>
    );

  if (!enabled) {
    return (
      <main className="admin">
        <h1>ניהול</h1>
        <div className="card notice">
          <strong>פאנל הניהול כבוי.</strong>
          <p>
            כדי להפעיל אותו מגדירים בשרת את משתנה הסביבה <code dir="ltr">ADMIN_PASSWORD</code> ומפעילים מחדש.
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

  if (!data)
    return (
      <main className="admin">
        <h1>ניהול</h1>
        {error ? <div className="banner bad">{error}</div> : <div className="card muted">טוען הגדרות…</div>}
      </main>
    );

  // ---- Helpers bound to the current draft ----
  const settingField = (key: string, opts: { wide?: boolean; placeholder?: string; children?: ReactNode } = {}) => {
    const s = def(key);
    if (!s) return null;
    const changed = !resets.has(key) && (draft[key] ?? "") !== initial(s);
    return (
      <Field
        key={key}
        id={`set-${key}`}
        def={s}
        value={draft[key] ?? ""}
        onChange={(v) => set(key, v)}
        placeholder={opts.placeholder ?? (s.kind === "secret" ? (s.isSet ? `${s.value} · ריק = לא לשנות` : "לא מוגדר") : undefined)}
        error={fieldErrors[key]}
        wide={opts.wide ?? s.kind === "text"}
        overridden={s.source === "admin"}
        resetPending={resets.has(key)}
        onReset={() => setResets((r) => new Set(r).add(key))}
        onUndoReset={() =>
          setResets((r) => {
            const n = new Set(r);
            n.delete(key);
            return n;
          })
        }
        changed={changed}
      >
        {opts.children}
      </Field>
    );
  };

  const savedExtras = parseEnvs(def("ENVIRONMENTS")?.value ?? ""); // masked secrets, for hints
  const savedExtraIds = new Set(savedExtras.map((e) => e.id));
  const extras = parseEnvs(draft.ENVIRONMENTS ?? "");
  const setExtras = (next: EnvObj[]) => set("ENVIRONMENTS", serializeEnvs(next));
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  /** One field inside an additional environment. */
  const extraField = (i: number, f: string) => {
    const s = def(f);
    if (!s) return null;
    const e = extras[i];
    const was = savedExtras.find((x) => x.id === e.id);
    const placeholder =
      s.kind === "secret"
        ? was?.[f]
          ? `${was[f]} · ריק = לא לשנות`
          : f === "KIBANA_API_KEY"
            ? "ריק = אותו מפתח של Elasticsearch"
            : "לא מוגדר"
        : ENV_INHERITED.has(f)
          ? "ריק = כמו בסביבה הראשית"
          : s.default;
    return (
      <Field
        key={f}
        id={`env-${i}-${f}`}
        def={s}
        value={e[f] ?? ""}
        placeholder={placeholder}
        wide={s.kind === "text"}
        onChange={(v) =>
          setExtras(extras.map((x, j) => (j === i ? { ...x, [f]: s.kind === "enum" && v === s.default ? "" : v } : x)))
        }
      />
    );
  };

  const mainChanged = ["ENV_NAME", ...ENV_FIELDS].some((k) => k in changes);
  const envsTab = (
    <div className="tab-body">
      {fieldErrors.ENVIRONMENTS && (
        <div className="banner bad" role="alert">
          {fieldErrors.ENVIRONMENTS}
        </div>
      )}
      <EnvCard
        title={draft.ENV_NAME || "ראשית"}
        subtitle={host(draft.ELASTIC_URL) || host(draft.KIBANA_URL)}
        isMain
        open={open.has(MAIN)}
        onToggle={() => toggle(MAIN)}
        status={<StatusLine caps={envStatus[MAIN]} error={envErr[MAIN]} />}
        changed={mainChanged}
      >
        <div className="fgrid">
          {settingField("ENV_NAME")}
          {ENV_MAIN_FIELDS.map((k) => settingField(k))}
        </div>
        <h4 className="sub">נתונים</h4>
        <div className="fgrid">{ENV_DATA_FIELDS.map((k) => settingField(k))}</div>
        <Advanced count={ENV_ADVANCED_FIELDS.length}>{ENV_ADVANCED_FIELDS.map((k) => settingField(k))}</Advanced>
      </EnvCard>

      {extras.map((e, i) => {
        const key = e.id && savedExtraIds.has(e.id) ? e.id : `new-${i}`;
        const isNew = !savedExtraIds.has(e.id);
        const saved = savedExtras.find((x) => x.id === e.id);
        const changed = Boolean(saved) && serializeEnvs([e]) !== serializeEnvs([stripSecrets(saved!)]);
        return (
          <EnvCard
            key={key}
            title={e.name}
            subtitle={host(e.ELASTIC_URL) || host(e.KIBANA_URL)}
            isMain={false}
            isNew={isNew}
            open={open.has(key) || isNew}
            onToggle={() => toggle(key)}
            status={isNew ? <span className="env-status">תיבדק אחרי שמירה</span> : <StatusLine caps={envStatus[e.id]} error={envErr[e.id]} />}
            changed={changed}
            onRemove={() => setExtras(extras.filter((_, j) => j !== i))}
          >
            <div className="fgrid">
              <div className="f">
                <div className="f-head">
                  <label htmlFor={`env-${i}-name`}>שם</label>
                </div>
                <input
                  id={`env-${i}-name`}
                  className="input"
                  placeholder="Staging"
                  value={e.name ?? ""}
                  onChange={(ev) => setExtras(extras.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)))}
                />
              </div>
              <div className="f">
                <div className="f-head">
                  <label htmlFor={`env-${i}-id`}>מזהה</label>
                  <Info text="באנגלית קטנה, למשל staging. נשמר בדשבורדים ובקישורים, ולכן לא משנים אותו אחרי שמירה." />
                </div>
                <input
                  id={`env-${i}-id`}
                  className="input"
                  dir="ltr"
                  placeholder="staging"
                  value={e.id ?? ""}
                  disabled={!isNew}
                  onChange={(ev) =>
                    setExtras(extras.map((x, j) => (j === i ? { ...x, id: ev.target.value.toLowerCase() } : x)))
                  }
                />
              </div>
              {ENV_MAIN_FIELDS.map((f) => extraField(i, f))}
            </div>
            <h4 className="sub">נתונים</h4>
            <div className="fgrid">{ENV_DATA_FIELDS.map((f) => extraField(i, f))}</div>
            <Advanced count={ENV_ADVANCED_FIELDS.length}>{ENV_ADVANCED_FIELDS.map((f) => extraField(i, f))}</Advanced>
          </EnvCard>
        );
      })}

      <button type="button" className="btn add-env" onClick={() => setExtras([...extras, { id: "", name: "" }])}>
        <Icon.Plus size={16} /> הוסף סביבה
      </button>
    </div>
  );

  // ---- Model tab ----
  const chosen = new Set((draft.LLM_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const modelOptions = [...new Set([...models.list, ...(draft.LLM_MODEL ? [draft.LLM_MODEL] : []), ...chosen])];
  const llmTab = (
    <div className="tab-body">
      <div className="card">
        <div className="fgrid">
          {settingField("LLM_BASE_URL")}
          {settingField("LLM_API_KEY")}
          {settingField("LLM_MODEL", {
            children: modelOptions.length ? (
              <select id="set-LLM_MODEL" className="input" dir="ltr" value={draft.LLM_MODEL ?? ""} onChange={(e) => set("LLM_MODEL", e.target.value)}>
                {!draft.LLM_MODEL && <option value="">—</option>}
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : undefined,
          })}
        </div>
        <div className="models-row">
          {models.loading ? (
            <span className="muted small">טוען את רשימת המודלים…</span>
          ) : models.error ? (
            <span className="field-error">
              <bdi dir="ltr">{models.error}</bdi>
            </span>
          ) : (
            <span className="muted small">המפתח מציע {models.list.length} מודלים לשיחה</span>
          )}
          <button type="button" className="link-btn" onClick={loadModels}>
            רענן
          </button>
        </div>
        {models.loading ? null : modelOptions.length > 0 ? (
          settingField("LLM_MODELS", {
            wide: true,
            children: (
              <div className="checks" id="set-LLM_MODELS" role="group">
                {modelOptions.map((m) => (
                  <label key={m} className="check" dir="ltr">
                    <input
                      type="checkbox"
                      checked={chosen.has(m)}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        e.target.checked ? next.add(m) : next.delete(m);
                        set("LLM_MODELS", modelOptions.filter((x) => next.has(x)).join(", "));
                      }}
                    />
                    {m}
                  </label>
                ))}
              </div>
            ),
          })
        ) : (
          <div className="fgrid">{settingField("LLM_MODELS", { wide: true })}</div>
        )}
        <Advanced count={LLM_ADVANCED.length}>{LLM_ADVANCED.map((k) => settingField(k))}</Advanced>
      </div>
    </div>
  );

  // ---- General tab ----
  const envChoices = [{ id: MAIN, name: draft.ENV_NAME || "ראשית" }, ...extras.filter((e) => e.id).map((e) => ({ id: e.id, name: e.name || e.id }))];
  const generalTab = (
    <div className="tab-body">
      <div className="card">
        <div className="fgrid">
          {settingField("CHAT_RETENTION_HOURS")}
          {settingField("APP_BASIC_AUTH")}
          {settingField("LIBRARY_ENV", {
            children: (
              <select id="set-LIBRARY_ENV" className="input" value={draft.LIBRARY_ENV || MAIN} onChange={(e) => set("LIBRARY_ENV", e.target.value)}>
                {envChoices.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            ),
          })}
          {settingField("DASHBOARDS_INDEX")}
          {settingField("LOG_LEVEL")}
          {settingField("LOG_FORMAT")}
        </div>
        <Advanced count={GENERAL_ADVANCED.length}>{GENERAL_ADVANCED.map((k) => settingField(k))}</Advanced>
      </div>
      <div className={`storage-line ${data.storage.writable ? "" : "bad"}`}>
        <Icon.Save size={14} />
        <span>
          {data.storage.writable ? "ההגדרות נשמרות ב-" : "אין הרשאת כתיבה ל-"}
          <bdi dir="ltr" className="mono">
            {data.storage.file}
          </bdi>
          {data.storage.writable ? ". כדי שיישמרו גם אחרי הפעלה מחדש של ה-pod, התיקייה צריכה להיות על volume קבוע." : ". צריך DATA_DIR שאפשר לכתוב אליו."}
        </span>
      </div>
    </div>
  );

  const TABS: { id: Tab; label: string }[] = [
    { id: "envs", label: `סביבות (${1 + extras.length})` },
    { id: "llm", label: "מודל AI" },
    { id: "general", label: "כללי" },
  ];

  return (
    <main className="admin">
      <div className="admin-head">
        <h1>ניהול</h1>
        <div className="lib-actions">
          <button type="button" className="btn" onClick={() => checkEnvs(savedEnvIds(data))}>
            <Icon.Refresh size={16} /> בדוק חיבור
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

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? "on" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {changedTabs.has(t.id) && <span className="tab-dot" aria-label="שינויים שלא נשמרו" />}
          </button>
        ))}
      </div>

      {error && !Object.keys(fieldErrors).length && (
        <div className="banner bad" role="alert">
          {error}
        </div>
      )}

      {tab === "envs" ? envsTab : tab === "llm" ? llmTab : generalTab}

      <div className={`savebar ${changeCount ? "dirty" : ""}`} role="region" aria-label="שמירה">
        <span className={changeCount ? "" : "muted"}>
          {notice && !changeCount ? notice : changeCount ? `${changeCount} שינויים שלא נשמרו` : "אין שינויים"}
        </span>
        <div className="lib-actions">
          <button
            type="button"
            className="btn"
            disabled={!changeCount || busy}
            onClick={() => {
              resetDraft(data);
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
    </main>
  );
}
