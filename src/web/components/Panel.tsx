import { useEffect, useState } from "react";
import { api } from "../api";
import { Chart, numberFmt } from "./Chart";
import { Icon } from "./icons";
import { discoverUrl } from "../../shared/discover";
import type { Panel, QueryResult, TimeRangeKey } from "../../shared/recipe";

type State = { data?: QueryResult; error?: string; loading: boolean };

function formatCell(v: unknown, type: string): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return numberFmt.format(v);
  if ((type === "date" || type === "date_nanos") && typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString("he-IL", { dateStyle: "short", timeStyle: "medium" });
  }
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function DataTable({ data, maxRows = 50 }: { data: QueryResult; maxRows?: number }) {
  return (
    <div className="table-wrap">
      <table className="data-table" dir="ltr">
        <thead>
          <tr>
            {data.columns.map((c) => (
              <th key={c.name} scope="col">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.values.slice(0, maxRows).map((row, i) => (
            <tr key={i}>
              {row.map((v, j) => (
                <td key={j} className={typeof v === "number" ? "num" : undefined}>
                  {formatCell(v, data.columns[j]?.type)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.values.length > maxRows && <div className="table-more">מוצגות {maxRows} שורות מתוך {data.values.length}</div>}
    </div>
  );
}

function Metric({ panel, data }: { panel: Panel; data: QueryResult }) {
  const col = panel.y?.[0];
  const i = data.columns.findIndex((c) => c.name === col);
  const v = i >= 0 ? data.values[0]?.[i] : undefined;
  const text = typeof v === "number" ? numberFmt.format(v) : v == null ? "—" : String(v);
  return (
    <div className="metric">
      <span className="metric-value" dir="ltr">
        {text}
        {panel.unit && v != null ? <span className="metric-unit">{panel.unit}</span> : null}
      </span>
      {panel.description && <span className="metric-caption">{panel.description}</span>}
    </div>
  );
}

export function PanelView(props: {
  panel: Panel;
  range: TimeRangeKey;
  tick: number;
  discoverBase?: string;
  envId?: string;
  onRemove: () => void;
}) {
  const { panel, range, tick, discoverBase, envId, onRemove } = props;
  const [state, setState] = useState<State>({ loading: panel.type !== "text" });
  const [showQuery, setShowQuery] = useState(false);
  const [showData, setShowData] = useState(false);

  useEffect(() => {
    if (panel.type === "text" || !panel.esql) return;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    api
      .query(panel.esql, range, ctrl.signal)
      .then((data) => setState({ data, loading: false }))
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setState((s) => ({ ...s, error: err.message, loading: false, data: undefined }));
      });
    return () => ctrl.abort();
  }, [panel.esql, panel.type, range, tick]);

  const height = panel.type === "metric" ? 0 : panel.width === "third" ? 200 : 260;
  const isChart = ["line", "area", "bar", "hbar"].includes(panel.type);

  return (
    <article className={`panel w-${panel.width} t-${panel.type}`} aria-busy={state.loading}>
      <header className="panel-head">
        <div className="panel-title-wrap">
          <h2 className="panel-title">{panel.title}</h2>
          {state.loading && <span className="spinner" aria-label="טוען" />}
        </div>
        <div className="panel-actions">
          {panel.esql && discoverBase && (
            <a
              className="icon-btn"
              href={discoverUrl(discoverBase, panel.esql, range)}
              target="_blank"
              rel="noreferrer"
              title="פתח ב-Discover"
              aria-label="פתח ב-Discover"
            >
              <Icon.External size={15} />
            </a>
          )}
          {panel.esql && (
            <button
              type="button"
              className={`icon-btn ${showQuery ? "on" : ""}`}
              onClick={() => setShowQuery((v) => !v)}
              title="הצג שאילתה"
              aria-label="הצג שאילתה"
              aria-pressed={showQuery}
            >
              <Icon.Code size={15} />
            </button>
          )}
          {isChart && (
            <button
              type="button"
              className={`icon-btn text ${showData ? "on" : ""}`}
              onClick={() => setShowData((v) => !v)}
              aria-pressed={showData}
              title="הצג כטבלה"
            >
              טבלה
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onRemove} title="הסר פאנל" aria-label="הסר פאנל">
            <Icon.X size={15} />
          </button>
        </div>
      </header>

      {panel.type === "text" ? (
        <p className="panel-text">{panel.text}</p>
      ) : state.error ? (
        <div className="panel-error" role="alert">
          <strong>השאילתה נכשלה</strong>
          <span dir="ltr">{state.error}</span>
        </div>
      ) : !state.data ? (
        <div className="panel-skeleton" style={{ height: height || 72 }} />
      ) : panel.type === "metric" ? (
        <Metric panel={panel} data={state.data} />
      ) : panel.type === "table" || showData ? (
        <DataTable data={state.data} />
      ) : state.data.values.length === 0 ? (
        <div className="panel-empty" style={{ height }}>
          אין נתונים בטווח הזמן הזה
        </div>
      ) : (
        <Chart panel={panel} data={state.data} height={height} colorScope={envId} />
      )}

      {showQuery && panel.esql && (
        <pre className="query" dir="ltr">
          {panel.esql}
        </pre>
      )}
      {state.data?.truncated && <div className="panel-note">התוצאה קוצצה למגבלת השורות</div>}
    </article>
  );
}
