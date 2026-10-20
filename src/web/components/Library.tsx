import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "./icons";
import { savedHash } from "../route";
import { forgetRecent, type RecentItem } from "../share";
import type { Capabilities, DashboardSummary } from "../../shared/recipe";

const when = (iso: string) => new Date(iso).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });

export function Library(props: {
  caps: Capabilities | null;
  recent: RecentItem[];
  onRecentChange: () => void;
  onImport: (file: File) => void;
}) {
  const { caps, recent } = props;
  const [q, setQ] = useState("");
  const [items, setItems] = useState<DashboardSummary[] | null>(null);
  const [error, setError] = useState<string>();
  const canRead = Boolean(caps?.library.read);

  useEffect(() => {
    if (!canRead) return;
    const t = setTimeout(() => {
      setError(undefined);
      api.listDashboards(q).then(setItems, (e) => setError(e.message));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, canRead]);

  const titleOf = new Map(items?.map((i) => [i.id, i.title]) ?? []);
  const envs = caps?.environments ?? [];
  const envName = (id?: string) => envs.find((e) => e.id === (id || "main"))?.name ?? id;

  return (
    <main className="library">
      <div className="lib-head">
        <div>
          <h1>הדשבורדים שלי</h1>
          <p className="muted">
            כל דשבורד הוא "מתכון" של שאילתות. פתיחה מריצה אותן מחדש על הנתונים העדכניים, ושיחה חדשה עליו לא משנה את המקור עד
            שבוחרים לשמור.
          </p>
        </div>
        <div className="lib-actions">
          {canRead && (
            <>
              <label htmlFor="lib-search" className="sr-only">
                חיפוש דשבורד
              </label>
              <input
                id="lib-search"
                type="search"
                className="input"
                placeholder="חיפוש לפי שם או הערות…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </>
          )}
          <label className="btn">
            <Icon.Upload size={16} /> ייבוא JSON
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) props.onImport(f);
                e.target.value = "";
              }}
            />
          </label>
          <a className="btn primary" href="#/new">
            <Icon.Plus size={16} /> דשבורד חדש משיחה
          </a>
        </div>
      </div>

      <section aria-labelledby="lib-shared">
        <h2 id="lib-shared" className="section-title">
          ספרייה משותפת <bdi dir="ltr" className="muted">({caps?.library.index ?? "ai-dashboards"})</bdi>
        </h2>
        {!caps ? (
          <div className="card muted">בודק הרשאות…</div>
        ) : !canRead ? (
          <div className="card notice">
            <strong>הספרייה המשותפת לא זמינה כרגע.</strong>
            <p>
              אפשר לשמור ולשתף דשבורדים דרך "העתק קישור" (הדשבורד כולו נשמר בתוך הקישור) או דרך ייצוא לקובץ JSON. כדי להפעיל
              ספרייה משותפת עם גרסאות, צריך הרשאות <code dir="ltr">read</code> ו-<code dir="ltr">create_doc</code> על האינדקס.
            </p>
            {caps.library.reason && (
              <p className="muted">
                <bdi dir="ltr">{caps.library.reason}</bdi>
              </p>
            )}
          </div>
        ) : error ? (
          <div className="card notice bad" role="alert">
            <bdi dir="ltr">{error}</bdi>
          </div>
        ) : !items ? (
          <div className="card muted">טוען…</div>
        ) : items.length === 0 ? (
          <div className="card muted">{q ? "לא נמצאו דשבורדים." : "עדיין אין דשבורדים בספרייה."}</div>
        ) : (
          <div className="table-wrap card flush">
            <table className="lib-table">
              <thead>
                <tr>
                  <th scope="col">שם</th>
                  <th scope="col">גרסה אחרונה</th>
                  <th scope="col">נשמר</th>
                  <th scope="col">פאנלים</th>
                  <th scope="col">
                    <span className="sr-only">פעולות</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <a className="lib-name" href={savedHash(d.id)}>
                        {d.title}
                      </a>
                      {envs.length > 1 && (
                        <span className="badge env-badge" title="נפתח בסביבה הזו; אפשר להריץ אותו על כל סביבה">
                          {envName(d.env)}
                        </span>
                      )}
                      {d.notes && <div className="lib-notes">{d.notes}</div>}
                      {d.forked_from && (
                        <a className="lib-fork" href={savedHash(d.forked_from.id, d.forked_from.version)}>
                          <Icon.Fork size={13} /> עותק של {titleOf.get(d.forked_from.id) ?? "דשבורד אחר"} (גרסה{" "}
                          {d.forked_from.version})
                        </a>
                      )}
                    </td>
                    <td>
                      {d.version}
                      {d.versions > 1 && <span className="muted"> · {d.versions} גרסאות</span>}
                    </td>
                    <td className="nowrap">{when(d.saved_at)}</td>
                    <td>{d.panel_count}</td>
                    <td className="row-actions">
                      <a className="btn small" href={savedHash(d.id)}>
                        <Icon.Chat size={14} /> פתח והמשך בשיחה
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="lib-recent">
        <h2 id="lib-recent" className="section-title">
          נפתחו לאחרונה בדפדפן הזה
        </h2>
        {recent.length === 0 ? (
          <div className="card muted">כאן יופיעו דשבורדים שעבדת עליהם, גם בלי ספרייה משותפת.</div>
        ) : (
          <ul className="recent-list card flush">
            {recent.map((r) => (
              <li key={r.key}>
                <a href={r.hash}>{r.title}</a>
                <span className="muted">
                  {r.panels} פאנלים · {when(r.at)}
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`הסר את ${r.title} מהרשימה`}
                  onClick={() => {
                    forgetRecent(r.key);
                    props.onRecentChange();
                  }}
                >
                  <Icon.X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
