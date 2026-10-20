import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { Panel, QueryResult } from "../../shared/recipe";

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

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

function optionFor(
  panel: Panel,
  data: QueryResult,
  colorOf: (name: string) => string,
): echarts.EChartsCoreOption {
  const unit = panel.unit;
  const { xs, isTime, series } = buildSeries(panel, data);
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
      ? { type: "scroll", top: 0, left: "center", icon: "roundRect", itemWidth: 12, itemHeight: 4, textStyle: { color: INK_2 } }
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

export function Chart({ panel, data, height, colorScope }: { panel: Panel; data: QueryResult; height: number; colorScope?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
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
    chart.current = echarts.init(ref.current, undefined, { renderer: "canvas" });
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    slots.current.clear();
  }, [panel.esql, panel.series, panel.y?.join(","), colorScope]);

  useEffect(() => {
    chart.current?.setOption(optionFor(panel, data, colorOf), { notMerge: true });
  }, [panel, data]);

  return <div ref={ref} dir="ltr" style={{ width: "100%", height }} role="img" aria-label={panel.title} />;
}
