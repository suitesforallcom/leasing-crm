# Gmail Ingest — Setup Guide (для Tony)

Пошаговая инструкция как подключить авто-трекинг исходящих email сотрудников через Gmail API + Pub/Sub.

**Что в итоге:** все письма, которые любой `@al-en.com` сотрудник отправляет из Gmail → в Pulse автоматически появляется `+1 email` через ~10 секунд. Никакого ручного ввода, никаких BCC-фильтров.

**Время на настройку:** ~20 минут единоразово.

---

## Что мы НЕ читаем

- ❌ Тело письма
- ❌ Вложения
- ❌ Письма из Inbox / Drafts / Trash

Используется scope `gmail.metadata` — Google гарантирует, что доступа к содержимому нет. Видим: дату, тему, отправителя, получателя.

---

## Архитектура (схема)

```
Сотрудник отправил письмо из Gmail
        │
        ▼
   Gmail Watch (registered per-employee)
        │ "messageAdded в SENT"
        ▼
  Pub/Sub topic "gmail-push" в Google Cloud
        │
        ▼
  Cloud Function onGmailPush
        │ gmail.users.history.list → messages.get(metadata)
        │ матчит recipient ↔ tenant ↔ unit
        ▼
  Firestore /workspaces/default/data/state
        │ u.outreach[].push({type:'email', sentBy, subject, ...})
        ▼
  Pulse при следующем reload → emailsMtd ++
```

---

## Шаг 1 — Включить API в Google Cloud Console (5 мин)

Проект GCP: **`suitesforall`** (тот же, что Firebase).

