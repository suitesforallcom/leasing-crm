# UNIT_EMAIL_PLAN.md — переписка из карточки юнита (Gmail-подобный оверлей)

> **Статус: ПЛАН. Код не начат, ничего не задеплоено.** Дата 2026-10-24.
> Исполнение начинается только после явного «да» Тони по § 9 (вопросы) и по пунктам
> CLAUDE.md § 2 (Cloud Functions, `firestore.rules`, индексы, секреты, внешние API,
> новая зависимость, роли). Язык документа — русский, идентификаторы — английские.
> Ссылки вида `M:79838` = `floor-map-editor.html:79838`, `F:7204` = `functions/index.js:7204`,
> `G:124` = `functions/gmail-ingest.js:124`, `PP:` = репозиторий `/Users/diskc/Projects/kiwi-rentals`.

---

## 0. Резюме

1. Тони хочет: иконку конверта в шапке карточки юнита; по клику — оверлей почти на весь экран,
   «как в Gmail»: вся переписка по юниту/арендатору, чтение и отправка; настройка «какой
   сотрудник какие письма видит»; сотрудники ведут переписку из программы, а не из личных ящиков.
2. Образец — вкладка «Emails» задачи в PropertyPulse 2.0 (`app.kiwi-rentals.com/tasks`).
   Изучен её код: письма читаются из ящиков Google Workspace через service-account с
   domain-wide delegation, хранятся в Postgres, HTML санитизируется при каждом чтении,
   отправка — Gmail API `messages.send` из ящика сотрудника, привязка писем к задаче считается
   «на лету» по точным адресам участников (бейдж «Rule») или вручную (бейдж «via thread»).
3. В SuitesForAll уже есть: (а) `functions/gmail-ingest.js` — слежение за **метаданными**
   писем сотрудников (без тел), пишет счётчики в Pulse; оно не strip-aware и не видит `u.email`,
   поэтому к юнитам сейчас фактически ничего не привязывается; (б) клиентская отправка через
   Gmail REST с **личным** OAuth-токеном сотрудника (`sendEmailViaGmail`, `M:59647`) — ровно
   то, от чего Тони хочет уйти; (в) напоминания через Stripe; (г) `mailto:`-черновики.
4. Предлагаемая архитектура: **один общий ящик компании** (например `leasing@al-en.com`),
   к которому Cloud Functions ходят через отдельный service-account с DWD (паттерн уже
   отработан в проекте); письма и треды — в новых коллекциях `workspaces/default/mail*`,
   вложения и сырой HTML — в Storage; клиент читает **только через CF-двери** (как в PP2),
   `firestore.rules` закрывают коллекции для прямого доступа; отправка — CF `mailSend` с
   outbox, идемпотентностью, rate-limit, аудитом и dead-letter (инвариант § 0.2.5).
5. Привязка письма к юниту: автоматически по точному адресу (`u.email`, `u.emailCc`,
   `u.prospects[].email`, `u.tenantHistory[].email`) → бейдж «Rule»; вручную → «linked by …»;
   остальные письма треда — «via thread». Ключ юнита всегда `buildingId__unitId` (Entry 88).
6. Права: по умолчанию admin — всё; manager — чтение и отправка в своих зданиях
   (`members.buildings`); mapeditor/teamviewer/viewer — ничего. Поверх — явные гранты
   `mailAccess/{uid}` (здания, направления, отправка, видимость непривязанных писем),
   проверяемые в каждой CF и отражённые в `firestore.rules`.
7. Три фазы: **Phase 0 — чтение** (ingest + оверлей только для чтения), **Phase 1 — отправка**
   (compose / reply / reply all / forward), **Phase 2 — права и настройки** (матрица доступа,
   Inbox непривязанных писем, «Hide for me», бейджи непрочитанных, метки Gmail по желанию).
8. Каждая фаза = отдельный деплой functions + правка rules с явного одобрения Тони; хостинг
   (клиент) выезжает авто-деплоем как обычно; у каждой фазы — тесты, критерии готовности и откат.
9. Открытых вопросов девять (§ 9); главные — общий ящик или личные, адрес/домен ящика,
   глубина архива и новая зависимость `sanitize-html`.

---

## 1. Что просил Тони (формулировка задачи)

«Я хочу иметь возможность отправлять письма из карточки Unit. Добавь иконку конверта между
кнопкой «⋯» и зелёной иконкой/чипом в шапке карточки юнита. Когда её нажимаешь — открывается
окно поверх текущей страницы практически на весь экран, и там всё должно выглядеть как в Gmail:
вся переписка по этому юниту/арендатору, можно читать и писать письма. У нас уже есть похожий
раздел в PropertyPulse 2.0 (вкладка задачи «Emails») — там письма отправляются из задачи,
а здесь нужно из Unit. Настройки нужно будет вынести: какой пользователь к каким письмам имеет
доступ. Я хочу, чтобы сотрудники вели всю переписку отсюда, а не через свой личный почтовый ящик.»

Правило Тони: «перед началом исполнения пиши мне планы». Этот документ — план.

---

## 2. Что уже есть в SuitesForAll (факты с `file:line`)

### 2.1 Карточка юнита — точка вставки иконки

- Правая панель `<aside class="sidebar">` `M:21061`, контейнер `#detail` `M:21286-21287`.
  Карточка целиком перерисовывается `renderDetail()` (`M:77846`, ~139 вызовов), поэтому
  состояние оверлея живёт вне DOM карточки (`_mailCtx`), как `_drawerCtx` (`M:148013`) и
  `_unitSvcCtx` (`M:126688`). Инвариант Entry 46: runtime-состояние не хранить на объекте юнита.
- Шапка — `_renderUnitV2Header(u, editOn)` `M:79291`, единственный вызов `M:78383`.
  Шаблон строки заголовка `M:79824-79857`: `h2.upv2-h-title` → статус-пилюля
  `.upv2-pill` (зелёная `upv2-pill-paid|occupied`, CSS `M:10208-10219`) → `secondaryPill` →
  `div.upv2-h-actions` (`margin-left:auto; display:flex; gap:6px`, CSS `M:10168`), внутри
  которого в режиме просмотра стоит `.upv2-menu-wrap` с кнопкой «⋯» `.upv2-menu-btn`
  (`M:79838-79849`; CSS `M:10350-10358`: 30×30, radius 8, рамка `var(--rd-border-strong)`).
- **Уточнение к скриншоту Тони:** «зелёный чип» — это статус-пилюля («Paid · Oct»,
  «Occupied»), а «N person capacity» — текст подзаголовка `.upv2-h-sub` (`subBits`
  `M:79453-79463`, вывод `M:79853`). Конверт встаёт внутри `.upv2-h-actions` **слева от «⋯»**,
  то есть визуально между пилюлей и «⋯» — ровно как просил Тони.
- Иконка уже есть в спрайте: `<symbol id="i-mail">` `M:18079`; хелпер `_rdIc('mail', 17)`
  (`M:79210` → `_svgIcon` `M:163944-163949`).
- Меню «⋯» (`menuItems` `M:79703-79821`, обработчики `toggleUnitMenu/closeUnitMenu`
  `M:80985-81008`) и view-mode контекстное меню правой кнопки (Entry 94,
  `_unitContextMenuView` `M:72360-72398`, пункт «Send invoice…» `M:72385`) — туда же добавится
  пункт «Emails…».
- Мёртвый, но готовый прецедент кнопки в шапке: `.upv2-h-contact-btn` `M:10844-10859` +
  `toggleContactPopover` `M:80693-80730` (попап `mailto:`/`tel:`; сейчас не выводится).

### 2.2 Контактные поля юнита (где искать адреса)

| Поле | Использований | Роль |
|---|---|---|
| `u.email` | 180 | основной адрес арендатора (форма `#fEmail` `M:82237`) |
| `u.emailCc` | 22 | второй контакт (`#fEmailCc` `M:82246`); `u.stripeBillingContact` `'primary'|'cc'` `M:82218` |
| `u.tenantEmail` | 8 | legacy-алиас, читается как `(u.tenantEmail || u.email)` (`M:67329`, `M:130479`) |
| `u.tenant`, `u.company` | 299 / 242 | имя арендатора; присутствие арендатора = `(u.tenant||u.company)` (§ 0.2.2) |
| `u.prospects[]` | 38 | `{id, name, email, phone, company, stage, …}` `M:114998-115015`; чипы `mailto:` `M:115241` |
| `u.tenantHistory[]` | — | снимки прошлых арендаторов (move-out `M:101121-101123` очищает `u.email`) |
| `u.outreach[]` | 49 вызовов `recordOutreach` | журнал действий (`M:147545-147597`), cap 100, зеркало в `audit` |

Полей `u.contacts`, `u.contactEmail`, `u.billingEmail` **не существует** (0 вхождений).
Отдельных коллекций `tenants/contacts` нет — личность арендатора живёт на юните (DECISIONS § 1).
Групповые лизы: финансы и контакты несёт головной юнит (`groupRole:'primary'`), подкомнаты —
`u.parentId`; письма по юниту-участнику группы и по подкомнате показываем от головного юнита.

### 2.3 Существующие email-пути и почему их недостаточно

**(а) `functions/gmail-ingest.js` — метаданные писем сотрудников (Pulse).**
Архитектура (`G:1-42`): per-employee `gmail.users.watch(SENT+INBOX)` → Pub/Sub topic
`gmail-push` → `onGmailPush` (`G:124`) → `history.list` → `messages.get(format=metadata)` →
транзакция на legacy-документ `workspaces/default/data/state`: совпал адрес → `u.outreach[]`
(`type:'email'|'received'|'reply'`, `autoLogged:true`), не совпал → `state.gmailActivity[]`
(cap 50, `G:68`). Авторизация: service-account `pulse-gmail-watcher@suitesforall.iam.gserviceaccount.com`
с domain-wide delegation на `@al-en.com`, scope только `gmail.metadata` (`G:105`), секрет
`GMAIL_SA_KEY` (`G:52`), env `GMAIL_PUBSUB_TOPIC` (`G:53`); тот же ключ использует
`calendar-ingest.js`. Watch перерегистрирует `bootstrapGmailWatch` ежедневно 04:00 UTC (`G:542`)
для членов с ролью admin/manager (`G:577`); root-admin callables `adminBootstrapGmailWatch`,
`adminStopGmailWatch`. Тело письма и вложения **не читаются** — это явное privacy-обещание
(GMAIL_INGEST_SETUP.md § «Что мы НЕ читаем», pulse/CLAUDE_CODE_INSTRUCTIONS.md § 11
«Never store body»).

