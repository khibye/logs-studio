import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Chart, numberFmt, type PointInfo, type PrevOverlay } from "./Chart";
import { Icon } from "./icons";
import { discoverUrl } from "../../shared/discover";
import {
  TIME_RANGES,
  chartCompare,
  compareShiftMs,
  type Annotation,
  type Compare,
  type Panel,
  type QueryResult,
  type TimeRangeKey,
} from "../../shared/recipe";

type State = { data?: QueryResult; error?: string; loading: boolean };

/** Runs a panel's query (optionally on another environment or an earlier period) and re-runs on refresh. */
function usePanelData(
  panel: Panel,
  range: TimeRangeKey,
  tick: number,
  opts: { enabled: boolean; env?: string; compare?: Compare },
): State {
  const [state, setState] = useState<State>({ loading: opts.enabled && panel.type !== "text" });
  useEffect(() => {
    if (!opts.enabled || panel.type === "text" || !panel.esql) {
      setState({ loading: false });
      return;
    }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    api
      .query(panel.esql, range, { signal: ctrl.signal, env: opts.env, compare: opts.compare })
      .then((data) => setState({ data, loading: false }))
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setState({ error: err.message, loading: false });
      });
    return () => ctrl.abort();
  }, [panel.esql, panel.type, range, tick, opts.enabled, opts.env, opts.compare]);
  return state;
}

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

function metricValue(panel: Panel, data?: QueryResult): unknown {
  if (!data) return undefined;
  const i = data.columns.findIndex((c) => c.name === panel.y?.[0]);
  return i >= 0 ? data.values[0]?.[i] : undefined;
}

function Delta({ cur, prev, label }: { cur: unknown; prev: unknown; label: string }) {
  if (typeof cur !== "number" || typeof prev !== "number") return null;
  let text: string;
  let dir: "up" | "down" | "flat";
  if (prev === 0) {
    text = cur === 0 ? "ללא שינוי" : "חדש";
    dir = cur === 0 ? "flat" : "up";
  } else {
    const pct = ((cur - prev) / Math.abs(prev)) * 100;
    dir = Math.abs(pct) < 0.5 ? "flat" : pct > 0 ? "up" : "down";
    const n = Math.abs(pct) >= 100 ? Math.round(pct) : Math.round(pct * 10) / 10;
    text = dir === "flat" ? "ללא שינוי" : `${n > 0 ? "+" : ""}${numberFmt.format(n)}%`;
  }
  const big = prev !== 0 && Math.abs((cur - prev) / prev) >= 0.5;
  return (
    <span className={`delta ${dir} ${big ? "big" : ""}`} title={`בתקופה הקודמת: ${numberFmt.format(prev)}`}>
      <span aria-hidden="true">{dir === "up" ? "▲" : dir === "down" ? "▼" : "•"}</span>
      <bdi dir="ltr">{text}</bdi> {label}
    </span>
  );
}

function Metric({ panel, data, prev, prevLabel }: { panel: Panel; data: QueryResult; prev?: QueryResult; prevLabel?: string }) {
  const v = metricValue(panel, data);
  const text = typeof v === "number" ? numberFmt.format(v) : v == null ? "—" : String(v);
  return (
    <div className="metric">
      <span className="metric-value" dir="ltr">
        {text}
        {panel.unit && v != null ? <span className="metric-unit">{panel.unit}</span> : null}
      </span>
      {prev && prevLabel && <Delta cur={v} prev={metricValue(panel, prev)} label={prevLabel} />}
      {panel.description && <span className="metric-caption">{panel.description}</span>}
    </div>
  );
}

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** The chat message for "analyze this point". Readable for the user, precise for the model. */
function pointMessage(panel: Panel, p: PointInfo, envName?: string): string {
  const lines = [`נתח את הנקודה הזו:`, `• פאנל: "${panel.title}" (id: ${panel.id})`];
  if (envName) lines.push(`• סביבה: ${envName}`);
  if (p.isTime && p.from && p.to) lines.push(`• זמן: ${fmtTime(p.from)}–${fmtTime(p.to)} (${p.from} עד ${p.to})`);
  if (p.category !== undefined) lines.push(`• ${p.xColumn}: ${p.category}`);
  if (p.seriesColumn && p.seriesName) lines.push(`• ${p.seriesColumn}: ${p.seriesName}`);
  lines.push(`• ${p.yColumn}: ${p.value === null ? "אין ערך" : numberFmt.format(p.value)}`);
  lines.push(p.isTime ? "מה קרה כאן, ומה השתנה לעומת מה שהיה לפני כן?" : "מה בולט כאן ולמה?");
  return lines.join("\n");
}

type Side = { env?: string; envName?: string; state: State; prev?: State };

