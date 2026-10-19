# סטודיו לוגים

אפליקציית ווב שבה מתכתבים עם מודל AI על הלוגים באלסטיק, והוא בונה **דשבורדים חיים** תוך כדי השיחה. אפשר לשמור את הדשבורדים, לשתף אותם, לפתוח אותם שוב ולהתחיל עליהם שיחה חדשה, או ליצור מהם עותק (fork).

השרת **stateless**: אין בסיס נתונים, אין sessions, ושום דבר לא נשמר בשרת בין בקשות.

---

## הרעיון המרכזי: "מתכון"

כל דשבורד הוא **מתכון** בפורמט JSON: רשימת פאנלים, ולכל פאנל שאילתת ES|QL והוראות איך לצייר את התוצאה. המתכון **לא מכיל נתונים**. בכל פתיחה ובכל רענון האפליקציה מריצה את השאילתות מחדש, ולכן הדשבורד תמיד מציג נתונים עדכניים.

```json
{
  "title": "שגיאות 5xx – checkout-api",
  "notes": "מה הדשבורד בודק ולמה (המודל כותב ומעדכן)",
  "time_range": "24h",
  "panels": [
    {
      "id": "over-time", "title": "שגיאות לאורך זמן", "type": "line", "width": "full",
      "esql": "FROM logs-* | WHERE http.response.status_code >= 500 | STATS errors = COUNT(*) BY bucket = BUCKET(@timestamp, 50, ?_tstart, ?_tend), service.name | SORT bucket",
      "x": "bucket", "y": ["errors"], "series": "service.name"
    }
  ]
}
```

סוגי פאנלים: `metric`, `line`, `area`, `bar`, `hbar`, `table`, `text`.

## איפה כל דבר נשמר

| מה | איפה |
|---|---|
| השיחה | בדפדפן בלבד (localStorage), ל-`CHAT_RETENTION_HOURS` שעות (ברירת מחדל 24). רענון או מעבר לספרייה וחזרה לא מאבדים אותה. השרת לא שומר שיחות |
| הטיוטה הנוכחית | בשורת הכתובת (`#/r/...`). רענון הדף לא מאבד אותה |
| דשבורד ששמרת | **קישור**: המתכון כולו דחוס בתוך ה-URL. **קובץ JSON**: ייצוא וייבוא. **ספרייה משותפת**: אינדקס `ai-dashboards` באלסטיק, אם יש הרשאה |
| "נפתחו לאחרונה" | localStorage של הדפדפן (נוחות אישית בלבד) |
| הנתונים | Elasticsearch. נשלפים מחדש בכל רענון |
| מפתחות | משתני סביבה בשרת. לעולם לא נשלחים לדפדפן |

## מה עובד לפי ההרשאות שיש לך

האפליקציה בודקת בעלייה מה מותר למפתח (`_has_privileges`) ומדליקה או מכבה כפתורים בהתאם. סטטוס מלא מופיע בכפתור "מחובר ל-Elastic" בפינה.

| הרשאות | מה זמין |
|---|---|
| **קריאה בלבד ללוגים** | צ'אט, דשבורדים חיים, רענון אוטומטי, "פתח ב-Discover", **שמירה ושיתוף בקישור**, ייצוא וייבוא JSON, רשימת "נפתחו לאחרונה" |
| **+ `read` ו-`create_doc` על `ai-dashboards`** | ספרייה משותפת עם חיפוש, **גרסאות**, "עדכן", "שמור כעותק" (fork), קישור קצר |
| **+ Kibana 9.4 ומעלה** | ייצוא המתכון לדשבורד אמיתי של Kibana (ניסיוני) |

### גרסאות ו-fork

- כל שמירה יוצרת **מסמך חדש** (`<id>__v<n>`) ולא דורסת. כך יש היסטוריה, ואפשר לפתוח כל גרסה.
- **עדכן**: שומר גרסה חדשה של אותו דשבורד. אם מישהו שמר בינתיים גרסה חדשה יותר, השמירה נחסמת עם הודעה, ושום דבר לא נדרס.
- **שמור כעותק**: יוצר דשבורד חדש עם `forked_from`, שמצביע על הגרסה שממנה התחלת. המקור לא משתנה.
- פתיחת דשבורד ממשיכה את השיחה שלך עליו, אם היא עדיין שמורה בדפדפן. אחרת מתחילה שיחה חדשה, והמודל מקבל את המתכון (כולל ה-`notes`) כהקשר. "שיחה חדשה" מוחקת את השיחה השמורה.
- הקישור בשורת הכתובת כולל `&s=...`, המזהה של השיחה בדפדפן שלך. בדפדפן אחר אין לו משמעות, ומי שמקבל ממך קישור לא רואה את השיחה.