Два дефекта, важные для плана (исправлять их — отдельное решение, § 9 Q8):
- `_persistEmailRecords` (`G:389-502`) строит индекс по `doc.state.buildings` (`G:504-523`),
  а под включённым `syncBuildingsStrip` монолит несёт `buildings: []` (Entry 45, подтверждено
  Entry 83 от 2026-10-01) → совпадений 0, все письма уходят в `gmailActivity`.
- индекс ищет `u.tenantEmail`, `u.contactEmail`, `u.contacts[].email` (`G:510-514`), а основной
  адрес живёт в `u.email` (§ 2.2).
Вывод: как источник «переписки по юниту» этот модуль не годится (нет тел, нет вложений, не
привязывает). Переиспользуем из него только паттерн авторизации (`_gmailClientFor` `G:100-109`),
lifecycle watch/Pub/Sub, разбор заголовков (`_extractMetadata` `G:282-362`, `_parseEmailList`,
`_normalizeMessageId`) и идею идемпотентности по Gmail `messageId`.

**(б) Клиентская отправка через Gmail REST с личным токеном** — `connectGmail()` `M:59519-59609`
(Firebase `GoogleAuthProvider.addScope('gmail.send')`, access-token в localStorage
`sfa_gmail_token_v1` на 55 мин, `state.settings.gmail[uid]`), `sendEmailViaGmail({to, cc,
subject, htmlBody, textBody, replyTo})` `M:59647-59726` → `POST gmail.googleapis.com/gmail/v1/users/me/messages/send`.
Вызовы: тестовое письмо `M:59819`, уведомление о расторжении `_moDispatchNoticeEmail`
`M:103913-103950` (пишет только в `recoveryCases[].events`). Нет BCC, вложений, тредов,
rate-limit, идемпотентности, роли проверяются только в онбординге (`M:59884`). Письмо уходит
**от личного ящика сотрудника** — противоречит цели Тони и Entry 20 («bearer-токены не хранить
на клиенте»). В Phase 1 этот путь переводится на `mailSend` (§ 9 Q9).

**(в) Напоминания через Stripe** — `stripeResendInvoice` (`F:2088-2139`, `requireEditor`,
`stripe.invoices.sendInvoice`); клиент `mpmSendReminder` `M:160202`, `agingBulkSendReminders`
`M:150281-150343` (+ `recordOutreach(u,'reminder',…)`). Письмо шлёт Stripe — не трогаем.

**(г) `mailto:`-черновики** — `payEmailTenant`, `_leaseDraftEmail`, «Open in email app» (Entry 92).
Остаются как есть; после Phase 1 можно добавить рядом кнопку «Send from SuitesForAll».

### 2.4 Инфраструктура, которую переиспользуем

| Что | Где | Как используем |
|---|---|---|
| Модалки `.stripe-modal` + `.stripe-modal-card` | CSS `M:5894-5938`, `_closeOtherModals` `M:102321`, реестр крестиков `closeMap` `M:163776` | оверлей `#unitMailModal` по образцу `#unitInvoiceReportModal` (`M:25324`, CSS `M:11124-11140`: `max-width:1080px; max-height:90vh; padding:0`, sticky-шапка) |
| Экранирование | `esc()` `M:78925-78933`, `_safeHttpUrl` `M:78941-78948` | каждая строка письма на рендере |
| Sandbox-iframe | `frame.setAttribute('sandbox','')` + санитайзер `M:129076-129081`; srcdoc `M:155793` | тело письма только в `<iframe sandbox>` |
| Роли на клиенте | `currentRole()` `M:38033`, `canEdit()` `M:38081`, `canSeeFinance()` `M:38095`, `canAccessBuilding(bid)` `M:38138`, `canSendLeases()` `M:112083`, `ROOT_ADMINS` `M:38028`, `applyRoleVisibility()` body-классы | новые `canUseMail()` / `canSendMail()` по 7-шаговой процедуре AUTH_AND_PERMISSIONS_RULES |
| Контекст выбора | `currentBuilding()` `M:28005`, `currentFloor()` `M:28014`, `selectedIds` `M:28061`; `bId/fId/uId` в шапке `M:79304-79306` | `openUnitMail(bId, fId, uId)` |
| Вызов CF | `stripeCallable(name)` `M:30283-30345` (traceId, ≤3 ретрая на transient) | все `mail*` callables |
| Серверный гейт | `requireEditor(auth)` `F:133-150`; строже — `_dsAssertCanSendLeases` `F:11130-11146` (admin/manager, отвергает `archived`) | `_mailAssertCanRead / _mailAssertCanSend` по образцу DocuSign |
| Аудит | `recordAudit` `F:7204-7244` → `audit/{id}`; клиент `recordAuditClient` `M:30693` с localStorage-outbox `M:30526-30590`; `_dsAudit` → `docusign_log` | `audit` с `action:'mail.*'` |
| Rate-limit | `_rateLimitMoneyCallable(ns, unitId, perWsHour, perUnitDay)` `F:574-612` → `rateLimits/*` (Entry 76) | `mailSend` fail-closed ДО вызова Gmail |
| Dead-letter | `_webhookDeadLetter(key, payload)` `F:4112-4123` → `webhookDeadLetter/{key}`, `_ttl` 90 д (Entries 75/84) | `mailDeadLetter/{key}` тем же кодом |
| Strip-aware запись в юнит | `mutateWorkspaceState` `F:310`, `_loadBuildingsForCF`, `findUnit` `F:370` (Entry 45); серверный `u.outreach.push` как в `dsSendEnvelope` `F:11419-11435` | запись `u.outreach[]` после успешной отправки |
| Идемпотентность | `idempotencyKey` `/^[A-Za-z0-9_-]{8,128}$/` `F:1024-1029`; `webhookEvents/{eventId}` `F:3453` | `mailOutbox/{idempotencyKey}` |
| Секреты/конфиг | `defineSecret` + `secrets:[…]` (Entry 20); несекретный конфиг в `integrations/{name}` (rules `:321`, member read / admin write) | `MAIL_SA_KEY`; `integrations/mail` |
| Тесты CF | `tests/sign-link-cf.test.cjs` (`Module._load`-стабы firebase-admin/functions/params, in-memory Firestore, fake `fetch`) | `tests/mail-*.test.cjs` |
| Прототип UX в проекте | Pulse `EmailsTab` `pulse/employee-detail.jsx:849` (чипы Sent/Received/Replies/All, таблица, «Suite N» по `tenantEmailIndex` `pulse/data-shim.jsx:1121-1140`) | подтверждает конвенции: фильтр направления, newest first |
| Лог активности юнита | `#activityLogModal` `M:25040+`, `_ALM_KINDS` (`email: ✉️`), tenant drawer «Outreach log» `M:148166-148173` | исходящие письма видны в Activity через `u.outreach[]` |

### 2.5 Чего в SFA нет (и что придётся построить)

Нет чтения тел писем и вложений, нет серверной отправки (нет nodemailer/sendgrid/smtp —
0 вхождений), нет коллекций для писем, нет rules для них, нет HTML-санитайзера на сервере
(клиентский `_uploadTplSanitizeHtml` `M:126134` оставляет `<style>` и не рассчитан на чужую
почту), нет CSP в `firebase.json`, нет настройки «кто какие письма видит», нет TZ-хелпера на
клиенте (даты «сегодня»/выписки — `America/New_York`, `M:153487-153496`; сервер
`settings.timeZone` по умолчанию `'UTC'` `F:5072`).

---

## 3. Что взять из PropertyPulse 2.0 и чего нельзя

### 3.1 Где код образца

- Каталога `KR/` в репозитории нет: приложение в корне (`app/`, `components/`, `lib/`, `db/`).
- Ветка `main` (`4045b1cbfd`) содержит сканер ящиков, Gmail-клиент, отправку и блок
  «In the mail» задачи, но **вкладка Emails в том виде, как на скриншотах** (строка счётчиков,
  бейджи «Rule»/«via thread», «Gmail label set», «Hide for me», «Discuss this email»,
  Reply/Reply all/Forward) живёт в рабочих ветках агентов:
  `PP:.claude/worktrees/agent-aadd623a6b8fc6506` (`08583bbace`, 2026-10-23) и
  `/Users/diskc/Projects/wt.noindex/pp-private-sections-1024`
  (`security/tony-private-mail-docs-20261024`, `fed2cdd301`, 2026-10-24, несёт прод-коммит `n912`).
- Спецификация «вкладка читается как Gmail» — `qa-artifacts/n872/README.md` в этих ветках;
  там же цитата Тони от 08.10.2026: «в почте повторить полностью копировать дизайн Gmail так
  как сотрудники привыкли там работать … такие же шрифты такие же размеры все точно также».

### 3.2 Архитектура PP2 в одном абзаце

Next.js 16 + Postgres (Supabase) + Drizzle; **все ящики домена** (57) читаются service-account'ом
с domain-wide delegation (`lib/mailbox/gmail-client.ts:156-210`: JWT RS256 на `node:crypto`,
`sub` = ящик, токен минтится на каждый вызов и не хранится; без `googleapis`), scopes
`gmail.readonly` + `gmail.send` (+ `gmail.modify` для меток/корзины/звезды в worktree);
опрос по Vercel-cron каждые 30 мин (`messages.list` двумя проходами, опционально
`history.list` c курсором; батчи по 50; `format=full`, тело ≤ 20 000 символов); одна строка на
письмо на ящик (`core.mail_messages`, unique `(org, mailbox_email, message_id)`); сырой HTML
лениво при первом открытии (`core.mail_message_html`) и **санитизация при каждом чтении**
(`lib/mailbox/html-sanitize.ts`, parse5, «REBUILD, NEVER CLEAN»); состояние рядом с архивом:
метки, корзина/звезда (org-wide), прочитанность (per user), «Hide for me» (per viewer);
привязка к задаче считается на чтении шестью «ногами» (`lib/tasks/mail-correlation.ts:12-45`:
тред задачи, файл задачи, номер счёта, **точный адрес** контрагента, адрес исполнителя,
остальные письма треда) + явные ссылки «целый тред» / «одно письмо»; отправка —
`POST users/me/messages/send {raw, threadId}` из **ящика нажавшего**, MIME вручную
(`lib/mailbox/mime.ts`), `In-Reply-To`/`References` из сохранённого письма, Message-ID читается
назад и письмо записывается как `source:'sent'`; гейты: org-переключатель → человеческий
«send gesture» (sha256, однократный) → SA настроен; видимость ящиков: owner/admin видят все,
остальные — свои + выданные гранты (`lib/mailbox/visibility.ts`), на задаче строже
(`mayReadTaskMail`), на любой отказ — один 404.

