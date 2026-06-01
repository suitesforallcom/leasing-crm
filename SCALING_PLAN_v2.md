# SCALING_PLAN_v2.md — масштабирование SuitesForAll на бесконечные здания и платежи

> Живой документ. Переработка `SCALING_PLAN.md` (v1) после двух инцидентов потери данных 2026-05-30.
> Цель: **добавление здания / юнита / платежа НЕ увеличивает ни один существующий документ**.
> Статус: ПЛАН. Реализацию начинать только в ОТДЕЛЬНОМ тестовом workspace, не на живом проде.

---

## 0. Почему v1 не годится и что мы поняли

v1 пытался вынести платежи в плоскую коллекцию `payments/{unitId__ym}` и стрипать их из монолита на лету. Два механизма убили данные на живом проде:

1. **diff-on-push strip** — вычислял, что удалить из коллекции, по разнице «прошлый снапшот vs текущий state». Когда `fbApplyRemote` загружал стрипнутый (без платежей) монолит раньше, чем overlay восстанавливал платежи, `cur` оказывался пустым → diff решал «всё удалили» → снёс ВСЕ 1277 платёжных доков. Дважды. Санитарный барьер «cur просел >20%» не спас.
2. **building-agnostic ключ** `unitId__ym` — у нас 4 РЕАЛЬНЫХ здания с ПОВТОРЯЮЩИМИСЯ номерами су́ит (101–352 есть в нескольких). Overlay красил платежи b1 на одноимённые пустые су́иты других зданий → 575 фантомных записей, раздувших монолит до 898 KB.

**Незыблемые выводы для v2:**
- **Ключи ВСЕГДА building-aware:** `buildingId__unitId[__ym]`. Номера юнитов НЕ глобально уникальны.
- **Никогда не удалять по диффу.** Удаление — только по явному событию (move-out / удаление юнита), точечно.
- **Запись — точечная через DAO в нужный документ**, а не «собери весь state и вычисли разницу на пуше».
- **Сначала тестовый workspace.** На живые финансы — только проверенное, с протестированным откатом.
- Текущее состояние (после отката v1): `settings.syncV2 = false`, монолит-режим, коллекция `payments` осиротела и игнорируется, баннер-шторм лечится backoff'ом (он от миграции не зависит и остаётся). Strip отключён наглухо (kill-switch в `_fbPaymentsCutover`).

---

## 1. Диагноз потолка

Всё состояние — ОДИН документ Firestore, жёсткий лимит **1 MB**.
- b1 = 590 KB. 50 зданий × ~100 KB ≈ 5 MB → упор в лимит на ~8–9 зданиях.
- Платежи: 1277 записей = 203 KB на ТЕСТОВОЙ доле. Реальный поток (годы × сотни юнитов) — мегабайты.
- Каждое сохранение переписывает весь документ → стоимость записи и частота конфликтов растут с общим размером (корень баннер-шторма).

Это потолок архитектуры, а не данных. Резать поля — лишь отсрочка.

**Где сейчас вес (828 KB):** `buildings` 780 KB (94%). По полям юнитов: payments 203 · leaseDocuments 104 · outreach 66 · prospects 34 · additionalServices 28 · stripe 24 · tenantHistory 18 · points 11. По зданиям: b1 590 · Bay Vista 97 · «Suites For All» дубль 54 · Crane Nest 39.

---

## 2. Целевая архитектура: документ-на-сущность

Принцип: **один документ = одна сущность**. «Добавить» = создать НОВЫЙ документ, не раздувая старые. У Firestore нет лимита на число документов в коллекции → отсюда бесконечные здания/платежи.