---

## התקנה והרצה

דרוש Node.js 20 ומעלה.

```bash
npm install
cp .env.example .env     # ולמלא את הערכים
npm run build
npm start                # http://localhost:8787
```

פיתוח (שרת + Vite עם רענון חם):

```bash
npm run dev              # http://localhost:5173
```

### הדגמה בלי אלסטיק ובלי מודל

יש סקריפטים של Elasticsearch, Kibana ומודל **מזויפים**, כדי לראות את כל הזרימה מקומית:

```bash
cp .env.mock.example .env
npm run mock             # טרמינל 1
npm run dev              # טרמינל 2
```

ה-Elasticsearch המזויף מעניק כברירת מחדל קריאה בלבד. כדי לבדוק את הספרייה המשותפת: `MOCK_WRITE=1 npm run mock`.

### Docker

```bash
docker build -t logs-studio .
docker run --env-file .env -p 8787:8787 logs-studio
```

מכיוון שהשרת stateless, אפשר להריץ כמה עותקים מאחורי load balancer בלי sticky sessions.

---

## הגדרות (משתני סביבה)

| משתנה | ברירת מחדל | הסבר |
|---|---|---|
| `ELASTIC_URL` | `http://localhost:9200` | כתובת Elasticsearch |
| `ELASTIC_API_KEY` | | המפתח בפורמט Encoded |
| `LOG_INDEX_PATTERNS` | `logs-*` | אילו אינדקסים מותר לשאול (רשימה מופרדת בפסיקים). כשמגדירים אינדקס אחד, המודל עובד רק עליו |
| `LOG_CONTEXT` | | תיאור חופשי של הנתונים שהמודל מקבל בכל שיחה: מה כל שדה אומר, איך מזהים שגיאה, שמות שירותים. `\n` לשורה חדשה |
| `LOG_CONTEXT_FILE` | | נתיב לקובץ טקסט עם אותו תיאור (עדיף לתיאור ארוך). גובר על `LOG_CONTEXT` |
| `TIME_FIELD` | `@timestamp` | שדה הזמן שעליו מופעל טווח הזמן |
| `DASHBOARDS_INDEX` | `ai-dashboards` | אינדקס הספרייה המשותפת |
| `MAX_ROWS` | `1000` | מקסימום שורות לשאילתה |
| `KIBANA_URL` | | נדרש ל-"פתח ב-Discover" ולייצוא |
| `KIBANA_PUBLIC_URL` | `KIBANA_URL` | אם הדפדפן מגיע ל-Kibana בכתובת אחרת מהשרת |
| `KIBANA_SPACE` | | Space של Kibana לקישורים ולייצוא |
| `KIBANA_EXPORT` | `auto` | `off` מכבה את הייצוא. ב-`auto` הוא נדלק רק ב-9.4 ומעלה |
| `LLM_BASE_URL` | | למשל `https://host/v1`. כל שרת תואם OpenAI עם tool calling |
| `LLM_API_KEY` | | |
| `LLM_MODEL` | | שם המודל |
| `LLM_STREAM` | `true` | `false` אם השרת מתקשה עם streaming של tool calls |
| `LLM_MAX_STEPS` | `14` | כמה סבבים מול המודל מותרים לשאלה אחת |
| `CHAT_RETENTION_HOURS` | `24` | כמה זמן השיחה נשמרת בדפדפן. `0` מבטל את השמירה |
| `APP_BASIC_AUTH` | | `user:password`. מומלץ מאוד כשהאפליקציה נגישה ברשת |

---

## יצירת מפתחות (Kibana → Dev Tools)

המפתח מקבל לכל היותר את ההרשאות של המשתמש שיוצר אותו. משתמש רגיל צריך הרשאת `manage_own_api_key` כדי ליצור מפתח לעצמו.

**קריאה בלבד** (מה שיש לך היום):

```
POST /_security/api_key
{
  "name": "logs-studio",
  "expiration": "90d",
  "role_descriptors": {
    "logs-studio": {
      "indices": [
        { "names": ["logs-*"], "privileges": ["read"] }
      ]
    }
  }
}
```

**עם ספרייה משותפת**: מוסיפים שורה ל-`indices`:

```
{ "names": ["ai-dashboards"], "privileges": ["read", "create_doc"] }
```