### 3.3 Что переносится (чистые модули → портируем в CF/клиент)

| Модуль PP2 | Строк | Куда в SFA | Что берём |
|---|---|---|---|
| `lib/mailbox/html-sanitize.ts` | 484 | `functions/mail-sanitize.js` | политику allowlist: теги, стили deny-by-default, `href` только `https:/mailto:/tel:`, `rel="noopener noreferrer nofollow" target="_blank"`, блокировка `<img src=https>` → `data-blocked-src`, `cid:` → ссылка на вложение, cap 2 МБ, идемпотентность; реализация на `sanitize-html` (§ 6) |
| `lib/mailbox/mime.ts` + `send-mail-core.ts` | 346 + 499 | `functions/mail-send.js` | сборку MIME (QP, RFC 2047 заголовки, `multipart/alternative`/`mixed`), цепочку `In-Reply-To`/`References` (≤ 20, корень сохраняется), `Re:`/`Fwd:` без дублей, Forward = новый тред, read-back Message-ID |
| `lib/tasks/mail-correlation.ts` (нога d, f) | — | `functions/mail-link.js` | «точный адрес, никогда по домену», собственные ящики исключаются из ключей, «same_thread» наследование |
| `lib/tasks/mail-added-by.ts`, `mail-threads/emails-line.ts`, `mail-tally.ts` | 463/203/170 | клиент, блок `unit-mail` | семантику бейджей (своя ссылка письма → ссылка треда «via thread» → «Rule: <поле>: <адрес>») и строки счётчиков |
| `qa-artifacts/n872/README.md` + `workspace/gmail/gmail.css`, `gmail-format.ts` | — | CSS/JS оверлея | типографику и размеры Gmail (§ 5.2), форматы дат, свёртку «•••», карточки вложений 180×120 |
| `lib/mailbox/visibility.ts` (`decideMailboxVisibility`) | 506 | `functions/mail-access.js` | идею «один предикат видимости для всех чтений» и fail-closed |
| `mail_message_reads.ts` `unreadFromParts` | — | Phase 2 | чистое правило «непрочитано» с эпохой (старые письма не считаются непрочитанными) |

### 3.4 Что НЕ переносится и чем заменяем

| PP2 | Почему нельзя | В SFA |
|---|---|---|
| React/Next.js компоненты, Tailwind, `next/font` | монолит на vanilla JS без сборки; PRINCIPLES: без новых фреймворков/шрифтов | шаблонные строки + `esc()`, один новый `<script>`-блок и `<style>`-блок, системный стек `Roboto, "Segoe UI", Arial` без загрузки веб-шрифтов |
| Postgres/Drizzle/RLS, `pg_advisory_xact_lock`, уникальные индексы | Firestore | детерминированные id документов (`{mailboxId}__{gmailMessageId}`), транзакции, `onConflict` = `set(..., {merge:true})` по тем же id |
| Vercel cron + `CRON_SECRET` | Firebase | `onSchedule` + Pub/Sub push (уже есть `gmail-push`) |
| 57 ящиков всего домена | цель Тони — переписка от программы, не от личных ящиков; privacy-обещание ingest | один общий ящик (§ 4.2), многоящичность заложена в модель (`mailboxId`) |
| «Rule-matches as suggestions» (№931) — письма по правилу лишь предлагаются к задаче | на юните переписка арендатора — это и есть содержание; предложения без привязки сломают ожидание «вся переписка здесь» | авто-привязка по адресу с бейджем «Rule» и кнопкой «Not this unit» (reject) |
| «included topics» | в проде PP2 фильтр мёртв (поле `topic` никто не пишет) | фильтр «All contacts / Tenant / CC / Prospects / Former tenants» |
| «Discuss this email» → комментарий задачи | у юнита нет комментариев | заметка в журнал юнита `recordOutreach(u,'note', 'About «subject» from Sender: …')` → вкладка Activity |
| Таблицы `mail_triage`, `ai_reply_drafts`, саммари, авто-правила | ИИ-слой вне задачи | не делаем; письма помечены как untrusted для будущих агентов (AGENT_API_PLAN) |
| Отправка «из ящика нажавшего» | см. § 4.2 | отправка из общего ящика с именем сотрудника в display-name, `sentByUid` в документе |

### 3.5 Соответствие элементов экрана PP2 → SFA

| На скриншоте PP2 | Смысл в PP2 | В SFA |
|---|---|---|
| «Email correspondence · direction shown on every email» | подпись панели | «Unit correspondence · direction shown on every email» (Incoming/Outgoing в шапке письма и стрелка в строке) |
| «All included topics» | мёртвый фильтр | «All contacts» (см. § 3.4) |
| «All directions» | Incoming / Outgoing | то же |
| «Newest first · Central time» | сортировка фиксирована; TZ организации | «Newest first · Eastern time» из `integrations/mail.timeZone` (по умолчанию `America/New_York`) |
| «6 threads · 1 letter attached to this task · 31 letters · 23 shown · 6 threads found in the mail · showing 5» | явные привязки · найдено правилами · показано | «N threads · M linked by hand · L letters · showing S» |
| строка треда: отправители по именам, «6», Inbox, тема, чипы PDF, «+2», «Gmail label set», «Rule», «via thread», «Hide for me» | см. § 4.4, § 5.3 | те же элементы; «Gmail label set» — только Phase 2 (опция) |
| «Reply / Reply all / Forward / Discuss this email» | ответ из задачи | то же из юнита (Phase 1) |

---

## 4. Целевая архитектура

### 4.1 Потоки

```
Gmail (общий ящик leasing@…)
   │ users.watch(INBOX,SENT) → Pub/Sub topic `sfa-mail-push`      (≈10 с)
   ▼
CF mailOnPush ──┐
CF mailSyncScheduled (каждые 10 мин: догон по history.list,      ┼─► normalize → Firestore mailThreads / mailMessages
   продление watch, 404-expired → ограниченный пересчёт)  ──────┘    + Storage raw.html / вложения
                                                                      + unitKeys по точным адресам (strip-aware индекс)
Клиент (оверлей) ──► CF mailListThreads / mailGetThread / mailGetAttachmentUrl / mailLinkThread
                 ──► CF mailSend (Phase 1): outbox → rate-limit → MIME → messages.send → read-back → mailMessages(outbound)
                                               → u.outreach[] (mutateWorkspaceState) → audit → ответ клиенту
Firestore rules: mail* закрыты для прямого чтения/записи; mailAccess/{uid} — self/admin read; mailUserState — own uid
```

### 4.2 Ящик и авторизация — три варианта, рекомендация A

**A (рекомендую). Один общий ящик компании.** Отдельный пользователь Google Workspace, например
`leasing@al-en.com` (адрес — Q2), с лицензией. Доступ CF — через **новый** service-account
`sfa-mail-sa@suitesforall.iam.gserviceaccount.com` с domain-wide delegation и минимальным
набором scopes: Phase 0 `https://www.googleapis.com/auth/gmail.readonly`; Phase 1 плюс
`…/gmail.send`; `…/gmail.modify` — только если Тони захочет метки/прочитанность в самом Gmail
(Q6). Ключ SA — секрет `MAIL_SA_KEY` (как `GMAIL_SA_KEY`, Шаг 6 GMAIL_INGEST_SETUP.md).
Код имперсонирует только адреса из `integrations/mail.mailboxes[]` (allowlist); никакой адрес
не приходит из запроса клиента (паттерн PP2 `task-mail-access.ts:335-339`).
Почему отдельный SA, а не добавить scopes к `pulse-gmail-watcher`: тот ключ связан обещанием
«только метаданные» для личных ящиков сотрудников; расширение его scopes молча расширяет,
что можно сделать с любым ящиком домена. Два client-ID с разными scopes видны и аудируемы в
Workspace Admin → API controls. Честное предупреждение: DWD по природе домен-wide — SA с
`gmail.readonly` технически может читать любой ящик домена; ограничение одним ящиком живёт
в коде и конфиге, ключ — только в Secret Manager, вызовы — только из CF.
Плюсы A: единый архив, не зависящий от текучки; арендатор пишет на один стабильный адрес;
любой допущенный сотрудник продолжает чужую переписку; простая модель прав (по зданиям);
ровно то, что сказал Тони («не через свой личный ящик»). Минус: письма, которые арендаторы
по привычке шлют на личные адреса сотрудников, в архив не попадут (их по-прежнему считает
метаданными `gmail-ingest.js` для Pulse).

**A2. Тот же общий ящик, но 3-legged OAuth** (Тони один раз входит как `leasing@`, refresh-token
кладём в Secret Manager `MAIL_OAUTH_REFRESH_TOKEN`). Действительно ограничивает доступ одним
ящиком, не требует DWD. Минусы: нужен OAuth consent screen (тип Internal — без верификации
Google); refresh-token отзывается при смене пароля/инцидентах безопасности → ручной повторный
вход; в проекте нет прецедента. Держим как запасной вариант.

**B. Как в PP2: личные ящики сотрудников** (читать и отправлять от имени каждого admin/manager
через DWD, scopes `gmail.readonly` + `gmail.send`). Плюсы: 1:1 с образцом; ответы арендаторов
приходят туда, куда они привыкли. Минусы: чтение тел личной рабочей почты всех сотрудников —
отмена задокументированного privacy-обещания; история уходит вместе с сотрудником; письмо
всё равно уходит от личного адреса; модель прав сложнее (владелец ящика + гранты, как в PP2
`visibility.ts`). Модель данных ниже многоящичная (`mailboxId`), так что B или гибрид
(A + чтение личных ящиков только для тредов, привязанных к юниту) можно добавить позже без
миграции.

### 4.3 Модель данных (Firestore v2-стиль, все документы пишут только CF)

Ключ юнита везде `unitKey = buildingId + '__' + unitId` (как `payments/{buildingId__unitId__ym}`,
Entry 88: номера сьютов повторяются между зданиями).

