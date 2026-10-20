import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { Annotation, Panel, QueryResult } from "../../shared/recipe";

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, CanvasRenderer]);

/** An earlier period drawn as dashed lines, shifted forward onto the current axis. */
export type PrevOverlay = { data: QueryResult; shiftMs: number; label: string };

/** What the user clicked on, in data terms. */
export type PointInfo = {
  /** Click position inside the chart, in px. */
  px: number;
  py: number;
  isTime: boolean;
  /** Time charts: the clicked bucket. */
  from?: string;
  to?: string;
  /** Category charts: the clicked category. */
  category?: string;
  xColumn: string;
  seriesColumn?: string;
  seriesName?: string;
  yColumn: string;
  value: number | null;
};

const DEPLOY_COLOR = "#6b6f76";
const MAX_PREV_SERIES = 3;

/** Categorical slots in fixed order (validated palette; never cycled). */
export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const OTHER_COLOR = "#898781";
const INK_2 = "#52514e";
const MUTED = "#898781";
const GRID = "#e1e0d9";
const AXIS = "#c3c2b7";
const MAX_SERIES = 8;

export const numberFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

type Series = { name: string; points: Map<string, number | null> };

function buildSeries(panel: Panel, data: QueryResult) {
  const idx = new Map(data.columns.map((c, i) => [c.name, i]));
  const xi = idx.get(panel.x!)!;
  const xType = data.columns[xi]?.type ?? "keyword";
  const isTime = xType === "date" || xType === "date_nanos";
  const xKey = (v: unknown) => String(v);

  const xs: string[] = [];
  const seenX = new Set<string>();
  for (const row of data.values) {
    const k = xKey(row[xi]);
    if (!seenX.has(k)) {
      seenX.add(k);
      xs.push(k);
    }
  }
  if (isTime) xs.sort((a, b) => Date.parse(a) - Date.parse(b));

  let series: Series[] = [];
  if (panel.series && idx.has(panel.series)) {
    const si = idx.get(panel.series)!;
    const yi = idx.get(panel.y![0])!;
    const groups = new Map<string, Series>();
    const totals = new Map<string, number>();
    for (const row of data.values) {
      const name = row[si] === null ? "(ריק)" : String(row[si]);
      const g = groups.get(name) ?? { name, points: new Map() };
      const y = toNum(row[yi]);
      g.points.set(xKey(row[xi]), (g.points.get(xKey(row[xi])) ?? 0) + (y ?? 0));
      groups.set(name, g);
      totals.set(name, (totals.get(name) ?? 0) + Math.abs(y ?? 0));
    }
    const ranked = [...groups.values()].sort((a, b) => (totals.get(b.name) ?? 0) - (totals.get(a.name) ?? 0));
    series = ranked.slice(0, MAX_SERIES - 1);
    const rest = ranked.slice(MAX_SERIES - 1);
    if (rest.length === 1) series.push(rest[0]);
    else if (rest.length > 1) {
      const other: Series = { name: "אחר", points: new Map() };
      for (const s of rest) for (const [k, v] of s.points) other.points.set(k, (other.points.get(k) ?? 0) + (v ?? 0));
      series.push(other);
    }
  } else {
    series = (panel.y ?? []).map((col) => {
      const yi = idx.get(col)!;
      const points = new Map<string, number | null>();
      for (const row of data.values) points.set(xKey(row[xi]), toNum(row[yi]));
      return { name: col, points };
    });
  }
  return { xs, isTime, series };
}

type Built = ReturnType<typeof buildSeries>;