את האינדקס עצמו האדמין יוצר פעם אחת (המיפוי בקובץ `scripts/ai-dashboards-index.json`):

```
PUT /ai-dashboards
{ ...התוכן של scripts/ai-dashboards-index.json... }
```

**ייצוא ל-Kibana** (רק מ-9.4): המפתח צריך גם הרשאת כתיבה לדשבורדים ב-Kibana, ב-Space שהוגדר. הדרך הפשוטה היא תפקיד עם Dashboards: All באותו Space. את שמות ההרשאות המדויקים כדאי לבדוק בתיעוד של הגרסה שלכם.

---

## אבטחה

- **ההרשאות של המפתח הן הגבול האמיתי.** מפתח לקריאה בלבד מבטיח שהמודל לא יכול לשנות דבר באלסטיק. ES|QL הוא ממילא שפה לקריאה בלבד.
- בנוסף, השרת בודק כל שאילתה לפני הרצה: רק `FROM` על אינדקסים מ-`LOG_INDEX_PATTERNS`, בלי אינדקסי מערכת (`.`), עם `LOOKUP JOIN` רק לאינדקסים מותרים, ומוסיף `LIMIT` אוטומטי.
- המפתחות נשמרים רק בשרת.
- **שימי לב: תוצאות שאילתות נשלחות לספק המודל.** אם בלוגים יש מידע רגיש, כדאי להגביל שדות כבר ברמת המפתח (field-level security).
- קישור משותף מכיל את **השאילתות**, לא את הנתונים. מי שפותח אותו רואה נתונים רק דרך השרת, כלומר רק אם יש לו גישה לאפליקציה.

## מגבלות ידועות

- **ייצוא ל-Kibana הוא ניסיוני.** הוא נבנה לפי הדוגמאות המפורסמות של Kibana Dashboards API (Preview ב-9.4, GA ב-9.5), ולא נבדק מול Kibana אמיתי. כל ההמרה נמצאת בקובץ אחד, `src/server/kibanaExport.ts`, וכדאי לבדוק אותה כשתשדרגו. פאנלי טקסט לא מיוצאים.
- **"פתח ב-Discover"** בונה קישור למצב ES|QL של Discover. כדאי לוודא פעם אחת שזה נפתח כמו שצריך בגרסה שלכם.
- קישור עם דשבורד גדול מאוד (עשרות פאנלים) עלול להיות ארוך מדי לצ'אט או למייל. האפליקציה מזהירה, ואז עדיף ייצוא JSON או הספרייה המשותפת.
- הממשק בעיצוב בהיר בלבד.
- איכות הניתוח תלויה במודל. מודל חלש יתקשה עם ES|QL ועם tool calling. אם הוא נכשל הרבה, כדאי לנסות מודל חזק יותר או `LLM_STREAM=false`.

## מבנה הקוד

```
src/shared/recipe.ts      סכמת המתכון (zod), משותפת לשרת ולדפדפן
src/shared/discover.ts    בניית קישורי Discover
src/server/index.ts       ה-API (Express), stateless
src/server/agent.ts       לולאת המודל וארבעת הכלים: list_indices, get_fields, run_esql, set_dashboard
src/server/prompt.ts      הנחיות המערכת למודל
src/server/elastic.ts     גישה ל-Elasticsearch, הרצת ES|QL ובדיקות שאילתות
src/server/library.ts     הספרייה המשותפת: גרסאות, עדכון, fork
src/server/capabilities.ts בדיקת ההרשאות בפועל
src/server/kibanaExport.ts ייצוא ל-Kibana (ניסיוני)
src/web/                  ממשק React: צ'אט, דשבורד (ECharts), ספרייה
scripts/mock-*.ts         Elasticsearch, Kibana ומודל מזויפים לפיתוח
```

### ה-API

| | |
|---|---|
| `GET /api/capabilities` | מה זמין לפי ההרשאות |
| `POST /api/chat` | `{messages, recipe, time_range}`. מחזיר אירועים בפורמט NDJSON: `text`, `tool_start`, `tool_end`, `recipe`, `error`, `done` |
| `POST /api/query` | `{esql, time_range}`. מריץ שאילתה של פאנל |
| `GET /api/dashboards?q=` | רשימת הדשבורדים (הגרסה האחרונה של כל אחד) |
| `GET /api/dashboards/:id?version=` | מתכון |
| `GET /api/dashboards/:id/versions` | כל הגרסאות |
| `POST /api/dashboards` | `{recipe, mode: "new" \| "update" \| "fork"}` |
| `POST /api/export/kibana` | `{recipe}` |
