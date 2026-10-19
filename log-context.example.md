# דוגמה ל-LOG_CONTEXT_FILE: תיאור הנתונים בשביל המודל. להעתיק, לערוך ולהפנות אליו מ-.env

- האינדקס: logs-myapp-prod. לוגים של שרתי ה-API, שורה לכל בקשה.
- service.name: שם השירות (checkout-api, cart-svc, user-svc).
- http.response.status_code: קוד התשובה. שגיאות שרת הן 500 ומעלה.
- event.duration: זמן הטיפול בבקשה, בננו-שניות. לחלק ב-1000000 כדי לקבל מילישניות.
- log.level: "error" לשגיאות, "warn" לאזהרות.
- message: הודעת השגיאה המלאה.
- סביבה: השדה deployment.environment, ערכים prod / staging.
