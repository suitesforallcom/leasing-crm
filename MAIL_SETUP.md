# MAIL_SETUP.md — Unit mail: настройка общего ящика (для Tony)

Переписка из карточки юнита (план — `UNIT_EMAIL_PLAN.md`). **Phase 0 = чтение**:
письма общего ящика компании попадают в SuitesForAll, привязываются к юнитам по
адресам арендаторов и показываются в оверлее по иконке конверта. Отправка — Phase 1.

Код: `functions/mail-shared.js`, `mail-sanitize.js`, `mail-access.js`, `mail-link.js`,
`mail-sync.js`, `mail-read.js`; тесты `npm run test:mail`; правила `firestore.rules`
(блоки `mail*`), индексы `firestore.indexes.json` (`mailThreads`).

---

## Что мы читаем и что нет

- ✅ **Общий ящик** (`leasing@al-en.com` или другой адрес из конфига) — целиком: заголовки,
  тела, вложения. Это архив переписки компании с арендаторами.
- ❌ Личные ящики сотрудников — Unit mail их не трогает (для них действует только
  метаданный Pulse-ingest, см. GMAIL_INGEST_SETUP.md).
- ❌ Черновики, корзина, спам общего ящика (пропускаются при синке).

Клиент (браузер) письма напрямую из Firestore не читает: только через Cloud Functions
с проверкой роли и грантов (admin — всё; manager — свои здания; остальные — ничего,
пока admin не выдаст грант). HTML санитизируется при каждом чтении, картинки не
грузятся без клика «Display images», вложения отдаются подписанными URL на 10 минут.

---

## Шаги Tony (один раз, ~25 минут)

### Шаг 1 — Ящик в Google Workspace (3 мин)

