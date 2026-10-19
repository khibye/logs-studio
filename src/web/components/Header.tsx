import { Icon } from "./icons";
import { Menu } from "./Menu";
import { TIME_RANGES, TIME_RANGE_KEYS, type Capabilities, type TimeRangeKey } from "../../shared/recipe";

const REFRESH_OPTIONS = [
  { v: 0, label: "ללא רענון אוטומטי" },
  { v: 30, label: "רענון כל 30 שנ׳" },
  { v: 60, label: "רענון כל דקה" },
  { v: 300, label: "רענון כל 5 דק׳" },
];

function Row({ ok, title, detail }: { ok: boolean | "partial"; title: string; detail?: string }) {
  return (
    <li className={`cap ${ok === true ? "ok" : ok === "partial" ? "partial" : "bad"}`}>
      <span className="cap-icon" aria-hidden="true">
        {ok === true ? <Icon.Check size={14} /> : <Icon.X size={14} />}
      </span>
      <span className="cap-text">
        <span>{title}</span>
        {detail && (
          <bdi dir="ltr" className="cap-detail">
            {detail}
          </bdi>
        )}
      </span>
    </li>
  );
}

function Status({ caps, onRecheck }: { caps: Capabilities | null; onRecheck: () => void }) {
  const tone = !caps
    ? "neutral"
    : !caps.elastic.ok || !caps.logs.read || !caps.llm.configured
      ? "bad"
      : "ok";
  const label = !caps ? "בודק חיבור…" : tone === "ok" ? "מחובר ל-Elastic" : "בעיית חיבור";
  return (
    <Menu
      className={`status ${tone}`}
      label={
        <>
          <span className="dot" aria-hidden="true" />
          {label}
        </>
      }
    >
      {() =>
        caps ? (
          <div className="caps">
            <ul>
              <Row ok={caps.elastic.ok} title={`Elasticsearch ${caps.elastic.version ?? ""}`} detail={caps.elastic.error} />
              <Row ok={caps.logs.read} title={`קריאת לוגים: ${caps.logs.patterns.join(", ")}`} detail={caps.logs.reason} />
              <Row ok={caps.llm.configured} title="מודל AI" detail={caps.llm.model} />
              <Row
                ok={caps.library.write ? true : caps.library.read ? "partial" : false}
                title={
                  caps.library.write
                    ? `ספרייה משותפת (${caps.library.index}): קריאה וכתיבה`
                    : caps.library.read
                      ? `ספרייה משותפת (${caps.library.index}): קריאה בלבד`
                      : `ספרייה משותפת (${caps.library.index}): לא זמינה`
                }
                detail={caps.library.reason}
              />
              <Row ok={true} title="שמירה בקישור ובקובץ JSON" />
              <Row ok={caps.discover.enabled} title="פתיחה ב-Discover" detail={caps.discover.enabled ? undefined : "KIBANA_URL is not set"} />
              <Row
                ok={caps.kibanaExport.enabled}
                title="ייצוא לדשבורד Kibana (ניסיוני)"
                detail={caps.kibanaExport.reason}
              />
            </ul>
            <button type="button" className="btn small" onClick={onRecheck}>
              <Icon.Refresh size={14} /> בדוק שוב
            </button>
          </div>
        ) : (
          <div className="menu-note">בודק…</div>
        )
      }
    </Menu>
  );
}

export function Header(props: {
  view: "studio" | "library";
  studioHref: string;
  caps: Capabilities | null;
  range: TimeRangeKey;
  refreshSec: number;
  onRange: (r: TimeRangeKey) => void;
  onRefreshSec: (s: number) => void;
  onRefreshNow: () => void;
  onRecheck: () => void;
}) {
  const { view, studioHref, caps, range, refreshSec } = props;
  return (
    <header className="top">
      <a className="brand" href={studioHref}>
        <Icon.Logo />
        <span>סטודיו לוגים</span>
      </a>
      <nav aria-label="ניווט ראשי" className="nav">
        <a href={studioHref} aria-current={view === "studio" ? "page" : undefined}>
          סטודיו
        </a>
        <a href="#/library" aria-current={view === "library" ? "page" : undefined}>
          הדשבורדים שלי
        </a>
      </nav>
      <a className="btn ghost" href="#/new">
        <Icon.Plus size={16} /> חדש
      </a>
      <div className="spacer" />
      {view === "studio" && (
        <div className="controls">
          <label className="select">
            <Icon.Clock size={15} />
            <span className="sr-only">טווח זמן</span>
            <select value={range} onChange={(e) => props.onRange(e.target.value as TimeRangeKey)}>
              {TIME_RANGE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {TIME_RANGES[k].label}
                </option>
              ))}
            </select>
          </label>
          <label className="select">
            <span className="sr-only">רענון אוטומטי</span>
            <select value={refreshSec} onChange={(e) => props.onRefreshSec(Number(e.target.value))}>
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn icon" onClick={props.onRefreshNow} aria-label="רענן עכשיו" title="רענן עכשיו">
            <Icon.Refresh size={16} />
          </button>
        </div>
      )}
      <Status caps={caps} onRecheck={props.onRecheck} />
    </header>
  );
}