export function PanelView(props: {
  panel: Panel;
  range: TimeRangeKey;
  tick: number;
  discoverBase?: string;
  envId?: string;
  envName?: string;
  /** Show this environment side by side with the current one. */
  compareEnv?: { id: string; name: string } | null;
  /** Compare with the previous period (metrics: change %, time charts: dashed line). */
  comparePrev: boolean;
  annotations?: Annotation[];
  multiEnv: boolean;
  onAsk: (text: string) => void;
  onRemove: () => void;
}) {
  const { panel, range, tick, discoverBase, envId, envName, compareEnv, comparePrev, annotations, multiEnv, onAsk, onRemove } =
    props;
  const [showQuery, setShowQuery] = useState(false);
  const [showData, setShowData] = useState(false);
  const [point, setPoint] = useState<{ p: PointInfo; side: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const isChart = ["line", "area", "bar", "hbar"].includes(panel.type);
  const prevKind: Compare | undefined =
    !comparePrev || compareEnv ? undefined : panel.type === "metric" ? "previous" : panel.type === "line" || panel.type === "area" ? chartCompare(range) : undefined;

  const main = usePanelData(panel, range, tick, { enabled: true });
  const prev = usePanelData(panel, range, tick, { enabled: Boolean(prevKind), compare: prevKind });
  const other = usePanelData(panel, range, tick, { enabled: Boolean(compareEnv), env: compareEnv?.id });

  const sides: Side[] = [{ env: envId, envName, state: main, prev: prevKind ? prev : undefined }];
  if (compareEnv) sides.push({ env: compareEnv.id, envName: compareEnv.name, state: other });
  const loading = sides.some((s) => s.state.loading);

  const prevOverlay: PrevOverlay | undefined =
    prevKind && prevKind !== "previous" && prev.data
      ? { data: prev.data, shiftMs: compareShiftMs(range, prevKind), label: "שבוע שעבר" }
      : prevKind === "previous" && prev.data && panel.type !== "metric"
        ? { data: prev.data, shiftMs: compareShiftMs(range, prevKind), label: "תקופה קודמת" }
        : undefined;

  useEffect(() => {
    if (!point) return;
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setPoint(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPoint(null);
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc));
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [point]);

  const height = panel.type === "metric" ? 0 : panel.width === "third" && !compareEnv ? 200 : 260;

  const body = (side: Side, i: number) => {
    const st = side.state;
    if (panel.type === "text") return <p className="panel-text">{panel.text}</p>;
    if (st.error)
      return (
        <div className="panel-error" role="alert">
          <strong>השאילתה נכשלה</strong>
          <span dir="ltr">{st.error}</span>
        </div>
      );
    if (!st.data) return <div className="panel-skeleton" style={{ height: height || 72 }} />;
    if (panel.type === "metric")
      return (
        <Metric
          panel={panel}
          data={st.data}
          prev={side.prev?.data}
          prevLabel={TIME_RANGES[range].prevLabel}
        />
      );
    if (panel.type === "table" || showData) return <DataTable data={st.data} />;
    if (st.data.values.length === 0)
      return (
        <div className="panel-empty" style={{ height }}>
          אין נתונים בטווח הזמן הזה
        </div>
      );
    return (
      <div className="chart-wrap">
        <Chart
          panel={panel}
          data={st.data}
          height={height}
          colorScope={side.env}
          prev={i === 0 ? prevOverlay : undefined}
          annotations={i === 0 ? annotations : undefined}
          onPoint={isChart ? (p) => setPoint({ p, side: i }) : undefined}
        />
        {point && point.side === i && (
          <div
            ref={popRef}
            className="point-pop"
            style={{ left: Math.max(4, point.p.px - 110), top: Math.max(4, point.p.py + 10) }}
            role="dialog"
            aria-label="פעולות לנקודה"
          >
            <div className="point-head" dir="ltr">
              {point.p.isTime && point.p.from ? fmtTime(point.p.from) : point.p.category}
              {point.p.seriesName ? ` · ${point.p.seriesName}` : ""}
              {point.p.value !== null ? ` · ${numberFmt.format(point.p.value)}` : ""}
            </div>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                onAsk(pointMessage(panel, point.p, multiEnv ? side.envName : undefined));
                setPoint(null);
              }}
            >
              <Icon.Chat size={15} /> נתח בצ'אט
            </button>
            {i === 0 && discoverBase && panel.esql && point.p.isTime && point.p.from && point.p.to && (
              <a
                className="menu-item"
                href={discoverUrl(discoverBase, panel.esql, range, { from: point.p.from, to: point.p.to })}
                target="_blank"
                rel="noreferrer"
                onClick={() => setPoint(null)}
              >
                <Icon.External size={15} /> Discover לזמן הזה
              </a>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <article className={`panel w-${panel.width} t-${panel.type} ${compareEnv ? "compare" : ""}`} aria-busy={loading}>
      <header className="panel-head">
        <div className="panel-title-wrap">
          <h2 className="panel-title">{panel.title}</h2>
          {loading && <span className="spinner" aria-label="טוען" />}
        </div>
        <div className="panel-actions">
          {panel.type !== "text" && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => onAsk(`הסבר מה רואים בפאנל "${panel.title}" (id: ${panel.id}) ומה בולט בו.`)}
              title="שאל על הפאנל בצ'אט"
              aria-label="שאל על הפאנל בצ'אט"
            >
              <Icon.Chat size={15} />
            </button>
          )}
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

      {sides.length === 1 ? (
        body(sides[0], 0)
      ) : (
        <div className="sides">
          {sides.map((side, i) => (
            <div key={side.env ?? i} className="side">
              <div className={`side-label ${i === 0 ? "current" : ""}`}>{side.envName}</div>
              {body(side, i)}
            </div>
          ))}
        </div>
      )}

      {showQuery && panel.esql && (
        <pre className="query" dir="ltr">
          {panel.esql}
        </pre>
      )}
      {main.data?.truncated && <div className="panel-note">התוצאה קוצצה למגבלת השורות</div>}
      {isChart && !showData && main.data && main.data.values.length > 0 && (
        <div className="panel-hint">
          {prevOverlay && <span className="legend-dash">{prevOverlay.label}</span>}
          {annotations?.length ? <span className="legend-deploy">פריסות</span> : null}
          <span>לחיצה על הגרף: ניתוח הנקודה בצ'אט</span>
        </div>
      )}
    </article>
  );
}