1. [admin.google.com → Users](https://admin.google.com/ac/users) → **Add new user**:
   имя `SuitesForAll Leasing`, адрес `leasing@al-en.com` (или другой — тогда тот же
   адрес в Шаге 7). Нужна обычная лицензия пользователя.
2. (Опционально) в настройках этого пользователя добавить alias, например `office@al-en.com`.

### Шаг 2 — Service account `sfa-mail-sa` (4 мин)

Отдельный от `pulse-gmail-watcher` — у него другой client ID и другие scopes
(видно и аудируемо в Admin Console).

1. [IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=suitesforall)
   → **Create Service Account**: name `sfa-mail-sa`, description
   `Unit mail: общий ящик через domain-wide delegation` → Create and Continue →
   без ролей проекта → Done.
2. Открыть созданный аккаунт → **Advanced settings → Domain-wide delegation → Enable** →
   скопировать **Client ID** (длинное число) — нужен в Шаге 3.
3. Вкладка **Keys → Add key → Create new key → JSON** → файл скачается
   (например `suitesforall-xxxx.json`). Не класть в git, не пересылать.

### Шаг 3 — Domain-wide delegation в Workspace Admin (3 мин)

[Security → Access and data control → API controls → Manage Domain Wide Delegation](https://admin.google.com/ac/owl/domainwidedelegation)
→ **Add new**:

- Client ID — из Шага 2;
- OAuth scopes — **одной строкой через запятую** (при правке список заменяется целиком,
  поэтому сразу оба, второй понадобится в Phase 1):
  ```
  https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send
  ```
→ **Authorize**.

### Шаг 4 — Pub/Sub topic `sfa-mail-push` (3 мин)

[Pub/Sub → Topics](https://console.cloud.google.com/cloudpubsub/topic/list?project=suitesforall)
→ **Create Topic**: ID `sfa-mail-push`, галочку «default subscription» снять → Create.
На странице topic → **Permissions → Add principal**:
`gmail-api-push@system.gserviceaccount.com`, роль **Pub/Sub Publisher** → Save.

Через CLI (если `gcloud` жив):
```bash
gcloud pubsub topics create sfa-mail-push --project=suitesforall
gcloud pubsub topics add-iam-policy-binding sfa-mail-push \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher --project=suitesforall
```

### Шаг 5 — Секрет `MAIL_SA_KEY` (1 мин)

```bash
firebase functions:secrets:set MAIL_SA_KEY --data-file=/path/to/suitesforall-xxxx.json
firebase functions:secrets:access MAIL_SA_KEY | head -c 60   # должно начинаться с {"type": "service_account"
rm /path/to/suitesforall-xxxx.json
```

### Шаг 6 — Роль для подписанных URL (2 мин)

Вложения отдаются подписанными URL (`getSignedUrl`), для этого runtime-аккаунту
функций нужна роль **Service Account Token Creator** на самом себе.

1. Узнать аккаунт: [Cloud Functions](https://console.cloud.google.com/functions/list?project=suitesforall)
   → любая функция → Details → **Service account** (обычно
   `PROJECT_NUMBER-compute@developer.gserviceaccount.com`).
2. [IAM](https://console.cloud.google.com/iam-admin/iam?project=suitesforall) → найти
   этот аккаунт → Edit → **Add another role → Service Account Token Creator** → Save.

CLI-вариант (подставь номер проекта):
```bash
gcloud iam service-accounts add-iam-policy-binding PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --member=serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --role=roles/iam.serviceAccountTokenCreator --project=suitesforall
```

### Шаг 7 — Конфиг `integrations/mail` (2 мин)

В браузере на https://suitesforall.web.app (залогинен как admin) → консоль (F12):

```js
const {sdk, db} = fbSync;
await sdk.setDoc(sdk.doc(db, 'workspaces', 'default', 'integrations', 'mail'), {
  enabled: false,              // включим в Шаге 10, после backfill
  mailboxes: [{ id: 'leasing', address: 'leasing@al-en.com', displayName: 'SuitesForAll Leasing', enabled: true }],
  ownDomains: ['al-en.com'],
  timeZone: 'America/New_York',
  sendEnabled: false,          // Phase 1
  gmailLabelsEnabled: false,   // Phase 2 (опция)
  backfillSince: '2026-01-01', // с какой даты импортировать архив
  limits: { perUserPerDay: 100, perWorkspacePerHour: 120, perUnitPerDay: 20, maxRecipients: 20 },
}, { merge: true });
```

Скажи «секрет загружен, конфиг записан» — дальше Шаг 8 делаю я после твоего «ок» на деплой.

---

## Шаг 8 — Деплой rules / indexes / functions (отдельное одобрение Tony)

```bash
cd "/Users/diskc/Projects/Claude/Projects/Office map"
npm run test:mail
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only functions:mailOnPush,functions:mailSyncScheduled,functions:mailBackfill,functions:mailAdminStatus,functions:mailListThreads,functions:mailGetThread,functions:mailGetAttachmentUrl,functions:mailLinkThread,functions:mailRelinkUnit
```

Если деплой ругается `secret ... not found` — не выполнен Шаг 5. Если
`insufficient permission` на Pub/Sub — Шаг 4. Индекс `mailThreads` строится
несколько минут; до его готовности `mailListThreads` вернёт `failed-precondition`.

## Шаг 9 — Первичный импорт (backfill)

В консоли браузера (root admin):

```js
console.log((await stripeCallable('mailAdminStatus')({})).data);        // состояние ящика
let r; do {
  r = (await stripeCallable('mailBackfill')({ pageSize: 100 })).data.results[0];
  console.log(r.imported, r.done ? 'DONE' : 'more…');
} while (!r.done);
```

Каждый вызов тянет ≤ 100 писем (вложения копируются в Storage), повторный вызов
продолжает с сохранённой страницы. Ошибки отдельных писем попадают в
`pendingRetry` и повторяются синком; полный сбой — в `lastError` + dead-letter.

## Шаг 10 — Включить

```js
const {sdk, db} = fbSync;
await sdk.setDoc(sdk.doc(db, 'workspaces', 'default', 'integrations', 'mail'), { enabled: true }, { merge: true });
await stripeCallable('mailAdminStatus')({ renewWatch: true });   // сразу зарегистрировать watch (иначе — ближайший 10-минутный тик)
```

После этого в карточке юнита (admin/manager) появляется конверт слева от «⋯».

## Smoke-тест

1. С любого внешнего адреса, который записан в `u.email` тестового юнита, отправить письмо
   на `leasing@al-en.com` с темой `Test unit mail`.
2. ≤ 30 с: открыть юнит → конверт → тред виден с бейджем **Rule · email: <адрес>**.
3. `(await stripeCallable('mailAdminStatus')({})).data` → `lastSyncAt` свежий,
   `lastError: null`, `deadLetters: []`, `watchExpiration` в будущем.
4. Логи: `firebase functions:log --only mailOnPush,mailSyncScheduled`.
5. Письмо с HTML и картинкой-пикселем: в оверлее нет запроса к пикселю (Network), скрипты не
   выполняются; вложение открывается по подписанному URL.

## Откат

1. `integrations/mail.enabled = false` — конверт исчезает, push игнорируется, синк не идёт.
2. `await stripeCallable('mailAdminStatus')({ stopWatch: true })` (root admin) — Gmail перестаёт слать push.
3. `firebase functions:delete mailOnPush mailSyncScheduled mailBackfill mailAdminStatus mailListThreads mailGetThread mailGetAttachmentUrl mailLinkThread mailRelinkUnit`
4. Клиент — `git revert` коммитов Phase 0 (hosting выезжает авто-деплоем); rules —
   `git revert` + `firebase deploy --only firestore:rules`.
5. Данные `workspaces/default/mail*` и Storage `mail/` можно оставить (не мешают) или удалить
   admin-скриптом. Секрет — `firebase functions:secrets:destroy MAIL_SA_KEY`; service account и
   запись DWD — удалить в консолях.

## Что хранится и где

| Данные | Где | Кто пишет | Кто читает |
|---|---|---|---|
| конфиг (адрес ящика, лимиты, TZ, рубильники) | `workspaces/default/integrations/mail` | admin | все члены (rules) |
| состояние синка (курсор, watch, ошибки, backfill) | `workspaces/default/mailboxes/{id}` | CF | CF (`mailAdminStatus`) |
| треды (агрегат, участники, привязки к юнитам) | `workspaces/default/mailThreads/{mailboxId__threadId}` | CF | CF (`mailListThreads`) |
| письма (заголовки, текст ≤ 100 КБ, список вложений) | `workspaces/default/mailMessages/{mailboxId__msgId}` | CF | CF (`mailGetThread`) |
| сырой HTML и вложения | Storage `mail/default/{mailboxId}/{msgId}/…` | CF | подписанные URL |
| ошибки, которые нельзя терять | `workspaces/default/mailDeadLetter/*` (TTL 90 д) | CF | admin |
| гранты доступа | `workspaces/default/mailAccess/{uid}` (Phase 2) | CF | свой / admin |
| аудит привязок, watch, (Phase 1) отправок | `workspaces/default/audit` (`source: 'mail'`) | CF | Settings → Audit |
