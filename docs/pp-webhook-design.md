# PP Webhook «building.changed» — дизайн и инварианты

> Финальный дизайн (после адверсариального ревью 3 линзами, 2026-06-09).
> Реализация: `functions/pp-webhook.js`. Контракт для PP-стороны:
> `docs/pp-webhook-contract-for-pp.md`. Деплой §2-gated — только по GO Тони.

## Архитектура: notify + pull

SFA шлёт подписанный СИГНАЛ `{event:'building.changed', buildingId, excelId,
changedAt, …}` на URL PropertyPulse; PP в ответ сам тянет данные через уже
задеплоенный `ppOfficeExport?buildingId=…`. Данные арендаторов по вебхуку не
передаются — только идентификаторы (PII-гард зафиксирован тестом).

## Точки срабатывания (почему именно эти)

| Триггер | Путь | Зачем |
|---|---|---|
| `ppNotifyBuildingChanged` | `workspaces/{ws}/buildings/{bid}` | Монолит под strip-ON к зданиям слеп (`buildings:[]` и у клиента, и в `mutateWorkspaceState`). Коллекция видит все 3 пути мутаций: клиентский leader-mirror, серверный CF-mirror, инцидентные Admin/REST-записи. |
| `ppNotifyPaymentChanged` | `workspaces/{ws}/payments/{pid}` | Чистая оплата/void НЕ меняет PP-видимый хэш здания: `u.payments` вырезан из зеркала, а живые stripe-штампы (`lastInvoiceId`/`autoSentYm`/`moveInRent`) не входят в curated-проекцию. Без этого триггера PP вечно показывал бы «paid» после void. `buildingId` парсится из id дока (`{bid}__{uid}__{ym}`), эхо-перезаписи зеркал отсекаются сравнением `rec` before/after. |
| `ppWebhookFlushScheduled` | кран `* * * * *` | Trailing edge debounce'а + sweep claim'ов старше 5 мин (упавший инстанс). |

`ws !== 'default'` (staging) — отбрасывается первой строкой.

## Ключевые решения (выжившие после ревью)

1. **Хэш — всегда по ЖИВОМУ доку, прочитанному в транзакции.** Событие
   триггера — только сигнал: Eventarc не гарантирует порядок, и хэш по
   event-снапшоту отравлялся бы устаревшими событиями (silent staleness при
   реверте). Кран при claim'е тоже перечитывает живой док — это же лечит
   delete-в-окне (честный `deleted:true` только при реальном отсутствии дока).
2. **`contentHash = sha256(stableStringify(curateBuilding(doc)))`** — та же
   PP-видимая проекция, что у DTO экспорта (`ppExport.js`). Метаданные
   (`_savedRev/_mirroredAt/_mirroredBy`) и геометрия (`pointsFlat`) в хэш не
   входят → сессионный burst (перезапись всех зданий при загрузке страницы) и
   drag юнитов подавлены полностью. Bootstrap-шум: первый деплой → по одной
   нотификации на здание при первой записи (разово, принято).
3. **Debounce ≥60s на здание** (`ppWebhookQueue/{ws}__{bid}`): leading edge
   сразу; внутри окна — `dirty + pendingHash` (последний побеждает); кран
   дошлёт. Реверт к уже-нотифицированному контенту отменяет pending
   (`cancel-dirty`), кроме случая `paymentsDirty`.
4. **At-least-once**: claim держит `dirty=true + sendingAt`; dirty снимается
   только после успешной доставки; кран пересылает claim'ы старше 5 мин
   (инстанс умер между claim и POST). Дубли дедупит PP по `deliveryId`.
   После give-up (4 попытки) — строгий отказ: `lastError` в queue-док +
   `logger.error`; catch-up = обязательный периодический полный pull PP.
   Пост-ревью гарды (3 подтверждённые гонки закрыты):
   - **settle проверяет владение claim'ом** (`q.deliveryId === claim.deliveryId`)
     прежде чем трогать `sendingAt/dirty/lastError` — медленная доставка A не
     может стереть маркеры более нового claim'а B;
   - **`cancel-dirty` при живом `sendingAt` снимает только `pendingHash`**,
     dirty остаётся за settle/краном (иначе крах доставщика делал потерю
     невидимой для sweep);
   - **удаление queue-дока после delete-нотификации — внутри settle-tx** и
     только без pending: recreate здания в окне не теряется.
   Плюс страховка: исчерпание tx-ретраев (горячий док) → best-effort
   `dirty=true`, кран дошлёт по живому доку.