```
workspaces/default/integrations/mail                      (существующее правило: member read / admin write; НЕсекретный конфиг)
  { mailboxes: [ { id:'leasing', address:'leasing@al-en.com', displayName:'SuitesForAll Leasing', enabled:true } ],
    timeZone:'America/New_York', sendEnabled:false, gmailLabelsEnabled:false,
    limits:{ perUserPerDay:100, perWorkspacePerHour:120, perUnitPerDay:20, maxRecipients:20, maxAttachmentBytes:26214400 },
    backfillSince:'2026-01-01', updatedBy, updatedAt }

workspaces/default/mailboxes/{mailboxId}                   (CF-only; состояние синка)
  { address, lastHistoryId, watchExpiration, watchRenewedAt, lastSyncAt, lastError:{at,code,message}|null,
    backfill:{ pageToken|null, done:bool, imported:n }, syncVersion:n (растёт при каждом изменении — сигнал клиенту), stats:{threads,messages} }

workspaces/default/mailThreads/{mailboxId}__{gmailThreadId}  (CF-only)
  { mailboxId, gmailThreadId, subject, subjectNorm (без Re:/Fwd:, lower), snippet (≤200),
    participants:[lower-email…] (без собственных ящиков), participantNames:{ 'email':'Name' },
    unitKeys:[ 'B__204' … ] (auto ∪ manual − rejected), buildingIds:[…],
    links:[ { unitKey, buildingId, via:'address'|'manual'|'history', value:'tenant@x.com', field:'email'|'emailCc'|'prospect'|'tenantHistory', by, at } ],
    rejected:[ { unitKey, by, at, reason } ],
    firstMessageAt, lastMessageAt, messageCount, hasAttachments, hasInbound, hasOutbound, lastDirection,
    isExternal:bool (писал кто-то вне домена), bounceCount, gmailLabelIds:[…], updatedAt }

workspaces/default/mailMessages/{mailboxId}__{gmailMessageId} (CF-only)
  { mailboxId, gmailMessageId, gmailThreadId, messageIdHeader, inReplyTo, references:[…] (≤50),
    direction:'inbound'|'outbound', from:{name,email}, to:[{name,email}], cc:[…], bcc:[…] (только outbound), replyTo,
    subject, date (ISO из Date-заголовка), internalDate (ms), snippet,
    bodyText (≤100 КБ, plain или HTML→text), bodyHtmlPath ('mail/default/{mailboxId}/{gmailMessageId}/raw.html')|null, bodyHtmlBytes,
    attachments:[ { index, filename, mime, size, storagePath, gmailAttachmentId, contentId|null, inline:bool } ],
    labelIds:[…], unitKeys:[…] (денормализация из треда), buildingIds:[…],
    isBounce:bool, sentByUid|null, sentByEmail|null, sentVia:'app'|'gmail'|null, outboxId|null,
    source:'push'|'poll'|'backfill'|'send', createdAt }

workspaces/default/mailOutbox/{idempotencyKey}            (CF-only; Phase 1)
  { status:'queued'|'sending'|'sent'|'failed'|'dead', mailboxId, unitKey, buildingId, mode:'new'|'reply'|'replyAll'|'forward',
    inReplyToMessageDocId|null, to, cc, bcc, subject, bodyText, bodyHtml, attachments:[…], byUid, byEmail,
    attempts, lastError, gmailMessageId|null, gmailThreadId|null, createdAt, sentAt|null }

workspaces/default/mailDeadLetter/{key}                   (CF-only; как webhookDeadLetter, _ttl 90 д)
workspaces/default/mailAccess/{uid}                       (CF-written через mailSetAccess; rules: read self/admin, write false; Phase 2)
  { read:'all'|'buildings'|'none', buildings:[bid…], directions:['inbound','outbound'], send:bool, seeUnlinked:bool, updatedBy, updatedAt }
workspaces/default/mailUserState/{uid}__{mailboxId}__{gmailThreadId}  (rules: read/write только свой uid; Phase 2)
  { hiddenAt|null, readAt|null, lastSeenMessageCount }
audit/{id}  — существующая коллекция, action: 'mail.send' | 'mail.send.failed' | 'mail.link' | 'mail.unlink' | 'mail.reject' | 'mail.hide' | 'mail.access.set' | 'mail.sync.error'
members/{uid}.preferences.mailSignature  — подпись сотрудника (поле `preferences` уже self-writable по rules :147-152; schema state.* не трогаем)
```

Storage (bucket `suitesforall.firebasestorage.app`): `mail/default/{mailboxId}/{gmailMessageId}/raw.html`
и `…/att/{index}_{safeFilename}`. Путь **вне** `/workspaces/{wid}/**`, поэтому ни одно
существующее правило `storage.rules` его не открывает — доступ только через подписанные URL
(V4, 10 минут) из `mailGetAttachmentUrl`; `storage.rules` в Phase 0 не меняем. Для
`getSignedUrl` runtime-SA функций нужна роль `Service Account Token Creator` (одноразовый шаг
Тони в IAM; запасной путь — отдача файла через `onRequest` с проверкой ID-токена).

Индексы (`firestore.indexes.json`, деплоит Тони):
- `mailThreads`: `unitKeys` (ARRAY_CONTAINS) + `lastMessageAt` (DESC) — список по юниту;
- `mailThreads`: `mailboxId` (ASC) + `lastMessageAt` (DESC) — Inbox/все треды (Phase 2);
- `mailMessages`: `gmailThreadId` (ASC) + `internalDate` (ASC) — письма треда;
- `mailOutbox`: `status` + `createdAt` (Phase 1, для dead-letter-обзора).

Размеры: документ Firestore ≤ 1 МиБ → `bodyText` ≤ 100 КБ, HTML всегда в Storage; письмо в
Gmail ≤ 25 МБ вложений — копируем целиком; средний ящик лизинг-офиса — единицы ГБ в год.

### 4.4 Привязка письма к юниту

1. **Auto (бейдж «Rule»)**: при ingest CF строит индекс «адрес → unitKey» из v2-коллекции
   `buildings/*` через `_loadBuildingsForCF` (strip-aware, Entry 45), поля `u.email`,
   `u.emailCc`, `u.tenantEmail` (legacy), `u.prospects[].email` (`field:'prospect'`),
   `u.tenantHistory[].email` (`field:'tenantHistory'`, бейдж «former tenant»). Сравнение
   **только по точному адресу в нижнем регистре, никогда по домену** (PP2 `mail-correlation.ts:37-40`);
   собственные ящики из участников исключаются. Групповые лизы: адрес на головном юните →
   `unitKey` головы; клиент при открытии с юнита-участника/подкомнаты запрашивает ключ головы
   (`_mailUnitKeyFor(u)` → `groupRole`/`parentId`, как финансовые поверхности, § 0.2.2).
2. **Via thread**: все письма треда наследуют `unitKeys` треда (PP2 нога `same_thread`).
3. **Manual**: `mailLinkThread({threadDocId, unitKey, action:'link'|'unlink'|'reject'})` —
   бейдж «linked by Kristen», «Not this unit» убирает ключ и кладёт его в `rejected[]`,
   чтобы ночной перерасчёт не вернул его. Аудит `mail.link/unlink/reject`.
4. **Пересчёт**: `mailRelinkScheduled` (ночью, треды с `lastMessageAt > now−180д`) и
   `mailRelinkUnit({unitKey})` после изменения `u.email/u.emailCc` в `saveDetail` (Phase 2);
   до Phase 2 — кнопка «Find more emails» в оверлее (admin), вызывающая тот же CF.
5. Непривязанные треды (`unitKeys = []`) видны в Inbox-виде (Phase 2) admin'ам и тем, у кого
   `seeUnlinked:true`, с кнопкой «Link to unit…» (поиск по зданию/сьюту/арендатору).

### 4.5 Права доступа

**Роли по умолчанию** (без документа `mailAccess/{uid}`):

| Роль | Чтение | Отправка | Непривязанные (Inbox) |
|---|---|---|---|
| admin (и `ROOT_ADMINS`) | все здания, оба направления | да | да |
| manager | здания из `members.buildings` (`[]` = все), оба направления | да | нет |
| mapeditor, teamviewer, viewer | нет | нет | нет |

**Гранты `mailAccess/{uid}`** (Phase 2, Settings → Mail → Access, только admin, CF `mailSetAccess`):
`read: 'all'|'buildings'|'none'`, `buildings:[…]`, `directions:['inbound','outbound']`
(например teamviewer видит только исходящие), `send:true|false`, `seeUnlinked`. Грант
переопределяет дефолт роли в обе стороны (можно и сузить manager'а, и дать viewer'у чтение
одного здания). Архивированный член (`archived:true`) — ничего, как в `_dsAssertCanSendLeases`.

**Сервер**: `_mailAccessFor(auth)` в `functions/mail-access.js` читает `members/{uid}` +
`mailAccess/{uid}` и возвращает `{ canRead(buildingId, direction), canSend(buildingId), seeUnlinked, uid, email, role }`;
каждая `mail*` CF начинает с него; любой отказ — `HttpsError('permission-denied')` без деталей
(один ответ на «не твоё / не существует», Entry 92). Списки фильтруются по зданиям в CF,
письма треда отдаются только если тред допущен.

**`firestore.rules` (зеркало, в том же коммите, что и CF):**
```
match /mailboxes/{id}      { allow read, write: if false; }   // CF-only
match /mailThreads/{id}    { allow read, write: if false; }
match /mailMessages/{id}   { allow read, write: if false; }
match /mailOutbox/{id}     { allow read, write: if false; }
match /mailDeadLetter/{id} { allow read, write: if false; }
match /mailAccess/{uid}    { allow read: if isAdmin(wid) || request.auth.uid == uid; allow write: if false; }
match /mailUserState/{id}  { allow read, write: if isMember(wid) && id.matches('^' + request.auth.uid + '__.*'); }
```
Явные `false`-блоки документируют намерение (сейчас коллекции закрыты лишь отсутствием match).
`integrations/mail` читается всеми членами (адрес ящика и лимиты — не секрет).