function optionFor(
  panel: Panel,
  built: Built,
  colorOf: (name: string) => string,
  prev?: PrevOverlay,
  annotations?: Annotation[],
): echarts.EChartsCoreOption {
  const unit = panel.unit;
  const { xs, isTime, series } = built;
  const multi = series.length > 1;
  const fmtVal = (v: number) => `${numberFmt.format(v)}${unit ? ` ${unit}` : ""}`;
  const horizontal = panel.type === "hbar";
  const timeLabel = (k: string) => {
    const d = new Date(k);
    return Number.isNaN(d.getTime()) ? k : d.toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
  };

  const categoryAxis: any = isTime
    ? { type: "time", axisLine: { lineStyle: { color: AXIS } }, axisLabel: { color: MUTED, hideOverlap: true }, splitLine: { show: false } }
    : {
        type: "category",
        data: xs,
        inverse: horizontal,
        axisLine: { lineStyle: { color: AXIS } },
        axisTick: { show: false },
        axisLabel: {
          color: INK_2,
          hideOverlap: true,
          width: horizontal ? 180 : 110,
          overflow: "truncate",
        },
      };
  const valueAxis: any = {
    type: "value",
    axisLabel: { color: MUTED, formatter: (v: number) => compactFmt.format(v) },
    splitLine: { lineStyle: { color: GRID } },
  };

  const seriesOpts = series.map((s) => {
    const c = colorOf(s.name);
    const data = isTime ? xs.map((k) => [k, s.points.get(k) ?? null]) : xs.map((k) => s.points.get(k) ?? null);
    if (panel.type === "bar" || panel.type === "hbar") {
      return {
        type: "bar",
        name: s.name,
        data,
        barMaxWidth: 28,
        itemStyle: { color: c, borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] },
        emphasis: { focus: "series" },
      };
    }
    return {
      type: "line",
      name: s.name,
      data,
      showSymbol: false,
      symbolSize: 8,
      connectNulls: false,
      lineStyle: { width: 2, color: c },
      itemStyle: { color: c },
      areaStyle: panel.type === "area" ? { color: c, opacity: 0.14 } : undefined,
      emphasis: { focus: "series" },
    };
  });

  // ---- Previous period: dashed, same colour, shifted forward onto today's axis ----
  const isLine = panel.type === "line" || panel.type === "area";
  if (prev && isTime && isLine) {
    const old = buildSeries(panel, prev.data);
    const keep = new Set(series.slice(0, MAX_PREV_SERIES).map((s) => s.name));
    // Only draw the part that overlaps today's axis, so a misaligned result can't stretch it.
    const lo = Date.parse(xs[0]);
    const hi = Date.parse(xs[xs.length - 1]);
    const pad = Math.max((hi - lo) / Math.max(xs.length - 1, 1), 60e3);
    const inView = (k: string) => {
      const t = Date.parse(k) + prev.shiftMs;
      return t >= lo - pad && t <= hi + pad;
    };
    for (const s of old.series) {
      if (!keep.has(s.name) || s.name === "אחר") continue;
      const c = colorOf(s.name);
      seriesOpts.push({
        type: "line",
        name: `${s.name} · ${prev.label}`,
        data: old.xs.filter(inView).map((k) => [Date.parse(k) + prev.shiftMs, s.points.get(k) ?? null]) as any,
        showSymbol: false,
        symbolSize: 6,
        connectNulls: false,
        lineStyle: { width: 1.5, color: c, type: "dashed", opacity: 0.6 },
        itemStyle: { color: c, opacity: 0.6 },
        areaStyle: undefined,
        emphasis: { focus: "series" },
        z: 1,
      } as any);
    }
  }

  // ---- Deploy / change events: thin vertical lines; the description shows on hover ----
  if (annotations?.length && isTime && xs.length) {
    const lo = Date.parse(xs[0]);
    const hi = Date.parse(xs[xs.length - 1]);
    const span = Math.max(hi - lo, 1);
    const shown = annotations.filter((a) => {
      const t = Date.parse(a.time);
      return t >= lo - span * 0.02 && t <= hi + span * 0.02;
    });
    if (shown.length) {
      seriesOpts.push({
        type: "line",
        name: "__deploys",
        data: [],
        silent: false,
        markLine: {
          symbol: ["none", "circle"],
          symbolSize: 6,
          animation: false,
          lineStyle: { color: DEPLOY_COLOR, width: 1, type: "solid", opacity: 0.55 },
          label: { show: false },
          emphasis: {
            lineStyle: { width: 2, opacity: 1 },
            label: {
              show: true,
              position: "insideEndTop",
              color: "#15171a",
              backgroundColor: "rgba(255,255,255,0.92)",
              padding: [2, 4],
              formatter: (p: any) => p.data?.label?.text ?? "",
            },
          },
          data: shown.map((a) => ({
            xAxis: Date.parse(a.time),
            label: { text: `${timeLabel(a.time)} · ${a.label || "פריסה"}` },
          })),
        },
      } as any);
    }
  }

  return {
    animation: false,
    textStyle: { fontFamily: "'IBM Plex Sans Hebrew', system-ui, sans-serif" },
    grid: {
      left: 4,
      right: 12,
      top: multi ? 36 : 12,
      bottom: 4,
      outerBoundsMode: "same",
      outerBoundsContain: "axisLabel",
    },
    legend: multi
      ? {
          type: "scroll",
          top: 0,
          left: "center",
          icon: "roundRect",
          itemWidth: 12,
          itemHeight: 4,
          textStyle: { color: INK_2 },
          data: series.map((s) => s.name),
        }
      : undefined,
    tooltip: {
      trigger: "axis",
      axisPointer: { type: panel.type === "bar" || panel.type === "hbar" ? "shadow" : "line" },
      valueFormatter: (v: any) => (typeof v === "number" ? fmtVal(v) : "—"),
      ...(isTime
        ? {
            formatter: (params: any[]) => {
              const head = timeLabel(params[0]?.value?.[0] ?? params[0]?.axisValue);
              const rows = params
                .filter((p) => p.seriesName !== "__deploys")
                .map((p) => `${p.marker} ${p.seriesName}: <b>${p.value?.[1] == null ? "—" : fmtVal(p.value[1])}</b>`)
                .join("<br/>");
              return `<div dir="ltr" style="text-align:left">${head}<br/>${rows}</div>`;
            },
          }
        : {}),
    },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series: seriesOpts,
  };
}