```
workspaces/{ws}/
  meta/app                              крошечный: settings, investments, флаги, _rev глоб.
  buildings/{buildingId}                мета здания + этажи + юниты (БЕЗ платежей)   ~50–150 KB
  payments/{buildingId__unitId__ym}     каждый платёж — отдельный док, building-aware ключ  ~150 B
  leaseDocs/{buildingId__unitId__n}     тяжёлые доки аренды (сейчас 104 KB) → сюда / в Storage
  tenants/{id} · leases/{id} · contracts/{id}
  ingest/{gmail|calendar|aircall}       активность отдельно, вне горячего документа
```

### Два ключевых решения
1. **Per-building документы.** Каждое здание — свой документ. 50 зданий = 50 документов по ~100 KB, ни один не близок к 1 MB. Добавление здания не трогает остальные.
2. **Платежи — отдельная коллекция, ключ `buildingId__unitId__ym`.** Building-aware (исправляет утечку v1). Растут бесконечно, не раздувая документ здания.

### Почему масштабируется бесконечно
- Документ здания несёт только структуру — фиксированный размер, не растёт от истории платежей.
- Платежи / leaseDocs / активность — в своих коллекциях; лимит 1 MB к ним неприменим (он про документ, не про коллекцию).
- Операторы, правящие разные здания/юниты → разные документы → **ноль конфликтов** (баннер-шторм уходит в корне).

### Что делает это выполнимым без переписывания приложения
Клиент продолжает собирать **тот же in-memory `state.buildings[*].floors[*].units[*]`**, только из стримов коллекций:
- `onSnapshot` на `buildings` → пересобирает `state.buildings`;
- `onSnapshot` на `payments` → раскладывает по юнитам **по (buildingId, unitId, ym)** — building-aware.
Все 145k строк рендера/финансов/аренды работают как есть. Меняется только слой хранения.

---

## 3. Второй потолок (на будущее, НЕ сейчас)

Per-building документы снимают лимит 1 MB. При ОЧЕНЬ больших портфелях (сотни зданий, годы платежей) появится второй потолок: клиент грузит ВСЁ в память и рендерит. Решение — **lazy-load**: держать в памяти только активное здание, подгружать юниты/платежи по требованию. Это бо́льшая правка (код предполагает «всё в памяти»), НЕ нужна для 50 зданий — Firestore спокойно отдаёт тысячи мелких документов. Слой хранения делаем сейчас, lazy-load — когда реально упрёмся.

---

## 4. Repository/DAO-слой (линчпин, и страховка от багов v1)

Вся запись идёт через тонкий слой с building-aware сигнатурами:
```
repo.updateUnit(buildingId, unitId, patch)
repo.setPayment(buildingId, unitId, ym, rec)
repo.deletePayment(buildingId, unitId, ym)        // ТОЛЬКО по явному событию
repo.updateBuildingMeta(buildingId, patch)
repo.appendLedger(entry)
```
UI/бизнес-логика зовёт высокоуровневые мутаторы; КАК они пишут (монолит / per-entity) решает флаг. Точечная запись в нужный документ убивает оба класса багов v1 (нет диффа → нет ложных mass-delete; ключ building-aware → нет утечки).

---

## 5. Миграция — strangler-fig, по кускам, сначала на ТЕСТОВОМ workspace

Каждая фаза: реализуем → гоняем в тестовом workspace (где ошибка ничего не стоит) → сверка/нагрузка → только потом флаг на живой → soak → ретайр старого. Откат на любом шаге.

- **Фаза 0 — фундамент.**
  - DAO-слой перед всеми мутациями (механически, поведение не меняет).
  - Тестовый workspace `workspaces/staging` (или второй Firebase-проект) с копией данных.
  - Метрика «до/после» по документам (расширить `sfaSyncStats` на размеры per-doc).

