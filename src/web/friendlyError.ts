/**
 * Turns a technical error (Elasticsearch, proxies, the model's API) into a short Hebrew
 * sentence that says what to do. The original text stays available as "technical details".
 */
export type Friendly = { title: string; hint?: string; kind: "slow" | "query" | "auth" | "busy" | "network" | "model" | "other" };

const RULES: { re: RegExp; f: Friendly }[] = [
  {
    re: /did not finish within|gateway timeout|http 504|\b504\b|timed? ?out|did not answer in time/i,
    f: { kind: "slow", title: "השאילתה כבדה מדי לטווח הזמן הזה.", hint: "נסי טווח זמן קצר יותר, או צמצמי במיקוד (namespace / pod)." },
  },
  {
    re: /unknown column|unknown index|verification_exception|parsing_exception|no such index|is not in the result|must be numeric/i,
    f: { kind: "query", title: "השאילתה של הפאנל לא מתאימה לנתונים בסביבה הזו.", hint: "אפשר לבקש מהמודל לתקן אותה." },
  },
  {
    re: /security_exception|unauthorized|forbidden|\b401\b|\b403\b|not authorized|privilege/i,
    f: { kind: "auth", title: "אין למפתח של האפליקציה הרשאה לנתונים האלה.", hint: "צריך לבקש מהאדמין להרחיב את ההרשאות." },
  },
  {
    re: /too many requests|\b429\b|circuit_breaking|rejected_execution|es_rejected/i,
    f: { kind: "busy", title: "האלסטיק עמוס כרגע.", hint: "נסי שוב בעוד דקה." },
  },
  {
    re: /network error|failed to fetch|אין תקשורת|נקטע/i,
    f: { kind: "network", title: "החיבור לשרת של האפליקציה נקטע.", hint: "נסי שוב. אם זה חוזר, כדאי לבדוק את ה-pod." },
  },
  {
    re: /model .* is not available|LLM_|context length|maximum context|rate limit|openai|completions/i,
    f: { kind: "model", title: "המודל לא הצליח לענות.", hint: "נסי שוב, או בחרי מודל אחר בראש השיחה." },
  },
];

export function friendlyError(message: string): Friendly {
  for (const r of RULES) if (r.re.test(message)) return r.f;
  return { kind: "other", title: "משהו השתבש." };
}