**Клиент** (7 шагов AUTH_AND_PERMISSIONS_RULES «Changing the role matrix»): хелперы
`canUseMail()` / `canSendMail()` на `currentRole()` + закэшированный `mailAccess/{uid}`
(читается при входе рядом с `bootstrapMemberOnSignIn` `M:38670`); конверт и пункты меню
гейтятся в JS (`if (!canUseMail()) return;` в `openUnitMail`) и CSS-классом `body.no-mail`
из `applyRoleVisibility()`; View-As (Entry 19) меняет только видимость, CF всегда проверяет
реального пользователя. Это «изменение role-helper'ов» — требует одобрения Тони (§ 2).

### 4.6 Cloud Functions (новые файлы `functions/mail-*.js`, подключение из `functions/index.js`)

| CF | Триггер | Фаза | Назначение |
|---|---|---|---|
| `mailOnPush` | `onMessagePublished({topic:'sfa-mail-push', secrets:[MAIL_SA_KEY], timeoutSeconds:120, memory:'512MiB'})` | 0 | payload `{emailAddress, historyId}` → если адрес ∈ allowlist → `_mailSyncDelta(mailbox)` |
| `mailSyncScheduled` | `onSchedule('every 10 minutes')` | 0 | догон дельты по `history.list(startHistoryId)`; `404/400` → `_mailResync(mailbox, 'newer_than:7d')`; продление watch, если `watchExpiration − now < 2д`; ошибки → `mailboxes.lastError` + `mailDeadLetter` + Sentry |
| `mailBackfill` | `onCall` root-admin | 0 | первичный импорт с `backfillSince`, ≤ 200 писем за вызов, `pageToken` в `mailboxes.backfill`, повторный вызов продолжает |
| `mailListThreads` | `onCall` | 0 | `{unitKey?, view:'unit'|'inbox'|'all', direction?, contact?, cursor?, limit≤50}` → треды, допущенные `_mailAccessFor`; поиск — на клиенте по загруженным (как в PP2), серверный поиск по `participants`/`subjectNorm` — Phase 2 |
| `mailGetThread` | `onCall` | 0 | `{threadDocId, htmlFor:[messageDocId…]}` → письма треда (без HTML) + санитизированный HTML запрошенных писем (сырой из Storage → `sanitizeEmailHtml` при каждом чтении) |
| `mailGetAttachmentUrl` | `onCall` | 0 | `{messageDocId, index}` → подписанный URL на 10 мин, `Content-Disposition: attachment` для всего, кроме image/pdf |
| `mailLinkThread` | `onCall` | 0 | link / unlink / reject (§ 4.4) + аудит |
| `mailRelinkUnit` | `onCall` | 0 (кнопка) / 2 (автовызов) | пересчёт auto-ссылок для одного юнита |
| `mailSend` | `onCall`, `secrets:[MAIL_SA_KEY]` | 1 | § 4.7 |
| `mailSetAccess` | `onCall` admin | 2 | запись `mailAccess/{uid}` + аудит `mail.access.set` |
| `mailRelinkScheduled` | `onSchedule('0 5 * * *')` | 2 | ночной пересчёт ссылок |
| `mailAdminStatus` | `onCall` admin | 2 | здоровье ящика, dead-letters, счётчики — для Settings → Mail |

Регион `us-central1` и `maxInstances` наследуются от `setGlobalOptions` `F:31`. Подключение —
по образцу `F:11935-11942` (`const _mail = require('./mail-sync'); exports.mailOnPush = _mail.mailOnPush; …`),
~15 строк в `functions/index.js`. Gmail-клиент — `googleapis@^144` (уже в зависимостях),
`google.auth.JWT({ email, key, scopes, subject: mailboxAddress })` как `G:100-109`.
Квоты Gmail API: 250 единиц/с на пользователя (`messages.get` 5, `send` 100, `history.list` 2,
`watch` 100); дневной лимит отправки Workspace — 2 000 писем на ящик; watch живёт 7 дней;
история `history.list` доступна ≈ неделю, поэтому догон не реже чем раз в сутки обязателен.

### 4.7 Отправка (Phase 1) — порядок гейтов, ничего не умирает молча

1. Клиент: `mailSend({ idempotencyKey, mailboxId, unitKey, buildingId, floorId, unitId, mode,
   inReplyToMessageDocId, to[], cc[], bcc[], subject, bodyText, bodyHtml, attachments[] })`;
   `idempotencyKey` генерируется при открытии формы (как в `createStripeInvoice`),
   повтор клика с тем же ключом возвращает прежний результат.
2. CF: `_mailAccessFor` → `canSend(buildingId)` иначе `permission-denied`.
3. `integrations/mail.sendEnabled === true` (рубильник Тони), иначе `failed-precondition`
   с одной фразой «Sending is switched off».
4. Валидация: адреса RFC-формы (regexp + запрет CR/LF — как `_gmailEncodeHeader` `M:59731`),
   ≤ `limits.maxRecipients`, тема ≤ 998 байт, тело ≤ 1 МБ, вложения ≤ 25 МБ суммарно и из
   allowlist типов (pdf, png/jpg/gif/webp/heic, docx/xlsx, txt/csv); `unitId+buildingId+floorId`
   обязательны (Entry 22).
5. Rate-limit **fail-closed до внешнего вызова** (Entry 76): `_rateLimitMoneyCallable('mail',
   unitKey, limits.perWorkspacePerHour, limits.perUnitPerDay)` + дневной счётчик на `uid`.
6. Outbox: `mailOutbox/{idempotencyKey}` `status:'queued'` (durable запись до отправки);
   если документ уже `sent` → вернуть его результат (идемпотентность).
7. Сборка MIME (`functions/mail-send.js`, порт `mime.ts`): `From: "Kristen Meek · SuitesForAll" <leasing@…>`,
   `Reply-To: leasing@…`, подпись из `members/{uid}.preferences.mailSignature` (plain), для
   reply/replyAll — `In-Reply-To`/`References` из сохранённого письма и `threadId` Gmail;
   forward — новый тред, блок `---------- Forwarded message ---------` + вложения оригинала
   копируются из Storage по `(sourceMessageDocId, index)`; ответ на письмо с `isBounce` запрещён.
8. `users.messages.send({userId:'me', requestBody:{raw, threadId}})` → `messages.get(format=metadata)`
   для `Message-ID` → немедленная запись `mailMessages/{mailboxId}__{id}` (`direction:'outbound'`,
   `sentByUid/sentByEmail`, `source:'send'`) и обновление треда; push позже упрётся в тот же id
   (`set merge`) — дублей нет.
9. `mutateWorkspaceState` (strip-aware, Entry 45): `u.outreach.push({ kind:'email', ts, note:'Email sent to x@y — subject',
   by, byEmail, messageId, threadId, source:'mail' })` с cap 100 (как `F:11419-11435`) — журнал
   Activity и Pulse получают событие; плюс `audit` row `mail.send` (`sentBy`, Entries 10/30).
   Если запись состояния упала после успешной отправки — не бросать, `stateWriteOk:false` в
   аудит и `mailDeadLetter` (Entry 22).
10. Outbox `sent`; ответ клиенту `{ ok:true, messageDocId, threadDocId }`. Любая ошибка до шага 8 —
    outbox `failed` + `lastError`, клиенту одна фраза; ошибка Gmail с 5xx/429 — `attempts++`,
    outbox остаётся `queued`, повторная попытка из `mailSyncScheduled` (≤ 3), затем `dead` +
    `mailDeadLetter` + Sentry (§ 0.2.5 — событие не умирает молча).
11. Клиент показывает «Sent» **только** после ответа CF (§ 0.2.5: никаких «✓ sent» до
    durable-подтверждения); до вызова — 8-секундный Gmail-подобный «Undo» на клиенте
    (без серверной очереди).
12. Bounce: входящее от `mailer-daemon@`/`postmaster@` с `In-Reply-To` на наше письмо помечает
    наше письмо `deliveryFailed:true`, тред `bounceCount++`, красный чип «Delivery failed» в
    строке и аудит `mail.bounce` — лизинг-офису важно знать, что напоминание не дошло.

---

## 5. UI

### 5.1 Иконка конверта (Phase 0)

В `_renderUnitV2Header` внутри `.upv2-h-actions` (`M:79838-79849`) **перед** `.upv2-menu-wrap`
в режиме просмотра (в edit-режиме, как и «⋯», не показывается):

