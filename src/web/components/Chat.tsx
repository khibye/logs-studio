import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./icons";

export type ToolChip = { id: string; summary: string; result?: string; ok?: boolean };
export type UiMessage = {
  role: "user" | "assistant";
  content: string;
  tools?: ToolChip[];
  streaming?: boolean;
  error?: string;
  /** Which model answered (shown when the conversation used more than one). */
  model?: string;
};

/** Renders `inline code` without interpreting any HTML. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <code key={i} dir="ltr">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

const SUGGESTIONS_NEW = [
  "מה השגיאות הנפוצות ב-24 השעות האחרונות?",
  "בנה דשבורד בריאות כללי: נפח לוגים, שגיאות, שירותים מובילים",
  "איזה שירות הכי רועש בלוגים?",
];
const SUGGESTIONS_EXISTING = ["הסבר מה רואים בדשבורד הזה", "השווה לטווח זמן ארוך יותר", "הוסף פילוח לפי שירות"];

export function Chat(props: {
  messages: UiMessage[];
  busy: boolean;
  hasDashboard: boolean;
  basedOn?: string;
  llm: { configured: boolean; model?: string };
  models: string[];
  model: string;
  onModel: (m: string) => void;
  restored?: boolean;
  retentionHours?: number;
  onSend: (text: string) => void;
  onStop: () => void;
  onNewChat: () => void;
}) {
  const { messages, busy, hasDashboard, basedOn, llm, models, model, onModel, restored, retentionHours = 0, onSend, onStop, onNewChat } =
    props;
  const mixedModels = new Set(messages.filter((m) => m.role === "assistant" && m.model).map((m) => m.model)).size > 1;
  const keepFor = retentionHours >= 48 ? `${Math.round(retentionHours / 24)} ימים` : `${retentionHours} שעות`;
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (value = text) => {
    const v = value.trim();
    if (!v || busy || !llm.configured) return;
    onSend(v);
    setText("");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const suggestions = hasDashboard ? SUGGESTIONS_EXISTING : SUGGESTIONS_NEW;

  return (
    <aside className="chat" aria-label="שיחה עם המודל">
      <div className="chat-head">
        <div>
          <div className="chat-title">שיחה</div>
          <div className="chat-sub">
            {!llm.configured ? (
              "המודל לא מוגדר בשרת"
            ) : models.length > 1 ? (
              <label className="model-pick">
                <span>מודל:</span>
                <select value={model} onChange={(e) => onModel(e.target.value)} disabled={busy} dir="ltr">
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                מודל: <bdi dir="ltr">{model || llm.model}</bdi>
              </>
            )}
          </div>
        </div>
        <button type="button" className="btn" onClick={onNewChat} disabled={busy || messages.length === 0}>
          שיחה חדשה
        </button>
      </div>

      <div className="chat-list" ref={listRef} aria-live="polite">
        {messages.length === 0 && (
          <div className="chat-empty">
            {basedOn ? (
              <p>
                שיחה חדשה על <strong>{basedOn}</strong>. המודל מכיר את הפאנלים וההערות של הדשבורד. שינויים יישמרו רק כשתבחרי
                "עדכן" או "שמור כעותק".
              </p>
            ) : (
              <p>בקשי ניתוח של הלוגים, והמודל יבנה דשבורד חי מהממצאים.</p>
            )}
          </div>
        )}
        {restored && messages.length > 0 && (
          <div className="chat-restored">השיחה שוחזרה. היא נשמרת רק בדפדפן הזה, למשך {keepFor} מההודעה האחרונה.</div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="msg user">
              {m.content}
            </div>
          ) : (
            <div key={i} className="msg assistant">
              {m.tools && m.tools.length > 0 && (
                <ul className="tools" aria-label="פעולות שהמודל ביצע">
                  {m.tools.map((t) => (
                    <li key={t.id} className={`tool ${t.ok === false ? "bad" : t.ok ? "ok" : "run"}`} dir="ltr" title={t.result}>
                      <span className="tool-name">{t.summary}</span>
                      {t.result && <span className="tool-result">→ {t.result}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {m.content && (
                <div className="msg-text">
                  <RichText text={m.content} />
                </div>
              )}
              {m.streaming && !m.content && <div className="typing" aria-label="המודל עובד" />}
              {m.error && (
                <div className="msg-error" role="alert">
                  <bdi dir="ltr">{m.error}</bdi>
                </div>
              )}
              {mixedModels && m.model && (
                <div className="msg-model" dir="ltr">
                  {m.model}
                </div>
              )}
            </div>
          ),
        )}
      </div>

      <div className="chat-foot">
        {!busy && (
          <div className="chips">
            {suggestions.map((s) => (
              <button key={s} type="button" className="chip" onClick={() => submit(s)} disabled={!llm.configured}>
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          <label htmlFor="chat-input" className="sr-only">
            הודעה למודל
          </label>
          <textarea
            id="chat-input"
            rows={2}
            value={text}
            placeholder={hasDashboard ? "בקשי שינוי או ניתוח נוסף…" : "מה לבדוק בלוגים?"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            disabled={!llm.configured}
          />
          {busy ? (
            <button type="button" className="send stop" onClick={onStop} aria-label="עצור">
              <Icon.Stop size={18} />
            </button>
          ) : (
            <button
              type="button"
              className="send"
              onClick={() => submit()}
              aria-label="שליחה"
              disabled={!text.trim() || !llm.configured}
            >
              <Icon.Send size={18} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
