# Calendar Ingest — Setup (Phase 14)

Чтобы автозагрузка событий Google Calendar заработала в Pulse, нужно добавить ОДНУ настройку в Workspace Admin Console.

## Что нужно сделать (1 минута)

1. Открой https://admin.google.com/ac/owl/domainwidedelegation
2. В таблице **API clients** найди строку с Client ID `117100433349513699261` (это `pulse-gmail-watcher` SA, уже добавлен для Gmail)
3. Кликни ✏️ Edit (или открой эту строку)
4. В поле **OAuth scopes** допиши ВТОРОЙ scope (через запятую):

```
https://www.googleapis.com/auth/gmail.metadata,https://www.googleapis.com/auth/calendar.events.readonly
```

5. Save / Authorize

## Также — включить Calendar API в Google Cloud

👉 https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=suitesforall

Кнопка **Enable**. ~10 секунд.

## После этого

Cloud Function `refreshCalendarEvents` уже задеплоена. Она запускается каждые 5 минут и пишет события каждого менеджера в Firestore. Pulse MyDay читает оттуда **Today's schedule** и **Today's calendar**.

Можно вручную запустить первый refresh — в DevTools Console на https://suitesforall.web.app:

```javascript
fbSync.sdk.httpsCallable(fbSync.functions, 'adminRefreshCalendar')({}).then(r => console.log('CALENDAR:', r.data)).catch(e => console.error('ERR:', e?.message || e))
```

Ожидаемый ответ: `{ processed: 5, failed: 0 }`.

## Что увидишь в MyDay после refresh

Сейчас «Today's schedule» хардкодом «Team standup 9:00 / Property tour 10:15 / 1:1 with Daniel 11:30». После Phase 14 заработает реально — твои события Google Calendar за сегодня.

## Privacy

Scope `calendar.events.readonly` — Pulse читает **только** title / start / end / location / attendee-count события. Не редактирует. Не имеет доступа к описаниям с конфиденциальной инфой если включить более узкий scope в будущем.