function nearestIndex(sortedMs: number[], t: number): number {
  let best = 0;
  for (let i = 1; i < sortedMs.length; i++) if (Math.abs(sortedMs[i] - t) < Math.abs(sortedMs[best] - t)) best = i;
  return best;
}

/** Turns a click position into data: which bucket / category, which series, what value. */
function pointAt(panel: Panel, built: Built, chart: echarts.ECharts, px: number, py: number): PointInfo | null {
  if (!chart.containPixel("grid", [px, py])) return null;
  const [a, b] = chart.convertFromPixel({ gridIndex: 0 }, [px, py]) as number[];
  const horizontal = panel.type === "hbar";
  const { xs, isTime, series } = built;
  if (!xs.length || !series.length) return null;

  let key: string;
  let clickedY: number;
  const info: Partial<PointInfo> = {};
  if (isTime) {
    const ms = xs.map((k) => Date.parse(k));
    const i = nearestIndex(ms, a);
    key = xs[i];
    const step = ms.length > 1 ? (i < ms.length - 1 ? ms[i + 1] - ms[i] : ms[i] - ms[i - 1]) : 3600e3;
    info.from = new Date(ms[i]).toISOString();
    info.to = new Date(ms[i] + step).toISOString();
    clickedY = b;
  } else {
    const i = Math.max(0, Math.min(xs.length - 1, Math.round(horizontal ? b : a)));
    key = xs[i];
    info.category = key;
    clickedY = horizontal ? a : b;
  }
  // The series whose value at this point is closest to where the user clicked.
  let pick = series[0];
  let bestDist = Infinity;
  for (const s of series) {
    const v = s.points.get(key);
    if (v === null || v === undefined) continue;
    const d = Math.abs(v - clickedY);
    if (d < bestDist) {
      bestDist = d;
      pick = s;
    }
  }
  const multi = series.length > 1;
  return {
    px,
    py,
    isTime,
    xColumn: panel.x!,
    yColumn: panel.series ? panel.y![0] : multi ? pick.name : panel.y![0],
    seriesColumn: panel.series && multi ? panel.series : undefined,
    seriesName: panel.series && multi ? pick.name : undefined,
    value: pick.points.get(key) ?? null,
    ...info,
  };
}

export function Chart(props: {
  panel: Panel;
  data: QueryResult;
  height: number;
  colorScope?: string;
  prev?: PrevOverlay;
  annotations?: Annotation[];
  onPoint?: (p: PointInfo) => void;
}) {
  const { panel, data, height, colorScope, prev, annotations, onPoint } = props;
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const built = useRef<Built | null>(null);
  const onPointRef = useRef(onPoint);
  onPointRef.current = onPoint;
  const panelRef = useRef(panel);
  panelRef.current = panel;
  // Color follows the entity, not its rank: a series keeps its slot across refreshes.
  const slots = useRef(new Map<string, string>());
  const colorOf = (name: string) => {
    if (name === "אחר") return OTHER_COLOR;
    let c = slots.current.get(name);
    if (!c) {
      const used = new Set(slots.current.values());
      c = SERIES_COLORS.find((x) => !used.has(x)) ?? OTHER_COLOR;
      slots.current.set(name, c);
    }
    return c;
  };

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, undefined, { renderer: "canvas" });
    chart.current = c;
    c.getZr().on("click", (e: any) => {
      if (!onPointRef.current || !built.current) return;
      const p = pointAt(panelRef.current, built.current, c, e.offsetX, e.offsetY);
      if (p) onPointRef.current(p);
    });
    c.getZr().on("mousemove", (e: any) => {
      if (!onPointRef.current) return;
      c.getZr().setCursorStyle(c.containPixel("grid", [e.offsetX, e.offsetY]) ? "pointer" : "default");
    });
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    slots.current.clear();
  }, [panel.esql, panel.series, panel.y?.join(","), colorScope]);

  useEffect(() => {
    const b = buildSeries(panel, data);
    built.current = b;
    chart.current?.setOption(optionFor(panel, b, colorOf, prev, annotations), { notMerge: true });
  }, [panel, data, prev, annotations]);

  return <div ref={ref} dir="ltr" style={{ width: "100%", height }} role="img" aria-label={panel.title} />;
}
