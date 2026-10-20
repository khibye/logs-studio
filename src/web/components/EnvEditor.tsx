import type { SettingView } from "../api";
import { Icon } from "./icons";

/** Same list as ENV_FIELDS on the server. */
const ENV_FIELDS = [
  "ELASTIC_CONNECTION",
  "ELASTIC_URL",
  "ELASTIC_API_KEY",
  "KIBANA_URL",
  "KIBANA_PUBLIC_URL",
  "KIBANA_SPACE",
  "KIBANA_API_KEY",
  "LOG_INDEX_PATTERNS",
  "TIME_FIELD",
  "LOG_CONTEXT",
] as const;
const INHERITED = new Set(["LOG_INDEX_PATTERNS", "TIME_FIELD", "LOG_CONTEXT"]);

type Env = Record<string, string>;

function parse(v: string): Env[] {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** Canonical form (fixed key order, no empty fields) so edits compare cleanly with the saved value. */
export function serializeEnvs(envs: Env[]): string {
  if (!envs.length) return "";
  return JSON.stringify(
    envs.map((e) => {
      const out: Env = { id: e.id ?? "", name: e.name ?? "" };
      for (const f of ENV_FIELDS) if (e[f]) out[f] = e[f];
      return out;
    }),
  );
}

/** The editor's starting value: the saved environments with secrets blanked (empty = keep). */
export function initialEnvs(masked: string, defs: Map<string, SettingView>): string {
  return serializeEnvs(
    parse(masked).map((e) => {
      const copy = { ...e };
      for (const f of ENV_FIELDS) if (defs.get(f)?.kind === "secret") delete copy[f];
      return copy;
    }),
  );
}

export function EnvEditor(props: {
  value: string;
  /** Saved value with secrets masked, for "currently set" hints. */
  masked: string;
  defs: Map<string, SettingView>;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const { value, masked, defs, disabled, onChange } = props;
  const envs = parse(value);
  const saved = new Map(parse(masked).map((e) => [e.id, e]));
  const set = (next: Env[]) => onChange(serializeEnvs(next));
  const update = (i: number, key: string, v: string) => set(envs.map((e, j) => (j === i ? { ...e, [key]: v } : e)));

  return (
    <div className="envs">
      {envs.length === 0 && <p className="muted">אין סביבות נוספות. כל העבודה נעשית על הסביבה הראשית.</p>}
      {envs.map((e, i) => {
        const was = saved.get(e.id);
        return (
          <div key={i} className="env-card">
            <div className="env-card-head">
              <strong>{e.name || "סביבה חדשה"}</strong>
              <button
                type="button"
                className="link-btn"
                disabled={disabled}
                onClick={() => set(envs.filter((_, j) => j !== i))}
              >
                הסר
              </button>
            </div>
            <div className="fields">
              <div className="field">
                <div className="field-head">
                  <label htmlFor={`env-${i}-id`}>מזהה</label>
                </div>
                <input
                  id={`env-${i}-id`}
                  className="input"
                  dir="ltr"
                  placeholder="staging"
                  value={e.id ?? ""}
                  disabled={disabled}
                  onChange={(ev) => update(i, "id", ev.target.value.toLowerCase())}
                />
                <div className="field-foot">
                  <span className="muted">באנגלית. נשמר בדשבורדים ובקישורים, ולכן עדיף לא לשנות אחרי שהתחלתם להשתמש.</span>
                </div>
              </div>
              <div className="field">
                <div className="field-head">
                  <label htmlFor={`env-${i}-name`}>שם</label>
                </div>
                <input
                  id={`env-${i}-name`}
                  className="input"
                  placeholder="Staging"
                  value={e.name ?? ""}
                  disabled={disabled}
                  onChange={(ev) => update(i, "name", ev.target.value)}
                />
              </div>
              {ENV_FIELDS.map((f) => {
                const def = defs.get(f);
                if (!def) return null;
                const id = `env-${i}-${f}`;
                const secret = def.kind === "secret";
                const placeholder = secret
                  ? was?.[f]
                    ? `${was[f]} · השאירי ריק כדי לא לשנות`
                    : f === "KIBANA_API_KEY"
                      ? "ריק = אותו מפתח של Elasticsearch"
                      : "לא מוגדר"
                  : INHERITED.has(f)
                    ? "ריק = כמו בסביבה הראשית"
                    : def.default ?? "";
                return (
                  <div key={f} className={`field ${def.kind === "text" ? "wide" : ""}`}>
                    <div className="field-head">
                      <label htmlFor={id}>{def.label}</label>
                      <code dir="ltr" className="field-key">
                        {f}
                      </code>
                    </div>
                    {def.kind === "enum" ? (
                      <select
                        id={id}
                        className="input"
                        value={e[f] || def.default || ""}
                        disabled={disabled}
                        onChange={(ev) => update(i, f, ev.target.value === def.default ? "" : ev.target.value)}
                      >
                        {def.options?.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : def.kind === "text" ? (
                      <textarea
                        id={id}
                        className="input area"
                        rows={3}
                        placeholder={placeholder}
                        value={e[f] ?? ""}
                        disabled={disabled}
                        onChange={(ev) => update(i, f, ev.target.value)}
                      />
                    ) : (
                      <input
                        id={id}
                        className="input"
                        dir="ltr"
                        type={secret ? "password" : "text"}
                        autoComplete={secret ? "new-password" : "off"}
                        placeholder={placeholder}
                        value={e[f] ?? ""}
                        disabled={disabled}
                        onChange={(ev) => update(i, f, ev.target.value)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <button
        type="button"
        className="btn"
        disabled={disabled}
        onClick={() => set([...envs, { id: "", name: "" }])}
      >
        <Icon.Plus size={16} /> הוסף סביבה
      </button>
    </div>
  );
}