- **Фаза 1 — платежи в свою коллекцию (наибольший выигрыш + самый горячий путь).**
  - Ключ `buildingId__unitId__ym`. Запись через `repo.setPayment` в точках мутации (manual payment, void, mark-paid, heal, import + серверные webhook/late-fee). НЕ diff-on-push.
  - Чтение: `onSnapshot` на `payments`, раскладка по (buildingId, unitId, ym).
  - Удаление: только в `openMoveOutModal` / явном clear → `repo.deletePayment`.
  - Дубль-запись (монолит + коллекция) → сверка → переключение чтения → снятие платежей с монолита (по одному, с проверенным `sfaRehydrateMonolith`-аналогом building-aware).
  - Gated: `firestore.rules` (новая коллекция, building-aware), `firestore.indexes.json` (collectionGroup/queries), `functions/index.js` (серверная запись в коллекцию).

- **Фаза 2 — здания в свои документы.**
  - `workspaces/{ws}/buildings/{buildingId}` — мета + этажи + юниты (без платежей).
  - `meta/app` — settings/investments/флаги.
  - Клиент собирает `state.buildings` из коллекции `buildings`.
  - После этого добавление здания = новый документ. Лимит 1 MB на здание (а не на весь портфель).

- **Фаза 3 — вынос тяжёлых полей.**
  - `leaseDocuments` (104 KB) и `leaseEnvelopes` → Storage/подколлекция (паттерн `_tplStripReplacer`/`htmlStorageRef` уже есть).
  - `outreach` (66 KB) уже зеркалится в `audit`-подколлекцию → в документе оставить хвост (cap 25), полная история в audit.
  - Активность (gmailActivity/callActivity/calendarEvents/dailyHistory) → свои документы `ingest/*`.

- **Фаза 4 — ретайр монолита.** Старый `data/state` → крошечный `meta/app` или удаляется; дубль-запись убирается.

- **Фаза 5 — деньги-инварианты.** Append-only ledger как источник истины «оплачено», идемпотентные ключи на каждую Stripe/auto-invoice запись (частично есть). Соответствие `FINANCIAL_INVARIANTS.md`.

- **Фаза 6 (далеко) — lazy-load клиента** для сотен зданий.

---

## 6. Требует одобрения Tony (gated, по каждому — отдельный запрос)
- `firestore.rules` — новые коллекции с той же ролевой моделью.
- `firestore.indexes.json` — индексы под запросы платежей/зданий.
- `functions/index.js` — серверная запись платежей в коллекцию, не в state.
- Схема `state.*` — декомпозиция.

## 7. Незыблемые правила безопасности (из инцидентов 2026-05-30)
1. Ключи building-aware: `buildingId__unitId[__ym]`. Никогда только `unitId`.
2. Никаких delete-by-diff. Удаление — по явному событию, точечно.
3. Запись точечная через DAO, не вычисление разницы на пуше.
4. Сначала тестовый workspace. На прод — проверенное.
5. Протестированный откат до каждого включения.
6. Деньги (`u.payments[*]`, void, refund) — gated, с бэкапом (localStorage + Storage snapshot).
7. Дубль-запись + сверка перед переключением чтения; снятие со старого хранилища — только после soak.

## 8. Текущее состояние (на момент написания, 2026-05-30)
- Монолит-режим, `settings.syncV2 = false`. Документ ~814 KB, запас до 1 MB на ближайшие здания есть.
- Баннер-шторм/version-conflict — лечится backoff + сбросом залипшего статуса (НЕ зависит от миграции, остаётся).
- v1-артефакты инертны: strip — kill-switch; коллекция `payments` осиротела (игнорируется); серверный триггер `mirrorPaymentsOnStateWrite` no-op при syncV2=false.
- Фантомные кросс-билдинговые платежи (575) вычищены; данные b1 (1277) целы.

