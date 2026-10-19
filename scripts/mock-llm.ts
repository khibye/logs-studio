/**
 * A scripted fake of an OpenAI-compatible /v1/chat/completions endpoint, for
 * exercising the agent loop without a real model. It walks a fixed script:
 *   user message → get_fields → run_esql → set_dashboard (first attempt has an
 *   error on purpose, to test the fix-up loop) → set_dashboard → final answer.
 * Supports stream: true (SSE) and stream: false.   MOCK_LLM_PORT=4010
 */
import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));
const PORT = Number(process.env.MOCK_LLM_PORT ?? 4010);

const dashboard = (broken: boolean) => ({
  title: "שגיאות 5xx לפי שירות",
  notes: "בדיקת העלייה בשגיאות 5xx: באיזה שירות ו-endpoint היא מתרכזת, ומה השגיאות האחרונות.",
  time_range: "24h",
  panels: [
    { id: "total", title: "שגיאות 5xx", type: "metric", width: "third", esql: "FROM logs-* | WHERE http.response.status_code >= 500 | STATS errors = COUNT(*)", y: ["errors"] },
    { id: "avg", title: "זמן תגובה ממוצע", type: "metric", width: "third", unit: "ms", esql: "FROM logs-* | STATS avg_ms = AVG(event.duration)", y: ["avg_ms"] },
    { id: "svc", title: "שירותים עם שגיאות", type: "metric", width: "third", esql: "FROM logs-* | WHERE http.response.status_code >= 500 | STATS services = COUNT_DISTINCT(service.name)", y: ["services"] },
    {
      id: "over-time",
      title: "שגיאות לאורך זמן, לפי שירות",
      type: "line",
      width: "full",
      esql: "FROM logs-* | WHERE http.response.status_code >= 500 | STATS errors = COUNT(*) BY bucket = BUCKET(@timestamp, 50, ?_tstart, ?_tend), service.name | SORT bucket",
      x: "bucket",
      y: [broken ? "error_count" : "errors"],
      series: "service.name",
    },
    {
      id: "top-paths",
      title: "Top endpoints עם שגיאות",
      type: "hbar",
      width: "half",
      esql: "FROM logs-* | WHERE http.response.status_code >= 500 | STATS errors = COUNT(*) BY url.path | SORT errors DESC | LIMIT 10",
      x: "url.path",
      y: ["errors"],
    },
    {
      id: "recent",
      title: "שגיאות אחרונות",
      type: "table",
      width: "half",
      esql: "FROM logs-* | WHERE http.response.status_code >= 500 | KEEP @timestamp, service.name, url.path, http.response.status_code, message | SORT @timestamp DESC | LIMIT 20",
    },
  ],
});

function nextStep(messages: any[]) {
  const toolMsgs = messages.filter((m) => m.role === "tool");
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const sinceUser = messages.slice(lastUserIdx + 1).filter((m) => m.role === "tool");
  const n = sinceUser.length;
  const last = toolMsgs[toolMsgs.length - 1];
  if (n === 0) return { text: "בודקת אילו שדות יש בלוגים. ", tool: { name: "get_fields", args: { index_pattern: "logs-*" } } };
  if (n === 1) return { tool: { name: "run_esql", args: { query: "FROM logs-* | WHERE http.response.status_code >= 500 | STATS errors = COUNT(*) BY service.name | SORT errors DESC" } } };
  if (n === 2) return { text: "בונה דשבורד.", tool: { name: "set_dashboard", args: dashboard(true) } };
  if (n === 3 && String(last?.content).includes('"ok":false')) return { tool: { name: "set_dashboard", args: dashboard(false) } };
  return {
    text: "רוב שגיאות ה-5xx מגיעות מ-`checkout-api`, עם עלייה חדה לפני כמה שעות. בניתי דשבורד עם 6 פאנלים: מדדים עיקריים, שגיאות לאורך זמן לפי שירות, endpoints מובילים וטבלת שגיאות אחרונות.",
  };
}

let callNo = 0;
app.post("/v1/chat/completions", async (req, res) => {
  const step = nextStep(req.body.messages ?? []);
  const id = `chatcmpl-${++callNo}`;
  const toolCall = step.tool
    ? { id: `call_${callNo}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }
    : null;

  if (!req.body.stream) {
    return res.json({
      id,
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: toolCall ? "tool_calls" : "stop", message: { role: "assistant", content: step.text ?? null, tool_calls: toolCall ? [toolCall] : undefined } }],
    });
  }
  res.setHeader("Content-Type", "text/event-stream");
  const send = (delta: any, finish: string | null = null) =>
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  send({ role: "assistant" });
  for (const word of (step.text ?? "").split(/(\s+)/)) {
    if (!word) continue;
    send({ content: word });
    await sleep(15);
  }
  if (toolCall) {
    const args = toolCall.function.arguments;
    send({ tool_calls: [{ index: 0, id: toolCall.id, type: "function", function: { name: toolCall.function.name, arguments: "" } }] });
    for (let i = 0; i < args.length; i += 80) send({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 80) } }] });
  }
  send({}, toolCall ? "tool_calls" : "stop");
  res.write("data: [DONE]\n\n");
  res.end();
});

app.listen(PORT, () => console.log(`mock LLM on http://localhost:${PORT}/v1`));