5. **Подпись** Stripe-style: `X-Signature: t=<unix>,v1=<hmac(secret, t.body)>`,
   окно 300s, подпись пересчитывается НА КАЖДУЮ попытку, `deliveryId` один на
   доставку. `redirect:'error'` — подписанный POST никогда не уезжает за 3xx.
   Ретраим network/timeout/5xx/429; 4xx и redirect — немедленный give-up.
6. **Активация — runtime-конфиг** `ppWebhookQueue/_config {enabled, url,
   debounceMs}` (TTL-кэш 60s): kill switch и смена URL БЕЗ редеплоя
   (house-DORMANT паттерн; `defineString` отвергнут — параметры запекаются на
   деплое). В Secret Manager только `PP_WEBHOOK_SECRET`; его ротация =
   редеплой (PP-верификатор принимает список ключей — см. контракт §7).
   URL-валидация: только https без user:pass; http — исключительно
   127.0.0.1/localhost (эмулятор). Не сконфигурировано → тихий no-op
   (1 info-лог на инстанс, без значений).
7. **Fail-safe**: модуль пишет ТОЛЬКО в top-level `ppWebhookQueue` (клиентам
   закрыта implicit default-deny; явный deny-блок — в следующий §2-gated
   rules-pass, чтобы защита не зависела от будущего catch-all). НИКОГДА не
   пишет в `buildings/*` (не взаимодействует с `_savedRev`-гардом FIXES_LOG 65),
   монолит, payments, Stripe. Тело хендлеров целиком в try/catch + `retry:false`
   → нет event-redelivery штормов; Firestore-триггеры асинхронны post-commit —
   упавший вебхук физически не может откатить породившую запись.
8. **Лог-контракт**: никогда не логируем url/секрет/подпись/тела (и не читаем
   тело ответа PP). Только `{buildingId, attempts, status, reason, durationMs}`.

## Латентность (честная)

Leading edge — секунды. Trailing: типично 60–120s, worst-case ≈2 мин до
первой попытки, ≈3.5 мин доставка при ретраях к флапающему приёмнику.
Rate cap: ≤1 claim/60s на здание = ≤5 POST/мин при сегодняшних 5 зданиях.

## Активация (runbook)

1. Тони (до первого деплоя): `firebase functions:secrets:set PP_WEBHOOK_SECRET`
   (256-bit hex; без секрета деплой с `secrets:[…]` упадёт/спросит).
2. GO-деплой: `firebase deploy --only functions:ppNotifyBuildingChanged,functions:ppNotifyPaymentChanged,functions:ppWebhookFlushScheduled,functions:ppOfficeExport`
   (последний — редеплой ради excelId-фильтра dba6957). Задеплоено = DORMANT:
   конфиг-дока нет → no-op.
3. Когда PP-приёмник готов:
   `GOOGLE_APPLICATION_CREDENTIALS=… node scripts/admin-firestore.js pp-webhook-config --enable --url=https://… --confirm`
4. Kill switch (мгновенно, без редеплоя):
   `… pp-webhook-config --disable --confirm` (триггеры увидят ≤60s).

Rollback: `firebase functions:delete ppNotifyBuildingChanged ppNotifyPaymentChanged ppWebhookFlushScheduled --region us-central1` + (опц.) откат ppOfficeExport на e2f3683-билд.

## Тесты

- Pure-Node: `node functions/pp-webhook.test.js` (81 assert: HMAC-векторы,
  hash-стабильность, таблица debounce, классификатор ретраев, конфиг-валидатор,
  payload-контракт, deliverWebhook с мок-fetch).
- Эмуляторный E2E: `firebase emulators:exec --only firestore,functions
  "node functions/test-harness/run-e2e.js"` (нужен `functions/.secret.local` c
  `PP_WEBHOOK_SECRET=emulator-test-secret` и PATH на OpenJDK). 11 сценариев:
  bootstrap-burst, leading/trailing, metadata-only, geometry-only, payments
  (paid/void/echo), flaky→доставка с 4-й, dead→give-up+lastError, delete,
  staging, kill switch.

## Известные ограничения v1

- Give-up = потеря нотификации (компенсируется обязательным периодическим
  полным pull'ом PP — контракт §5).
- ≥60s — между claim'ами; во время retry-хвоста транзиентно возможны 2
  in-flight доставки на здание (PP обязан терпеть out-of-order/конкурентные —
  он всё равно пуллит текущее состояние).
- Смена формы `curateBuilding` (новый релиз экспорта) → разовый re-fire по
  каждому зданию при первой следующей записи.
- Pre-existing (НЕ этот дизайн): `_mirrorBuildingV2CF` затирает `_savedRev`
  на buildings-доках — отдельная задача (чип «Fix CF mirror wiping _savedRev»).