## 9. Журнал
- 2026-05-30: v1 (single payments collection, unitId-key, diff-strip) — 2 инцидента mass-delete + кросс-билдинговая утечка. Откачен. Уроки → v2. План v2 оформлен; реализация ждёт отдельного захода с тестовым workspace.
- 2026-05-31: **Phase 0 начат.** (1) Building-aware write-DAO `repo.setPayment/deletePayment` (ключ `buildingId__unitId__ym` через `_payKeyV2`); per-entity mirror dormant за `syncV2Enabled()` (выкл) → поведение не изменилось. Проведены основные операторские пути записи: manual-payment (waive/paid), deleteManualPayment, payBulkMarkPaid. Отложено на UI-verified проход: cyclePaymentStatus + длинный хвост (Stripe-link, lease-defaults, proration, email, merge, loadPaymentsData). (2) Тестовый workspace `staging`: `WORKSPACE_ID` теперь резолвится (allowlist `default`/`staging`, `?ws=`/localStorage); громкий баннер + `sfaUseWorkspace()` / `sfaSeedStagingFromProd()`. **firestore.rules НЕ менялись** — root-admin bypass на `{wid}`-wildcard уже даёт доступ к `staging`. Метрика (Phase 0 п.3) уже покрыта `sfaScaleV2Audit`. Коммиты `7a9e299` (DAO) + `1c44523` (staging), задеплоено. ОСТАЛОСЬ Phase 1: per-entity запись за флагом, обкатать в `staging`, потом прод.
- 2026-05-31: **операторские записи покрыты целиком** — `cyclePaymentStatus` тоже через `repo` (`0997414`). **Phase 1 client core реализован DORMANT** (`71558e7`, за выключенным `syncV2` → на прод нулевое влияние): `repo._mirrorSet/_mirrorDel` (building-aware dual-write `buildingId__unitId__ym`, `_schema:'v2'`), `repo.mirrorAllV2` (backfill), `sfaMirrorPaymentsV2()` (guarded), `sfaReconcilePaymentsV2()` (read-only сверка). Коллекция переиспользует существующую `payments` (rules уже разрешают; staging-коллекция пустая → чистый тест). Wrong-floor лог диагностирован как безобидный (KNOWN_ISSUES #12). **СЛЕДУЮЩЕЕ (с Tony):** обкатать dual-write в `staging` (seed → switch → syncV2=true → mirrorAllV2 → reconcile=clean → правки → reconcile); затем серверный dual-write trigger (`functions/index.js` — gated); затем переключение чтения + soak + strip монолита (всё с reconcile-гейтом). Прод-коллекция `payments` несёт осиротевшие v1-доки (агностик-ключ) — вычистить перед прод-включением.
- 2026-05-31: **фикс id тестового workspace** — `__staging__` отвергается Firestore (резерв `__.*__`: «Resource id is invalid because it is reserved»), воркспейс не инициализировался. Переименован в `staging` во всём коде/доках (`91c5b08`). Данные не пострадали (seed только читает прод). Стейл-флаг `__staging__` теперь вне allowlist → авто-возврат на `default`. **NB на будущее:** id документов/коллекций не должны матчить `__.*__`; ключи платежей `buildingId__unitId__ym` валидны (`__` в середине, не обёрнут).
- 2026-05-31: ✅ **dual-write ВАЛИДИРОВАН в `staging`** (Tony прогнал). seed → switch → `syncV2=true` → `sfaMirrorPaymentsV2()` (1278 записано) → `sfaReconcilePaymentsV2()` = **1278/1278, missing 0 / extra 0 / mismatched 0 — ✓ ЧИСТО**. Building-aware запись + сверка работают байт-в-байт, кросс-билдинговой утечки нет. Прод не затронут (`syncV2` на проде остаётся off). СЛЕДУЮЩЕЕ: (a) перед прод-включением — `sfaCleanV1OrphanPayments()` вычистить v1-сирот из прод-коллекции; (b) включить client dual-write на проде (флаг — additive, монолит остаётся истиной) + soak с периодическим reconcile; (c) серверный trigger `functions/index.js` (GATED, нужно одобрение Tony) — чтобы auto-billing CF тоже зеркалил; (d) затем переключение чтения → soak → strip монолита (реальный выигрыш по размеру), каждый шаг под reconcile-гейтом.
- 2026-05-31: ✅ **ПРОД dual-write ВКЛЮЧЁН + валидирован.** `syncV2` включился на проде во время staging-теста (saveState отработал на прод-вкладке/до переключения) — узаконили осознанно (Tony выбрал «A»). Вычищены 1283 v1-сироты (`sfaCleanV1OrphanPayments`), backfill `sfaMirrorPaymentsV2` → 1284, `reconcile(ws=default)` = **1284/1284, missing 0 / extra 0 / mismatched 0 — ✓ ЧИСТО.** Прод в фазе dual-write: ЧТЕНИЕ из монолита (UI не меняется), коллекция — живая тень, откат `syncV2=false; saveState()`. **SOAK** (периодический `sfaReconcilePaymentsV2()`). ОЖИДАЕМЫЕ gap'ы при soak (это СИГНАЛ, не баг): (1) непроведённые автоматические записи (proration/bounce/email/merge) → провести через `repo`; (2) серверные auto-billing CF пишут платёж в монолит МИМО клиента → нужен серверный trigger (`functions/index.js`, GATED) до read-switch. После закрытия gap'ов + чистого soak → переключение чтения → strip монолита.
- 2026-05-31 (вечер): ⚠️ **incident + recovery.** Сегодняшняя сессия начала seed-cleanup в монолите через raw `delete u.payments[ym]` (а не через `repo.deletePayment`) — это создало 9 extras в v2 на reconcile (b1__329 / b1__342 / b1__403 / b1__439 + 5×b1__449). Также деплои из `main` (отстаёт на 630 commits от scaling branch) дважды откатили прод-код на main + activity-pill фиксы — на ~2 часа scaling V2 функций НЕ БЫЛО на проде, любой reload триггернул бы Object.assign-клоббер сидом (`5a0b44d` отсутствовал). RECOVERY: (a) cherry-pick activity-pill фиксов на scaling branch → merge origin/main → re-stamp → deploy scaling tip → восстановило все scaling V2 функции + `5a0b44d`; (b) reconcile показал 1 missing (`b1__336__2026-05` — единственная запись за окно регрессии) + те же 9 extras; mirror+delete через `repo` → **1276/1276, 0/0/0 ЧИСТО**; (c) **закрытие trap'а навсегда:** Tony одобрил fast-forward `main → 7f282ef` (scaling tip) + retire `claude/modest-curie-8a50ad` (local+remote+worktree) + commit `admin-firestore.js` который жил только в worktree. main теперь содержит ВСЕ scaling V2 коммиты. Память обновлена (`feedback_worktree_must_merge_main_first.md`, `project_main_lags_feature_branches.md`). **NB:** seed-cleanup / любая bulk-mutation `u.payments[*]` ОБЯЗАНА идти через `repo.deletePayment` (с opts.save для батча) — raw `delete` создаёт reconcile drift.
- 2026-05-31 (вечер): ✅ **Phase 1 server-side dual-write deployed** (`ba68a4d`, `firebase deploy --only functions` одобрен Tony). Закрывает последний из ожидаемых gap'ов журнала выше («auto-billing CF пишут мимо клиента»). Помимо auto-billing покрывает все 5 CF-точек записи в `u.payments[ym]`: `handleInvoicePaid` (anchor + advance-prepay siblings по `paidVia='stripe-advance' + stripe.invoiceId`), `handleInvoiceVoided` (rent→pending), `handleChargeRefunded` (refunded/partial), `confirmBankMatch` (bank-feed confirm, с capture buildingId/floorId внутри mutate), `undoAutoAppliedPayment` (mirror delete по explicit undo). Три helper'а рядом с `findUnit`: `_stateIfSyncV2()` (gate + fresh-state read), `_writePaymentV2()` (точечная запись), `_deletePaymentV2()` (точечное удаление — НИКОГДА по diff, см. §0 п.2). Fire-and-forget pattern (ошибки логируются, не пропагируются), gate через `state.settings.syncV2` — откат через flip флага без redeploy. **СЛЕДУЮЩЕЕ:** soak ≥ 24-48ч с периодическим `sfaReconcilePaymentsV2()` → 0 drift подряд → потом **read-switch** (клиент читает из коллекции, не из монолита) → ещё soak → **strip монолита** (реальный выигрыш по размеру, сейчас ~841 KB → ~600 KB после strip). Strip отдельный план — past v1 incident `payments strip` дважды mass-удалил 1277 записей (2026-05-30); v2 strip ОБЯЗАН быть «delete-by-event», не «delete-by-diff».
- 2026-05-31 → 2026-06-01: ⏳ **Autonomous 12h run #2 — DORMANT scaffolding shipped** (Tony approved «A + B + C + D и все остальное»). 4 коммита на main, все additive, нулевое поведенческое влияние без явного flip флагов:
  - `de72bc5` Phase 1.2 read-switch CLIENT CORE (DORMANT). `syncV2ReadEnabled()` gate, `onSnapshot('workspaces/{ws}/payments')` listener с debounced re-render (100ms), helpers `_v2PaymentsAttachListener/Detach/AttachIfFlagged`. fbApplyRemote hook восстанавливает listener при reload если флаг сохранён. Console: `sfaTestReadSwitchV2(true/false)`, `sfaReadSwitchSmoke()`. Активация: `settings.syncV2 → settings.syncV2Read = true → attach`.
  - `ad53f88` Phase 2 BUILDING DUAL-WRITE MIRRORS (DORMANT). `buildingsSyncV2Enabled()` gate, `_buildingForV2()` strip helper (deep-clone minus `u.payments`), `_mirrorBuildingsToV2()` change-aware batch write (только реально изменившиеся через `_stableStringifyBld` hash compare), `_mirrorBuildingDeleteV2()` для explicit-event delete. Console: `sfaMirrorBuildingsV2()` (root-admin backfill), `sfaReconcileBuildingsV2()` (read-only sверка). NOT YET ROUTED через saveState hook — это в следующем шаге активации.
  - `1d69489` SCALING_AUDIT_2026-05-31.md (`SCALING_AUDIT_2026-05-31.md`). Read-only audit двумя Explore-агентами в параллели: 177 read sites `u.payments` (44 функции, all idempotent — read-switch safe to flip); 367 reads `state.buildings` (300+ функций, hot-path readers identified, Phase 2 safety checklist — 4 helper guards + listener attach timing + delete-sync + loading sentinel — ~2-3ч работы).
  - `e184d83` Phase 1 reconcile monitoring CF (`reconcilePaymentsV2Scheduled` cron `0 * * * *` UTC + `runReconcilePaymentsV2Now` onCall). Пишет hourly snapshots в `workspaces/{wid}/scaling/reconcileLatest` + append-only history `reconcile_<tsIso>`. Result shape: `{stateCount, cloudCount, v1OrphanCount, missingInCloud[0..50] + total, extraInCloud, mismatched, clean, флаги syncV2/syncV2Read/syncBuildingsV2, computedAt}`. Surfaces `v1OrphanCount` для visibility на latent issue ниже.
  - **LATENT ISSUE surfaced**: `mirrorPaymentsOnStateWrite` trigger в functions/index.js:8324 (добавлен в `042885f` 2026-05-30) использует v1-схему (`unitId__ym`, no `_schema:'v2'`) и delete-by-diff anti-pattern (§0 rule 2). При `syncV2=true` (включено сегодня) trigger silent создаёт v1-keyed docs которые collidируют между зданиями с одинаковыми suite ID. **Не auto-fixed в autonomous run** — рекомендация: disable этот trigger когда Tony вернётся (в-handler mirrors из `ba68a4d` покрывают тот же ground корректно). Reconcile CF теперь surfaces v1OrphanCount чтобы это было видно в hourly snapshots.