Открой [Google Cloud Console — APIs & Services](https://console.cloud.google.com/apis/library?project=suitesforall) для проекта `suitesforall`.

Включи две API (нажми «Enable» на каждой):

1. **Gmail API** → https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=suitesforall
2. **Cloud Pub/Sub API** → https://console.cloud.google.com/apis/library/pubsub.googleapis.com?project=suitesforall

Альтернатива — через CLI (если у тебя установлен `gcloud`):

```bash
gcloud services enable gmail.googleapis.com --project=suitesforall
gcloud services enable pubsub.googleapis.com --project=suitesforall
```

---

## Шаг 2 — Создать Pub/Sub topic (2 мин)

Открой [Pub/Sub → Topics](https://console.cloud.google.com/cloudpubsub/topic/list?project=suitesforall):

1. Нажми **«Create Topic»**
2. Topic ID: `gmail-push`
3. Default subscription: **сними галочку** (не нужна — у нас Cloud Function триггер сам подписку создаст)
4. **«Create»**

Альтернатива — CLI:

```bash
gcloud pubsub topics create gmail-push --project=suitesforall
```

### Шаг 2.1 — Дать Gmail API право публиковать в topic

Это критично. Без этой permission watch() будет failing.

В Pub/Sub Console, на странице созданного topic `gmail-push`:

1. Справа панель **«Permissions»** (или вкладка «Permissions»)
2. **«Add Principal»**
3. New principals: `gmail-api-push@system.gserviceaccount.com`
4. Role: `Pub/Sub Publisher`
5. **«Save»**

Альтернатива — CLI:

```bash
gcloud pubsub topics add-iam-policy-binding gmail-push \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher \
  --project=suitesforall
```

---

## Шаг 3 — Создать service account (3 мин)

Открой [IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=suitesforall):

1. **«Create Service Account»**
2. Name: `pulse-gmail-watcher`
3. ID: `pulse-gmail-watcher` (заполнится автоматически)
4. Description: `Domain-wide delegation для авто-трекинга исходящей почты сотрудников в Pulse`
5. **«Create and Continue»**
6. Skip «Grant this service account access to project» (для domain-wide delegation НЕ нужно никакой IAM-роли)
7. **«Done»**

### Шаг 3.1 — Включить Domain-Wide Delegation

На странице созданного service account:

1. **«Details»** → раскрыть «Advanced settings» (или сразу видна секция «Domain-wide delegation»)
2. **«Enable Google Workspace Domain-wide Delegation»** ☑️
3. (опционально) Product name for consent screen: `SuitesForAll Pulse`
4. **«Save»**
5. **Скопировать «Unique ID» (OAuth 2 Client ID)** — длинная цифра вида `123456789012345678901`. **Сохрани, понадобится на Шаге 5.**

### Шаг 3.2 — Скачать JSON ключ

На странице service account:

1. Вкладка **«Keys»**
2. **«Add Key» → «Create new key»**
3. Type: **JSON**
4. **«Create»** — файл скачается, например `suitesforall-abc123def456.json`
5. **Открой файл, скопируй весь его контент (JSON), он понадобится на Шаге 6.**

⚠️ **Безопасность:** этот файл = полный доступ к Gmail-метаданным всех твоих сотрудников. Не клади в git, не пересылай в Slack/email. После шага 6 — удали локальную копию (Firebase будет хранить).

---

## Шаг 4 — В Google Cloud дать service account публиковать в Pub/Sub

В Pub/Sub Console, на topic `gmail-push`, секция Permissions:

1. **«Add Principal»**
2. New principal: `pulse-gmail-watcher@suitesforall.iam.gserviceaccount.com`
3. Role: `Pub/Sub Subscriber` (для receiving) и отдельно `Pub/Sub Publisher` (не нужно для нашего use case, можно пропустить)

⚠️ Реально из этих ролей нам нужен только **Pub/Sub Subscriber** для нашего Cloud Function — но это auto-grant при деплое функции. Этот шаг можно **пропустить**.

---

## Шаг 5 — Domain-Wide Delegation в Workspace Admin Console (3 мин)

Самый чувствительный шаг — это даёт нашему service account право импер­сонировать любого `@al-en.com` пользователя для чтения метаданных Gmail.

Открой [Workspace Admin Console — API Controls](https://admin.google.com/ac/owl/list?tab=configuredApps):

1. Слева **Security → Access and data control → API Controls**
2. Прокрути вниз до **«Domain-wide delegation»** → **«Manage Domain Wide Delegation»**
3. **«Add new»**
4. Client ID: **вставь Unique ID из Шага 3.1** (цифра, например `123456789012345678901`)
5. OAuth scopes (one per line):
   ```
   https://www.googleapis.com/auth/gmail.metadata
   ```
6. **«Authorize»**

### Опционально — ограничить кого мониторим

Если хочешь исключить топ-менеджмент / себя из мониторинга:

- В Workspace Admin Console создай Google Group, например `pulse-tracked@al-en.com`
- Добавь туда только тех, кого хочешь видеть в Pulse leaderboard
- В CF можно тогда читать членов этой группы вместо всего workspace (это потом, если понадобится — сейчас CF берёт всех `admin`/`manager` members из Firestore)

---

## Шаг 6 — Загрузить SA key как Firebase Secret (1 мин)

Из терминала (там же, где обычно деплоишь):

```bash
cat /path/to/suitesforall-abc123def456.json | firebase functions:secrets:set GMAIL_SA_KEY --data-file=-
```

Или интерактивно:

```bash
firebase functions:secrets:set GMAIL_SA_KEY
# (введёт промпт — вставь содержимое JSON-файла + Ctrl+D)
```

Проверь, что записалось:

```bash
firebase functions:secrets:access GMAIL_SA_KEY | head -3
# должен показать первые строки JSON
```

После этого **удали локальный .json файл** (`rm /path/to/...json`).

---

## Шаг 7 — Деплой Cloud Functions

Деплой — отдельный action, я НЕ запускаю авто-деплоем (это `firebase deploy --only functions`, явное approval требуется):

```bash
firebase deploy --only functions:onGmailPush,functions:bootstrapGmailWatch,functions:adminBootstrapGmailWatch,functions:adminStopGmailWatch
```

Если выдаст «secret not granted» ошибку — после первой попытки секрет привяжется к функции, повтори:

```bash
firebase deploy --only functions
```

---

## Шаг 8 — Первый bootstrap (запуск watch для всех менеджеров)

В консоли браузера (на `https://suitesforall.web.app`, ты залогинен как `tony@al-en.com`):

```javascript
const fn = firebase.functions().httpsCallable('adminBootstrapGmailWatch');
const res = await fn({});
console.log(res.data);
// Ожидаемый ответ: { ok:true, registered: <число>, skipped: 0, failed: 0 }
```

Если `failed > 0` → проверь errors в логах: `firebase functions:log --only adminBootstrapGmailWatch`.

Самые частые ошибки:
- **403 / unauthorized_client** — domain-wide delegation не настроен правильно, или scope не тот. Проверь Шаг 5.
- **401 / invalid_grant** — service account ключ ротирован или невалиден. Проверь Шаг 6.
- **insufficient_permission** — Pub/Sub topic permission. Проверь Шаг 2.1.

---

## Шаг 9 — Smoke test (твоя проверка)

1. С `tony@al-en.com` отправь любое тестовое письмо — на свой второй email, на коллегу, куда угодно
2. Подожди 10-30 секунд
3. Открой [https://suitesforall.web.app/pulse.html](https://suitesforall.web.app/pulse.html)
4. Найди свою строку → колонка **«Emails»** должна показать `+1` относительно того, что было до теста

Если не увеличилось:
- Проверь логи: `firebase functions:log --only onGmailPush`
- В логе должен быть `[gmail-push] processed { userEmail: 'tony@al-en.com', count: 1 }`
- Если `count: 0` — письмо ушло, но Gmail API его ещё не индексировал, повтори через минуту
- Если `[gmail-push] state doc missing` — проверь что `/workspaces/default/data/state` существует

---

## Шаг 10 — Раскатка на остальных менеджеров

После успешного smoke test, повтори Шаг 8 — он одновременно регистрирует watch для всех, у кого role=admin или role=manager в `workspaces/default/members`.

Дальше `bootstrapGmailWatch` крутится каждые сутки автоматически (cron 04:00 UTC) и перерегистрирует watch (Gmail режет на 7-й день).

---

## Что делать когда нанимается новый сотрудник

Auto-onboarding (Entry 25) сам добавит его в `workspaces/default/members`. Watch для него зарегистрируется на следующем daily cron (≤ 24 часа) — либо ты можешь сразу запустить `adminBootstrapGmailWatch` руками для немедленной активации.

---

## Что делать если хочешь остановить мониторинг для одного человека

В консоли браузера:

```javascript
const fn = firebase.functions().httpsCallable('adminStopGmailWatch');
await fn({ userEmail: 'someone@al-en.com' });
```

Или полностью отключить всё:

```javascript
await fn({});  // без userEmail = все
```

---

## Rollback (если что-то пошло не так)

1. Останови watch для всех: `adminStopGmailWatch({})` в браузерной консоли
2. Удали Cloud Functions: `firebase functions:delete onGmailPush bootstrapGmailWatch adminBootstrapGmailWatch adminStopGmailWatch`
3. Удали secret: `firebase functions:secrets:destroy GMAIL_SA_KEY`
4. Удали service account в IAM Console
5. Удали Pub/Sub topic `gmail-push`
6. Удали Domain-wide delegation entry в Workspace Admin Console

Firestore data (`state.gmailActivity[]`, `gmailWatch/*` docs) можно оставить — не мешает.

---

## Privacy / Compliance notes

- **Scope** `gmail.metadata` — Google API не возвращает тело письма даже если запросить (technical guarantee, не policy)
- **Storage** — мы сохраняем только: messageId Gmail-side, threadId, subject (≤500 chars), from, to (primary), date
- **Retention** — `state.gmailActivity[]` ограничен 5000 записей (FIFO trim)
- **Опт-аут** — любой сотрудник может попросить исключить себя; админ запускает `adminStopGmailWatch({userEmail:'x@al-en.com'})`
- **Сотрудник видит мониторинг** — в его Google Account → Security → Third-party apps появится `SuitesForAll Pulse` с указанием scopes (если выставил Product name в Шаге 3.1)

---

## Что мне нужно от тебя обратно после Шага 6

Скажи **«секрет загружен»** или просто **«ок»** — и я сделаю Шаг 7 (deploy) после твоего явного approve.