```html
${(typeof canUseMail === 'function' && canUseMail())
  ? `<button type="button" class="upv2-menu-btn upv2-mail-btn" onclick="event.stopPropagation(); openUnitMail('${bId}','${fId}','${uId}')" title="Emails" aria-label="Emails">${_rdIc('mail', 17)}<span class="upv2-mail-badge" id="unitMailBadge" hidden></span></button>`
  : ''}
```
Тот же размер/рамка, что у «⋯» (`.upv2-menu-btn`); бейдж непрочитанных — Phase 2. Показывается
для любого статуса юнита (vacant с prospect'ами тоже переписывается). Дополнительно пункт
«Emails…» в меню «⋯» (`menuItems`, после «Send invoice…») и в контекстном меню Entry 94
(`_unitMenuItem('mail', 'Emails…', …)` рядом с `M:72385`).

### 5.2 Оверлей `#unitMailModal` — каркас и типографика

- `<div class="stripe-modal" id="unitMailModal">` + `.stripe-modal-card.um-card`
  `{ width:min(1440px, 96vw); height:92vh; max-height:92vh; padding:0; display:flex; flex-direction:column }`
  (расширение прецедента `#unitInvoiceReportModal .stripe-modal-card` `M:11124-11140`);
  `z-index` модалки 10100 (CSS `M:5894`); регистрируется в `closeMap` (`M:163776`) как
  `unitMailModal: 'closeUnitMail'`; открытие вызывает `_closeOtherModals('unitMailModal')`;
  Escape закрывает (слушатель как `M:72325`); фокус возвращается на кнопку конверта.
- Шапка оверлея (sticky): «Suite 204 · 919 Milam» + арендатор/компания, адрес ящика
  (`leasing@al-en.com`), поиск «Search emails…», `<select>` All contacts / Tenant / CC /
  Prospects / Former tenants, `<select>` All directions / Incoming / Outgoing, подпись
  «Newest first · Eastern time», кнопка «New email» (Phase 1), «Link an email…» (Phase 2), «×».
- Две колонки: слева список тредов (360–420px, прокрутка), справа — разговор. На ширине
  < 900px — одна колонка (список → разговор с «← Back»).
- Типографика по n872 (копия Gmail): контейнер `.um` с токенами
  `--gm-font: Roboto, "Segoe UI", Arial, sans-serif; --gm-body: Arial, Helvetica, sans-serif;
  --gm-ink:#1f1f1f; --gm-grey:#5e5e5e; --gm-icon:#444746; --gm-line:#e3e3e3; --gm-divider:#dadce0;
  --gm-outline:#c4c7c5; --gm-hover:rgba(68,71,70,.08); --gm-focus:#0b57d0`; тема 22/28px,
  строка списка 40px `400 14px/20px`, имя `700 14px/20px`, адрес `12px/20px #5e5e5e`, тело
  `14px/20px Arial #222`, аватар 40px круг с инициалом (10 цветов, контраст ≥ 4.5:1), пилюли
  действий 36px radius 18, карточки вложений 180×120 с бейджем PDF `#c5221f`. Веб-шрифт не
  грузим (PRINCIPLES: без новых шрифтов без одобрения) — системный стек. Светлая тема
  внутри `.um` даже при тёмной теме приложения (как в PP2: у Gmail-вида нет dark mode).
- Весь текст писем, имена и темы — через `esc()`; тела — только в `<iframe sandbox>` (§ 6).

### 5.3 Список тредов, фильтры, счётчики

Строка треда (одна `<button class="um-row" aria-expanded>`): отправители по **именам**
(одно письмо — имя как написано; несколько — первые имена в порядке появления, > 3 →
«Jackie .. Ryan, Kristen»); счётчик «6»; чип «Inbox» если хоть одно письмо с label INBOX;
тема — «первые слова» последнего письма без цитаты (≤ 200 симв.); скрепка; дата (`9:22 AM`
сегодня / `Oct 7` в этом году / `12/19/24` старше); стрелка направления последнего письма
(↙ входящее / ↗ исходящее); бейджи привязки: «Rule · tenant email: ryan@kastle.com»,
«Kristen · linked», «via thread», «former tenant»; красный «Delivery failed» (bounce);
вторая строка — ≤ 3 чипа файлов («PDF · 919 Milam - Kastle…», `+2`), клик по чипу открывает
письмо с этим файлом; «Hide for me» справа (Phase 2); «Gmail label set / not set — reason»
(Phase 2, опция). Сортировка — только newest first (как в PP2).

Фильтры: поиск — клиентский по загруженным тредам (имя, адрес, тема, сниппет, имена файлов;
без debounce, через `requestAnimationFrame`), направление, контакт. Строка счётчиков
(`role="status"`): «N threads · M linked by hand · L letters · showing S» + «Show K more»
(страницы по 50 через `cursor`). Пустые состояния: «No emails linked to this unit yet» /
«No results». Обновление: слушатель `mailboxes/{id}` недоступен клиенту по rules →
CF `mailListThreads` вызывается при открытии, по кнопке «↻» и каждые 60 с, пока оверлей
открыт и вкладка видима (как `useLiveMail` в PP2); после `mailSend` список обновляется сразу.
Если в Phase 2 захочется realtime — отдельный публичный документ `mailStatus/{mailboxId}`
(`syncVersion`) с heal-цепочкой § 0.2.4 (`_v2BuildingsOnListenerError`).

### 5.4 Просмотр треда

Верхняя полоса: «← Back» (на узких), тема 22px, чип «External» (писал кто-то вне `al-en.com`)
или «Internal», «Expand all / Collapse all», «Open in Gmail» (ссылка на тред в Gmail для
admin — `https://mail.google.com/mail/u/0/#all/{gmailThreadId}`, `target=_blank`). Письма —
от старых к новым; длинный тред сворачивает середину в кружок «N» (первое, N, два последних;
`KEEP_NEWEST = 2`). Свёрнутое письмо (64–80px): аватар, имя, одна серая строка сниппета, дата.
Открытое письмо: имя + `<address>`, скрепка, дата «Wed, Oct 7, 6:06 PM (15 hours ago)»
(TZ из конфига), слово направления **Incoming / Outgoing**, для исходящих — «sent by Kristen
from SuitesForAll»; «to Ryan, Jackie ▾» с попапом from/to/cc/date/subject; тело: текст с
«•••» для цитат/подписи (разрез по `On … wrote:`, `---------- Forwarded message ---------`,
`From:`, `>`, `-- `, `Sent from my …`) или HTML в `<iframe sandbox>` (§ 6) с полосой
«Images are not displayed · Display images»; «[Message clipped] View entire message» если
`bodyText` обрезан; вложения — «N attachments» под пунктирной линией, карточки 180×120,
клик → подписанный URL (откроется/скачается). Меню «⋮» письма: Reply · Reply all · Forward ·
Mark unread (Phase 2) · Show original (сырой HTML как текст) · Copy link to this email
(`#unit=B__204&mail=<threadDocId>` — состояние в URL-хэше, чтобы ссылку можно было отправить
коллеге).

### 5.5 Compose / Reply / Reply all / Forward / Discuss (Phase 1)

Пилюли под последним письмом: **Reply · Reply all · Forward · Discuss this email**; стрелка
«ответить» и «⋮» у каждого письма. Форма ответа встраивается под письмом (как в PP2), «New
email» — та же форма в режиме `new` (в правой колонке). Поля: To / Cc / Bcc — чипы с
автодополнением из контактов юнита (арендатор, CC, prospects, участники треда); тема
(предзаполнение `Re:`/`Fwd:` без дублей); plain-text `textarea` (v1 без rich-text — Gmail-подобный
текст с переносами, ссылки автоматически); подпись сотрудника подставляется, редактируется в
Settings → Mail → My signature; вложения: «Attach file» (PDF и изображения — через существующее
правило `/workspaces/{wid}/**` для editor'ов и путь `workspaces/default/mail-uploads/{uid}/…`;
docx/xlsx потребуют правки `storage.rules` → Q7) и «Forward with original attachments».
Предзаполнение как в PP2 (`reply-model.ts:224-248`): Reply → To = автор (своё письмо → его
получатели); Reply all → To автор + To, Cc — Cc, свои адреса убраны; Forward → To пусто,
тело с блоком пересылки и вложениями. Кнопка «Send» → 8-секундный «Undo» → `mailSend`;
статус-строка под формой (ошибки — там же красным, без toast'а-спама; успех — тост «Message sent»);
черновик живёт в памяти страницы (localStorage `sfa_mail_draft_{unitKey}` для «New email»);
закрытие с текстом спрашивает «Discard draft?». Запрещено: Bcc в reply (как в PP2), отправка
без получателя, ответ на bounce, отправка при `sendEnabled:false`.
«Discuss this email» → поле заметки в оверлее → `recordOutreach(u, 'note', 'About «subject» from Sender: <text>', {mailThreadId})`
+ `saveState()` под `requireLeaderTab` (Entry 79) → заметка видна во вкладке Activity юнита.

### 5.6 Время, состояния, ошибки

Все даты — `Intl.DateTimeFormat('en-US', {timeZone})` с `timeZone` из `integrations/mail.timeZone`
(по умолчанию `America/New_York` — текущая конвенция приложения; «Central time» в PP2 — его
организационная настройка). Загрузка: скелет строк; ошибки CF — одна фраза в панели + `toast(msg,'error')`;
`permission-denied` → оверлей не открывается, тост «You don't have access to unit emails».
Кнопки асинхронных действий — `_flashButton/_restoreButton`.

### 5.7 Вне v1

Мобильный клиент `m.html` (отдельное приложение — конверт появится позже), rich-text редактор,
drag-and-drop вложений, Gmail-метки, звёзды/спам/корзина, ИИ-черновики, шаблоны писем (кандидат
на Phase 3 — шаблоны напоминаний/уведомлений с подстановкой полей юнита).

---

## 6. Безопасность и инварианты

1. **Чужой HTML — только после серверной санитизации и только в sandbox.** `mailGetThread`
   пропускает сырой HTML из Storage через `sanitizeEmailHtml` (политика PP2: удалить `script,
   style, iframe, object, embed, form, input, meta, link, base, svg, math, template, audio, video,
   noscript, head`; атрибуты `on*` и `style` с `url()/expression/@import` — убрать; `href` только
   `https:`, `mailto:`, `tel:`; всем ссылкам `rel="noopener noreferrer nofollow" target="_blank"`;
   `<img src="https://…">` → `data-blocked-src` (трекинг-пиксели не грузятся, пока сотрудник
   не нажал «Display images»); `cid:` → подписанный URL вложения; cap 2 МБ; санитайзер при
   **каждом** чтении, чтобы исправление политики применялось ко всей истории). Реализация —
   пакет `sanitize-html` в `functions/` (новая зависимость → Q4); альтернатива без зависимости —
   отдавать только `bodyText`. Клиент: `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox"
   referrerpolicy="no-referrer" srcdoc="…">` с `<meta http-equiv="Content-Security-Policy"
   content="default-src 'none'; img-src data: https://storage.googleapis.com; style-src 'unsafe-inline'">`
   внутри srcdoc; высота по `postMessage` нельзя (нет скриптов) — iframe растягивается по
   `contentDocument.body.scrollHeight` после `load` (same-origin srcdoc без `allow-same-origin`
   недоступен → используем фиксированную высоту 60vh с прокруткой внутри; это сознательный
   компромисс в пользу изоляции). Текстовый режим — всегда через `esc()`.
2. **Prompt-injection.** Письма — недоверенные данные. Любой будущий агент (AGENT_API_PLAN,
   MCP) получает письма только через `mailGetThread`-проекции с явным полем `untrusted:true`
   и никогда не исполняет инструкции из тел; саммари не считаются источником фактов (правило
   PP2). В этом плане ИИ-слоя нет.
3. **Отправка — только из CF**, с гейтами § 4.7 в этом порядке: доступ → рубильник → валидация →
   rate-limit fail-closed → durable outbox → внешний вызов → запись. Никаких отправок из
   браузера (клиентский `sendEmailViaGmail` после Phase 1 выводится из употребления).
   AUTOMATION_BOUNDARIES RED: Claude сам никогда не шлёт письма — кнопку нажимает оператор.
4. **Секреты и конфиг**: ключ SA только в Secret Manager (`MAIL_SA_KEY`), токены минтятся в CF
   и не сохраняются; адрес ящика и лимиты — в `integrations/mail` (Entry 20); `functions/.env*`
   не трогаем. Логи — `_maskEmail` (`F:554`) на адресах; адреса арендаторов и темы писем не
   попадают в commit-сообщения и в Sentry-сообщения (только id).
5. **Аудит**: `audit` row на каждую отправку (`mail.send`, `sentBy`, получатели маскированные,
   `messageId`), привязку/отвязку, скрытие, изменение прав, ошибку синка; `u.outreach[]` только
   для исходящих (входящие не раздувают монолит — Entry 29/46).
6. **Dead-letter**: каждый `return` по ошибке в `mailOnPush`/`mailSyncScheduled`/`mailSend`
   оставляет `mailDeadLetter/{key}` (и `mailboxes.lastError`), повтор ограничен (≤ 3), затем
   Sentry; Phase 2 показывает их в Settings → Mail (§ 0.2.5).
7. **Идемпотентность**: id документов = Gmail id; outbox по `idempotencyKey`; повторный push с
   тем же `historyId` безвреден (`set merge`); backfill возобновляемый.
8. **Rules**: прямого доступа к письмам нет (§ 4.5); `mailUserState` только свой uid; никаких
   `allow read, write: if true`.
9. **Данные состояния** (§ 0.2.3): открытие оверлея и ввод в форме ничего не пишут в `u.*`;
   запись `u.outreach[]` — только после подтверждённой отправки; «Discuss» пишет заметку только
   по кнопке Save.
10. **Листенеры**: в Phase 0 клиентских `onSnapshot` на mail-коллекции нет (CF-двери + опрос);
    если появятся — только с heal-цепочкой § 0.2.4.
11. **PII и удаление**: `eraseTenantPii` (`F:7438`) в Phase 2 расширяется на `mailMessages`/Storage
    по адресу арендатора (soft: `redactedAt`, тела и вложения удаляются, заголовки остаются);
    политика хранения — Q5.
12. **Лимиты**: `perUserPerDay 100`, `perWorkspacePerHour 120`, `perUnitPerDay 20`,
    `maxRecipients 20`, вложения ≤ 25 МБ — в `integrations/mail.limits`, меняет admin в Settings.

---

## 7. Поэтапный план (именованные шаги)

### Phase 0 — Read («вся переписка по юниту видна»)

**Шаги Тони до начала (консоли; 20–30 минут):**
- T0.1 (Mailbox): создать пользователя Workspace `leasing@al-en.com` (или выбранный адрес, Q2),
  при желании alias `office@…`; выставить имя отправителя «SuitesForAll Leasing».
- T0.2 (Service Account): IAM → `sfa-mail-sa`, включить domain-wide delegation, скопировать
  Client ID, скачать JSON-ключ (как Шаг 3 GMAIL_INGEST_SETUP.md).
- T0.3 (DWD scopes): Workspace Admin → API controls → Domain-wide delegation → добавить Client ID
  со scopes `https://www.googleapis.com/auth/gmail.readonly` (и сразу `…/gmail.send`, чтобы не
  переписывать список в Phase 1 — список при правке **заменяется**, не дополняется).
- T0.4 (Pub/Sub): topic `sfa-mail-push`, principal `gmail-api-push@system.gserviceaccount.com` →
  роль Pub/Sub Publisher (Шаг 2 GMAIL_INGEST_SETUP.md).
- T0.5 (Secret): `cat key.json | firebase functions:secrets:set MAIL_SA_KEY --data-file=-`, удалить
  локальный файл.
- T0.6 (IAM для подписанных URL): runtime-SA функций → роль `Service Account Token Creator`.
- T0.7 (Config): документ `integrations/mail` (черновик JSON я подготовлю; admin пишет его из
  консоли браузера или через `admin-firestore.js`).

**Шаги Claude (код; один коммит на шаг, ≤ 5 файлов, parse-check перед каждым):**
- P0.1 (Mail Sync CF): `functions/mail-sync.js` — `_mailClientFor(address)`, `_mailSyncDelta`,
  `_mailResync`, `_mailRenewWatch`, нормализация письма (`_mailNormalize`: заголовки, адреса,
  направление по `labelIds` SENT/INBOX с приоритетом над подсказкой — логика `G:289-305`,
  bodyText, вложения → Storage, `isBounce`), `mailOnPush`, `mailSyncScheduled`, `mailBackfill`.
- P0.2 (Mail Link): `functions/mail-link.js` — strip-aware индекс адресов (`_loadBuildingsForCF`),
  `_mailComputeLinks(thread, index)`, `mailLinkThread`, `mailRelinkUnit`.
- P0.3 (Mail Access + Doors): `functions/mail-access.js` (`_mailAccessFor`), `functions/mail-read.js`
  (`mailListThreads`, `mailGetThread`, `mailGetAttachmentUrl`), `functions/mail-sanitize.js`;
  подключение в `functions/index.js` (~15 строк); `functions/package.json` + `sanitize-html`.
- P0.4 (Rules + Indexes): блоки § 4.5 в `firestore.rules`; индексы § 4.3 в `firestore.indexes.json`;
  документация: ENVIRONMENT_VARIABLES.md (`MAIL_SA_KEY`), новый `MAIL_SETUP.md` (шаги T0.*),
  обновление privacy-раздела GMAIL_INGEST_SETUP.md (общий ящик читается целиком).
- P0.5 (CF Tests): `tests/mail-sync-cf.test.cjs` (нормализация, направление, идемпотентность,
  expired historyId → resync, dead-letter при ошибке Gmail, backfill-возобновление),
  `tests/mail-link.test.cjs` (точный адрес, не домен; strip-aware; group head; reject не
  возвращается), `tests/mail-access.test.cjs` (матрица 5 ролей × гранты × здания × направления),
  `tests/mail-sanitize.test.cjs` (XSS-векторы: `<script>`, `javascript:`, `on*`, `<style>@import`,
  `<img src=https>` → блок, `cid:` → ссылка, 2 МБ cap) — все по образцу `tests/sign-link-cf.test.cjs`.
- P0.6 (Unit Header Button): `canUseMail()`/`canSendMail()` + `body.no-mail`, кнопка-конверт
  в `_renderUnitV2Header`, пункты меню, `openUnitMail/closeUnitMail`, `_mailCtx`, регистрация в
  `closeMap`.
- P0.7 (Mail Overlay Read-only): разметка `#unitMailModal`, CSS `.um-*` (~350 строк), JS
  (~700 строк): список, фильтры, счётчики, разговор, свёртка, детали, iframe-тело, вложения,
  ссылка «Open in Gmail», «Find more emails», link/unlink/reject.
- P0.8 (Smoke + Docs): Playwright `tests/specs/unit-mail.spec.ts` (конверт виден admin'у,
  скрыт viewer'у, оверлей открывается/закрывается по Escape — по образцу `auth-gate.spec.ts`);
  FIXES_LOG Entry 95 (новые инварианты: «тело письма только через sandbox-iframe после
  серверной санитизации», «mail* коллекции закрыты для клиента», «unitKey всегда с buildingId»)
  + `check_gate` строки в `scripts/check-invariants.sh`; SESSION_LOG.

**Деплой Phase 0 (с одобрения Тони):** `firebase deploy --only firestore:rules,firestore:indexes`
→ `firebase deploy --only functions:mailOnPush,functions:mailSyncScheduled,functions:mailBackfill,functions:mailListThreads,functions:mailGetThread,functions:mailGetAttachmentUrl,functions:mailLinkThread,functions:mailRelinkUnit`
→ в консоли браузера root-admin: `mailBackfill({})` до `done:true` → `mailSyncScheduled`
регистрирует watch. Клиентская часть выезжает авто-деплоем хостинга **после** деплоя functions
(иначе конверт откроет пустой оверлей с ошибкой «not deployed»).

**Объём (оценка):** CF ≈ 900 строк, клиент ≈ 1 100 строк, rules/indexes ≈ 60, тесты ≈ 450,
доки ≈ 150; 3–4 рабочих дня чистого времени плюс шаги Тони.

**Критерии готовности Phase 0:** (1) письмо, отправленное арендатором на `leasing@…`, видно в
оверлее его юнита ≤ 30 с после доставки с бейджем «Rule»; (2) архив с `backfillSince` импортирован,
`mailboxes.backfill.done=true`, число тредов в оверлее совпадает с Gmail для 3 контрольных
арендаторов; (3) viewer/teamviewer/mapeditor конверта не видят и `mailListThreads` отвечает
`permission-denied`; manager с `buildings:['B1']` не видит треды B2; (4) HTML-письмо с
`<script>`/трекинг-пикселем отображается без выполнения скрипта и без запроса к пикселю
(проверка в Network); (5) вложение открывается по подписанному URL, прямой путь Storage
недоступен; (6) намеренно сломанный `historyId` → `mailDeadLetter` + восстановление следующим
тиком; (7) все `tests/mail-*.test.cjs` зелёные, parse-check 0 ошибок, Playwright smoke зелёный;
(8) `gmail-ingest.js`/Pulse работают как прежде.

**Откат Phase 0:** хостинг — `git revert` коммитов P0.6–P0.7 (кнопка исчезает, данные не
трогаются); functions — `firebase functions:delete mailOnPush mailSyncScheduled …`; rules/indexes —
`git revert` + повторный деплой; watch — `gmail.users.stop` через `mailAdminStatus({stopWatch:true})`
(или Tony из консоли); данные `mail*` и Storage можно оставить или удалить скриптом admin-а.

### Phase 1 — Send («пишем из карточки»)

- T1.1 (Scope): если `gmail.send` не был добавлен в T0.3 — добавить (список scopes заменяется
  целиком: `gmail.readonly,gmail.send`). T1.2 (Switch): `integrations/mail.sendEnabled=true`
  после smoke-теста.
- P1.1 (Mail Send CF): `functions/mail-send.js` — порт `mime.ts`/`send-mail-core.ts`, `mailSend`
  с гейтами § 4.7, outbox, retry из `mailSyncScheduled`, bounce-детектор в `_mailNormalize`.
- P1.2 (Compose UI): формы reply/replyAll/forward/new, чипы адресов с автодополнением, подпись,
  вложения (PDF/изображения), Undo 8 с, статус-строка, черновики, «Discuss this email».
- P1.3 (Signature Settings): карточка «My email signature» в Settings (пишет
  `members/{uid}.preferences.mailSignature` — уже разрешено rules), предпросмотр «From» строки.
- P1.4 (Legacy Path): `_moDispatchNoticeEmail` и «Send test email» переводятся на `mailSend`;
  `connectGmail`/`sendEmailViaGmail` и карточка Settings `M:23345-23372` помечаются deprecated
  (удаление — отдельным коммитом после недели работы; Q9).
- P1.5 (Tests + Docs): `tests/mail-send-cf.test.cjs` (гейты в правильном порядке — отказ ДО
  вызова Gmail; идемпотентность; threading-заголовки; forward без replyTo; rate-limit; outbox
  dead после 3 попыток; `stateWriteOk:false` не бросает после успешной отправки); FIXES_LOG
  Entry 96 + `check_gate` («mailSend: rate-limit до внешнего вызова», «никаких отправок из
  браузера»); Playwright: форма открывается, Send без получателя блокируется.
- Деплой: `functions:mailSend` + обновлённые `mailSyncScheduled` (с одобрения). Smoke: письмо с
  тестового юнита на адрес Тони → ответ Тони → виден в треде как Incoming.
- Объём: CF ≈ 500, клиент ≈ 600, тесты ≈ 250; 2–3 дня.
- Готовность: отправка/ответ/пересылка из оверлея попадают в Gmail-тред, в `mailMessages`
  (outbound, `sentByUid`), в `u.outreach[]` (Activity) и в `audit`; двойной клик не создаёт
  второго письма; при `sendEnabled:false` — отказ одной фразой; bounce помечается.
- Откат: `integrations/mail.sendEnabled=false` (мгновенно, без деплоя) → `git revert` клиента →
  `functions:delete mailSend`.

### Phase 2 — Access & Settings («кто что видит», Inbox, удобства)

- P2.1 (Access CF + Settings UI): `mailSetAccess`, вкладка Settings → Mail: статус ящика
  (`mailAdminStatus`: последний синк, ошибки, dead-letters с кнопкой Retry), матрица «user ×
  (read all / buildings / none, directions, send, see unlinked)», лимиты, TZ, рубильники.
- P2.2 (Inbox View): вид «all/unlinked threads» (кнопка-конверт в topbar для admin), «Link to
  unit…» с поиском по зданию/сьюту/арендатору, «Create prospect from this email» (push в
  `u.prospects[]` на клиенте под `requireLeaderTab`).
- P2.3 (Per-user State): «Hide for me» / «Show hidden (N)», прочитанность с эпохой
  (`mailUserState`), бейдж непрочитанных на конверте и в топбаре, `mailRelinkScheduled` +
  автовызов `mailRelinkUnit` из `saveDetail`.
- P2.4 (Optional Gmail Labels): при `gmailLabelsEnabled` и scope `gmail.modify` — метка
  `SFA/<Building> <Suite>` на привязанных тредах (как `Kiwi/<task>` в PP2), строка «Gmail label
  set / not set — reason».
- P2.5 (PII + Retention): расширение `eraseTenantPii`, политика хранения (Q5), экспорт треда в PDF
  (печать через `window.print()` sandbox-страницы).
- Деплой: functions (с одобрения), rules (`mailAccess`, `mailUserState` уже добавлены в Phase 0 —
  правки не нужны, если модель не изменится), индекс `mailboxId+lastMessageAt`.
- Объём ≈ 1 000 строк; 2–3 дня. Готовность: сценарии из § 4.5 проходят для всех 5 ролей с
  грантами; Inbox показывает непривязанные письма только admin/seeUnlinked; скрытое у одного
  пользователя видно другому.
- Откат: `git revert` + `functions:delete` новых CF; документы `mailAccess` без CF просто не
  читаются (дефолты ролей продолжают действовать).

### Что требует явного одобрения Тони (CLAUDE.md § 2 / AUTOMATION_BOUNDARIES RED)

| Пункт | Фаза |
|---|---|
| Правка и деплой `functions/*.js` (все `mail*` CF, 15 строк в `functions/index.js`) | 0, 1, 2 |
| `firestore.rules` (блоки § 4.5) и `firestore.indexes.json` | 0 (+ индекс в 2) |
| Новая зависимость `sanitize-html` в `functions/package.json` | 0 |
| Секрет `MAIL_SA_KEY`, новый service-account, DWD scopes, Pub/Sub topic, IAM Token Creator | 0 (Тони сам) |
| Внешний API Gmail (чтение в 0, отправка в 1) | 0, 1 |
| Role-helper'ы `canUseMail()/canSendMail()` и новая настройка прав | 0, 2 |
| `storage.rules` — только если нужны docx/xlsx-вложения при отправке | 1 (опц.) |
| Вывод из употребления клиентского Gmail OAuth (`connectGmail`) | 1 |

---

## 8. Тесты и проверки (сводно)

| Уровень | Что | Команда |
|---|---|---|
| Парсер монолита | обязательный после каждой правки `floor-map-editor.html` | `npm run parse-check` |
| CF unit | `tests/mail-sync-cf.test.cjs`, `mail-link`, `mail-access`, `mail-sanitize`, `mail-send-cf` — стаб-харнесс `tests/sign-link-cf.test.cjs` (`Module._load` → `firebase-admin`/`googleapis`/`sanitize-html` заменяются фейками; сеть не трогается) | `node tests/mail-sync-cf.test.cjs` и т. д.; все вместе — новый `npm run test:mail` |
| Синтаксис CF | `node --check functions/mail-*.js functions/index.js` | — |
| Инварианты | `scripts/check-invariants.sh` (predeploy хостинга) с новыми `check_gate` | автоматически |
| Playwright | `tests/specs/unit-mail.spec.ts`: конверт по ролям, открытие/закрытие, пустое состояние | `cd tests && npx playwright test` |
| Ручной smoke (Тони/я в браузере) | письмо арендатора → оверлей; отправка → Gmail-тред; XSS-письмо; bounce | по чек-листу критериев готовности |

---

## 9. Открытые вопросы Тони (ответь номерами; в скобках — что сделаю по умолчанию, если скажешь «как предлагаешь»)

1. **Чей ящик.** A — один общий ящик компании (рекомендую); B — личные ящики сотрудников как в PP2;
   A+B — общий ящик для отправки и чтение личных только для тредов, привязанных к юниту.
   (По умолчанию A.)
2. **Адрес и домен ящика.** `leasing@al-en.com`? DWD уже настроен для `al-en.com`; домен
   `suitesforall.com` потребовал бы свой Workspace/DWD. Имя отправителя «SuitesForAll Leasing»
   и формат `"Kristen Meek · SuitesForAll" <leasing@…>`? (По умолчанию `leasing@al-en.com`, формат как написан.)
3. **Кто видит по умолчанию.** admin — всё; manager — чтение и отправка в своих зданиях;
   mapeditor/teamviewer/viewer — ничего; индивидуальные гранты — в Phase 2. Подходит?
   (По умолчанию так.)
4. **Зависимость `sanitize-html` в functions** — можно ставить? Без неё в Phase 0 показываем
   только текст писем (HTML-вид появится позже). (По умолчанию ставлю.)
5. **Архив и хранение.** Импортировать весь ящик (включая непривязанные письма) с какой даты
   (`backfillSince`)? Хранить бессрочно или N лет? (По умолчанию: весь ящик с 2026-01-01, бессрочно.)
6. **Метки в самом Gmail** (`SFA/919 Milam 204` на тредах) — нужны? Это scope `gmail.modify`
   и Phase 2. (По умолчанию нет.)
7. **Вложения при отправке.** Только PDF и изображения (без правки `storage.rules`) или ещё
   docx/xlsx (нужна правка `storage.rules`)? (По умолчанию PDF+изображения.)
8. **Старый метаданный ingest для Pulse** (`gmail-ingest.js`): оставить как есть или в том же
   деплое исправить strip-awareness и `u.email` (две небольшие правки)? (По умолчанию оставляю как есть.)
9. **Личный Gmail OAuth на клиенте** (`connectGmail`, уведомление о расторжении): перевести на
   общий ящик в Phase 1 и убрать? (По умолчанию перевести и пометить deprecated, удалить через неделю.)

Принятые по умолчанию допущения, если возражений нет: push через Pub/Sub + догон раз в 10 минут;
TZ отображения `America/New_York` (настраивается в `integrations/mail.timeZone`); лимиты § 6.12;
мобильный клиент — позже; rich-text — позже.

---

## 10. Самопроверка плана по инвариантам

- § 0.2.1 (capture-inside-mutate): `mailSend` пишет `u.outreach[]` внутри `mutateWorkspaceState`;
  v2-зеркало платежей не затрагивается. ✔
- § 0.2.2 (settled state): денежных поверхностей план не трогает; напоминания остаются через Stripe. ✔
- § 0.2.3 (state только по завершении акта): формы/оверлей не пишут `u.*`; запись после подтверждённой отправки или по кнопке Save заметки. ✔
- § 0.2.4 (heal chain): клиентских `onSnapshot` в Phase 0/1 нет; вариант realtime в Phase 2 — только с heal-цепочкой. ✔
- § 0.2.5 (событие не умирает молча): outbox + dead-letter + Sentry на каждом раннем `return`; «Sent» только после ответа CF. ✔
- § 0.2.6 (invoice-first): не затрагивается. ✔
- Entry 45 (strip-aware): индекс адресов и запись outreach — через `_loadBuildingsForCF`/`mutateWorkspaceState`, не через `doc.state.buildings`. ✔
- Entry 46: `_mailCtx` вне объекта юнита. ✔ Entry 88: `unitKey` с `buildingId`. ✔
- Entry 22: CF-отправка требует `unitId+buildingId+floorId`, не бросает после успешного внешнего вызова. ✔
- Entry 76: rate-limit до внешнего вызова. ✔ Entries 10/30: `sentByUid/sentByEmail`. ✔
- Entry 20: секрет в Secret Manager, конфиг в `integrations/mail`, токены не хранятся. ✔
- Entry 92: один ответ на любой отказ, текст провайдера наружу не уходит. ✔
- Entry 19 (View-As): гейт на клиенте — только видимость; CF проверяет реального пользователя. ✔
- Entry 79: клиентская запись заметки (`Discuss`) под `requireLeaderTab`. ✔
- CLAUDE.md § 8: все пользовательские строки через `esc()`; фича обнаруживаема (конверт в шапке + пункты меню); localStorage используется только для черновика и переживает квоту (try/catch). ✔
- Схема `state.*` не меняется (конфиг и подпись — вне `state`). ✔ Нерешённых мест-заглушек в документе нет; всё открытое вынесено в § 9. ✔
