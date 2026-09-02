# FIXES_LOG — Canonical Regression Memory

> **Mandatory reading** before editing any payment, finance, lease, invoice,
> balance, late-fee, deposit, Stripe, report, or floor-map logic. Every entry
> below describes an invariant a future change MUST preserve. If you touch a
> listed file or function, cite the relevant entry number in your PR handoff.

## Purpose

This file is the **single source of truth** for previously-fixed bugs and the
invariants they established. It exists to stop one Claude session from
silently undoing what another Claude session already fixed. Each entry is
load-bearing — do not delete entries; mark them `superseded` (with a pointer
to the replacement entry) if a fix is intentionally rewritten.

## Status values

- **active** — fix is on `main` and protected. Editing the listed
  files/functions requires preserving the listed invariant.
- **needs-porting** — fix exists on a feature/fix branch but is **not yet on
  `main`**. The bug it addresses will reappear on `main`-based work until the
  branch is merged or cherry-picked. The "Porting note" field names the
  branch and commits.
- **superseded** — fix has been rewritten or replaced by a later entry.
  Cross-reference the new entry number in the "Bug it fixed" field.

## Entry template

```
### N. <short title> (YYYY-MM-DD)

- **Status:** active | needs-porting | superseded
- **Branch / commit:** <branch> @ <sha> (or multiple shas, oldest-first)
- **Area:** <feature area — e.g. Finance / billing / Stripe integration>
- **Files:** <repo-relative path, one per line>
- **Functions:** <fn names — comma-separated or one per line>
- **Bug it fixed:** <one or two sentences. Cite operator-visible symptom>
- **Invariant — DO NOT BREAK:** <the rule a future edit must preserve>
- **Verification:** <how to manually confirm the invariant still holds>
- **Regression test:** <automated test path, or "none — manual UI only">
- **Related PR / issue:** <link or "none">
- **Porting note:** <only for `needs-porting` — which branch, which commits>
```

---

## Active invariants (sorted newest-first)

> _Entries 1-7: **active** (Entries 1-2, 6-7 ported 2026-05-13;
> Entries 3, 5 ported 2026-05-13; Entry 4 ported 2026-05-17 via the
> cool-faraday merge `5ad0661`). All originally-listed branches in the
> "Recommended porting order" section below are now satisfied._
>
> **Pre-deploy invariant check is live as of 2026-05-13.**
> `scripts/check-invariants.sh` runs as the `hosting.predeploy` hook in
> `firebase.json`. It greps `floor-map-editor.html` for every greppable
> invariant in this file. If any check fails, `firebase deploy --only
> hosting` aborts before upload. When you port a new entry below, add a
> corresponding `check_gate` line to the script.

---

### 79. No-document automatic renewal: step 0 «are the terms changing?» + expired-lease alert (lease/renewal-flow + revenue, 2026-09-02)

**Problem (операторский + денежный):** договор Kiwi (и подписанные PDF-оригиналы) содержит auto-renewal клаузу — продлевается сам, подписывать нечего, если условия не меняются. А flow «Add renewal» умел только производить документ (Generate/Upload/Track), и главное: **незаписанное продление молча останавливало биллинг** — серверный `runAutoInvoices` гейтится по `u.until` (functions/index.js ~5208), late fees глохнут через 30 дней, а renewal-алерт (`_renderRenewalAlert`) исчезал ровно в день истечения (`daysLeft < 0 → return ''`) — тишина вместо тревоги.

**Fix:**
1. **Шаг 0 в Add renewal** (только kind='renewal'): «Are the contract terms changing?» — карточки 'auto' / 'changed'. 'changed' → прежний flow без изменений. 'auto' → расчётная панель (текущий конец, терм, новый конец, рента без изменений) и кнопка «Record renewal» → `_saveAutoRenewalRecord()`: пишет ТОЛЬКО `u.until` (годовщинная арифметика `_autoRenewAddMonths` — 15 Sep + 6 мес = 15 Mar, как в договоре; СОЗНАТЕЛЬНО не end-of-month конвенция `_leaseEndFromStartTerm`), `delete u.renewal`, сеет `u.renewalTerm` (ранее поле нигде не писалось — все конверты уносили дефолт «Monthly, market-adjusted»), кладёт запись в `leaseDocuments` (type='renewal', source='external', `autoRenewal:true`, без файла — «Upload version» скрыт, sourceLine «Automatic renewal per contract»), `recordOutreach('status', …)` → Activity + Audit. `leaseStart` и рента не трогаются (§3). Акт = подтверждение оператора (§0.2 rule 3 — как upload/external signed). Право на 'auto': не-M2M, живая tenancy, валидный `until`, числовой `leaseTerm` (`_autoRenewEligible`).
2. **Expired-ветка алерта:** `daysLeft < 0` больше не гасит плашку — красный алерт «Lease ended N d ago — auto-invoicing is stopped» с кнопками [Record auto-renewal] (openRenewalFlow с `{mode:'auto'}` — модалка открывается с предвыбранным авто-режимом) / [Renew…] / [Ends — confirm]. В окне 0-60d добавлена та же кнопка + подсказка «Auto-renews for N mo unless 60-day notice».
3. **`requireLeaderTab` в `_saveAddLeaseDocModal`** (Entry 16-класс, дыра существовала во всём Add-document flow): follower-вкладка раньше мутировала u.* локально, push тихо отклонялся, onSnapshot откатывал — «ghost success». Теперь честная ошибка + предложение take over.

**Invariant:** запись авто-продления НЕ создаёт/не имитирует подписание: никакого envelope, никакого файла, только `u.until` + doc-запись с `autoRenewal:true` + outreach. Expired occupied non-M2M юнит без решения «ending» ОБЯЗАН показывать алерт (билинг остановлен — тишина недопустима). Любой писатель unit-полей в Add-document flow проходит `requireLeaderTab`.

**Verification:** parse-check 4/0; функции `_autoRenewAddMonths`/`_autoRenewEligible`/`_renderRenewalAlert` прогнаны в браузере на localhost:5599 на данных 346-го (15.09.2026 + 6 → 15.03.2027; клампинг 31-го числа; expired-ветка рендерится с обеими кнопками); гейты Entry 77/78/79 зелёные.

### 78. Preview un-filled real values into bare token chips; renewal envelope carried signing date instead of commencement (lease/preview+send, 2026-09-02)

**Symptom:** после Entry 77 оператор снова видит в Preview·Lease по Suite 346 голый чип `{{lease_start}}` («All 1 field mapped») на месте Start Date — хотя override давно сброшен, каскад уходит в динамический library-default и `u.leaseStart='2026-03-15'` на месте. Вопрос оператора: «почему дата сама не подставляется».

**Root cause (два независимых слоя):**
1. **Превью (косметический, но вводящий в заблуждение):** в документе дата БЫЛА подставлена («March 15, 2026»). Её «раззаполнял» сам превью-токенизатор: `_ltPreviewTokenize` шаги 0/0b (`_ltAutoTokenizeHtml` + `_ltExtractProseValues`) прогонялись и по УЖЕ подставленному live-документу; prose-правило `'Start Date:' → lease_start` (`__date` regex) вырезало реальную дату и ставило на её место литерал `{{lease_start}}` в локальной копии html; tokens.size стал 1 → модалка авто-открылась в fields-режиме → оператор видел чип вместо даты (sample-режим и реальный документ несли верную дату). Один Start Date из всей Schedule A — потому что остальные `<li>` не матчат anchored-правила (Fee ≠ Rent, «Deposit/» ломает `[:\-—]`, и т.д.).
2. **Отправка (реальный баг в конверте):** `_slBuildPayloadFromForm` строил `leaseStartRaw = u.signed || u.leaseStart` — для renewal/amendment (pend без effDate) конверт уносил дату ПОДПИСАНИЯ старого договора (Feb 13, 2026) вместо даты начала (Mar 15, 2026). Расходился и с превью (оно читает `u.leaseStart` через `_liveLeaseFields`), и с решением §3 (2026-07-03: renewal не двигает start; leaseStart = commencement).

**Fix:** (1) `_ltPreviewTokenize(html, opts)` + `opts.skipAutoExtract`: шаги 0/0b пропускаются; `_previewLeaseTemplate` передаёт `{ skipAutoExtract: !!u }` — для live-документа с реальным юнитом smart-map выключен, tokens.size=0 → модалка сама падает в sample-режим с реальными значениями. Raw-шаблоны (редактор, `_previewLibraryTpl` без opts, workspace-превью с u=null) — прежнее поведение. (2) `_slBuildPayloadFromForm.lease_start`: при pending renewal/amendment — `u.leaseStart || u.signed` (commencement first); новая лиза — `pend.effDate` как раньше; без pending — легаси `u.signed || u.leaseStart` не тронут (bulk-рассылка на ~140117 тоже не тронута).

**Invariant:** превью live-документа (резолв с `asRawTemplate:false`) НЕ прогоняется через auto-extract (шаги 0/0b) — smart-map существует только для raw/недоконвертированных шаблонов. Конверт renewal/amendment несёт Start Date = `u.leaseStart` (commencement), не `u.signed`.

**Verification:** parse-check 4 blocks/0 errors; `_ltPreviewTokenize` вызван напрямую в браузере на localhost:5599 — с `skipAutoExtract:true` подставленный Schedule A возвращает tokens.size=0, без опции воспроизводится вырезание даты; check-invariants Entry 77+78 зелёные.

### 77. Renewal end date frozen: stored lease templates went to DocuSign verbatim (lease/data-integrity, 2026-09-02)

**Symptom:** оператор продлевает договор (Add document → kind=renewal → Generate & e-sign), в форме Lease End = новая дата — а превью и сам документ несут СТАРУЮ дату окончания текущей лизы («при продлении дата окончания не меняется»). На Suite 346 превью показало End Date: September 15, 2026 при новой дате 03/23/2027, плюс голый чип `{{lease_start}}` («All 1 field mapped»).

**Root cause (двухслойный):**
1. `_resolveLeaseTemplate` для сохранённых шаблонов (`u.leaseTemplateOverrides[kind]` → source='unit'; `state.settings.leaseTemplates[kind]` → source='workspace') возвращал HTML вербатим и в live-режиме: `opts.liveOverrides` (новые lease_end/term/rent из формы продления, приезжающие через `_slBuildPayloadFromForm` overlay Entry 73) молча игнорировались, `{{токены}}` не подставлялись вовсе — `docusignSendEnvelope` кодировал этот HTML в конверт как есть. Все остальные источники (library static/generated) прогоняются через `_liveLeaseFields(u, liveOverrides)` — только эти две ветки были сырыми.
2. Превью «📄 Preview lease» из send-модала (`_slOpenLeasePreview` → `_previewLeaseTemplate`) рендерило поля из текущего юнита БЕЗ отложенных условий `_slPendingRenewal` (они по Entry 73 сознательно не пишутся в юнит до отправки) — старая дата в превью даже для generated-шаблона.

**Fix:** новый хелпер `_renderStoredLeaseTpl(source, tpl, u, opts)`: raw-режим (редакторы) — вербатим как раньше; live-режим — `_ldSubstituteMergeTokens(tpl.html, _liveLeaseFields(u, opts.liveOverrides) + rent_table_html)` — тот же путь, что у static library-шаблонов; обе ветки resolve переведены на него. `_previewLeaseTemplate` принимает `unitContext.liveOverrides` и прокидывает в resolve; `_slOpenLeasePreview` собирает их из `_slPendingRenewal` (lease_end/term/rent; lease_start только для kind='lease' — renewal не двигает start, решение Tony 2026-07-03 §3). Сохранённый объект шаблона не мутируется (Object.assign-копия). Верифицировано на localhost:5599: unit-override с токенами получает March 23, 2027; raw-режим байт-в-байт; без override каскад уходит в library-default с новой датой и без старой.

**Invariant:** ЛЮБАЯ ветка `_resolveLeaseTemplate`, возвращающая сохранённый HTML, в live-режиме (`asRawTemplate:false`) ОБЯЗАНА подставить merge-токены через `_liveLeaseFields(u, opts.liveOverrides)`. Превью документа с отложенными (ещё не применёнными к юниту) условиями обязано получать их через liveOverrides, а не читать юнит.

**Data caveat (Tony action):** у Suite 346 сохранён пер-юнитовый override, где значения ЗАПЕЧЕНЫ статикой (End Date: September 15, 2026 — текст, не токен). Код-фикс подставляет токены, но статический текст не лечит: override надо сбросить (Add document → Edit template → Reset to workspace default) или пересохранить с `{{lease_end}}`-токенами. До сброса конверт по 346 продолжит нести старую дату.

### 76. Audit batch-4 CF hygiene: rate-limits on money callables, PII masking, dead-checkpoint removal (robustness/security, 2026-07-03)

**From audit 2026-07-03 P2 (§2 GO Tony). Deployed 3b8935a → 9 function targets.** Rate-limits (reuse createStripeInvoice counter pattern, fail-closed BEFORE Stripe call): stripeDiscountInvoice 40/ws-hr·5/unit-day, markInvoicePaidOutOfBand 40·5, voidOrDeleteStripeInvoice 40/ws-hr (no unitId in req.data). `_maskEmail` on 7 logger.* Cloud-Logging sites (audit docs untouched). Dead checkpoint in runAutoInvoices REMOVED (never called; resume relies on durable autoSentYm stamp) — the WORKING checkpoint in runAutoLateFees is untouched. No money-math change; §0.2 invariants intact.

### 75. Audit batch-1 server: late-fee Stripe-blind, $0 late-fee invoices, webhook coverage gaps, null-leaseStart phantom fees (finance/robustness, 2026-07-03)

**From audit 2026-07-03 (AUDIT_REPORT_2026-07-03.md, §2 GO Tony). Deployed a779c05 → stripeWebhook,runAutoInvoices,triggerAutoInvoicesNow,runAutoLateFees,triggerAutoLateFeesNow.**

Fixes: (1) runAutoLateFees/_computeOverdueMonths dup-search rent-invoice before fining; paid → skip + opportunistic ledger heal (capture-inside-mutate Entry 74, rent-line amount Entry 70, Entry 72 spread, Entry 71 only-advance); refund/bounced/partial rows guarded (dissent + in-mutate race guard) — real unpaid still fined; LIVE-only. (2) null-leaseStart gate: _computeOverdueMonths→[] + runAutoInvoices logs+dead-letter (no phantom fees after clobber/restore). (3) invoice-first late-fee cron (exclude→items→finalize→send, stamp after success never backwards; $0-shell excluded; stuck-draft resumed not re-stamped). (4) webhook: case invoice.paid (idempotent), case charge.dispute.closed (reads Dispute→charge→invoice; lost→bounced+audit); dead-letter on all silent returns (voided/refunded/failed); building-mirror failure → rethrow → Stripe Smart Retry (opts.rethrowMirrorFailure on 6 money sites; crons/callables keep warn-only default).

**OPEN (Tony action):** enable `invoice.paid` + `charge.dispute.closed` in the Stripe Dashboard webhook subscription — until then those two cases are dead (no harm; rest is live). 414/Fyffe after restore MUST get a valid ISO leaseStart or the null-leaseStart gate dead-letters it instead of billing.

### 74. All 4 payment mirrors used post-mutate re-read → silent write loss under strip (finance/data-integrity, 2026-07-03)

**Symptom class (аудит P0):** handleInvoicePaid/handleInvoiceVoided/handleChargeRefunded/confirmBankMatch зеркалили rec в v2-коллекцию из POST-mutate re-read (`_stateIfSyncV2` → findUnit), который под syncBuildingsStrip рехидрируется из ЕЩЁ НЕ обновлённой коллекции → свежая запись терялась (та же механика, что Entry 70). Именно поэтому reconcile dry-run находил расхождения после каждого биллинг-цикла.

**Fix (e27b966, deployed stripeWebhook+confirmBankMatch):** захват rec + routing-ключей в closure-переменные ВНУТРИ колбэка mutateWorkspaceState в момент записи; сброс captures в начале колбэка (txn-retry-safe); в paid — anchor + advance-сиблинги из того же снапшота, включая idempotent already-applied ветку (Smart-Retry re-heal); `_stateIfSyncV2` остался только гейтом.

**Invariant (правило №1 аудита — порти во все будущие CF-зеркала):** любой CF, зеркалирующий запись в v2-коллекцию, обязан брать rec из closure-переменной, заполненной ВНУТРИ mutateWorkspaceState. Post-mutate re-read как источник данных для зеркала ЗАПРЕЩЁН.

**Acceptance:** первый reconcile dry-run после следующего биллинг-цикла должен показать ноль расхождений.

### 73. Renewal via DocuSign rewrote the ACTIVE lease before any envelope was sent (lease/data-integrity, 2026-07-03)

**Symptom:** оператор нажал [Renew…] → в Add-Document модале (kind=renewal, source=docusign) кликнул главную кнопку → посмотрел lease preview → закрыл, НИЧЕГО не отправив. Действующая лиза уже переписана: Suite 428 until Jul31→Oct31, leaseTerm 6→3, документов 0, конвертов 0.

**Root cause:** DocuSign-ветка `_saveAddLeaseDocModal` (осознанное решение Entry 21 «не терять ввод, даже если не отправил» — правильное для НОВОЙ лизы на пустом юните) писала unit-поля и saveState() ДО создания конверта, а док не создавала вовсе. Для renewal на занятом юните это молчаливая перезапись действующего договора.

**Fix (36c41b0):** для kind='renewal'+source='docusign' поля идут в `window._slPendingRenewal` и применяются в `_slDoSend` ТОЛЬКО после успешной отправки (до снапшота u.leaseEnvelopes); документ несёт новые term/lease_end/rent через overlay в `_slBuildPayloadFromForm`; закрытие send-модала без отправки сбрасывает pending (тост «Renewal NOT applied»); чужой pending гасится при открытии модала другого юнита.

**Invariant:** операция над ДЕЙСТВУЮЩЕЙ лизой (renewal/amendment) не должна мутировать unit-поля раньше завершения акта (отправка конверта / загрузка подписанного файла). kind='lease' на пустом юните — Entry 21 остаётся в силе.

### 72. Rec-rebuild writers wiped payment metadata + falsy amount fallback in invoice.paid (finance/data-integrity, 2026-07-03)

**Symptom class (latent, caught pre-incident):** четыре серверных писателя пересобирали `u.payments[ym]` с нуля (handleInvoicePaid, handleInvoiceFailed, reconcile apply, full-refund writer) — любые метаданные на строке (с 2026-07-03: discount-поля `wasDiscounted/discountAmount/discountReason/…`) молча исчезали при следующем событии оплаты/фейла/рефанда. Плюс `(invoice.amount_paid || invoice.total || 0)` в invoice.paid: falsy-fallback записал бы ПОЛНУЮ сумму как собранную для счёта с amount_paid=0.

**Fix (3fd1b0c):** хелпер `_discountFieldsOf(rec)` (functions/index.js ~:404) — единственный источник discount-полей; все четыре писателя spread-сохраняют их из prior-rec; fallback заменён на явный null-check (`amount_paid != null ? amount_paid : total`).

**Invariant (порти в новые писатели):** ЛЮБОЙ писатель, пересобирающий `u.payments[ym]` объектом-литералом, ОБЯЗАН spread-сохранить `_discountFieldsOf(prior)` (и любые будущие метаданные-семейства). Не использовать falsy-fallback на денежных полях Stripe-событий — только явный null-check.

**Context:** родился из фичи скидок (stripeDiscountInvoice, credit note на открытый счёт — docs/invoice-discount-design-2026-07-03.md). Скидка пишется callable-ом синхронно (mutateWorkspaceState + _writePaymentV2 mirror под strip-гейтом — Entry 70 паттерн, rec захватывается ВНУТРИ txn-замыкания, не re-read). Идемпотентность: creditNotes.list fingerprint + Stripe idempotencyKey. v1-запреты: 100% (→ waiver), paid-счета (→ refund-флоу), advance-якоря.

**Known v1 edge (accepted):** void скидочного счёта оставляет discount-поля на rec (фантомная строка в bridge Discounts до ручной чистки) — display-only.

### 71. lastInvoiceYm stamp regressed by back-month writes → paid-green units with OPEN invoices (display/data-integrity, 2026-07-02)

- **Status:** active (healed + guarded, deployed)
- **Branch / commit:** main @ `f26329e` (F1/F1b/F2) + `572945d` (heal cap+whitelist). Deployed: `functions:reconcileStripeInvoices` + `functions:stripeWebhook`.
- **Area:** functions/index.js — reconcile apply stamp write, handleInvoicePaid stamp write (~3330), healStamps mode; client readers of `u.stripe.lastInvoiceYm` (_unitRentCurrentStatus, grid _invoiceSentThisYm, reminder buttons)
- **Bug it fixed:** BOTH reconcile apply AND `handleInvoicePaid` stamped `lastInvoiceId/lastInvoiceYm` UNCONDITIONALLY. The Entry-70 June batch therefore regressed 21 units' stamps `2026-07→2026-06` (each had a live July `-v2` invoice). Symptom (suite 412): map tile/header pill GREEN «Deposit paid · Jul» while the July $800 invoice is OPEN — `_unitRentCurrentStatus` misses the current-month branch and falls to the deposit-paid fallback; Reminder buttons re-targeted the paid June invoice; client catch-up dedupe gate disarmed. Same hole fires webhook-side whenever a tenant pays an OLD open invoice after a newer one is issued. Discovered via adversarial workflow wf_63898b05 (also found: $0-twins are status='paid' and would win a naive max-ym heal; future advance invoices — 337 Jul+Aug — would capture the stamp and manufacture the same bug).
- **Fix:** (F1) reconcile apply + (F1b) handleInvoicePaid: stamp writes only when `ym >= current stamp ym` (validated YYYY-MM; '>=' keeps same-month restamp; invalid/empty current → allow). (F2) `healStamps` mode in reconcileStripeInvoices: stamps-only repair, zero u.payments writes — candidate per unit = latest metadata-ym REAL rent invoice, **capped at the current UTC month** (future advance invoices never win), $0-shells excluded (`rentLineAmount>0 || total>0`), groups/void/draft excluded, `onlyInvoiceIds` whitelist honored, strict `>` on write, txn-retry-safe. Healed 2026-07-02 with 21-id whitelist: 20×(06→07) + 246; **337/224 + 11 null→old-month rows deliberately NOT applied**. Verified in building docs post-heal.
- **Invariant — DO NOT BREAK:** `u.stripe.lastInvoiceYm` NEVER moves backwards from any writer (webhook, reconcile, future tools); heal candidates NEVER exceed the current month; $0 'paid' shells NEVER become the stamp. Remaining unguarded writers (createStripeInvoice ~1567, client stamp writers 144767/91823/92155/93810) are operator-initiated — port the guard when touched.
- **Verification:** pre-check healPlan 21/21 rows `06→07`; post-heal GETs on b1/BayVista docs: 412/433/431/341/246 all lastInvoiceYm=2026-07 with July invoice ids, autoSentYm untouched.
- **Regression test:** none (live-verified)
- **Related PR / issue:** Entry 70 (the batch that triggered it); RECONCILE_PLAN_2026-07-02.md.
- **Porting note:** deployed us-central1 2026-07-02. Pre-heal backup: backups/pre-healstamps-2026-07-02/.

---

### 70. invoice.paid webhook silently dropped card payments → $25,674 missing from ledger; hardened reconcile recovered 42 payments (finance/data-integrity, 2026-07-02)

- **Status:** active (recovery COMPLETE; webhook hardening = Этап 4, pending)
- **Branch / commit:** main @ `01f46ce` (reconcile crash fix) + `3737dc5` (hardened apply + RECONCILE_PLAN_2026-07-02.md). Deployed: `functions:reconcileStripeInvoices`.
- **Area:** functions/index.js — stripeWebhook/handleInvoicePaid (~2910), reconcileStripeInvoices (~2300); ledger `workspaces/default/payments/*`
- **Bug it fixed:** two bugs. (A) `handleInvoicePaid` FAIL-CLOSES (returns 200, Stripe never retries) on any transient verify error (~2968-2972) → June (bulk-billed May 28) and July (backfill Jul 1) card payments were paid on Stripe but NEVER recorded in the ledger: **42 payments / $25,674.16** (18×Jul $12,125 + 23×Jun $12,849.16 + 315-May $700). Symptom chain: «Last payment: June», phantom aging owed (Suite 433 case), grid blue-while-header-green split-brain (Suite 452). (B) `reconcileStripeInvoices` — the recovery tool itself — was UNUSABLE: metadata-match returned `{building,floor,unit}` where downstream reads `{b,f,u}` → 500 crash on every auto-invoice; and its apply-path was a TRAP: wrote every paid invoice as rent (deposits/fees/$0/re-issues), amount=whole invoice, and under buildings-strip the write never persisted (monolith re-strips :316, building mirror deletes u.payments :233, `_writePaymentV2` never called) while still reporting appliedCount>0.
- **Fix:** multi-agent workflow (5 analysis lenses + live Firestore spot-check + adversarial review = NO-GO on naive apply) → staged plan (RECONCILE_PLAN_2026-07-02.md). Hardened apply: (1) post-txn `_writePaymentV2` mirror per applied month (handleInvoicePaid pattern ~3306); (2) amount = rent-purpose line items only; (3) per-row gates — $0-artifact, non-rent, month-already-settled (free/waived/paid&amount>0; paid+$0 shell counts NOT settled), group-member, advance-anchor, before-lease-start, purpose-unknown, ym-not-explicit (created-date fallback never auto-writes); (4) `onlyInvoiceIds` whitelist — apply writes only operator-confirmed ids, whitelist overrides ONLY soft gates; (5) txn-retry-safe counters; prior non-settled record preserved into `history` (354/417 late→paid upgrades). Recovery executed with verified pre-write backup (backups/pre-reconcile-2026-07-02/) in batches (452 reference → 17 July → 24 June/May), every doc GET-verified after write: **42/42 paid, correct amounts, zero dupes** (concurrent double-run converged — writes are absolute-value idempotent).
- **Invariant — DO NOT BREAK:** (1) reconcile apply MUST mirror every applied month via `_writePaymentV2` — a `u.payments` write inside `mutateWorkspaceState` alone does NOT persist under strip; (2) apply MUST derive rent amount from rent-line-items, never invoice `amount_paid`; (3) `month-already-settled` MUST treat `paid && amount===0` as NOT settled; (4) never bulk-apply without the whitelist on live data; (5) the 72 $0-shell invoices, deposits (D-), late fees (L-/X-) stay OUT of the rent ledger.
- **Verification:** live GETs on all 42 payment docs post-write (paid, exact rent amounts, linkedVia reconcile:metadata, 354/417 history=1 prior:late). Gates live-tested: 72 $0 + 32 non-rent + 28 settled + 74 tracked + 42 purpose-unknown correctly skipped.
- **Regression test:** none (recovery operation; gates exercised on live dry-run)
- **Related PR / issue:** RECONCILE_PLAN_2026-07-02.md (full staged plan + adversarial appendix). Root-cause hardening of the webhook itself (throw-for-retry on transient errors + dead-letter) = Этап 4, NOT yet shipped — until then dropped events remain possible; re-run reconcile dry-run after each billing cycle as a stopgap.
- **Porting note:** deployed to prod us-central1 2026-07-02. Excluded pending operator decision: 437-May $2 (test junk), 414-May $400 (ambiguous, equals its deposit).

---

### 69. Invoices table right-edge clip — silent-refresh wiped table-prefs every 30s (UI/recurring-regression, 2026-06-10)

- **Status:** active
- **Branch / commit:** `fix/invoice-table-clip` @ `ab392b9`, merged to main
- **Area:** Billing → Invoices table (#invTable, renderInvoicesPage/renderInvoicesHeader ~L143420); table-prefs system
- **Bug it fixed:** rightmost columns (CREATED/SENT BY) clipped with no affordance; «fixed» repeatedly, always regressed. THREE stacked causes (measured): (1) Σ column widths 1410px > container with macOS overlay scrollbars invisible (0 layout px) → legit overflow read as hard clip; (2) SMOKING GUN — the 30s silent auto-refresh re-built the thead, wiping applyTHWidth inline widths/resizers/hidden-cols, and the sig early-return exited BEFORE mountTablePrefs → layout oscillated every 30s, so every prior CSS fix appeared to work then broke; (3) unbounded sfa_inv_col_widths prefs synced via Firestore re-poisoned every device after each fix (900/1200px cols). Bonus: checkbox TH collapsed to 0px under fixed-layout deficit.
- **Fix:** .inv-scroll-wrap with overflow-x:auto + custom ::-webkit-scrollbar (permanently visible when overflowing; NOTE scrollbar-width:thin DISABLES ::-webkit-scrollbar in Chrome 121+ — do not re-add); silent-refresh no longer rebuilds thead (and every thead-rebuild path now reaches mountTablePrefs; sig reset on empty branch); makeTableResizable restore clamps [40..640] for ALL tables; one-time _sanitizeInvColWidths() heals the Firestore copy for keyBase sfa_inv_col_widths only; checkbox TH fixed 36px.
- **Invariant — DO NOT BREAK:** any code path that rebuilds a prefs-mounted table thead MUST re-run mountTablePrefs afterwards (or not rebuild on silent refreshes); width-prefs restore paths MUST clamp; never style scrollbars with scrollbar-width:thin alongside ::-webkit-scrollbar.
- **Verification:** headless Chromium @1400/@1100 with absurd prefs + silent-refresh flow: visible 11px h-scrollbar in all scenarios, no silent clip, prefs clamped, checkbox 36px.
- **Regression test:** none — manual + headless probe (agent-run).
- **Related PR / issue:** prior symptom patch 52d8cfb (scrollbar-gutter) — superseded by this root-cause fix.

---

### 68. Backup snapshots were empty shells under strip-ON — rehydrate + chunked verify + cascade prune (backup/data-safety, 2026-06-10)

- **Status:** active (deployed 2026-06-10; live-verified — frequent snapshots now chunked=true, 5 chunks, ~1.15MB with rehydrated buildings vs 48KB empty shells before)
- **Branch / commit:** `fix/backup-collections` @ `5810147`, merged via `cf5a067`. Deployed all 5 touchers: frequentBackupSnapshot, dailyBackupSnapshot, monthlyBackupVerify, takeManualBackup, restoreBackup
- **Area:** Backups (`_writeBackupSnapshot` / frequent+daily crons / prune / monthlyBackupVerify)
- **Files:** functions/index.js
- **Functions:** `_writeBackupSnapshot` (~4812), `_pruneOldBackups`, `_pruneOldFrequentBackups`, `monthlyBackupVerify`; test hooks under `SFA_TEST_EXPORTS`
- **Bug it fixed:** under buildings-strip (LIVE since ~2026-06-01) every snapshot read the raw monolith → stored `buildings: []` and no payments — ALL backups since ~June 4 were useless shells (CLAUDE.md §0.1 violation). Confirmed empirically in the 2026-06-09 Suite 344 incident: PITR was the only recovery source. Three latent companions: prune never deleted the `chunks` subcollection (orphan leak the moment chunking activates), `monthlyBackupVerify` read only the main doc (false «buildings empty» alarm on every chunked backup), and a failed rehydrate would have produced silent empty backups again.
- **Fix:** (1) `_writeBackupSnapshot` rehydrates via the existing strip-aware `_rehydrateStateForStripCF` (buildings from collection + payments merged into `u.payments`) before serializing — size goes >800KB → existing chunked path handles it; (2) explicit FAIL-LOUD: strip-ON + empty buildings after rehydrate → throw (cron error, not a phantom-success backup); (3) chunked path got the same read-back verify as inline (reassemble, compare building count); (4) both prune fns cascade-delete `chunks/*` before the parent (one batch per backup, ≤ ~20 ops); (5) `monthlyBackupVerify` reads via `_readBackupSnapshotBody` (reassembles chunks).
- **Invariant — DO NOT BREAK:** every backup snapshot MUST contain the rehydrated buildings (non-empty under strip-ON) and pass read-back verify; pruning MUST cascade into `chunks`; verify paths MUST read through `_readBackupSnapshotBody`, never the main doc alone.
- **Verification:** `firebase emulators:exec --only firestore "SFA_TEST_EXPORTS=1 node functions/test-harness/test-backup-collections.js"` — 13 asserts incl. the incident regression case (tenant+deposit stamp+merged payments present in a chunked, read-back-verified snapshot; empty rehydrate throws; prune cascades). All passed 2026-06-10.
- **Regression test:** functions/test-harness/test-backup-collections.js (emulator; local-only)
- **Related PR / issue:** docs/incident-2026-06-09-suite344.md (lesson #3). Cost: rehydrate ≈ +1.3k reads / 15-min snapshot ≈ $2-3/mo; chunked storage ≈ 350MB resident at 48h frequent retention.
- **Porting note:** DEPLOYED 2026-06-10 (targeted: 3 crons + takeManualBackup + restoreBackup). Live verification same day: 3 consecutive 15-min snapshots chunked with buildings.

---

### 67. CF building mirror wiped _savedRev — Entry 65 guard floor reset by every server mirror (sync/data-safety, 2026-06-09)

- **Status:** active (deployed 2026-06-10 03:34Z, full `firebase deploy --only functions`)
- **Branch / commit:** `fix/cf-mirror-savedrev` @ `83614f6`, merged to main via `d6f4784`. Deploy was forced by the 2026-06-09 Suite 344 incident (docs/incident-2026-06-09-suite344.md): this exact hole let a stale tab clobber building b1 — webhook deposit mark-paid 06-08 22:01Z wiped _savedRev, stale client wrote rev=2 on 06-09 12:30-12:45Z. Restored from PITR 12:30Z + _savedRev floors raised to 50000 on b1/Pasadena/BayVista. New Tampa & Tech Data survived BECAUSE their floors were intact — live proof the Entry 65 guard works when not wiped
- **Area:** Sync / buildings-strip mirror — SERVER write path (`_mirrorBuildingV2CF`)
- **Files:** functions/index.js
- **Functions:** `_mirrorBuildingV2CF` (~248); test hook `exports._test_mirrorBuildingV2CF` (env-gated `SFA_TEST_EXPORTS=1`, invisible to deploy discovery)
- **Bug it fixed:** `_mirrorBuildingV2CF` did a full `.set()` of `{_schema, buildingId, doc, _mirroredAt, _mirroredBy}` WITHOUT `_savedRev`. Every server-side mirror (Stripe webhook → mutateWorkspaceState, runAutoInvoices / runAutoLateFees crons) therefore DELETED `_savedRev` from `workspaces/{ws}/buildings/{bid}`. The Entry 65 Layer-2 rules guard (`request.resource.data.get('_savedRev',0) >= resource.data.get('_savedRev',0)`) then read resource `_savedRev` as 0 — the next stale-tab client write passed the guard, RE-OPENING the 2026-06-08 data-loss clobber vector. Found by adversarial review during the PP-webhook design (the webhook trigger observes CF-mirror writes).
- **Fix:** mirror now runs in a transaction: `tx.get` current `_savedRev` (missing/non-number → 0), `tx.set` full replacement INCLUDING `_savedRev: cur + 1`. Transaction also closes the read-modify-write race with a concurrent client mirror (tx retries with fresh rev). Legacy docs already wiped by the old code self-heal to `_savedRev: 1` on the next CF mirror. `doc` stays a FULL replace — never merge (deleted units must not linger).
- **Invariant — DO NOT BREAK:** every server-side write to `buildings/{bid}` MUST preserve-and-advance the top-level `_savedRev` inside a transaction. Never `.set()` a building doc without `_savedRev`; never lower it; never `merge:true` the `doc` field. (Extends Entry 65 invariant #2 from client writes to CF writes.)
- **Verification:** `firebase emulators:exec --only firestore "SFA_TEST_EXPORTS=1 node functions/test-harness/test-mirror-savedrev.js"` — 9 asserts: 5→6 advance, create→1, legacy-no-field→1 heal, monotonic re-mirror→7, full doc replace, pointsFlat flattening intact. All passed 2026-06-09.
- **Regression test:** functions/test-harness/test-mirror-savedrev.js (emulator; local-only)
- **Related PR / issue:** none. Related: Entry 65 (the guard this fix restores).
- **Porting note:** DEPLOYED 2026-06-10. (Historical: until deployed, prod CF mirrors kept wiping `_savedRev` — which materialized as the 2026-06-09 incident.)

---

### 66. Entire-floor lease — gross area becomes the leased/rentable area (feature/finance-surface, 2026-06-09)

- **Status:** active
- **Branch / commit:** `main` @ (this commit)
- **Area:** Floor leasing / rentable-area definition / multi-suite lease head
- **Files:** floor-map-editor.html · FINANCIAL_MODEL_REFERENCE.md (EQ-8)
- **Functions:** `_floorRentableSqft`, `_floorFullLeaseActive` (after `_floorGrossSqft`), `_floorFullLeaseEnable` / `_floorFullLeaseDisable` / `bmSetFloorFullLease` (Building modal block), `_groupCreate` (new `opts.keepStatus`), wiring in `_renderStackingChart` + summary tables, `updateStats`, `calcStatsPerFloor`, settings Manage Floors list, `renderRentRoll` KPIs, `saveBuildingModal` (flag transitions)
- **Bug it fixed:** none — feature (operator request 2026-06-09: «Когда арендуется весь этаж включается абсолютно все помещения в аренду. Т.е. гросс эрия арендуется»). Design from workflow wf_c8a13109-eb2, approved then built.
- **Invariant — DO NOT BREAK:**
  1. `_floorRentableSqft(f, base)` is a PURE resolver — `f.rentableSqft` is NEVER overwritten by this feature; disabling the flag must restore prior area numbers byte-identically.
  2. Money lives on the EXISTING group-lease head (Entry/EQ-2): no `floor.rent` / `floor.tenant` fields. Enable = `_groupCreate` over `_stRentableUnits(f)` (head = largest sqft); disable = `_groupDissolve` (keeps per-unit data).
  3. Restroom/common/circulation units are NEVER marked `rentable=true` — their area enters only arithmetically via `_floorGrossSqft`.
  4. Occupancy honesty: 100%-occupied ONLY while `_floorFullLeaseActive(f)` (head `status==='occupied'` AND `head.tenant||head.company` — LLC-only fallback). The bare flag must not inflate occupancy.
  5. `_groupCreate` third arg `opts.keepStatus` — vacant-floor enable must NOT force members to `occupied` (anti-phantom-lease). Existing callers pass no opts → behavior unchanged.
  6. Enable guards: block when the floor already has any suite group (commingling) or >1 distinct tenant. Vacant-floor enable zeroes head `contractRent` (proforma only — no phantom contract).
- **Verification:** Building modal → Floors → tick "Lease entire floor" on a floor with units → Save. Dashboard Rentable/RSF, Stacking Rentable column, Manage Floors occupancy, Rent Roll Rentable KPI all show gross for that floor; $/ft² drops accordingly. Untick → all numbers revert exactly. Vacant floor: occupancy does NOT jump to 100%.
- **Regression test:** none — manual UI only.
- **Related PR / issue:** none (auto-deploy pipeline). Design memory: project_floor_rentable_and_total_area.
- **Known limitation (v1):** units drawn on the floor AFTER enabling are not auto-added to the full-floor group (re-toggle to rebuild); no map overlay yet (planned follow-up).

---

### 65. Follower-tab building clobber → DATA LOSS (New Tampa floors 4-6); leader-gate _mirrorBuildingsToV2 (sync/data-safety, 2026-06-08)

- **Status:** active
- **Branch / commit:** `main` @ `3c81bde` (fix) + stamp `a2d763a`; data restore via Admin/REST write (not a code commit)
- **Area:** Sync / buildings-strip mirror (`syncBuildingsV2`) — client→collection write path
- **Files:** floor-map-editor.html
- **Functions:** `_mirrorBuildingsToV2` (~33619), `_mirrorBuildingsReady` (33531); compare `fbPushNow` leader-gate (`_sfaTabSync.isLeader()`, 32427)
- **Bug it caused:** Under strip-ON, buildings live in `workspaces/{ws}/buildings/{id}` and EVERY tab mirrored them on each `saveState` — `_mirrorBuildingsToV2` was NOT leader-gated, unlike `fbPushNow` (Entry 16). With 2+ tabs open, a stale FOLLOWER tab re-mirrored each building from its OWN outdated `state.buildings`, overwriting the leader's edits in the collection; the read-listener (`_v2BuildingsAttachListener`) then reverted the leader's in-memory value. Symptoms: building-field edits revert (excelId/code never stick), and — when a follower held a pre-import building — whole floors + blueprints were OVERWRITTEN with the stale version. 2026-06-08 incident: New Tampa floors 4/5/6 lost ALL units (25/32/36 → 0) + blueprints reverted; floor 3 reverted to an old 13-unit layout. Other 4 buildings + floors 1-2 intact. Diagnosed via direct Firestore REST reads (architect morning export `_rev 20073` vs current `_rev 20321`).
- **Fix:** (1) CODE — follower tabs skip the building mirror (added `_sfaTabSync.isLeader()` guard at the top of `_mirrorBuildingsToV2`, symmetric with `fbPushNow`; typeof-guard → not-ready tab-sync counts as leader so single-tab is unaffected). (2) DATA — surgically restored New Tampa floors 4/5/6 from the architect morning export into the collection doc (flattened points→pointsFlat, payments stripped, format = `_buildingForV2`), KEEPING current floors 1/2/3 (incl. 3 post-morning tenants on F3: units 305/308/310) and excelId 217.1; other buildings untouched. Written with `_mirroredBy:'incident-restore-2026-06-08'`; verified stable (no re-clobber).
- **Layer 2 — DB-enforced monotonic version (permanent, 2026-06-08 commits `c3954fc` client + `82e1563` rules):** the leader-gate alone is insufficient (a stale LEADER, or an old-code tab, still clobbers). Each building collection doc carries a top-level `_savedRev`; the v2 read paths (`_v2BuildingsAttachListener` + getDocs fallback) record the last-seen `_savedRev` into `_buildingSavedRev[bid]`; `_mirrorBuildingsToV2` writes `lastSeen+1` and only advances `_buildingSavedRev` on write SUCCESS. `firestore.rules` `match /buildings/{bid}`: `allow create, update: if isEditor(wid) && (resource==null || request.resource.data.get('_savedRev',0) >= resource.data.get('_savedRev',0))` — a stale write (version behind, or old-code with no `_savedRev` → defaults to 0 → < current) is REJECTED BY THE DATABASE, independent of tab count or client code version. `allow delete: if isEditor(wid)` (delete has no incoming version). NOTE: this means EVERY client buildings-write path MUST stamp `_savedRev` (audited: only the mirror writes/creates; delete is separate) or it will be denied. Restore writes used the project-owner OAuth token via the Firestore REST API, which BYPASSES rules (IAM owner) — so the rule cannot be tested that way; verify with a real Firebase-Auth client (multi-tab edit → no clobber). Data restored: New Tampa rebuilt from the architect morning export (`~/sfa-incident-2026-06-08/architect-morning.json`), `_savedRev=30000`.
- **Invariant — DO NOT BREAK:** (1) any client→Firestore write that can run from multiple tabs MUST be leader-gated (`_sfaTabSync.isLeader()`) — monolith push (`fbPushNow`), buildings mirror (`_mirrorBuildingsToV2`), payments/leaseDocs mirrors. (2) Every client write to `buildings/{bid}` MUST stamp a monotonic `_savedRev` (else the rules deny it). (3) Don't lower a building's `_savedRev`. Multi-tab editing of buildings was the loss vector.
- **Verification:** open in ONE tab only (or all tabs on the fixed build); edit a building field / floor → save → reopen → persists; the collection doc's `_mirroredBy` should never flip to a stale follower's overwrite. Incident copies preserved in `~/sfa-incident-2026-06-08/`.
- **Regression test:** none — manual / live REST verification.
- **Related:** extends Entry 16 (follower-tab push skip) to the buildings mirror; same root mechanism as the excelId-revert finding (2026-06-08).

---

### 64. Customizable dashboards — drag-reorder + freeform corner-resize + hide, per-user (UI/feature, 2026-06-07)

- **Status:** active
- **Branch / commit:** `main` @ `<this commit>`
- **Area:** UI / Home dashboard layout customization (Task 10, Phase 1 = Home)
- **Files:** floor-map-editor.html
- **Functions / rules:** `DASHBOARDS` registry, `_defaultDashboardLayout`, `_ensureDashboardLayout`, `_dashIsPristine`, `applyDashboardLayout`, `toggleDashboardCustomize`, `_dashBuildAffordances`, `_dashClearAffordances`, `toggleDashBlock`, `setDashBlockSpan`, `resetDashboardLayout`, `_dashResizeStart`, `_wireDashBlockDnD`, `_dashReorder`; CSS `.hv-body.dash-grid` / `body.dash-customizing` / `.dash-affordances` / `.dash-resize-handle`; `renderHomeView` (apply call at end); `PER_USER_SETTINGS_KEYS` (added `'dashboardLayouts'`); `state.settings.dashboardLayouts` default.
- **Feature it added:** Operator request — a "Customize" gear on dashboards to **drag blocks to reorder, resize freely by dragging a corner, hide/show, and Reset**, saved per-user. Phase 1 = Home (the 6 `hv-section` blocks: queue/revenue/portfolio/quick/upcoming/activity). Phase 2 (other dashboards: `#financeAnalyticsView`, Portfolio) is deferred — the engine is already view-parameterized via the `DASHBOARDS` registry.
- **Architecture:** Home blocks are static `<section data-dash-block>` filled BY ID (`renderHomeView` sets `#hvQueueCard.innerHTML` etc., never rebuilds the section), so re-applying layout after each render is safe. `applyDashboardLayout('home')` runs as the LAST line of `renderHomeView`. **Default-parity guard:** while the stored layout equals default AND customize is off (`_dashIsPristine`), the ORIGINAL flex `.hv-body` (2fr/1fr masonry) is kept untouched — `.dash-grid` is only added once the user actually customizes or opens Customize. On `.dash-grid`, `.hv-main`/`.hv-side` become `display:contents` so the 6 sections are direct 12-col-grid items; width = `grid-column: span var(--dw)` (1–12), height = optional `min-height var(--dh)` (0 = natural), order = CSS `order`. Customize affordances (grip/eye/resize-handle, `draggable=true`, `body.dash-customizing`) are injected dynamically and NEVER persisted.
- **Invariant — DO NOT BREAK:** (1) `renderHomeView` MUST keep filling cards BY ID (never `section.innerHTML` / never rebuild `<section>`), and MUST call `applyDashboardLayout('home')` last (wrapped in try/catch). (2) `'dashboardLayouts'` MUST stay in `PER_USER_SETTINGS_KEYS` (per-user: stripped from `fbPushNow` payload, restored in `fbApplyRemote` — never leak one user's layout to another). (3) The pristine-default path MUST leave the original flex layout (no `.dash-grid`, no inline `order/--dw/--dh`) so non-customizers see zero change. (4) Persist only on drop / resize-end / eye-toggle (never mid-drag). (5) Adding `state.settings.dashboardLayouts` is additive/backward-compatible — `_ensureDashboardLayout` lazily backfills; old states without the key default to `{}`.
- **Verification (live, headless, demo data — layout is data-independent):** default render = original masonry (queue/revenue/portfolio left x=248 w=649, quick/upcoming/activity right x=917 w=325, independent stacking, no `.dash-grid`). Gear → `body.dash-customizing`, `.hv-body` 12 tracks, every section draggable + grip/eye/resize handle, Reset visible. `setDashBlockSpan('home','queue',12,320)` → `--dw:12` (w 994px) + `--dh:320px`. `toggleDashBlock` → hidden. `_dashReorder` → order reassigned. State written to `localStorage['sfa_v5_state'].settings.dashboardLayouts`. Reload → custom layout persists as grid WITHOUT affordances, `_dashCustomizing=null` (transient off). Reset → pristine, back to flex masonry exactly. parse-check 3/0.
- **Discoverability fix (same day, 2026-06-07):** the first cut used an icon-only "gear" whose SVG (centre dot + 8 radial spokes) read as a SUN/brightness toggle — operator couldn't find it. Replaced with a **labelled pill button** (`.hv-dash-btn`, real cog icon + the word **"Customize"**, `id="hvDashGear"`, `[data-dash-label]` span that swaps to **"Done"** + `.active` in edit mode), plus a **hint bar** (`.hv-dash-hint` / `#hvDashHint`, shown only under `body.dash-customizing`, inserted before `.hv-body`) that explains the gestures and carries **Reset layout** + **Done** buttons. Lesson: layout/affordance icons must be unambiguous OR labelled — verify the icon doesn't collide with a common meaning (sun/settings).
- **Reorder-drag rewrite (same day, 2026-06-07):** the first cut used native HTML5 drag-and-drop (`draggable=true` + `dragstart/dragover/drop`). In a CSS grid it was unreliable (operator: right-column blocks wouldn't lift up) and gave NO drop-target feedback. Replaced with **pointer-drag + live reflow** (`_dashPointerDown` / `_dashLiveSequence` / `_dashApplyOrders`, all on `pointerdown`/`pointermove`/`pointerup`): a floating clone (`.dash-drag-clone`, `position:fixed`) follows the cursor, the source block dims (`.dash-dragging`) and the other blocks **reflow live** so the gap shows exactly where it will land; orders persist on `pointerup` only, **Esc cancels** (restores captured orders). Row grouping in `_dashLiveSequence` is by **top edge** (align-items:start → same-row blocks share top), NOT centre — block heights differ (left tall / right short), so centre-grouping mis-sorts. Resize-handle pointerdown `stopPropagation`s so it never starts a reorder; `_dashPointerDown` also bails on `.dash-resize-handle`/`.dash-affordances` targets. `touch-action:none` on sections in customize so touch-drag doesn't scroll.
- **Regression test:** none — manual UI / live `preview_eval` measurement.
- **Related PR / issue:** Task 10; plan `fluffy-painting-cake.md`. Phase 2 pending operator confirmation.

---

### 63. Map cut off at the bottom — grid row overflow + letterbox top-pin (UI/layout, 2026-06-07)

- **Status:** active
- **Branch / commit:** `main` @ `<this commit>`
- **Area:** UI / floor-map canvas layout + viewBox fit alignment + pan math
- **Files:** floor-map-editor.html
- **Functions / rules:** `.workspace`, `.canvas-area`, `.sidebar`, `.sidebar-content`, `#planSvg` CSS; `<svg id=planSvg preserveAspectRatio>`; `onPanMove`
- **Bug it fixed:** Long-standing "the map is cut off at the bottom by a border; can't view the full height." LIVE MEASUREMENT (not code-reading) found TWO causes: **(1) Grid-row overflow** — `.workspace` had `grid-template-columns` but **no `grid-template-rows`**, so its single implicit row was `auto` and grew to the tallest column's content (the right `.sidebar` Dashboard ≈775px). At a 720px window the row resolved to 775px → `.canvas-area` (and the docked legend bar) extended to y=831, **111px below the 720px viewport** → the legend + map bottom were clipped (the operator's "бордюр"). **(2) Letterbox top-pin** — `#planSvg` was `width:auto;height:auto`, so a viewBox'd SVG took its INTRINSIC height (= viewBox aspect) and sat top-pinned; with `preserveAspectRatio="xMidYMin meet"` (Y-top) all the vertical slack pooled at the BOTTOM (the big empty area below wide floors).
- **Fix:** (1) `.workspace { grid-template-rows: minmax(0, 1fr) }` pins the row to (100vh−56px); `min-height:0` on `.canvas-area`/`.sidebar`/`.sidebar-content` so grid/flex items don't inflate by min-content and the sidebar's existing `.sidebar-content` scroller engages. (2) `#planSvg { width:100%; height:100% }` makes the SVG fill the whole canvas; `preserveAspectRatio="xMidYMid meet"` centers the content vertically (verified: equal top/bottom gaps). (3) Because filling the SVG introduces a letterbox on the short axis, `onPanMove` was changed from separate `viewBox.w/clientWidth` & `viewBox.h/clientHeight` scales to a single uniform `min(...)` scale (the real px/unit) so vertical panning tracks the cursor 1:1. Click mapping already uses `svgPoint()`→`getScreenCTM()` (letterbox-safe); the wheel handler uses `svgPoint` + width-scale (safe) — both untouched.
- **Invariant — DO NOT BREAK:** (1) `.workspace` MUST define `grid-template-rows` (a column-only grid with `height:100%` lets content stretch the row past the viewport — the root cause). (2) Any pan/zoom that maps screen↔SVG must account for `preserveAspectRatio` letterbox — use `getScreenCTM()` (svgPoint) or the uniform `min()` scale, never per-axis `clientWidth/clientHeight`. (3) `#planSvg` fills the canvas (`width/height:100%`), not intrinsic. (4) Topbar-always-visible (UX §15) + auto-fit Entry 61 (`sfaFitToContent` bbox math) untouched.
- **Verification (live, headless, demo data — layout is data-independent):** before — `gridTemplateRows:775px`, `.canvas-area` bottom 831 (>720), legend 767–831 off-screen. After — `gridTemplateRows:664px`, `.canvas-area` 56→720, legend 656–720 on-screen, `#planSvg` fills 664, content centered (topGap 87 = bottomGap 87). Pan tracks 1:1 in both axes.
- **Regression test:** none — manual UI / live measurement.
- **Related PR / issue:** workflow `wq4p5zrq9` (identified the letterbox/xMidYMin half); the grid-row-overflow half was found by live `getBoundingClientRect` measurement (the code-only analysis had wrongly concluded the height chain was sound — a reminder to MEASURE layout bugs, not just read CSS).

---

### 62. Degenerate (zero-length) walls render as a clickable black dot — skip them (UI, 2026-06-07)

- **Status:** active
- **Branch / commit:** `main` @ `<this commit>`
- **Area:** UI / floor-plan wall rendering
- **Files:** floor-map-editor.html
- **Functions:** `renderWalls` (@68260), wall-create handler (@71401)
- **Bug it fixed:** Operator saw a small black dot floating in empty canvas space (New Tampa 2nd floor) with a hand cursor on hover. It was a wall in `currentBuilding().walls[]` with coincident endpoints (`points:[x1,y1,x2,y2]`, (x1,y1)≈(x2,y2)). `.wall-line { stroke-linecap: round }` (@8954) renders a zero-length line as a filled round dot, and `cursor:pointer` makes it clickable. Created by a click-without-drag in wall-draw mode (@71401) or floor auto-generation.
- **Fix:** (1) `renderWalls` skips any wall whose endpoint distance < 2px (`Math.hypot(dx,dy) < 2`) or whose `points` is malformed — `forEach` index `i` is preserved so select/splice-by-`i` of the OTHER walls is unaffected; (2) the wall-create handler no longer pushes a wall when start≈end (cancels the draw without writing dead data). Data is NOT mutated — existing degenerate walls are simply not drawn; cleanup of the dead `walls[]` entries is a separate optional data-fix.
- **Invariant — DO NOT BREAK:** wall select/delete uses the array index from `renderWalls`' `forEach`; skipping a render must NOT reindex (keep `forEach((w,i)=>{ if(degenerate) return; ... })`, never `.filter()` before the loop). `stroke-linecap:round` stays (real walls want rounded ends) — the guard is what prevents the dot.
- **Verification:** the black dot disappears on reload; drawing a wall with a click-without-drag no longer creates a dot; normal walls render unchanged. parse-check 3/0.
- **Regression test:** none — manual UI.
- **Related PR / issue:** identified via live DOM probe (operator 2026-06-07); relates to the "outlier coords" note in Entry 61.

---

### 61. Floor plan must bg-aware auto-fit on every open (building/view/boot), not only floor-switch (UI, 2026-06-07)

- **Status:** active
- **Branch / commit:** `main` @ `<this commit>`
- **Area:** UI / floor-plan viewBox auto-fit
- **Files:** floor-map-editor.html (viewBox/UI only)
- **Functions:** `switchBuilding`, `showFloorPlan`, boot-fit, the ungated resize listener
- **Bug it fixed:** Some floors opened filling the canvas, others opened small in the upper-left with a big empty bottom-right (operator: "должна растягиваться на всю ширину/высоту"). Root cause: only `switchFloor` (@65447) ran the **bg-aware** fitter `sfaFitToContent` (@100783) AND reset the two gates (`_userHasPanned=false`, `window._sfaLastBgSrc=null`). `switchBuilding` (@61902) and `showFloorPlan` (@130244) ran NO fit → the viewBox stayed stale from the previous floor → with `preserveAspectRatio="xMidYMin meet"` (X-center, Y-top) the slack pooled bottom-right = the small-upper-left look. Boot (@152722) used the **bg-blind** `zoomReset` (ignores the blueprint extent).
- **Fix:** mirror `switchFloor`'s ritual on the other open paths — `switchBuilding`: reset both gates after the floor repoint + `setTimeout(sfaFitToContent,0)` after `renderAll()`; `showFloorPlan`: same tail, **guarded by `_wasPlan`** so a redundant in-plan call never clobbers the operator's manual zoom; boot-fit swapped `zoomReset`→`sfaFitToContent`. Also **gated the previously-ungated resize listener** (@100783) with `activeView==='plan'` + `_userHasPanned` checks (it was the only resize path that blew away manual pan on any window resize — had to be gated since this fix makes `sfaFitToContent` canonical).
- **Invariant — DO NOT BREAK:** (1) Every explicit open of the plan (building/floor/view switch, boot) must bg-aware-fit AND reset both gates (`_userHasPanned` + `_sfaLastBgSrc`) — `_sfaLastBgSrc=null` is required so the async `renderBg.onload` corrective re-fit (@66026, gated `isNewSrc && !_userHasPanned`) upgrades the 0ms baseVB-fallback fit to the true bg extent. (2) The fit must NOT fire on incidental re-renders / resize when `_userHasPanned` (respect manual zoom) — hence the `_wasPlan` guard in `showFloorPlan` and the resize gates. (3) `renderBg` no-blank (Entry 51) untouched. (4) `switchFloor` unchanged.
- **Verification:** open a building via the dropdown → plan now fills the canvas (was small upper-left); switch floors → still fits; resize after a manual zoom → manual zoom preserved (resize gated). Live probe (workflow `wuqe7lcrj`) dumps current viewBox vs would-be sfaFitToContent bbox → "matches" on every open after the fix.
- **Regression test:** none — manual UI / live.
- **Related PR / issue:** workflow `wuqe7lcrj`. Out of scope (flagged): finite-but-wrong outlier unit coords over-zoom both fitters; `sfaFitToContent` doesn't reserve the top-pill slack that `zoomReset` did (minor, only relevant if resize/RO are later swapped too).

---

### 60. Rent invoices must set Stripe due_date = anchor + grace at issuance (finance/Stripe, 2026-06-07)

- **Status:** active
- **Branch / commit:** `main` @ `<this commit>`
- **Area:** Finance / Stripe invoice creation / due-date anchor
- **Files:** functions/index.js (Cloud Function — manual create + auto-invoice cron), floor-map-editor.html (senders + `_rentDueUnix` helper)
- **Bug it fixed:** RENT invoices were created with `days_until_due:7` (or cron `dueDays`) from the SEND date, never anchored to the lease/billing schedule. For a future lease (Suite 449, starts Jul 1), the July invoice's Stripe `due_date` was in mid-June → Stripe buckets it `past_due` and (collection_method `send_invoice`) may dun the tenant for rent not yet due. Entry 59 fixed only the UI badge; this fixes the actual Stripe `due_date`.
- **Fix:** client `_rentDueUnix(rent, ym, leaseStartIso, u)` computes the absolute anchor (`ym===leaseStartYm ? leaseStart : 1st-of-ym`) + `state.settings.lateFee.graceDays ?? 5` via the canonical `_monthBilling`, and every RENT sender passes it as `dueDateUnix` (Unix seconds): move-in `sendRent`, split installment 1, NTO rent, catch-up. The CF accepts optional `dueDateUnix` (rent-only) and, **for `send_invoice`**, sets Stripe `due_date` when the anchor is in the FUTURE (`> now+120s, < now+366d`), else `days_until_due:0` = due immediately/`past_due` (operator decision 2026-06-07: late-issued rent shows past_due). The **auto-invoice cron** (`runAutoInvoices`) computes the same anchor server-side (`1st-of-nextYm + grace`). Footer shows the exact date. No `dueDateUnix` / non-rent → unchanged (`days_until_due`). Stripe takes `due_date` XOR `days_until_due`, never both.
- **Invariant — DO NOT BREAK:** (1) `due_date` only for RENT + `send_invoice` + FUTURE anchor; deposit/late-fee/custom and `charge_automatically` untouched. (2) NEVER pass both `due_date` and `days_until_due`. (3) NEVER pass an absolute past `due_date` (Stripe rejects on finalize → would abort the send); past anchor → `days_until_due:0`. (4) Grace source = `state.settings.lateFee.graceDays` (matches `_computeUnitMoney`/Entry 59), not the per-building override. (5) Split installment 2 keeps its own `daysUntilDue2` anchor. (6) Backward-compatible: old client (no `dueDateUnix`) → CF behaves as before.
- **Verification:** Stripe TEST mode — send move-in rent for a unit whose lease starts next month → invoice `due_date` = leaseStart+grace, bucket not `past_due`; deposit still send+7d; late-fee still due-now; back-dated lease → falls to `days_until_due:0` and still sends (no finalize throw). `node --check functions/index.js` + client parse-check 3/0.
- **Regression test:** none — manual / Stripe test-mode UI.
- **Related PR / issue:** workflow `wa9bj0bx1`. Completes Entry 59. The EXISTING mis-dated 449 invoice is NOT auto-fixed — void + resend via the UI to reissue with correct due_date. Deployed `firebase deploy --only functions` + `--only hosting` (CLAUDE.md §2 operator approval 2026-06-07).

---

### 59. Move-in rent badge must honor lease-start grace, not raw Stripe past_due (finance-display, 2026-06-07)

- **Status:** active
- **Branch / commit:** `main` @ `<this commit>`
- **Area:** Finance display / move-in card / overdue grace anchor
- **Files:** floor-map-editor.html
- **Functions:** `_moveInInvoicePill` (+ 3 RENT call sites: `_renderProrateBox`, `_renderMoveInCardForModal`, split-remainder)
- **Bug it fixed:** Suite 449 (lease starts Jul 1 2026, grace 5d) showed "First month rent — July 2026 **PAST DUE**" while viewing June — before the lease even starts. `_moveInInvoicePill` (~90653) rendered the **raw Stripe bucket** (`_lookupInvoiceBucket` → `past_due` → "PAST DUE", ~90682-90685) with no grace anchor. Stripe buckets the July invoice `past_due` because its `due_date` (created `days_until_due:7` from send date, NOT anchored to lease-start) already elapsed. Meanwhile `_monthBilling` (~84275) already computes the correct lease-start-month due date (`leaseStart + graceDays` = Jul 6) → `isOverdueByDate=false`, which is why the map renders BLUE (not red). Only the move-in pill bypassed the canonical grace. Exactly 3 surfaces wrong, all the same pill, RENT context only; deposit pill + map + `_computeUnitMoney` + Invoices table all already correct.
- **Fix:** added optional tri-state `graceOverdue` param to `_moveInInvoicePill`. When `graceOverdue === false` AND bucket is `past_due`, render "SENT" (blue, with a "Due <leaseStart+grace>" tooltip) instead of "PAST DUE". The 3 RENT call sites compute `_monthBilling(rent, ym, leaseStart, graceDays, now, u).isOverdueByDate` using `state.settings.lateFee.graceDays ?? 5` — the SAME source as `_computeUnitMoney` (NOT the per-building override) so the pill matches the map. Deposit calls pass no 3rd arg → `undefined` → unchanged. No formula touched — `_monthBilling` is read-only.
- **Invariant — DO NOT BREAK:** (1) Genuinely-overdue months still show PAST DUE (`graceOverdue===true` → gate is a no-op). (2) The pill's grace source MUST equal `_computeUnitMoney`'s (`state.settings.lateFee.graceDays`), never the per-building late-fee override — else the badge drifts off the map. (3) Deposit pill keeps its own non-rent grace (no 3rd arg). (4) `_isMonthSettled` paid-wins (Entry 55) short-circuits before the gate; lease-start gate (Entry 1) untouched. (5) Only `past_due` is gated (not `open`) — surgical.
- **Verification:** Suite 449 today → move-in rent badge reads SENT (blue) not PAST DUE; map still blue. Probe (workflow `wbfy9c5z4`) dumps `isOverdueByDate=false`, `dueDate=Jul 6`, `stripeBucket='past_due'`, pill should=SENT. After Jul 6 unpaid → PAST DUE returns.
- **Regression test:** none — manual UI / live console.
- **Related PR / issue:** workflow `wbfy9c5z4`. **SEPARATE follow-up (NOT done — needs operator approval, CLAUDE.md §2):** the Stripe invoice `due_date` itself is wrong (senders hardcode `days_until_due:7` from send date — `~85194`/`~91671`/`~91686`; CF `functions/index.js:1273`). Stripe may already be dunning the tenant for July rent. Fix = create the lease-start-month invoice with absolute `due_date = leaseStart + grace`. The display gate does NOT solve the tenant-facing Stripe reality.

---

### 58. Colored (non-vacant) units stay full-opacity in view mode; Opacity slider dims only vacant (UI, 2026-06-07)

- **Status:** active
- **Branch / commit:** `main` @ `<this commit>`
- **Area:** UI / floor-map unit fill rendering
- **Files:** floor-map-editor.html
- **Functions:** `renderUnits` (per-unit opacity computation)
- **Bug it fixed:** The Layers "Opacity" slider (`state.settings.unitOpacity`) was applied uniformly to ALL units, so lowering it (to see the blueprint underlay) also faded the colored/occupied units — their status colors went weak and the blueprint bled through them. Operator wanted colored units to stay full-strength.
- **Fix:** in `renderUnits` (~66196), compute per-unit opacity with a condition — in VIEW mode, any unit that is NOT a rentable vacant unit (`isVacantUnit = isRentable && u.status === 'vacant'`) renders at `opacity 1` regardless of the slider; only vacant units use `unitOpacity` (so the blueprint shows through empty space). EDIT mode is unchanged (all units stay translucent at `editModeOpacity` so the plan is visible while drawing). Selected-unit 0.7 floor preserved. Applied via the existing `unitOpacity` local that feeds both the rect `opacity` (~66331) and polygon `fill-opacity` (~66329).
- **Invariant — DO NOT BREAK:** (1) The Opacity slider must dim ONLY vacant units in view mode; non-vacant (occupied/reserved + non-rentable common areas) stay opaque. (2) EDIT mode keeps all units translucent (editModeOpacity) — do not make occupied units opaque in edit mode (the plan must stay visible while editing). (3) Default `unitOpacity=1` → no visible change at 100%; the branch only diverges when the slider is lowered.
- **Verification:** lower Layers→Opacity to ~40% in view mode → occupied units stay solid, vacant units fade and show the blueprint. Toggle Edit Mode → all units translucent as before. Console: `document.querySelectorAll('.unit-rect')` — vacant rects have `opacity≈0.4`, occupied rects `opacity=1`.
- **Regression test:** none — manual UI / live.
- **Related PR / issue:** operator request 2026-06-07 (follow-on to Entry 56/57 background work).

---

### 57. Background-settings sliders must re-sync from the active floor (UI/data-integrity, 2026-06-07)

- **Status:** active
- **Branch / commit:** `main` @ `<this commit>`
- **Area:** UI / floor-plan background panel / per-floor data integrity
- **Files:** floor-map-editor.html
- **Functions:** `_syncBgPanel` (new), `switchFloor`, `switchBuilding`, sidebar-tab handler, blueprint `handleFile`, `dedupeFloorsIn`
- **Bug it fixed:** Operator perceived background settings (Opacity / Scale / Offset X / Offset Y) "crossing between buildings." **Storage is genuinely per-floor and isolated** (every floor owns a fresh `bg` literal; no shared refs; no workspace-global opacity/offset — only `state.settings.showBg` boolean). The real bug: the Background-Settings panel was **WRITE-ONLY** — sliders `#bgOpacity/#bgScale/#bgX/#bgY` + spans `#bgOpacityVal/#bgScaleVal/#bgXVal/#bgYVal` were written only in the input handler (~101016) and **never repopulated from the active floor** on `switchFloor`/`switchBuilding`. After a switch the knobs stayed frozen on the previous floor's values → looked cross-building. **And it caused REAL corruption on interaction:** dragging a slider on a freshly-switched floor wrote the *stale displayed value* into that floor's `bg` and `saveState()`-persisted it to Firestore — overwriting the new floor's real setting with a neighbor's value.
- **Fix:** added `_syncBgPanel()` (reads `currentFloor().bg` → sets the four sliders + value spans) and call it on `switchFloor`, `switchBuilding`, blueprint upload reset (`handleFile`), and when the Layers sidebar tab opens. Also hardened the only `bg`-reference reassignment — `dedupeFloorsIn` `survivor.bg = doomed.bg` → `survivor.bg = { ...doomed.bg }` (deep-clone, no live alias). No data-model change, no migration, **`bg.src`/Storage/`renderBg` untouched** (Entry 51/52 invariants preserved).
- **Invariant — DO NOT BREAK:** (1) every read/write of a slider's `.value` must reflect the CURRENT floor — any new floor/building/panel entry point must call `_syncBgPanel()`. (2) The input handler writes to `currentFloor().bg` only — never make a bg setting workspace-global (it must stay per-floor). (3) No two live floors may share a `bg` object (clone on any copy path). (4) Never touch `bg.src`/`storagePath`/`finalizeBlueprintUpload`/`renderBg`'s atomic-swap (Entry 51/52).
- **Verification:** set Opacity=30% on Building A floor 1, switch to Building B floor 1 → slider now reads B's own value (not 30%); switch back → A still 30%. Live isolation probe (workflow `wavijvmkz`) dumps every floor's `{bld,floor,opacity,x,y}` + shared-ref detection — expect "ISOLATION OK".
- **Regression test:** none — manual UI / live console.
- **Related PR / issue:** workflow `wavijvmkz` (2026-06-07). Pre-existing already-corrupted floors (from past switch-then-drag) cannot be auto-recovered — the probe surfaces anomalies for manual review.

---

### 56. Building-address pill must not flex-collapse on crowded views (UI, 2026-06-07)

- **Status:** active
- **Branch / commit:** `main` @ `<this commit>`
- **Area:** UI / topbar building selector
- **Files:** floor-map-editor.html (CSS only)
- **Functions:** none (pure CSS — `.building-selector` / `.building-pill .bp-main` / `.top-search` + a relax `@media`)
- **Bug it fixed:** The building address (and on the worst views the name too) vanished from the topbar pill on **Floor Plan / Rent Roll / Stacking** but showed on every other view ("на некоторых страницах есть, на некоторых нет"). Root cause: the topbar is a single non-wrapping flex row where `.floor-group` (floor tabs, shown only on those 3 views via the `data-view` whitelist @ ~5786) and `.topbar-actions` are `flex-shrink:0`, so `.building-selector` (`flex:0 1 260px`, the only shrinkable text element) was squeezed to its `min-width:84px`; inside it `.bp-main` had `min-width:0` and collapsed to 0 → name+address ellipsis to nothing, leaving only photo+chevron. Not a media-query (the old `@media(max-width:1180px){.bp-addr{display:none}}` was already removed in `52d8cfb`) and not a data problem (the name vanished too). Verified live: at narrow width `.bp-main` width → 0 with `display:block` (flex-collapse, not a CSS hide).
- **Fix:** reserve a readable minimum for the text block — `.bp-main min-width:0→88px`, `.building-selector min-width:84→160px` — and **fund it from the expendable search box** (`.top-search min-width:160→84px`) so the reservation is **net-zero on overflow** (selector +76px = search −76px). A relax `@media(max-width:1280px)` restores all three to their old values so on a genuinely narrow window the address yields to ellipsis and the pill never overflows onto Map/Rent Roll. Live-measured: `addedOverflow = 0px` vs the pre-fix baseline at the same width; `selector.right − topNavTabs.left = −40px` (no overlap) before and after.
- **Invariant — DO NOT BREAK:** (1) `.building-selector` must never shrink below the pill's content min such that the pill overflows right onto Map/Rent Roll (2026-05-29 overlap incident, comment @ ~244-248). (2) The address reservation MUST stay overflow-neutral — if you raise `.bp-main`/`.building-selector` min-width, keep the offsetting `.top-search` reduction (and the `@media` relax) so total shrink capacity is unchanged. (3) Floor tabs are higher priority than the address (operator 2026-06-07): never shrink/scroll `.floor-group` to make room for the address. (4) Keep `.topbar` always-visible (sticky, no scroll-reveal — UX_STANDARDS §15 / Entry 49).
- **Verification:** at window > 1280px on Floor Plan, `#bpAddr` renders (≥~88px wide); at ≤1280px it ellipsizes and the pill stays within the selector (no overlap). Console: compare `document.querySelector('.topbar').scrollWidth - clientWidth` before/after the style — must not increase.
- **Regression test:** none — manual UI / live width sweep.
- **Related PR / issue:** workflow `wigax3hnc` (2026-06-07); supersedes the partial `#3` fix in `52d8cfb` (which only removed the media query, leaving the flex-collapse).

---

### 55. Overdue/late-fee engine must honor Stripe-paid, not only local stamp (finance, 2026-06-07)

- **Status:** active
- **Branch / commit:** `main` @ `<this commit>`
- **Area:** Finance / overdue detection / late-fee accrual
- **Files:** floor-map-editor.html
- **Functions:** `_computeUnitMoney` (main per-month loop + late-fee loop)
- **Bug it fixed:** Split-brain "paid-but-overdue". A rent month paid on Stripe (`cache.bucket === 'paid'`) but whose local stamp `u.payments[ym].status` ≠ `'paid'`/`'free'` (e.g. stuck at `'late'`) read **OVERDUE** on the red "!" map badge, the Overview "Current month overdue — $X due" banner, the unbilled late-fee accrual, and the topbar/A-R surfaces — while the floor-map "Payment status" fill (`_computeUnitFillImpl`) and the Payment-History grid (`_renderUnitTenantHistoryBlock`) correctly read **PAID** (both honor the Stripe paid-bucket). Confirmed live on Suite 417 / June 2026: `u.payments['2026-06'].status === 'late'` while rent invoice `in_1Tc7Dz…` was `bucket:'paid'` ($350). `_computeUnitMoney` consulted ONLY the local stamp; every "green" surface also consulted Stripe. Same class as Entry 34 (display surfaces were migrated to `_isMonthSettled`; the overdue/late-fee engine was not).
- **Fix:** route `_computeUnitMoney`'s per-month settled test through the existing consolidated `_isMonthSettled(u, ym)` (returns `'paid'`/`'free'`/`'stripe-paid'`, carries the `_stampPointsToDeposit` deposit-cross-stamp guard, returns `null` for `open`/`past_due`). Both the main loop and the late-fee loop now treat `'paid'` **or** `'stripe-paid'` (or local `'paid'`/`'free'`) as settled. Old narrow check kept as a typeof-guarded fallback for load-order safety. No formula touched (proration, late-fee math, effective-rent unchanged).
- **Invariant — DO NOT BREAK:** a month is "settled" (no overdue, no late fee) iff `_isMonthSettled` returns `'paid'`/`'free'`/`'stripe-paid'`. A **sent-but-unpaid** invoice (`open`/`past_due`) MUST still count as overdue — `_isMonthSettled` returns `null` for those; never broaden the engine to treat an alive-unpaid invoice as paid. The lease-start gate (Entry 1) and deposit-cross-stamp guard (Entry 34) stay intact.
- **Verification:** live console `sfaDiagnoseSuitePaid('417','2026-06')` → unit reads PAID via Stripe; after fix `_isUnitOverdue(u)` returns `false`, Overview banner clears, June late fee no longer accrues. The floor-map fill + history grid were already PAID and must stay PAID (now all surfaces agree).
- **Regression test:** none — manual UI / live console (`_isMonthSettled` vs `_computeUnitMoney.unpaidMonths` agreement).
- **Related PR / issue:** workflow `wyvnhkho1` root-cause report (2026-06-07). Builds on Entry 34.

---

### 54. Move-addendum DocuSign anchors must land on the CLIENT line, not PROVIDER (legal, 2026-06-07)

- **Status:** active
- **Bug it fixed:** The relocation **addendum** (`_aeBuildDefaultBody` + `_aeBuildEnvelopeHtml`) shipped a broken DocuSign signing layout (the master lease path `_docusignBuildEnvelopeBody` was already correct — only the addendum was affected). Two compounding latent bugs: (1) `_aeBuildDefaultBody` emits LITERAL `/signHere/` `/dateSigned/` in BOTH the PROVIDER and CLIENT blocks, but `_aeBuildEnvelopeHtml`'s injection loop only matched `By: ___` (underscores) inside a `\bTENANT\b` block — the default body uses PROVIDER/CLIENT (never TENANT) and markers (not underscores), so the loop was DEAD and the fallback bolted ONE orphan anchor onto the doc END. DocuSign matches `anchorString` on the FIRST occurrence → the tenant's Sign-Here tab landed on the **PROVIDER** line. (2) **Extra bug caught only by post-fix verification, not in the audit plan:** the re-substitute regex that restores the invisible anchor span after HTML-escaping used literal `"` quotes, but `escTxt` escapes `"` → `&quot;`, so it NEVER matched and the span rendered as **visible escaped text** in the signed PDF.
- **Fix:** order-based, label-independent — convert literal markers to invisible span-anchors BEFORE escaping; only the LAST occurrence of each marker becomes a live anchor (tenant signs last = CLIENT block), earlier (PROVIDER) markers become a blank signature underline (provider signs offline, matching the master-agreement convention). Underscore-based injection kept ONLY as a zero-marker fallback. Re-substitute regex fixed to `&quot;`. Commit `d03c034`.
- **Risk if regressed:** a tenant's Sign-Here / Date tab lands on the landlord's line, or `/signHere/` prints as visible garbage in a legal document. Signature placement is INVISIBLE (`font-size:1px; color:white`) so it cannot be eyeballed in the PDF — only a DocuSign sandbox test reveals where the tab lands.
- **Gate:** `scripts/check-invariants.sh` — `Audit [9]` greps `_aeBuildEnvelopeHtml`'s re-substitute for the escaped `&quot;font-size:1px` form (guards against a "tidy-up" reverting it to literal `"`, which silently re-breaks the anchor).
- **Verification:** standalone Node harness on the signature region asserted exactly ONE live `/signHere/` + ONE `/dateSigned/` span, both in the CLIENT block, zero visible markers, zero escaped-span garbage, PROVIDER lines blank — all 7/7 pass. **Operator MUST still send one DocuSign sandbox envelope before relying on it for a real tenant** (anchor placement unverifiable from code alone).
- **PR / commits:** `d03c034` (shipped to main + prod 2026-06-07, deploy `d03c03494a5f`).
- **Porting concern:** none — on main + prod.

---

### 53. Multi-agent audit 2026-06-06 — 3 reintroduced regressions re-gated (2026-06-07)

- **Status:** active
- **Bug it fixed:** A read-only multi-agent audit (workflow `woboipj8u`, 191 agents, 55 verified findings — full list in `AUDIT_REPORT_2026-06-06.md`) caught THREE previously-fixed invariants that had silently regressed:
  1. **Entry-2 class** — `openBouncedCheckModal` used `if (startMs && … < startMs) break`, which short-circuits to a no-op when `startMs == null` → the bounced-check picker surfaced the **previous tenant's** paid months. Fixed to `!startMs ||` (commit `b3bec0f`, audit H14).
  2. **LLC-only occupancy** — `_isUnitOverdue` gated on `!u.tenant` only, so company-only leases (`u.company`, no `u.tenant`) never lit up overdue on the floor map. Fixed to `(!u.tenant && !u.company)` (commit `d613109`, audit M7).
  3. **Entry-44 class (data-safety)** — `fixFloorAssignments` deduped floors/units with no pre-mutation snapshot. Added `_localBackupCreate('pre-mutation')` at the top, before any mutation (commit `4e216f2`, audit H11/H12).
- **Risk if regressed:** (1) corrupts a prior tenant's payment history + creates a phantom recovery case; (2) company-only tenants' overdue debt invisible on the map; (3) unrecoverable floor/unit data loss (the 2026-06-04 incident class).
- **Gate:** `scripts/check-invariants.sh` — three new checks (`Audit H14 / M7 / H11/H12`) grep the three functions for the protective pattern; `firebase deploy --only hosting` aborts if any regresses.
- **PR / commits:** audit fixes shipped across `afabc36..1237d91` (merged to main); regression gates added 2026-06-07.
- **Test:** `bash scripts/check-invariants.sh` → all three print ✓.
- **Porting concern:** none — on main + prod.

---

### 52. NEVER delete blueprint Storage files + self-heal bg from cache (DATA LOSS, 2026-06-05)

- **Status:** active
- **Branch / commit:** `main` — `dcca813`
- **Area:** Floor-plan blueprints / Firebase Storage / data loss
- **Files:** `floor-map-editor.html` — `deleteMediaByPath()` (~:29795, `/blueprints/` guard), `_bgSelfHealFromCache()` + `renderBg()` onerror (~:65640).
- **Incident:** New Tampa 2nd + 4th floor blueprints vanished → "Could not display background image". Diagnosis: `bg.src` was a valid Storage URL but `getDownloadURL`/fetch returned 403/404 — the Storage OBJECT was deleted. Root: `finalizeBlueprintUpload` deletes the prior blueprint on re-upload/crop (`deleteMediaByPath(priorPath)`), but under the multi-writer race a stale session re-mirrors the OLD building (bg.src → the just-deleted file) over the new one → bg.src references a deleted object → 403/404. (NT 2nd recovered from the browser IndexedDB cache + re-upload; NT 4th not cached on the operator's machine.)
- **Invariant — DO NOT BREAK:** (1) `deleteMediaByPath` MUST skip any path matching `/blueprints/` — blueprint files are NEVER deleted (Storage is cheap, re-uploads rare; old versions accumulate, but `bg.src` can never point to a deleted object). Do NOT re-enable blueprint deletion on re-upload/crop/floor-delete. (2) `renderBg`'s `probe.onerror` calls `_bgSelfHealFromCache(currentFloor())` — if a blueprint's Storage file is gone but the data-URL is in the local IDB cache (`_bgIdbExec`, populated by `_bgCacheDataUrl`), it re-uploads it and fixes `bg.src` automatically (once per floor/session, `_bgHealedFloors` guard). The two work together: never-delete keeps the re-linked URL durable.
- **How to verify:** `grep -c "blueprints" floor-map-editor.html` in deleteMediaByPath shows the guard; `grep -c "_bgSelfHealFromCache" floor-map-editor.html` ≥ 2. Functional: a blueprint whose Storage object is missing auto-restores from cache on floor open (toast "Blueprint restored from local cache").
- **Recovery for blueprints with NO cache anywhere:** re-upload the original file (manual, one-time). PITR does NOT cover Storage; the IDB cache + this self-heal are the safety net.
- **Regression test:** none — manual UI only.

---

### 51. renderBg must NOT blank the canvas on re-render (blueprint flicker, 2026-06-05)

- **Status:** active
- **Branch / commit:** `main` — `dda0192` (sig-guard) + `44ada65` (atomic swap + token-stable sig)
- **Area:** Floor-map render / blueprint background / cross-origin Storage image
- **Files:** `floor-map-editor.html` — `renderBg()` (~:65631).
- **Bug it fixed (operator-visible):** the floor-plan background (Storage, cross-origin, async-loaded) flickered "disappears then reappears" on re-renders. `renderBg` did `clearG(bgG)` IMMEDIATELY, then appended the new `<image>` only in `probe.onload` — so during the async load the canvas was BLANK. A BG-watcher proved it: `bg.src` stayed a URL the whole time (data intact), but the DOM `<image>` was removed for ~280ms. `clearG(bgG)` exists ONLY in renderBg (no external clearer).
- **Invariant — DO NOT BREAK:** renderBg must (1) compute a signature from the **base URL (strip `?token`)** + scale/x/y/opacity — Firebase Storage download URLs re-tokenize on building re-delivery, so the full URL would look "changed" and force needless reloads; (2) skip entirely when the sig is unchanged AND an `<image>` exists or a load is in-flight (`_bgRenderedSig` / `_bgLoadingSig`); (3) **NOT clearG at the top** — clear the old `<image>` only inside `onload`, right before appending the new one (atomic swap → canvas never empty). `onerror` resets the sig so a failed load retries. Do NOT reintroduce a top-of-function `clearG(bgG)`.
- **How to verify:** `grep -c "_bgRenderedSig\|_bgLoadingSig" floor-map-editor.html` ≥ 6; `grep -c "clearG(bgG)" floor-map-editor.html` == 3 (1 comment + no-bg branch + onload; NO top-level one). Functional: a BG-watcher (poll `currentFloor().bg.src` + `bgG.querySelector('image')`) shows no `IMG-EST→IMG-NET` while the data stays URL.
- **Regression test:** none — manual UI only.

---

### 50. Buildings read-switch listener must ignore its OWN write echoes (over-render root, 2026-06-05)

- **Status:** active
- **Branch / commit:** `main` — `83b1f6f`
- **Area:** Scaling buildings read-switch / sync / over-rendering
- **Files:** `floor-map-editor.html` — `_v2BuildingsAttachListener()` onSnapshot docChanges loop (~:33658).
- **Bug it fixed:** the buildings-collection listener re-applied + fully re-rendered (renderUnits + renderBg + pills) on EVERY docChange — INCLUDING the client's own writes echoing back (Firestore delivers your own write to your own listener). The monolith listener has echo-suppression (`ignoreNext`, ~:34539) but the buildings listener had NONE. So every saveState → `_mirrorBuildingsToV2` → own echo → full re-render (this was the renderBg flicker trigger on unit edits, plus general churn). Idle churn itself is low (~1 apply/min, measured) — this is about the SELF-inflicted re-render on each save, not a runaway loop.
- **Invariant — DO NOT BREAK:** the buildings listener must skip docChanges where `ch.doc.metadata.hasPendingWrites` is true (the client's own un-acked local write) — we already have that building in state. Other users' / CF-mirror changes arrive with `hasPendingWrites=false` and apply as before. Do NOT remove this guard.
- **How to verify:** `grep -c "hasPendingWrites" floor-map-editor.html` ≥ 1 (the buildings listener). Functional: editing a unit must not spike `[bld-trace:v2-buildings-read]` from the editor's own save.
- **Regression test:** none — manual UI only.

---

### 49. Topbar pills: per-building refresh on switch + always-visible with muted zero (2026-06-05)

- **Status:** active
- **Branch / commit:** `main` — `be67190` (refresh on switch) + `921e948` (always-visible) + `bfc1c37` (muted zero)
- **Area:** Topbar KPI pills (overdue / expiring / lease-pending / contract / activity) / per-building scope
- **Files:** `floor-map-editor.html` — `switchBuilding()` (~:61620), `updateTopbarOutstandingPill` / `renderExpiringPill` / `updateTopbarActivityPill` / `updateTopbarLeasePill` / `updateTopbarContractPill`, `.pill-zero` CSS (~:2961).
- **Bugs fixed:** (a) pills are scoped per active building via `_matchesActiveBuilding(currentBuildingId)`, but `switchBuilding → renderAll()` did NOT recompute them, so after a building switch the pills showed the PREVIOUS building's $ until a listener/timer fired ("нет совпадения" — operator saw one building's overdue while viewing another). (b) pills hid entirely at zero, so "no pill" was ambiguous with "not loaded".
- **Invariant — DO NOT BREAK:** (a) `switchBuilding` must call `renderUserBadge()` (the canonical refresh of ALL topbar pills) synchronously right after `renderAll()` — `renderAll` does NOT recompute the pills. (b) the five pills are always-visible (show their 0 state, no hide-at-zero) and toggle the shared `.pill-zero` class (grayscale + dim, dot pulse off) when their count is 0; `canSeeFinance` gates still hide them for non-finance roles. Do NOT re-add hide-at-zero, and do NOT drop the switchBuilding pill-refresh.
- **How to verify:** `grep -c "renderUserBadge()" floor-map-editor.html` (switchBuilding includes one); `grep -c "classList.toggle('pill-zero'" floor-map-editor.html` == 5. Functional: switch buildings → overdue pill matches the building immediately; a $0 building shows a muted "0".
- **Regression test:** none — manual UI only.

---

### 48. ALL per-user display/view settings are PER-USER — must NOT sync (2026-06-05)

- **Status:** active
- **Branch / commit:** `main` — `0cd2e29` (generalizes Entry 47)
- **Area:** Multi-user sync / settings / per-user display & view preferences
- **Files:** `floor-map-editor.html` — `PER_USER_SETTINGS_KEYS` Set (declared just above `fbPushNow` ~:32078), the strip loop in `fbPushNow` (~:32092), and the capture/restore loops in `fbApplyRemote` (~:34548).
- **Bug it fixed (operator-visible):** like `editMode` (Entry 47), many other VISUAL / VIEW / DRAWING preferences lived in the SYNCED `settings` object, so one person changing their map view changed everyone's: theme (dark/light flipping for all), every `show*` map/panel toggle (labels, rent, sqft, tenant, sink, compact-status, lease/rent/new/overdue/onboarding icons, unit price/rate/proforma, grid, bg, units, walls), the opacities (`unitOpacity`/`editModeOpacity`/`priceTextOpacity`/`unitTextOpacity`), `labelScale`, and `snap`/`snapEdge`.
- **Invariant — DO NOT BREAK:** these per-user keys are listed in `PER_USER_SETTINGS_KEYS` and decoupled by TWO guards (keep both): (1) `fbPushNow` deletes every key in the set from the outgoing `payload.settings` (never pushed to others); (2) `fbApplyRemote` captures the local values for those keys before the wholesale `state.settings = remote.settings` merge and restores them after (incoming remote never overwrites your visual prefs). **Business/workspace settings are deliberately NOT in the set and MUST keep syncing:** `defaultRent`/`defaultRate`/`defaultSqft`/`defaultCap`, `sqftPerPerson`, `customUnitTypes`, `accessControl`, `people`, scaling flags (`syncV2`/`syncBuildingsStrip`/...), billing, cap-rate. When adding a new setting: if it controls how an individual SEES/DRAWS the map → add it to `PER_USER_SETTINGS_KEYS`; if it's shared business config → leave it out.
- **How to verify:** `grep -c "PER_USER_SETTINGS_KEYS" floor-map-editor.html` ≥ 3. Functional: two sessions — one changes theme / hides labels / changes opacity → the other's screen is unchanged.
- **Regression test:** none — manual UI only.

---

### 47. Edit Mode is PER-USER — must NOT sync between sessions (2026-06-04)

- **Status:** active
- **Branch / commit:** `main` — `662dab0`
- **Area:** Edit/View mode / multi-user sync / settings
- **Files:** `floor-map-editor.html` — `fbApplyRemote()` (~:34548, capture+restore of `_localEditMode`) and the push path (~:32092, `delete payload.settings.editMode`). Toggle: `toggleEditMode()` (~:100284) writes `state.settings.editMode` + `saveState()`.
- **Bug it fixed (operator-visible):** `state.settings.editMode` lived in the SYNCED `settings` object and `toggleEditMode()` calls `saveState()`, so one editor turning on Edit Mode pushed the flag to EVERY session — the architect entering Edit flipped Tony's session into edit too (editable inputs/handles appeared). Edit Mode is inherently per-user.
- **Invariant — DO NOT BREAK:** Edit Mode must stay PER-USER. Two guards, keep BOTH: (1) `fbApplyRemote` captures the local `settings.editMode` before the wholesale `state.settings = remote.settings` merge and restores it after — incoming remote never changes your view/edit mode. (2) the push path deletes `payload.settings.editMode` so a session's mode is never sent to others (stays in local `state` + localStorage). Do NOT remove either guard, and do NOT add `editMode` back into the synced payload. Note `state.settings = remote.settings` is a WHOLESALE replace — any other field that must stay per-user needs the same capture/restore treatment (like `ui`, which is skipped entirely at ~:34556 / the `k === 'ui'` continue).
- **How to verify:** `grep -c "_localEditMode" floor-map-editor.html` ≥ 2 and `grep -c "delete payload.settings.editMode" floor-map-editor.html` ≥ 1. Functional: two sessions; one toggles Edit Mode → the other stays in its own mode.
- **Regression test:** none — manual UI only.

---

### 46. Stripe-fetch throttle must NOT live on the unit object (strip flicker, 2026-06-04)

- **Status:** active
- **Branch / commit:** `main` — `b567815`
- **Area:** Invoicing / Stripe fetch / buildings-strip regression / UI flicker
- **Files:** `floor-map-editor.html` — `_fetchUnitInvoicesFromStripe()` (~:80898) + the module-level `_stripeFetchThrottleAt` map declared just above it.
- **Bug it fixed (operator-visible):** with the buildings-strip live, the unit card / "New tenant added" move-in modal showed "jumping numbers" — a storm of Stripe re-fetches (repeated `[unit invoice fetch] returned=N` + `[verify-Deposit]` in console). Root: the per-unit 5 s re-fetch throttle was stored on the unit object (`u._lastStripeFetchAt`). The `_v2BuildingsAttachListener` read-switch replaces the WHOLE building object on every event (`state.buildings[idx] = incoming`); the incoming units (from the collection doc) carry no runtime fields → the throttle reset on every tick → re-fetch storm (the strip fires the buildings listener far more often than the monolith ever did).
- **Invariant — DO NOT BREAK:** runtime/ephemeral per-unit fields that must survive sync (fetch throttles, in-flight handles, render caches) must NOT live on the unit object when the buildings-strip / read-switch can replace it. The Stripe-fetch throttle is keyed by `customerId` in the module-level `_stripeFetchThrottleAt` map (the natural per-fetch key; invoice rows already live in the module-level `_invoicesCache`, not on the unit). Do NOT reintroduce `u._lastStripeFetchAt` or any `u._*` throttle that the building swap wipes.
- **How to verify:** `grep -c "_stripeFetchThrottleAt" floor-map-editor.html` ≥ 3 and `grep -c "_lastStripeFetchAt" floor-map-editor.html` == 0. Functional: open a unit card under the strip → number/verify state stays stable (no re-fetch storm in console).
- **Regression test:** none — manual UI only.

---

### 45. Server CFs must be strip-aware (read + write) for the buildings-strip (2026-06-04)

- **Status:** active
- **Branch / commit:** `main` — `8e9735a` (functions/index.js); deployed + verified live the same day.
- **Area:** Cloud Functions / scaling buildings-strip / invoicing / waiver math / revenue-critical
- **Files:** `functions/index.js` — `readWorkspaceState()` + `mutateWorkspaceState()` (~:230-330) and helpers `_readStateRaw` / `_stripOnCF` / `_stableStringCF` / `_loadBuildingsForCF` / `_mergePaymentsIntoBuildingsCF` / `_rehydrateStateForStripCF` / `_buildingForV2CF` / `_mirrorBuildingV2CF`.
- **Bug it fixed (revenue-critical):** with the buildings-strip ON the monolith carries `buildings:[]` (real buildings live in the `workspaces/{ws}/buildings` collection, payments in `.../payments`). Server functions read units from the monolith via `findUnit(state,…)` (21 callers) and write stamps via `mutateWorkspaceState`. Under the strip BOTH broke: invoice send threw `"Unit not found in workspace state"`, waiver pro-rate saw no `u.payments` (→ over-billing), `u.stripe` stamps were lost (→ double-billing risk). **This is exactly why employees could not send invoices** until the workspace was reverted to ~925 KB earlier today.
- **Invariant — DO NOT BREAK:** the strip-aware I/O is **GATED on `state.settings.syncBuildingsStrip`** — when OFF, behavior is byte-identical (DORMANT). Keep it gated. `readWorkspaceState()` must rehydrate buildings + payments from the collections when the strip is on so `findUnit` / waiver math see the data. `mutateWorkspaceState()` must (a) pre-load buildings OUTSIDE the transaction, (b) let the mutate modify them, (c) mirror ONLY the shape-changed buildings back to the collection — 1:1 with the client `_buildingForV2` / `_mirrorBuildingsToV2` format: **payments stripped, points flattened to `pointsFlat`, doc key = `building.id`, `_schema:'v2'`** — and (d) re-strip `state.buildings=[]` before the monolith write so it stays small. Payments keep going via `_writePaymentV2` (NOT inside the building doc). **Do NOT write rehydrated buildings into the monolith** (that un-strips it → over the 1 MB cap).
- **Verified live (2026-06-04):** strip ON → push 925→**48 KB**; a rent invoice for Suite 243 then succeeded — `[nto-rent] ✓ invoice created in_1Teo4U2nq2bZh3q65IvV9fo6`, no "Unit not found". 679 units intact pre/post.
- **Known follow-up (perf, NOT correctness):** under the strip `_mergePaymentsIntoBuildingsCF` reads the FULL payments collection (~1297 docs) on every `readWorkspaceState` / `mutateWorkspaceState` call. Fine for operator-triggered sends; optimize to lazy/targeted (per-unit) loads before relying on it in the high-volume auto-billing cron.
- **How to verify:** `grep -c "_rehydrateStateForStripCF\|_mirrorBuildingV2CF" functions/index.js` ≥ 2; `node --check functions/index.js`. Functional: with `syncBuildingsStrip=true`, send a rent invoice → it creates on Stripe (no "Unit not found").
- **Regression test:** none — manual UI + live Stripe test.

---

### 44. fixFloorAssignments move-loop must NEVER delete a unit + backup/PITR gaps (DATA LOSS, 2026-06-04)

- **Status:** active
- **Branch / commit:** `main` — emergency freeze `451f866`, proper fix `c3e5fa7`; PITR enabled out-of-band.
- **Area:** Floor assignment / data integrity / backups / DATA LOSS incident
- **Files:** `floor-map-editor.html` — `fixFloorAssignments()` move loop (~:151654) and the `ensureRealDataSeeded` on-init auto-run (~:151712).
- **Incident (operator-visible, severe):** New Tampa floors progressively LOST units on every reload (floor 2 114→67, floor 4 23→0, floor 5 17→0; ~100 units deleted per pass). The architect's floors 4/5 were **permanently lost** (unrecoverable — see backup gap below).
- **Root cause (deletion):** the `fixFloorAssignments` move loop did, in order: `fromFloor.units = filter(u=>u!==unit)` (remove from source) → `if (target.units.some(u=>u.id===unit.id)) continue` (skip add when target already has the id). When cross-floor **dup ids** existed (from the phantom-floor / multi-writer sync churn), the unit was removed from source AND not added to target = **silently DELETED**. The function auto-ran on every load (`mismatches>3` → `fixFloorAssignments(true)`), so each reload deleted ~100 units.
- **Invariant — DO NOT BREAK:** in the move loop, **check for a dup id on the target BEFORE removing from the source**: `if (target.units.some(u=>u.id===unit.id)) continue;` must come FIRST; only `filter`-out-of-source when the push to target is certain. `fixFloorAssignments` must be incapable of deleting a unit — worst case a misplaced unit stays on its (wrong) floor. The on-init auto-run was emergency-frozen (`451f866`) then **PERMANENTLY REMOVED** (`0e02663`, operator decision): the app must NOT re-sort/dedup rooms on page load — the source of truth is where the operator placed a room, not the `id/100` rule. Dedup/re-sort is MANUAL-only via the «🔧 Fix Floor Assignments» button now. **Do NOT re-add an on-load auto-repair that mutates room/floor placement** (`dedupeAllFloors`/`dedupeUnitsEverywhere`/`fixFloorAssignments` on init) — that whole pattern caused this incident.
- **Backup gap (why it was unrecoverable — ARCHITECTURAL):** the server backup system (`/workspaces/{ws}/backups/`) snapshots ONLY the monolith state doc. The **buildings strip** moved buildings into the per-entity `buildings` collection, which the backup system does NOT capture — so under the strip, auto-backups are ~45 KB shells with no buildings. The architect's floors 4/5 lived only in the collection (synced today, post-strip) → no backup contained them. Full Firestore **PITR was DISABLED** (only a 1-hour version window existed; the loss predated it). **Fix: PITR now ENABLED (7-day, covers all collections).** If a future change strips data into collections, EITHER keep PITR on OR extend the backup CF to snapshot the collections.
- **Process lessons (do NOT repeat):** (1) take + VERIFY a full backup before any structural op (strip, floor/unit delete, restore); (2) NEVER run `sfaWipeBackups()` during instability (it removed local recovery snapshots mid-incident); (3) destructive auto-repairs must not run on load (they compound loss across reloads); (4) when debugging data loss, FREEZE mutations + secure a copy first, then diagnose — don't iterate destructive scripts.
- **How to verify:** `grep -B1 "fromFloor.units = fromFloor.units.filter" floor-map-editor.html` — the `if (target.units.some(...id...)) continue;` line must appear ABOVE the filter, not below. `grep -c "FLOOR-REPAIRS FROZEN" floor-map-editor.html` ≥ 1. PITR: `gcloud firestore databases describe --database='(default)' --project=suitesforall --format='value(pointInTimeRecoveryEnablement)'` → `POINT_IN_TIME_RECOVERY_ENABLED`.
- **Regression test:** none — manual UI only.

---

### 43. fixFloorAssignments must NOT synthesize phantom floors from sub-room IDs (2026-06-04)

- **Status:** active
- **Branch / commit:** `main` — fixes `cbfa2fc` (max-floor guard) + a follow-up (sub-room-by-pattern skip)
- **Area:** Floor assignment / data integrity / phantom floors
- **Files:** `floor-map-editor.html` — `fixFloorAssignments()` (~:151574): the `misplaced` detection loop (sub-room pattern skip + `_allUnitIds` set) and the floor-creation block (`expected > maxFloor + 1` guard).
- **Bug it fixed (operator-visible):** A phantom **"Floor 21"** appeared in the New Tampa building — a duplicate holding 33 of Floor 2's rooms. Cause: `fixFloorAssignments` routes each unit to floor `Math.floor(parseInt(id)/100)` and CREATES that floor if missing. Sub-rooms have 4+-digit ids (e.g. `2041` = a subdivision of suite 204, `2101` = sub-room of 210). They're meant to be skipped (`if (u.parentId) continue`), but when a sub-room's `parentId` was temporarily lost (during the night's sync churn), it got routed: `Math.floor(2101/100) = 21` → a phantom **Floor 21** was synthesized and the sub-room (plus, via downstream merge, a copy of Floor 2's units) landed there.
- **Invariant — DO NOT BREAK:** Two independent guards in `fixFloorAssignments`, keep BOTH:
  1. **Sub-room-by-pattern skip** (parentId-independent): skip routing a unit when `id >= 1000` AND its parent id (`Math.floor(id/10)`) exists among the building's units — it's a sub-room, rides with its parent. (`_allUnitIds` set built before the loop.)
  2. **Max-floor guard:** when the target floor doesn't exist, do NOT create it if `expected > maxExistingFloor + 1` — leave the unit in place + warn. Prevents materializing implausible floors (20/21/101) from bad ids. Legit incremental floors (max+1) still allowed.
- **Why both:** the parentId skip is the first line; guard #1 covers parentId loss (the actual trigger); guard #2 covers any other bad id (typo, corruption) regardless of sub-room status, and doesn't depend on maxFloor being clean.
- **How to verify:** `grep -c "_allUnitIds" floor-map-editor.html` ≥ 1 and `grep -c "expected > _maxFloor + 1" floor-map-editor.html` ≥ 1. Functional: a sub-room (e.g. 2041) on Floor 2 with parentId stripped must NOT create a Floor 20; `fixFloorAssignments` leaves it on Floor 2.
- **Cleanup of the existing phantom:** the already-created Floor 21 is removed once via console (gated splice that only deletes the floor if every one of its units also exists on another floor — no unique unit lost). Removing it also restores a clean `maxFloor` so guard #2 is at full strength.
- **Regression test:** none — manual UI only.

---

### 42. Building selector must NOT rebuild dropdown DOM when unchanged (2026-06-04)

- **Status:** active
- **Branch / commit:** `main` — fix `468f7b1`
- **Area:** UI / building selector / dropdown click handling
- **Files:** `floor-map-editor.html` — `renderBuildingSelector()` (~:59218), `_buildingSelectorSig` decl (just above the function).
- **Bug it fixed:** Building-switch clicks needed 2-3 tries (intermittent). `renderBuildingSelector()` rewrote `buildingList.innerHTML` on EVERY call, recreating the `.bd-item` nodes (inline `onclick`). When a background re-render fired between the operator's mousedown and mouseup, the clicked node was replaced → the browser never generated a `click` → the switch was dropped. Today's read-switch listener attach (Entry 41) increased re-render frequency, making the collision common.
- **Invariant — DO NOT BREAK:** `renderBuildingSelector` must compute a signature (`_buildingSelectorSig` = currentBuildingId + each accessible building's id/name/address/photo) and **skip the `list.innerHTML` rewrite when the signature is unchanged** (`if (_bsSig === _buildingSelectorSig && list.children.length) return;`). The pill + manager strip still update every call (not click targets); only the click-target list is guarded. Rebuild still fires on genuine changes (add/remove/rename/switch). Do NOT revert to an unconditional `list.innerHTML = …`.
- **General principle:** any menu/list built via `innerHTML` and re-rendered on data ticks has this latent click-loss bug. Guard the rebuild behind a content signature (or don't rebuild while the menu is open). Watch for the same pattern in other dropdowns.
- **How to verify:** `grep -c "_buildingSelectorSig" floor-map-editor.html` ≥ 3. Functional: open the building dropdown, click a building → switches first try, repeatedly.
- **Regression test:** none — manual UI only.

---

### 41. Read-switch listeners MUST attach after fbSync.enabled=true (2026-06-04)

- **Status:** active
- **Branch / commit:** `main` — fix `7ab691c`
- **Area:** Scaling V2 / read-switch listener attach / sync init / realtime + load speed
- **Files:** `floor-map-editor.html` — `fbActivateWorkspaceSync()` right after `fbSync.enabled = true` (~:31417).
- **Bug it fixed:** Symptom `[v2-read] Firestore not ready, cannot attach listener` + the app running ONLY on the one-shot getDocs fallback (slow ~1.5-3s load, NO realtime updates). In `fbActivateWorkspaceSync`, when the cloud doc is newer (remoteRev > localRev — the normal case), `fbApplyRemote()` runs at ~:31410 BEFORE `fbSync.enabled = true` (:31417). The v2 read-switch attach (`_v2*AttachIfFlagged`, called from fbApplyRemote) checks `fbSync.enabled`, sees false, bails — and nothing ever retried, so buildings/payments never arrived via onSnapshot.
- **Invariant — DO NOT BREAK:** immediately after `fbSync.enabled = true` in `fbActivateWorkspaceSync`, explicitly call `_v2PaymentsAttachIfFlagged()` + `_v2BuildingsAttachIfFlagged()` + `_v2LeaseDocsAttachIfFlagged()`. Idempotent (each attaches only if not already attached) + flag-gated (read-switch off → no-op). Without this, read-switch sessions silently fall back to one-shot getDocs (no realtime; the buildings strip then can't get live building updates either).
- **How to verify:** `grep -A12 "fbSync.status = 'syncing'" floor-map-editor.html | grep -c "AttachIfFlagged"` ≥ 3. Functional: reload a read-switch session → console shows `[v2-read] listener attached` + `[v2-buildings-read] listener attached` (not just "Firestore not ready" + fallback); realtime payment/building updates appear without reload.
- **Related:** together with Entry 40 (no-clobber) + Entry 39 (long-polling) + the `afed377` getDocs fallback, this makes the buildings strip safe + fast. Verified live on BOTH tony@al-en.com and architecture@zhukdev.com (employee): 804/804 units mirrored, push 992→44 KB, sync resumed.

---

### 40. fbApplyRemote MUST NOT apply monolith `buildings` under the buildings read-switch (2026-06-04)

- **Status:** active
- **Branch / commit:** `main` — fix `229b9b4`
- **Area:** Scaling V2 / Phase 2 buildings strip + read-switch / fbApplyRemote / data-loss (display)
- **Files:** `floor-map-editor.html` — `fbApplyRemote()` key-merge loop (~:34531, the `for (const k of ['buildings','tenants',…])`).
- **Bug it fixed (operator-visible):** With the buildings strip ON, the app **emptied itself after ~5 minutes of idle** ("everything disappears"). The monolith state doc carries `buildings: []` under the strip (geometry lives in the per-building `buildings` collection). `fbApplyRemote`'s merge loop did `state[k] = remote[k]` unconditionally, so ANY later remote monolith snapshot (Firebase ID-token refresh, a push echo, a long-polling reconnect re-delivery) applied the empty array and **wiped the live, collection-rehydrated `state.buildings`** (and their nested `u.payments`). The buildings read-switch listener does not re-deliver them (no `docChanges` since its last snapshot), so the map stayed blank until a manual reload.
- **Invariant — DO NOT BREAK:** In `fbApplyRemote`'s key-merge loop, **skip `'buildings'` whenever `syncBuildingsReadEnabled()` is true** (`if (k === 'buildings' && syncBuildingsReadEnabled()) continue;`). Under the read-switch the **collection** (onSnapshot listener + getDocs fallback) is the authoritative source for buildings — the monolith is NOT, and its (stripped/empty) buildings must never clobber the live ones. Only `'buildings'` is skipped; `tenants`/`leases`/`settings` (not stripped) still apply from the monolith normally.
- **Data safety:** NOT a real data-loss bug — the buildings collection is intact throughout (the monolith never deletes collection docs; building deletes are explicit-event only, see Entry 37/SESSION_LOG 361d3ab). The wipe was in-memory/display only; a reload restored everything from the collection. The fix removes the need to reload.
- **Edge case (not deployed):** if payments-strip were ON with buildings-read-switch OFF, applying `remote.buildings` (carrying `u.payments={}`) would wipe payments. Current prod runs both read-switches together, so the `syncBuildingsReadEnabled()` skip covers it. If that config ever ships, also preserve `u.payments` when applying monolith buildings.
- **How to verify:** `grep -c "k === 'buildings' && typeof syncBuildingsReadEnabled" floor-map-editor.html` ≥ 1. Functional: with the buildings strip ON, load the app, leave it idle 5-10 min (or trigger a monolith write from another tab) → `state.buildings` stays populated, map does not blank.
- **Regression test:** none — manual UI only (timing/sync-dependent).
- **Related PR / issue:** none.

---

### 39. Firestore MUST use long-polling transport (experimentalForceLongPolling) (2026-06-03)

- **Status:** active
- **Branch / commit:** `main` — fix `d0723c8`
- **Area:** Firebase / Firestore transport / sync reliability / scaling-strip prerequisite
- **Files:** `floor-map-editor.html` — SDK loader exposes `initializeFirestore` (~:28475); `fbSync.db` init (~:31263-31275).
- **Bug it fixed:** The default Firestore WebChannel watch stream (`onSnapshot`) was unreliable for the operator under load — a storm of `webchannel_blob` errors, slow/never-arriving snapshots — while one-shot `getDocs` (REST) always worked. This caused the empty-app incidents when the monolith was stripped (the app depends on the read-switch snapshot to repopulate; a stalled stream → empty $0 app).
- **Invariant — DO NOT BREAK:** `fbSync.db` MUST be created via `sdk.initializeFirestore(app, { experimentalForceLongPolling: true })`, NOT `sdk.getFirestore(app)`. `initializeFirestore` MUST run before ANY Firestore access (it throws if Firestore was already initialized). Keep the `getFirestore` fallback inside the `try/catch` for SDK builds lacking `initializeFirestore`. Do NOT "simplify" this back to `getFirestore` — that reintroduces the flaky WebChannel stream and breaks the strip (empty-app on reload).
- **Why this works:** long-polling avoids the long-lived WebChannel connection that extensions / middleboxes / load were tearing down. Confirmed via lp-test: 1297 payments + 5 buildings delivered in 0.0s from SERVER with 0 errors. This is the transport fix that made the Stage 5/6 strip safe to leave ON (together with Entry 37 cache re-merge + the `afed377` getDocs fallback + Entry 38 color prefetch).
- **Verification:** `grep -c "experimentalForceLongPolling" floor-map-editor.html` ≥ 1 and it must be the path assigned to `fbSync.db`. Functional: reload prod → Network shows Firestore `Listen` channel as repeated long-poll requests (not a single hanging stream); snapshots arrive promptly; no `webchannel` error storm in console.
- **Regression test:** none — manual / network-tab only (transport-level).
- **Related PR / issue:** none. Closes the root cause behind the 2026-06-03 strip reverts (the earlier "transient stream delay" theory in Entry 37's follow-up was the symptom; long-polling is the cure).

---

### 38. Map color prefetch must paginate ALL Stripe invoices + once-per-session gate (2026-06-03)

- **Status:** active
- **Branch / commit:** `main` — fix `cd51c01`
- **Area:** Floor-map / payment-status coloring / Stripe invoice cache / display-only
- **Files:** `floor-map-editor.html` — `_prefetchInvoicesForMapBadges()` (~:83550), `_mapBadgesPrefetchedFull` flag decl (next to `_lastStripeCacheFetchMs`, ~:83610).
- **Bug it fixed:** In Payment-status map mode, occupied units rendered the cream "Occupied" tint instead of blue (`#0EA5E9` invoice-sent·unpaid) / green (`#A7F3D0` paid). The current-month "invoice sent" color is derived from Stripe invoices in `_invoicesCache` (NOT from `u.payments`, which has no record for an invoiced-but-unpaid current month), and the cache was only partially populated.
- **Root cause (two-fold):** (a) `_prefetchInvoicesForMapBadges` fetched a single `stripeListInvoices({limit:100})` with no pagination — the workspace has **615** invoices, so only the first 100 reached the cache; (b) the guard `if (_invoicesCache.length > 0) return` let the lazy per-unit fetches (`_maybePrefetchInvoicesCache`, `[unit invoice fetch]`) seed ~20 rows and thereby **block the full prefetch from ever running**. Live cache was stuck at 21 → most units had no invoice → cream.
- **Invariant — DO NOT BREAK:** `_prefetchInvoicesForMapBadges` MUST paginate through ALL invoices via `res.hasMore` / `res.nextCursor` (cap 25 pages = 2500, with a `console.warn` when capped — no silent truncation), and MUST gate the full load behind the once-per-session flag `_mapBadgesPrefetchedFull` (set true only AFTER the loop succeeds), NOT behind `_invoicesCache.length > 0`. The 30s throttle (`_lastStripeCacheFetchMs`) and `anyStamp` gate stay.
- **Blast radius:** display only. `stripeListInvoices` is a passive read (same call the Invoices page makes); no money-computation path touched, no writes. Worst case if reverted: map under-colors; balances/owed/collections unaffected.
- **Verification:** load the app in Payment-status mode → after the boot prefetch, occupied invoiced units are blue and paid units green (not cream). Console diag: `_invoicesCache.length` should reach the full invoice count (~615), not ~100. `grep -c "startingAfter: cursor" floor-map-editor.html` ≥ 1; `grep -c "_mapBadgesPrefetchedFull" floor-map-editor.html` ≥ 3.
- **Regression test:** none — manual UI only (Stripe-backed, needs live invoices).
- **Related PR / issue:** none.
- **Follow-ups (2026-06-04, same area — keep all):**
  - `5906531` — re-fire `_prefetchInvoicesForMapBadges()` AFTER buildings load (in `_v2BuildingsFallbackFetch` + the buildings listener render block) + inflight-guard instead of the 30s throttle. Under the read-switch, buildings arrive ~3s late (getDocs fallback); the boot prefetch (200/800ms) ran with 0 buildings → `anyStamp=false` → never fetched → units stayed lease-yellow instead of payment-blue. Invariant: re-fire the prefetch once buildings are applied; guard it with `_mapBadgesPrefetchInflight` (NOT the shared 30s throttle) so it can be re-invoked.
  - `51c626c` — incremental recolor: call `renderUnits()` after EACH invoice page (Stripe lists created-desc → current month lands in page 1, so colors appear ~2-3s instead of ~20s). Also lowered the buildings + payments read-switch getDocs fallback 3s→1.5s.
  - `1a03921` — instant colors from the localStorage bucket cache: in `_computeUnitFillImpl` payment mode, read the unit's last-invoice status from `sfa_inv_buckets_v1` (via `u.stripe.lastInvoiceId`, current month only) as a fast path so the map paints paid/blue immediately on load without waiting for the ~4s Stripe fetch (which then refines via the invCacheKey memo invalidation). Display-only.

---

### 37. Buildings read-switch must re-merge u.payments from cache (2026-06-03)

- **Status:** active
- **Branch / commit:** `main` — fix `9099b34`
- **Area:** Scaling V2 / Phase 2.4 buildings read-switch / Phase 1.2 payments read-switch / payments hydration / false-overdue
- **Files:** `floor-map-editor.html` — `_v2PaymentsCache` decl (after `_v2PaymentsRerenderTimer`), `_v2PaymentsAttachListener` populate block (before the unit lookup), `_v2BuildingsAttachListener` fill block (after `_buildingFromV2Restore`, before `state.buildings[idx]=incoming / push`).
- **Invariant:** (a) the payments read-switch listener MUST update `_v2PaymentsCache[buildingId+'|'+unitId][ym]` on EVERY `payments` docChange, **before** the in-memory unit lookup (so a payment is cached even when its building isn't loaded yet). (b) the buildings read-switch listener MUST fill `u.payments` from `_v2PaymentsCache[bid+'|'+u.id]` for every incoming building's units (without clobbering already-set `ym`) — for NEW buildings (`idx<0`) too, not only swapped existing ones.
- **Why (incident 2026-06-03):** during the live Stage-6 buildings strip, the monolith stopped carrying `state.buildings`. On reload the buildings read-switch swapped in collection building docs (payments stripped by `_buildingForV2`); the payments listener had applied 1297 payment docs by locating units in `state.buildings`, but when buildings were absent/late those applies were dropped and **never re-applied** (the "refetch via cache" the code comment promised did not exist). The buildings listener only preserved payments from a *prior in-memory* building (`idx>=0`); a NEW building (every building under strip) got none → Suite 431 (and all units) showed **false "Overdue" + accrued late fees** for already-paid months. No data lost (payments intact in the `payments` collection); rolled back via `sfaRehydrateMonolith{Payments,Buildings}`. The real `_v2PaymentsCache` makes both snapshot orderings correct.
- **Blast radius:** hydration only — does NOT touch any money-computation path (rent / late-fee / owed / collections). Only affects behavior when the read-switch is ON; can only ADD recorded payments to in-memory state, never remove. With read-switches off → no-op.
- **Also fixed (role-helper):** `isRootAdmin()` was called with NO email in the 4 `sfaEnable*` toggles (`sfaEnableStripPaymentsV2` / `…BuildingsV2` / `…LeaseDocs` / `sfaEnableOutreachCap`) → `isRootAdmin(undefined)` always false → "root-admin only" rejected everyone incl. the owner. Fixed to `isRootAdmin(fbSync?.user?.email)`. (The 2026-06-03 payments-strip was activated by setting `state.settings.syncV2StripPayments=true` directly to work around this.)
- **How to verify:** `grep -c "_v2PaymentsCache" floor-map-editor.html` ≥ 4 (decl + populate set/del + buildings fill). `grep -c "!isRootAdmin()" floor-map-editor.html` must be **0** (all call sites pass an email). Functional: with both read-switches ON + buildings strip ON, reload → every paid suite still shows paid (no false late fees), `sfaReconcilePaymentsV2()` clean.
- **Strip retry gate:** before re-enabling the buildings strip (Stage 6), this fix must be deployed AND a reload must show paid suites intact under the strip. The payments strip (Stage 5) was independently verified safe (924→717 KB).
- **Follow-up `afed377` (getDocs fallback) — second half of making the strip safe.** The empty-app incident (2026-06-03, second attempt) was NOT this payment-merge bug and NOT a broken transport (16-min instrumentation showed the watch stream healthy, zero errors). It was a **transient stream delay** made fatal because the strip removed the monolith fallback. Fix: `_v2BuildingsFallbackFetch` / `_v2PaymentsFallbackFetch` — each read-switch schedules a one-shot `getDocs` 6s after attach; if the watch stream hasn't delivered, getDocs (REST, reliable) populates buildings/payments (+cache). Idempotent, inflight-guarded, early-return once the listener delivers, DORMANT-safe (read-switch off → no-op). **Invariant: keep the 6s getDocs fallback wired in both `_v2*AttachIfFlagged`** — it's what prevents a transient stream delay from showing an empty app under the strip. Together with this Entry-37 cache fix, the buildings strip is resilient to both (a) payment-merge gaps and (b) transient stream delays.
- **Rollback:** `git revert 9099b34 && … deploy`, or operationally `state.settings.syncBuildingsStrip=false; saveState(); sfaRehydrateMonolithBuildings()`.

---

### 36. Server-side CF payment writes must dual-write to v2 collection (2026-05-31)

- **Status:** active
- **Branch / commit:** `main` — commit `ba68a4d`
- **Area:** Scaling V2 / Phase 1 dual-write / Cloud Functions / Stripe webhook
- **Files:** `functions/index.js` — helpers `_stateIfSyncV2()` / `_writePaymentV2()` / `_deletePaymentV2()` (~:215-260), handler patches in `handleInvoicePaid` (anchor + advance siblings, ~:3025-3050), `handleInvoiceVoided` (~:2520-2535), `handleChargeRefunded` (~:2585-2600), `confirmBankMatch` (~:7665-7680), `undoAutoAppliedPayment` (~:7130-7145)
- **Invariant:** Every server-side CF that writes `u.payments[ym]` inside `mutateWorkspaceState((s) => {...})` MUST also mirror the result to `workspaces/{ws}/payments/{buildingId__unitId__ym}` via `_writePaymentV2()` after the mutate commits. Every CF that deletes `u.payments[ym]` MUST call `_deletePaymentV2()` on the same explicit event. Gate-checked through `_stateIfSyncV2()` — when `state.settings.syncV2 === false` the whole mirror block is a no-op (operator can roll back via flag without redeploying CF).
- **Why:** without server-side mirror, server writes (Stripe webhooks, bank-feed confirm, undo auto-applied) bypass the v2 collection entirely → `sfaReconcilePaymentsV2()` accumulates drift on every webhook → read-switch (Phase 2 next step) cannot proceed because the v2 collection is stale. Client-side mirror exists via `repo._mirrorSet/_mirrorDel` (floor-map-editor.html:31966), but CF writes happen out-of-process — same DB but different code path — so they need their own mirror call.
- **NEVER delete by diff.** v1 strip incident 2026-05-30: a server-side diff-on-push strip mass-deleted all 1277 payment docs ×2 (race where stripped monolith loaded before overlay rehydrated → diff read empty → "delete everything"). v2 mirror-delete is ONLY called from explicit-event handlers (`undoAutoAppliedPayment` → `_deletePaymentV2`). Never derive deletions from before/after state comparison. See `SCALING_PLAN_v2.md` §0 rule 2.
- **How to verify:** `grep -c "_writePaymentV2\|_deletePaymentV2\|_stateIfSyncV2" functions/index.js` returns **≥ 14** (3 helper definitions + ≥ 5 `_stateIfSyncV2` gate checks + ≥ 5 `_writePaymentV2` writes + ≥ 1 `_deletePaymentV2` delete). Functional test: trigger one of `invoice.payment_succeeded` / `invoice.voided` / `charge.refunded` / `confirmBankMatch` / `undoAutoAppliedPayment` → run `sfaReconcilePaymentsV2()` → expect `missing 0 / extra 0 / mismatched 0`.
- **Mirrors client pattern at floor-map-editor.html:** schema `{ _schema:'v2', buildingId, floorId, unitId, ym, rec, _mirroredAt, _mirroredBy:'cloud-function' }`. Field-for-field same as client `_mirrorSet`; reconcile treats both writes as the same doc.
- **Rollback:** flip `state.settings.syncV2 = false; saveState()` in client console (mirror block stops without CF redeploy), or `git revert ba68a4d && firebase deploy --only functions`.

---

### 35. `loadPaymentsData` must be FILL-ONLY — static seed must never overwrite live payments (2026-05-31)

- **Status:** active
- **Branch / commit:** `claude/modest-curie-8a50ad` — fix `5a0b44d`
- **Area:** Finance / payment records / b1 seed bootstrap / false-overdue
- **Files:** `floor-map-editor.html` — `loadPaymentsData()` (~:25855), `PAYMENTS_DATA` static seed (~:25777)
- **Invariant:** `loadPaymentsData()` must apply `PAYMENTS_DATA` **fill-only** — only set `u.payments[ym]` for months NOT already present. It must **NEVER** `Object.assign(u.payments, seed)` (which overwrites live records).
- **Why (incident 2026-05-31):** `PAYMENTS_DATA` (static seed, baseline 2026-05-01) hardcodes some suites' months as stale `{status:'late', amount:0}` (e.g. 433/413/408/449 `2026-04`, note `"…+late fee"`). The old `Object.assign(u.payments, seed)` ran on **every** load that triggered `loadPaymentsData` (via `fixFloorAssignments` step 4, or the `restored>0` fill-merge path → `loadPaymentsData(); saveState()`), **clobbering real synced `paid` records back to the stale seed value and persisting it**. Suites 408/413/433 (real Stripe-paid April, receipts, "client paid April rent on 10th") flipped to false-overdue. Proof: live record became byte-identical to the bare seed (no `stripe`/`history`/`date`), while the real payment survived only in the adjacent month. Data restored from `backups/2026-05-30`.
- **How to verify:** `grep -A25 "function loadPaymentsData(" floor-map-editor.html | grep "Object.assign(u.payments"` must return **nothing**. The loop must be `for (const ym of Object.keys(p.payments)) if (!(ym in u.payments)) u.payments[ym] = p.payments[ym]`. Enforced by `scripts/check-invariants.sh` (Entry 35 gate).
- **Note:** the seed is a one-time historical bootstrap; the synced live state is the source of truth. Same fill-only contract as `mergeTenantDataIntoFloor`.

---

### 34. Move-in rent stamp — deposit cross-stamp guard + self-heal (2026-05-28)

- **Status:** active
- **Branch / commit:** `claude/modest-curie-8a50ad`
- **Area:** Finance display / Move-in invoices badge / Suite header pill / Stripe stamp integrity
- **Files:**
  - `floor-map-editor.html`
    - `_stampPointsToDeposit` (new helper, near `_isMonthSettled`)
    - `_isMonthSettled`
    - `_unitRentCurrentStatus`
    - `_healStaleStripeStamps`
    - unit-detail panel pill render (where `pillLabel = 'Paid'` was hardcoded)
- **Functions / invariants:**
  - `_stampPointsToDeposit(u, invoiceId)` returns true when ANY of these hold:
    1. `u.stripe.depositInvoice.invoiceId === invoiceId` (direct cross-stamp).
    2. `_lookupInvoiceRow(invoiceId).metadata.purpose === 'deposit'` (Cloud-Function-stamped meta).
    3. `_lookupInvoiceRow(invoiceId).description` matches `/\bdeposit\b/i` (Stripe-Dashboard-issued fallback).
  - `_isMonthSettled` MUST NOT return `'stripe-paid'` for a ym when the stamp's invoiceId points to a deposit. Both branches (`u.stripe.moveInRent` and `u.stripe.lastInvoiceYm` paths) must guard.
  - `_unitRentCurrentStatus` MUST NOT use deposit-bucket as rent-bucket. Same guard on both `mi` and `lastInvoiceYm` paths.
  - `_healStaleStripeStamps` MUST self-heal cross-pointing stamps: if `u.stripe.moveInRent.invoiceId === u.stripe.depositInvoice?.invoiceId` OR the cached row is a deposit, delete `u.stripe.moveInRent` and (if matched) `u.stripe.lastInvoiceId`/`lastInvoiceYm`. NEVER touch `manualLink === true` stamps (operator-chosen).
  - Unit-detail pill label MUST distinguish three flavors of `_rentState === 'paid'`:
    1. `_rentLabel.startsWith('Deposit')` → `'Deposit paid'` (future-lease short-circuit)
    2. `_rentLabel.includes('waived')` → `'Waived'`
    3. otherwise → `'Paid'` (true rent paid)
- **Bug it fixed:**
  Operator-visible symptom: Suite 401 (Brittany Cratic, lease Jun 1 2026, viewed 2026-05-28) showed three contradictory states in one panel:
    - Move-in invoices card: «First month rent — June 2026 · $900.00 · **PAID**» (green pill)
    - Invoice History: «May 1, 26 · Jun · $900 · **PAST DUE**» (red pill, same invoice subject)
    - Payment History calendar: «No payments on record yet»
    - Suite header pill: «**Paid**»
  Root cause: `u.stripe.moveInRent.invoiceId` was stamped on the **deposit** invoice ID by an earlier sync glitch (both rent and deposit were $900 — same tenant, same suite). `_lookupInvoiceBucket(moveInRent.invoiceId)` correctly returned `'paid'` for that deposit row, which `_isMonthSettled` then returned as `'stripe-paid'` for ym=2026-06. Move-in card displayed PAID; Invoice History rendered directly from `_invoicesCache` and saw the real past-due June rent invoice; the two diverged. Suite header pill compounded the confusion: future-lease + deposit-paid short-circuit returned `state:'paid'` with label «Deposit paid · lease starts 2026-06-01», but render code collapsed all `_rentState === 'paid'` branches to a single «Paid» label, so operator could not tell whether rent or deposit was paid.
- **Invariant — DO NOT BREAK:**
  1. Any function that decides «is this rent paid» based on a Stripe stamp's invoice ID must first check `_stampPointsToDeposit(u, invoiceId)`. Bucket of a deposit invoice is not authoritative for rent.
  2. `_healStaleStripeStamps` MUST keep its cross-stamp self-heal step. Without it, `_findRentInvoiceInCache` / `_backfillRentStamp` can never re-stamp on the real rent invoice while the bad pointer persists.
  3. Pill label MUST stay distinguishable. If a future edit re-collapses to plain «Paid», operator regression returns: deposit-paid-during-future-lease looks identical to actual rent paid.
  4. `manualLink === true` is sacred. Never auto-clear a stamp the operator chose explicitly (FIXES_LOG Entry 3 invariant — preserved).
- **Verification:**
  1. **State A — clean tenant, no cross-stamp.** Move-in card shows PAID when rent is genuinely paid (either local `u.payments[ym].status='paid'` or `_lookupInvoiceBucket(rentInvId)==='paid'` where that invoice is NOT a deposit). Behavior unchanged from before fix.
  2. **State B — cross-stamped tenant (the Suite 401 scenario).** With `u.stripe.moveInRent.invoiceId === u.stripe.depositInvoice.invoiceId`: on next render `_healStaleStripeStamps` clears the bad pointer; `_findRentInvoiceInCache` re-stamps on the real rent invoice; Move-in card shows the real status (OPEN / PAST DUE) instead of PAID.
  3. **State C — future-lease tenant, deposit paid, rent not invoiced yet.** Suite header pill shows «Deposit paid» (not bare «Paid»). Move-in card shows «First month rent — Jun … — Not sent» (no rent invoice exists). No contradiction.
  4. **State D — rent waived for current month.** Pill shows «Waived». Existing free-month color (green) preserved.
  5. **State E — manualLink deposit stamp.** Operator-attached deposit stamp not touched by self-heal. Move-in rent stamp on a separate real rent invoice continues to work.
- **Regression test:** none — manual UI verification only. Reproduce State B by hand-editing localStorage `state.buildings[].floors[].units[].stripe.moveInRent.invoiceId = state...depositInvoice.invoiceId`, reload, verify Move-in card no longer says PAID.
- **Related PR / issue:** none (direct commit on `claude/modest-curie-8a50ad`)

#### Phase 2 — `lastInvoiceId` cross-stamp + diagnostic helper (2026-05-28, same-day second pass)

After first-pass fix deployed, Suite 401 still rendered wrong: green «Sent» (blue actually — the function returns `state:'sent'`) instead of the real Stripe status. Diagnostic showed `moveInRent: null` (Phase 1 heal cleared it) but `u.stripe.lastInvoiceId === u.stripe.depositInvoice.invoiceId` — cross-stamp had also landed on `lastInvoiceId/Ym` independently. Phase 1 heal only cleared `lastInvoiceId` as a side-effect of clearing `moveInRent` (line `if (u.stripe.lastInvoiceId === miAfter.invoiceId)`), so when `moveInRent` was already null at heal time, `lastInvoiceId` survived.

- **Additional invariants:**
  1. `_healStaleStripeStamps` MUST inspect `u.stripe.lastInvoiceId` independently of `u.stripe.moveInRent`. Both paths can carry the cross-stamp; the heal must cover the case where one is cleared but the other isn't.
  2. The same three deposit-detector conditions apply to `lastInvoiceId`: direct equality with `depositInvoice.invoiceId`, `metadata.purpose === 'deposit'`, or `description` matches `/\bdeposit\b/i`.
- **Diagnostic helper added** — `window.sfaDiagnoseSuitePaid(suiteId, ym?)` in `floor-map-editor.html`. Pure read-only. Prints:
  - Unit + stamps + paymentForYm + paymentForDeposit
  - `crossStamps` block (explicit deposit ↔ moveInRent ↔ lastInvoice collision detector)
  - All `_invoicesCache` rows matching the suite (by email/description/metadata)
  - `_stampPointsToDeposit` per id with sub-conditions
  - `_isMonthSettled` branch trace + `_findRentInvoiceInCache` result + final `_moveInRentStatus`
  - DOM badges inside `.move-in-card` + stale-render mismatch flag
  - Human VERDICT line naming the source of the rendered label
  - `suggestedFix` when applicable
- **How to invoke:** `sfaDiagnoseSuitePaid('401')` from browser console. `copy(sfaDiagnoseSuitePaid('401'))` puts the full JSON in clipboard for sharing.
- **Use it:** if any future regression surfaces a wrong Move-in card status, run this BEFORE attempting another fix. The VERDICT line tells you which code path produced the label.

---

### 33. Auto-invoice cron — cascade gate (workspace ← building ← floor ← unit) (2026-05-28)

- **Status:** active
- **Branch / commit:** `claude/modest-curie-8a50ad`
- **Area:** Auto-billing / Stripe invoicing / Cloud Functions cron
- **Files:**
  - `functions/index.js` — `runAutoInvoices` cron handler (`exports.runAutoInvoices`, schedule `0 9 * * *` UTC)
- **Functions / invariants:**
  - `runAutoInvoices` cron must walk the SAME cascade as the client-side `isAutoInvoiceEnabledFor` (`floor-map-editor.html:85290`) and `getEffectiveAutoInvoiceConfig` (`floor-map-editor.html:85313`). Priority order, highest to lowest:
    1. `building.billingRulesOverride.paused === true` → OFF (pause beats all)
    2. `unit.autoInvoice === 'on'` → ON
    3. `unit.autoInvoice === 'off'` → OFF
    4. `floor.billingRulesOverride.autoInvoice.enabled` (if boolean) wins
    5. `building.billingRulesOverride.autoInvoice.enabled` (if boolean) wins
    6. `state.settings.autoInvoice.enabled` (workspace fallback)
  - Same cascade applies to `sendBeforeDays` and `daysUntilDue` (building/floor override → unit `autoInvoiceBeforeDays` for sendBefore only → workspace).
  - Pre-loop fast-exit: if `cfg.enabled === false` AND no `b.billingRulesOverride.autoInvoice.enabled === true` anywhere AND no `f.billingRulesOverride.autoInvoice.enabled === true` anywhere AND no `u.autoInvoice === 'on'` anywhere → return early (avoids walking hundreds of units when truly nothing is enabled). Otherwise the per-unit loop runs and lets the cascade decide each unit.
- **Bug it fixed:**
  Operator-visible symptom: Tony confirmed via Settings → Billing screen that workspace-level `Enable auto-invoicing workspace-wide` checkbox was OFF, but cron also ignored building-level overrides. Firebase logs from 2026-05-20 through 2026-05-28 (8 consecutive cron runs at 09:00 UTC) all logged `[auto-invoice] workspace disabled, skipping` with zero per-unit processing — even on days when building-level overrides existed and units appeared in the client `Auto-billing Coverage` matrix as «Auto-rent ON». No June invoices were sent (trigger date 2026-05-22 = June 1 − sendBeforeDays 10). Root cause: cron checked only `cfg.enabled` and returned at line 2950, never walking the per-building/floor/unit cascade that the client UI already supported.
- **Invariant — DO NOT BREAK:**
  1. **Cron cascade order must mirror client.** If a future edit changes the client priority (e.g. unit override drops below floor), the cron MUST be updated in lockstep — otherwise UI shows units as «ON» while cron silently skips them (or vice versa).
  2. **No early-return solely on `cfg.enabled === false`.** Workspace toggle OFF is no longer sufficient to skip the run — only the workspace + per-building + per-floor + per-unit pre-scan returning «nothing enabled anywhere» justifies early-exit.
  3. **Per-cycle skip-list intact** (FIXES_LOG Entry 24 — Stripe-advance prepayment). When `u.payments[nextYm].status === 'open' && stripeInvoiceId && paidVia === 'stripe-advance'`, cron MUST still skip even if cascade enables the unit. This entry's cascade gate runs BEFORE the skip-list — order is enabled-check → tenant/email/rent-check → today-trigger-check → prepayment-skip-list. Don't move the prepayment skip-list above the cascade.
  4. **`globalDueDays` rename** — outer-scope `const dueDays` was renamed to `globalDueDays`. Inner per-unit loop declares its own `let dueDays = cascade(globalDueDays, bAi, fAi)`. Later references inside the loop to `dueDays` (Stripe `due_date` payload at ~line 3271, description string at ~line 3360, `days_until_due` at ~line 3369) all resolve to the inner per-unit value via block-scope shadowing.
- **Verification:**
  1. **State A — workspace OFF, all overrides OFF.** Cron logs `[auto-invoice] no auto-invoice enabled anywhere ..., skipping` and returns without walking units. Equivalent to old behavior.
  2. **State B — workspace ON, no overrides.** Per-unit loop runs as before; `effectiveEnabled = !!cfg.enabled === true` for every unit. Existing behavior preserved.
  3. **State C — workspace OFF, building X has `billingRulesOverride.autoInvoice.enabled === true`.** Cron logs `workspace toggle off — walking cascade ...`. Per-unit loop walks ALL units in ALL buildings. Units in building X get `effectiveEnabled = true` via cascade step 5. Units in other buildings get `effectiveEnabled = false` (workspace fallback). Only building X units proceed to today-trigger check.
  4. **State D — building paused.** Even if workspace + override say ON, `b.billingRulesOverride.paused === true` short-circuits `effectiveEnabled = false`. Verify by setting `paused: true` on a building with prior auto-invoice ON; expect zero invoices for that building, others unaffected.
  5. **State E — unit `autoInvoice: 'off'` inside a building with override ON.** Unit-level OFF beats building-level ON (priority 3 > priority 5). Verify by toggling one unit's auto-invoice pill in Auto-billing Coverage matrix.
- **Regression test:** none — relies on cron firing in a Firebase project. After deploy, set workspace OFF + one building override ON, manually trigger via `▶ Run cron now` in Settings → Billing & Late Fees, check `firebase functions:log --only runAutoInvoices` for `walking cascade for per-building/floor/unit overrides` line.
- **Related PR / issue:** none (direct commit on `claude/modest-curie-8a50ad`)

---

### 32. Bank-sync watermark — safety margin on incremental polls (2026-05-28)

- **Status:** active
- **Branch / commit:** `claude/modest-curie-8a50ad`
- **Area:** Bank reconciliation / Stripe Financial Connections / cron polling
- **Files:**
  - `functions/index.js` — `BANK_FEED_WATERMARK_SAFETY_DAYS` constant; `_pullTransactionsForAccount`; `pollBankTransactions`; `bankFeedScheduledPoll`
- **Functions / invariants:**
  - `BANK_FEED_WATERMARK_SAFETY_DAYS = 14` — incremental polls MUST subtract this many days from `lastPolledAt` when computing the `transacted_at >= since` filter passed to `stripe.financialConnections.transactions.list`. Without the margin, Stripe FC transactions published with `transacted_at < lastPolledAt < publish_time` (bank settles same-day, Stripe receives next day) silently fall through the gap between polls and are lost forever. 14 days covers observed worst-case bank-publishing lag (~7 days) with ~2× buffer.
  - `_pullTransactionsForAccount` — before each batch `set(merge:true)` MUST pre-read existing docs via `db.getAll(...refs)` and preserve operator match decisions on re-poll. Specifically: when `existing.matchState === 'confirmed' || existing.matchState === 'dismissed'` the `matchState`, `matchedTenantId`, `matchedUnitId`, `matchedYm` fields MUST NOT be included in baseDoc (merge:true would otherwise reset them to `'unmatched'`/`null`). `checkImageUrl: null` MUST only be written for genuinely new docs (operator-uploaded check images on existing docs must survive re-polls). `written` counter increments ONLY for new docs (`isNew = !existing`); rewrites count as `skipped` instead — otherwise the operator's «X new transactions pulled» message inflates on every overlap.
  - `pollBankTransactions` (callable, line ~5407) — backfill branch (`isBackfill || !c.backfillCompleted || !c.lastPolledAt`) keeps 365-day window; incremental branch subtracts safety margin.
  - `bankFeedScheduledPoll` (cron `7 * * * *`, line ~5547) — same window logic mirrors the callable.
- **Bug it fixed:**
  Operator-visible symptom: red banner «Bank sync is N days behind» (currently 10d for Capital One ....5709). Cron at `:07` every hour reported `scanned=0 written=0` for an active connection even though Stripe FC's `/diagnose` modal confirmed fresh transactions (5/26 ACH-withdrawal + 5/26 STRIPE-deposit) were available. Root cause: `since = lastPolledAt` queried only `transacted_at >= 2026-05-27 07:07:00 UTC`, but the missing transactions had `transacted_at` between 5/18 and 5/26 and got published by Stripe FC AFTER 5/17's cron tick had advanced `lastPolledAt` past their dates. With the 14-day safety margin, the next cron tick queries `transacted_at >= (lastPolledAt - 14d) ≈ 2026-05-13` and recaptures the 11-day gap on first run (Stripe txn-id dedup makes re-fetching idempotent).
- **Invariant — DO NOT BREAK:**
  1. **Never use bare `lastPolledAt` as the `transacted_at` filter** for incremental polls. Always subtract `BANK_FEED_WATERMARK_SAFETY_DAYS * 86400` seconds.
  2. **Never write `matchState` / `matchedTenantId` / `matchedUnitId` / `matchedYm` to baseDoc when an existing doc has `matchState === 'confirmed' || 'dismissed'`** — operator's manual decision wins over re-poll matcher output.
  3. **Never include `checkImageUrl: null` in baseDoc for existing docs** — would wipe operator-uploaded check images. New docs only.
  4. **Never count rewrites in `written`** — operator UI message «X new transactions pulled» relies on this counter being new-only. Use `skipped` for overlap rewrites.
  5. **Pre-read pattern (`db.getAll(...refs)`) is one batched RTT per page, not 100 individual gets** — preserve this when refactoring.
- **Verification:**
  1. Open Settings → Integrations → Bank Connections → Capital One → click «Refresh now». Within ≤5s, the inline banner should say «✓ N new transaction(s) pulled (M scanned)» where N corresponds to the missed 5/18–5/26 window (~10 transactions). Subsequent clicks should report «✓ Up to date — no new transactions».
  2. Open Settings → Integrations → Bank Connections → Capital One → click «Diagnose». The newest cached transaction date should match the newest Stripe sample date (no longer 9 days behind).
  3. The red top-banner «Bank sync is N days behind» should disappear after `_checkBankSyncHealth` re-runs (auto-triggered on refresh completion).
  4. Open Bank Activity panel. Any transaction operator previously marked `confirmed` or `dismissed` MUST retain that status after the refresh (regression test for operator-decision-preservation invariant).
  5. Cloud Functions logs: `[bank-feed] poll fca_XXX: scanned=N written=M` — `scanned` ≥ `written`; on stable accounts (no new bank activity since last poll) `written=0` and `scanned > 0` (re-scan of safety-margin overlap), NOT `scanned=0 written=0`.
- **Regression test:** none — bank-feed integration relies on live Stripe FC + Capital One sandbox. `scripts/check-invariants.sh` could add greppable checks for `BANK_FEED_WATERMARK_SAFETY_DAYS` constant + `preserveMatchDecision` guard but not currently gated.
- **Related PR / issue:** none (direct commit on `claude/modest-curie-8a50ad`)

---

### 31. HubSpot sync — funnel/qualified/owner detection invariants (2026-05-24)

- **Status:** active
- **Branch / commit:** `claude/modest-curie-8a50ad` (commits `a9cc8c3`, `6e4b9a9`, `78b1f75`, `3139657` + this entry)
- **Area:** HubSpot integration / Pulse Activity Center / Funnel analytics
- **Files:**
  - `functions/hubspot-sync.js` (`_buildAggregates`, `_fetchOwners`, `_fetchDeals`, `_fetchMeetings`, `_runSync`, `_buildStageDiagnostics`)
  - `pulse/overview.jsx` (HubspotInsights panel)
  - `pulse/data-shim.jsx` (HubSpot cache helpers)
  - `floor-map-editor.html` (`_hsContactLookup`, `_renderProspectCard` HubSpot owner chip)
- **Functions / invariants:**
  - `_fetchOwners` — MUST fetch BOTH active and archived owners (two API calls: `?archived=false`, `?archived=true`, merged). Without archived owners, 90%+ of historical deals' `hubspot_owner_id` points to an unknown owner and the deal gets silently dropped.
  - `_buildAggregates` — orphan deals (no resolvable owner email) MUST be bucketed under the sentinel key `'_unowned'`, NOT skipped via `continue`. Funnel sums `dealsByStage` across ALL email keys (including `_unowned`) so the total reflects every deal in the fetched window.
  - `_runSync` — deals + meetings MUST always be fetched in full (`sinceMs: null`), regardless of `fullSync` flag. The merge of `dealsByStage` is a shallow per-email spread (`{...prev[email], ...new[email]}`) which REPLACES the per-owner stage map, not extends it — so an incremental sync that only sees last-24h deals would WIPE the accumulated pipeline state on merge, leaving the funnel showing 2 deals instead of 2000. Contacts STAY gated behind `fullSync` (they're heavy: ~3K contacts = ~30 API calls + 200ms throttle; ownership rarely changes).
  - Qualified-stage detection — two-pass: FIRST reject negative outcome labels (`/\bnot interested|wrong area|wrong number|no answer|didn't request|...|ghosted|spam\b/`), THEN match positive qualified patterns (`/\bqualif|interested|warm|engaged|responded to|presentation sent\b/`). Single-pass would match `interested` inside `not interested` and inflate Qualified by ~25%.
  - Signed-stage detection — uses HubSpot pipeline metadata `probability === '1.0'` (isWon) as ground truth, OR label regex. Either signal flips `isSigned: true`.
  - `_buildStageDiagnostics` — includes ALL stages from `stageMeta` (including stages with 0 deals); UI flags `empty: true` and renders as dashed-border chip so the operator can spot configured-but-unused stages (e.g. «Contract» stage exists but operators never move deals there because signing happens in SuitesForAll).
  - `contactByEmail` map — compact form `{i, o, s}` (contactId, ownerId, lifecycleStage). DON'T expand to object-with-full-keys: 5K contacts × ~30 byte savings per entry = ~150 KB headroom under Firestore's 1MB doc cap.
- **Bug it fixed:**
  1. **Regex too narrow.** Original `isSigned` regex `/\b(contract|closed.?won|signed|lease.?signed)\b/` missed «Closed Won» / «Active Lease» / «Moved In» / «Executed» — Tony's pipeline labels and HubSpot defaults. Funnel showed 0 signed even when stages were named correctly. **Fix:** broadened regex + added isWon metadata fallback.
  2. **Qualified bucket misclassification.** «Call answered - not interested» (194 deals) matched the `interested` regex and landed in Qualified, inflating that bucket from 557 → 749 and undercounting Inquiry. **Fix:** two-pass detection (negative outcomes first).
  3. **Archived-owner deals silently dropped.** `_fetchOwners` only returned active owners → 90% of historical deals had `hubspot_owner_id` pointing to an offboarded rep → `_buildAggregates` skipped them with `if (!email) continue`. After fullSync, funnel showed 89 deals instead of 2000. **Fix:** fetch BOTH active+archived owners AND bucket truly-unowned deals under `'_unowned'` instead of dropping.
  4. **Incremental sync wiped pipeline state.** Scheduled hubspotSync (every 30 min) fetched only last-24h deals (`sinceMs = 24h`), then `_buildAggregates` produced `dealsByStage[email] = { stageX: 2 }`, then merge `{...prev[email], ...new[email]}` REPLACED the full pipeline counts. Within 30 minutes of a fullSync, funnel collapsed to ~2 deals. **Fix:** always fetch all deals/meetings, gate only contacts behind fullSync.
- **Verification:**
  1. Trigger fullSync from a logged-in browser: `await window.stripeCallable('hubspotSyncNow')({fullSync: true})`. Expected counts: `{contacts: ~3000, deals: 2000, meetings: 8, owners: 15, pipelines: 3}` — note `owners >= 15` confirms archived owners are included.
  2. After a normal scheduled sync (wait 30 min), refresh Pulse and check funnel totals: `funnel.inquiry + funnel.qualified + funnel.scheduledTour + funnel.pastTour + funnel.signed` MUST stay close to total deal count (currently ~2000). Drop below ~500 = scheduled-sync regression.
  3. In Pulse console: `(() => { const dbs = window._hsDataCache.dealsByStage; let total=0; for (const m of Object.values(dbs)) for (const n of Object.values(m)) total += n; return total; })()` — expect ~2000.
  4. Stage breakdown collapsible MUST list both populated stages (solid chips) AND configured-but-empty stages (dashed chips). Currently expect 26 populated + 9 empty.
  5. Floor-map prospect card with email matching a HubSpot contact MUST render the orange `prospect-contact-hubspot` chip (`🎯 <ownerFirstName>`). Test by calling `window._renderProspectCard(p, u, b, f, false)` on any prospect whose email appears in `_hsDataCache.contactByEmail` — output HTML MUST contain `prospect-contact-hubspot`.
- **Regression test:** none — relies on live HubSpot data and a logged-in Pulse session. The detection regexes are greppable: predeploy `scripts/check-invariants.sh` could add a check that `functions/hubspot-sync.js` contains the negative-outcome guard (`isNegativeOutcome`) and the orphan bucket (`'_unowned'`) but is not currently gated.
- **Related PR / issue:** none (direct commits on `claude/modest-curie-8a50ad`)

---

### 30. Multi-month advance prepayment — anti-double-billing invariants (2026-05-21)

- **Status:** active
- **Branch / commit:** `claude/modest-curie-8a50ad`
- **Area:** Invoicing / Stripe webhook / Auto-billing cron / state.payments schema
- **Files:**
  - `floor-map-editor.html` (ciSubmit stamping, `_ciBuildAllLines`, badge function, payment-history grid, confirm dialog)
  - `functions/index.js` (`runAutoInvoices` skip-list, `handleInvoicePaid` sibling sweep, `handleInvoiceFailed` sibling sweep, `extraLineItems` item-type mapping)
  - `FIXES_LOG.md`
- **Functions:**
  - `ciSubmit` — stamps every selected month with the same `stripeInvoiceId`
  - `runAutoInvoices` cron — skips months with `status='open' && stripeInvoiceId && paidVia='stripe-advance'`
  - `handleInvoicePaid` — after marking the anchor paid, sweeps `u.payments[*]` for matching `stripeInvoiceId + paidVia='stripe-advance'` and flips them all to `paid`
  - `handleInvoiceFailed` — same sweep, flips siblings to `late`
- **Bug it fixed:** Tenant wants to prepay 6 months in one Stripe invoice ($2,700 = 6×$450). Before this fix, only the **anchor** month was stamped in `state.payments`. When the next month rolled around, `runAutoInvoices` saw `u.payments[2026-07]` as undefined → created a duplicate $450 invoice. Tenant would have received 5 unwanted follow-up invoices despite having prepaid the entire period.
- **Invariant — DO NOT BREAK:**
  1. **Stamping at send time.** When `ciSubmit` fires with `selectedMonths.length >= 1` and `purpose === 'rent'`, EVERY entry in `selectedMonths` must be stamped with:
     ```js
     u.payments[ym] = {
       status: 'open',
       amount,
       stripeInvoiceId,
       paidVia: 'stripe-advance',
       coversInvoiceMonths: [...selectedMonths],
       advanceSentAt: ISO,
       sentBy: operatorEmail,
     }
     ```
     This includes single-month invoices (1 element in `selectedMonths`) — keeping the schema uniform lets the webhook sweep work for everything. The anchor (`ym === selectedMonths[0]`) additionally gets `_anchorMonth: true` so post-payment diagnostics can identify which line drove the rent-path on the backend.
  2. **Don't overwrite paid/free/waived months.** Stamping must skip any `u.payments[ym]` that's already `paid`, `free`, or `waived` — otherwise a multi-month send that accidentally included an already-collected month would void that record.
  3. **Cron skip-list.** `runAutoInvoices` must skip a month when **ALL** of these hold:
     - `u.payments[nextYm].status === 'open'`
     - `u.payments[nextYm].stripeInvoiceId` is truthy
     - `u.payments[nextYm].paidVia === 'stripe-advance'`
     Adding a fourth shortcut path? Make sure the underlying invoice isn't void — once we void a multi-month invoice, we expect cron to start re-issuing again, which the `handleInvoiceVoided` handler already enables (it clears `status` back to `pending` for the matched month, but ONLY the anchor — siblings stay 'open'; a follow-up sweep needed).
  4. **Webhook sweep.** `handleInvoicePaid` must walk `f.unit.payments[*]` after stamping the anchor and flip every sibling where `paidVia === 'stripe-advance' && stripeInvoiceId === invoice.id` to `status='paid'`. Same for `handleInvoiceFailed` (flip to `late`). Without the sweep, advance months stay stuck `open` forever — Stripe paid us, but the rent grid lies.
  5. **Visual labels.** Line items in the invoice modal show badge `RECURRING` for the anchor and `ADVANCE` (amber) for additional months. Payment-history grid cells show an amber `A` dot in the top-left for any month with `paidVia === 'stripe-advance'` — operator can distinguish "paid via prepayment bundle" from "paid month-by-month". Don't remove the dot — Tony specifically asked for it during the design review.
  6. **Confirm-dialog warning.** Send confirmation must show a banner when `selectedMonths.length > 1` explaining that auto-billing will be paused for the covered period and that all months flip back to `late` on Stripe failure.
- **Verification:**
  1. Send a 6-month invoice for any tenant. Open DevTools console:
     ```js
     const u = state.buildings.flatMap(b=>b.floors).flatMap(f=>f.units).find(u=>u.id === '<suite>');
     Object.keys(u.payments).filter(k=>u.payments[k].paidVia==='stripe-advance')
     ```
     Expected: 6 keys, all sharing the same `stripeInvoiceId`.
  2. Trigger `runAutoInvoices` manually (Settings → Billing → Run now). Check Cloud Function logs: for each prepaid month, expect a log line `[auto-invoice] <suite>: <ym> covered by advance invoice <id>; skipping`.
  3. After tenant pays in Stripe Dashboard: invoke `firebase functions:log --only stripeWebhook` and expect `[stripe] ✓ advance-paid: <suite> also flipped N sibling month(s) via invoice <id>`. Verify `u.payments[*].status === 'paid'` for all 6.
  4. Negative path — force a card decline. Expect sibling sweep on payment_failed: all 6 flip to `late`, NOT stuck on `open`.
- **Regression test:** none — relies on Stripe sandbox testing. The skip-list logic in `runAutoInvoices` is greppable: predeploy script in `scripts/check-invariants.sh` should add a `check_gate` line matching the `paidVia === 'stripe-advance'` check.
- **Related PR / issue:** none (direct commit on `claude/modest-curie-8a50ad`)

---

### 29. State bloat audit + self-healing payments slim — DO NOT use loose "empty" detection (2026-05-21)

- **Status:** active
- **Branch / commit:** `claude/modest-curie-8a50ad` (this commit)
- **Area:** Sync / Firestore doc-size hygiene / Finance (data integrity)
- **Files:**
  - `floor-map-editor.html` (`fbSanitizeState`)
  - `FIXES_LOG.md`
- **Functions:**
  - `fbSanitizeState` — added self-healing pass before the nested-array scrubber
- **Bug it fixed:** Production state hit 958.7 KB / 96 % of Firestore's 1MB
  doc limit. A prior cleanup attempt run from the browser console used a
  loose "empty payment" detector (checked only key count) and removed
  **1286 real payment records** — each with `amount/date/memo/paidBy/
  paidVia/status` populated. Local state was wiped; the remote doc was
  re-read with `getDoc(workspaces/default/data/state)` to restore the
  data. A local backup was written to a timestamped `sfa_v5_state_BACKUP_*`
  key before the overwrite so the wiped state remains recoverable.
- **Invariant — DO NOT BREAK:**
  1. The slim pass in `fbSanitizeState` only drops `u.payments[ym]` when
     it's literally `[]` OR when it's an object with **zero** of these
     fields populated: `status`, `amount`, `date`, `paidVia`,
     `stripeInvoiceId`, `paidAtIso`, `receiptPath`. Any operator-meaningful
     field present → keep the entry. If you add a new field to the
     payment shape, add it to the keep-list.
  2. Never write a "drop empty payment month" utility that uses a looser
     criterion (key count, presence of any field, etc.). The codebase
     reads `u.payments[ym].status` / `.amount` / `.date` widely — losing
     those means losing real accounting history.
  3. If a state-bloat audit is needed, ALWAYS back up `localStorage
     .getItem('sfa_v5_state')` to a timestamped key BEFORE any mutation,
     and verify a sample of mutated entries against the remote doc before
     calling `fbPushNow()`.
- **Verification:**
  1. Open DevTools console on production, run:
     ```js
     (() => { const s = JSON.parse(localStorage.getItem('sfa_v5_state')||'{}'); let real=0,empty=0;
       for (const b of s.buildings||[]) for (const f of b.floors||[]) for (const u of f.units||[]) {
         if (!u.payments) continue;
         for (const ym of Object.keys(u.payments)) {
           const p=u.payments[ym];
           if (p && (p.status||p.amount||p.date||p.paidVia||p.stripeInvoiceId)) real++;
           else empty++;
         }
       }
       return {real, empty};
     })()
     ```
     Expected after the fix lands and a push completes: `empty: 0` (the
     self-healing pass strips them on push). `real` should match the
     workspace's actual payment-record count (currently ~1286).
  2. Trigger a Firestore push (`fbPushNow()`) and verify the console emits
     `[fbSanitizeState] self-healing: dropped N empty u.payments[ym] entries`
     when N > 0. No emission when N = 0.
- **Regression test:** none — manual UI / console verification only. A
  unit test for `fbSanitizeState` would require extracting it from the
  single-file HTML, which is out of scope for this fix.
- **Related PR / issue:** none (direct commit on `claude/modest-curie-8a50ad`)

---

### 1. Lease-start gate — anti phantom $7,800 (2026-05-13)

- **Status:** active
- **Branch / commit:** ported to `main` via merge `d781daf` (cherry-picks
  `e743a00` + `8719638` + `22879cb` + `8b847ec`, originally from
  `fix/autobilling-respect-archive-filters` @ `bf3ef99` + `36534d9` +
  `24e68e8` + `f7d9f6c`)
- **Area:** Finance / billing / unit panel / Move-Out modal / aging
- **Files:**
  - `floor-map-editor.html`
- **Functions:**
  - `_computeUnitMoney`
  - `_renderUnitLateFeeOwed`
  - `_renderUnitPaymentHealth` (renders the 13-month payment-history grid)
  - `_moBuildBalanceBreakdown` (Move-Out modal "Outstanding balance")
  - `_bvComputeTenantBalance`
  - `_bvCountOutstandingMonths`
  - `dsoForTenant`
  - `trendForTenant`
  - `buildAgingRows`
- **Bug it fixed:** Adding a tenant to a suite without a `leaseStart` (and
  without a `signed` fallback) caused the unit panel to immediately show
  "12 months unpaid · $7,800 owed" + an "UNBILLED LATE FEES $624.00" alert
  for a tenant added today. Root cause: every function above does
  `new Date(u.leaseStart || u.signed || '')`, which yields `Invalid Date`
  when both fields are empty. The in-loop guard
  `if (lastDay < startDate) continue;` is bypassed because `lastDay <
  Invalid Date` is `false`, so the 12-month (or 24-month) loop processes
  every iteration as phantom debt.
- **Invariant — DO NOT BREAK:** Every function listed above MUST, at the
  very top of the function body (before any month-walking loop), gate on
  `startDate`:

  ```js
  const startDate = new Date((u.leaseStart || u.signed || '') + 'T00:00:00');
  if (!startDate || isNaN(startDate.getTime())) {
    return /* zero-shape result for this function */;
  }
  ```

  Do NOT rely solely on the in-loop `lastDay < startDate` guard — it
  short-circuits to `false` when `startDate` is `Invalid Date` and lets every
  iteration through. `buildAgingRows` uses `continue;` (skip this tenant)
  instead of `return` because it iterates over many tenants.
- **Verification:** Add a tenant to an empty suite (e.g. Suite 367, rent
  $650) without setting `Lease start`. Unit panel must show:
  - 0 unpaid months
  - $0 owed
  - No "UNBILLED LATE FEES" alert
  - Payment-history grid is empty (or shows a "Lease start not set"
    placeholder), NOT 13 red "Late >5d" squares
  - Move-Out modal "Outstanding balance" section is empty (NOT $16,848 of
    phantom items)
- **Regression test:** none — manual UI only. Future: Node-side test that
  imports `_computeUnitMoney` and asserts `{ owed: 0, unpaidMonths: 0 }`
  for `{ contractRent: 650, leaseStart: '' }`.
- **Related PR / issue:** [#3](https://github.com/suitesforallcom/leasing-crm/pull/3) (docs)
- **Pre-deploy guard:** [scripts/check-invariants.sh](scripts/check-invariants.sh) Entry 1 block — 9 `check_gate` calls.
- **Porting note:** Ported 2026-05-13 (merge `d781daf` on `main`). Cherry-pick
  commits on `main`: `e743a00` `8719638` `22879cb` `8b847ec`.

---

### 2. `if (X && cond) break` anti-pattern (2026-05-13)

- **Status:** active
- **Branch / commit:** ported via merge `d781daf` (cherry-pick `8b847ec`,
  originally `fix/autobilling-respect-archive-filters` @ `f7d9f6c`)
- **Area:** General JavaScript pattern; concrete instance in Move-Out modal
- **Files:**
  - `floor-map-editor.html`
- **Functions:**
  - `_moBuildBalanceBreakdown` (three loop sites — on `main` currently at
    lines `55699`, `55745`, `55804`; line numbers shift on the fix branch)
- **Bug it fixed:** The pattern `if (startMs && d.getTime() < startMs)
  break;` becomes a silent no-op when `startMs` is `null`/`undefined`: the
  `&&` short-circuits, the whole condition is `false`, `break` is NOT taken,
  and the 24-month loop completes in full. For a $650/mo tenant without a
  `leaseStart`, this produced **$16,848** of phantom items in the Outstanding
  balance section of the Move-Out modal.
- **Invariant — DO NOT BREAK:** Any loop-exit guard whose comparison depends
  on a value that could legitimately be `null` MUST exit on the null case,
  not skip the guard:

  ```js
  // ❌ BAD — no-op when startMs is null
  if (startMs && d.getTime() < startMs) break;

  // ✅ GOOD — exits immediately on the null case
  if (!startMs || d.getTime() < startMs) break;
  ```

  Or, even better, gate at the top of the function (see Entry 1). When you
  add a new loop with a "stop at lease start" / "stop at move-in" /
  "stop at hire date" guard, prefer the `!X ||` form unless you have a
  documented reason to let the loop run on null.
- **Verification:** Trigger Move-Out modal for a tenant with no `leaseStart`
  set. The Outstanding balance section must be empty (NOT 24 rows of
  $650 × N).
- **Regression test:** none — manual UI only. Static-analysis idea: a grep
  rule that flags `if (\w+\s*&&\s*[^)]*)\s*break;` for human review.
- **Related PR / issue:** [#3](https://github.com/suitesforallcom/leasing-crm/pull/3) (docs)
- **Pre-deploy guard:** [scripts/check-invariants.sh](scripts/check-invariants.sh) Entry 2 block — checks `_outstandingForUnit` body for absence of the broken `if (startMs && ...) break` form.
- **Porting note:** Ported 2026-05-13 (merge `d781daf` on `main`). Same merge as Entry 1.

---

### 3. Stripe stale-cache self-heal must not wipe manual bindings (2026-05-12)

- **Status:** active (ported to main 2026-05-13 in commits d1f6cb2 +
  103a230 — both paired commits cherry-picked cleanly, no conflicts)
- **Branch / commit:** `feature/consolidate-overdue-formula` @ `1025ee2` +
  `6496f71`
- **Area:** Stripe integration / payment binding / persistence
- **Files:**
  - `floor-map-editor.html`
- **Functions:**
  - `_healStaleStripeStamps`
  - related: the manual-link assignment paths (`_attachInvoiceAsDeposit`,
    `_attachInvoiceAsMoveInRent`, and any path that writes `u.stripe.*`
    with `manualLinkAt`/equivalent truth-source field)
- **Bug it fixed:** The self-heal pass deletes any Stripe stamp whose
  `sentAt` is older than the lease-start anchor. This wiped invoices the
  operator had **manually linked** as the deposit or the move-in rent — a
  manual link is a truth-source assignment and must survive heal passes.
- **Invariant — DO NOT BREAK:** `_healStaleStripeStamps` MUST NOT delete a
  `u.stripe.depositInvoice` / `u.stripe.moveInRent` / `u.stripe.lastInvoice*`
  stamp that was placed manually by the operator. The current fix marks
  manually-bound stamps with a `manualLinkAt` (or equivalent) flag; the heal
  loop checks the flag and skips. **Do not remove this flag check** when
  refactoring `_healStaleStripeStamps`. If you change the flag name, update
  every writer in the same commit.
- **Verification:** Manually link a Stripe invoice as deposit on a unit
  → reload the page (or wait for a `_healStaleStripeStamps` pass to fire)
  → deposit binding still present. Repeat for move-in rent.
- **Regression test:** none — manual UI only.
- **Related PR / issue:** none
- **Porting note:** Exists on branch `feature/consolidate-overdue-formula`.
  Commits `1025ee2` ("_healStaleStripeStamps was wiping manually-linked
  invoices") + `6496f71` ("stale SW cache + missing truth source wiped
  manual deposit links"). Cherry-pick both — they are paired.

---

### 4. Proration consolidated into `_monthBilling` (2026-05-12)

- **Status:** active (ported to main 2026-05-17 via merge `5ad0661`, which
  brought `claude/cool-faraday-3b7318` content including the consolidation
  commit `5ff2be7` — a clean port of `357b0c0` with Entry 1's lease-start
  gate kept intact at the top of `_computeUnitMoney`. Test suite
  `tests/overdue.test.js` runs `node tests/overdue.test.js` → 9/9 pass.)
- **Branch / commit:** `feature/consolidate-overdue-formula` @ `357b0c0`
  (consolidation) + `fd9a42a` + `4d85d89` + `03b6364` + `237dc8b` (consumers
  + tests) — original source. Active port on main is commit `5ff2be7`.
- **Area:** Finance / billing / rent calculation
- **Files:**
  - `floor-map-editor.html`
  - `tests/overdue.test.js` (new — Node-side regression suite)
  - `package.json` (new — wires `npm test` to the suite + parse-check)
- **Functions:**
  - `_computeProrate(rent, leaseStartIso)` — single source for partial-month
    rent (returns `{ ym, daysRemaining, daysInMonth, prorated }`)
  - `_monthBilling(rent, ym, leaseStartIso, graceDays, now?)` — single
    source for `{ monthRent, dueDate, isProratedMonth, isOverdueByDate,
    leaseStartYm }`
  - Consumers updated: `_computeUnitMoney`, Create Invoice modal,
    heatmap unpaid banner, charge-failed self-heal
- **Bug it fixed:** Four+ scattered copies of the overdue/prorate/grace
  formula had drifted — the same lease could show different overdue status
  in the unit panel vs. the heatmap vs. the Create Invoice modal. Some
  copies used `today > 1 + graceDays` (calendar anchor) and some used
  `today > leaseStart + graceDays` (lease anchor), giving contradictory
  answers in the first month of a lease.
- **Invariant — DO NOT BREAK:** All overdue / prorate / grace computations
  in this codebase MUST flow through `_monthBilling`. Inline `today > 1 +
  grace` style checks scattered around the file are forbidden — they will
  silently diverge again. `_computeProrate` is the only place that decides
  partial-month rent. When you add a new UI surface that needs to know "is
  this month overdue" or "what's the monthly charge for this period",
  call `_monthBilling` — do NOT write a fresh comparison.
- **Verification:** `node tests/overdue.test.js` (or `npm test`). The suite
  has 9 cases covering: lease-start day grace, grace edge, next-month
  rollover, month-before-lease anomaly, lease-start = 1st (no prorate),
  empty leaseStart fallback, graceDays = 0, leap-year February.
- **Regression test:** `tests/overdue.test.js` — **automated** (the only
  automated regression test in the project as of 2026-05-12).
- **Related PR / issue:** none
- **Porting note:** Ported 2026-05-17 (merge `5ad0661` on `main`). Source
  branch can be archived. The proration helper + tests/ directory +
  package.json all landed via the cool-faraday merge.

---

### 5. Invoice month overrides — `state.ui.invoiceMonthOverrides` (2026-05-12)

- **Status:** active (ported to main 2026-05-13 in commit c930613,
  conflict with Entry 7 resolved — `fmtBillingMonth` now returns a
  descriptor `{ kind, text, ym }` where `kind: 'deposit'` short-circuits
  for deposit invoices, `kind: 'override'` carries the ◆ marker)
- **Branch / commit:** `feature/consolidate-overdue-formula` @ `d5738e6`
- **Area:** Invoice History / operator labeling
- **Files:**
  - `floor-map-editor.html`
- **Functions:**
  - `_invMonthGetOverrides`, `_invMonthGetOverride`, `_invMonthSetOverride`,
    `_invMonthClearOverride` — state helpers (read/write
    `state.ui.invoiceMonthOverrides`)
  - `_invMonthLinkOpen`, `_invMonthLinkClose`, `_invMonthLinkShiftYear`,
    `_invMonthLinkPick`, `_invMonthLinkRender`, `_invMonthLinkSave`,
    `_invMonthLinkUnlink`, `_invMonthLinkOpenFromRow` — modal UI
  - Consumers: `fmtBillingMonth` (inside `_renderInvoiceHistorySection`),
    `renderRow` (Invoice History row), `_invHistoryRowMenu` (right-click
    menu), `_invHistoryOpenMonthLink`, `_invHistoryUnlinkMonth`
- **Bug it fixed:** One-off invoices arriving without `metadata.ym` (manual
  payments, Stripe imports without period tags, transfers without
  descriptions) had no way to be labeled by month. FOR column showed `—`
  and the operator could not attach the charge to a calendar period.
- **Invariant — DO NOT BREAK:**
  1. `fmtBillingMonth` MUST check `_invMonthGetOverride(r.id)` **before**
     `r.metadata.ym` / `r.ym`. Override always wins.
  2. The override map persists at `state.ui.invoiceMonthOverrides = {
     [invoiceId]: 'YYYY-MM' }` and saves via `saveState()`.
  3. Rows whose effective ym comes from an override must render the `◆`
     marker so the operator can distinguish manual links from native
     Stripe metadata at a glance.
  4. Right-click menu must offer "🗓 Link to month…" (or "🗓 <Month YYYY> ·
     Change…" + "⨯ Unlink month" if already linked) at the top of the
     menu, before void/hide actions.
  5. Void/draft bucket rows must NOT show the clickable "Link" label —
     there's no operational reason to label a cancelled charge.
- **Verification:** On a tenant whose history contains an invoice without
  `metadata.ym`: FOR column shows a clickable "Link" → click opens modal
  with year `‹ ›` switcher + 4×3 month grid → pick a month → Save → row
  shows `<Month>◆` → reload page → label persists.
- **Regression test:** none — manual UI only.
- **Related PR / issue:** none
- **Porting note:** Exists on branch `feature/consolidate-overdue-formula`.
  Commit `d5738e6`. Standalone — no dependencies on other porting entries.
  Conflict-free with Entry 7 (Deposit display in `fmtBillingMonth`) as long
  as both are applied: the override check is the first branch of the
  function, deposit check is the second, ym check is the third.

---

### 6. "Open report" button visible in all Invoice History states (2026-05-13)

- **Status:** active
- **Branch / commit:** ported 2026-05-13 (cherry-pick `9fbf895` on `main`,
  originally `fix/autobilling-respect-archive-filters` @ `d73dc7c`)
- **Area:** Invoice History UI / report entry point
- **Files:**
  - `floor-map-editor.html`
- **Functions:**
  - Inline render in the Invoice History section (loading state, empty
    state, list state — all three branches of `_renderInvoiceHistorySection`
    or equivalent)
- **Bug it fixed:** "📊 Open report →" button only appeared when invoices
  were present in the list. When the section was in the "Loading…" or
  "No invoices yet" state, the button was hidden — operators had no entry
  point to the full Invoice Report for tenants who hadn't been invoiced
  yet.
- **Invariant — DO NOT BREAK:** The Open-report button must render in all
  three states of the Invoice History section:
  1. Loading state (`<div class="upv2-inv-empty">Loading…</div>`)
  2. Empty state (`<div class="upv2-inv-empty">No matching invoices…</div>`)
  3. Populated list state
  If you refactor the rendering branches, mirror the button into each.
- **Verification:** Open a Suite that has zero invoices → "📊 Open report →"
  button is visible. Open a Suite while its Stripe cache is fetching →
  button visible.
- **Regression test:** none — manual UI only.
- **Related PR / issue:** none
- **Pre-deploy guard:** [scripts/check-invariants.sh](scripts/check-invariants.sh) Entry 6 block — counts `onclick="openUnitInvoiceReport()"` in floor-map-editor.html, fails if < 3.
- **Porting note:** Ported 2026-05-13 (cherry-pick `9fbf895` on `main`).

---

### 7. Deposit display in `fmtBillingMonth` (2026-05-13)

- **Status:** active
- **Branch / commit:** ported 2026-05-13 (cherry-pick `2cffc32` on `main`,
  originally `fix/autobilling-respect-archive-filters` @ `89eb152`)
- **Area:** Invoice History UI / FOR column labeling
- **Files:**
  - `floor-map-editor.html`
- **Functions:**
  - `fmtBillingMonth` (the small inner formatter inside
    `_renderInvoiceHistorySection`)
- **Bug it fixed:** A deposit invoice (`purpose === 'deposit'`) was showing
  the month name (e.g. "May") in the FOR column, because deposit invoices
  carry a `metadata.ym` that records when they were issued. The operator
  read "May" as if the deposit were a May rent obligation. Reported
  example: Suite 355, Audry Adams, $700 deposit issued in May → FOR column
  said "May".
- **Invariant — DO NOT BREAK:** `fmtBillingMonth` MUST detect
  deposit-purpose invoices and return `"Deposit"` instead of a month name,
  regardless of whether `metadata.ym` is present:

  ```js
  const purpose = r?.metadata?.purpose || r?.purpose || '';
  if (purpose === 'deposit') return 'Deposit';
  ```

  Order of checks in `fmtBillingMonth` (after Entry 5 ports too):
  1. Operator override (Entry 5) wins everything
  2. `purpose === 'deposit'` → "Deposit"
  3. Other non-rent purposes (`late_fee`, etc.) → "—"
  4. `metadata.ym` → month name
  5. Fallback → "—" / Link marker (Entry 5)
- **Verification:** Open Invoice History for a tenant with a deposit
  invoice. FOR column shows "Deposit" — not a month name.
- **Regression test:** none — manual UI only.
- **Related PR / issue:** none
- **Pre-deploy guard:** [scripts/check-invariants.sh](scripts/check-invariants.sh) Entry 7 block — greps `fmtBillingMonth` body for `purpose === 'deposit') return 'Deposit'`.
- **Porting note:** Ported 2026-05-13 (cherry-pick `2cffc32` on `main`).

---

### 8. Move-in cache lookup: drop tenancy window (2026-05-16)

- **Status:** active
- **Branch / commit:** `claude/cool-faraday-3b7318` @ (this commit)
- **Area:** Stripe integration / Move-in card status detection
- **Files:**
  - `floor-map-editor.html`
- **Functions:**
  - `_findDepositInvoiceInCache`
  - `_findRentInvoiceInCache`
- **Bug it fixed:** Move-in invoices card showed `NOT SENT` for a deposit
  that was already sent (visible as `OPEN` in Invoice History below).
  Reported example: Suite 403, Daniel Maycon, lease starts 2026-06-01,
  deposit invoice $800 created 2026-05-15 (17 days before lease start).
  Root cause: both `_findDepositInvoiceInCache` and `_findRentInvoiceInCache`
  applied a `tenancyStartMs = _tenantTenureStartMs(u)` filter
  (`leaseStart − 7 days`). Deposits routinely go out weeks before move-in
  (the whole point of the "Awaiting Deposit" status), so the 7-day grace
  produced false negatives: the cache row was rejected, no auto-backfill
  fired, and the card kept showing NOT SENT.
- **Invariant — DO NOT BREAK:** `_findDepositInvoiceInCache` and
  `_findRentInvoiceInCache` MUST NOT filter cache rows by
  `tenancyStartMs` / `_tenantTenureStartMs(u)`. The tenant-identity guard
  is the email-match (`emailLC !== email → continue`), combined with the
  suite-match (`metadata.unitId` or `"suite <id>"` in description) and
  the purpose-match (deposit/rent signals). That triple already separates
  current-tenant invoices from prior-tenant invoices without needing a
  time window. If you reintroduce a creation-date filter you will
  reproduce the original bug for any deposit issued in the pre-move-in
  "Awaiting Deposit" window.

  Note: `_tenantTenureStartMs` itself is NOT removed — 7 other call
  sites (heal-logic, void-guards, identity-match-on-write) still rely
  on it correctly. Only the two cache-lookup functions drop the
  filter.
- **Verification:** Create a unit with lease start ≥ 2 weeks in the
  future. Send a deposit invoice via Stripe (or manually link an
  existing one). Move-in card must show the deposit pill as `OPEN`
  (or `PAID`) — NOT `NOT SENT`. Confirm Invoice History on the same
  unit shows the same invoice.
- **Regression test:** none — manual UI only.
- **Related PR / issue:** none
- **Porting note:** Lives on `claude/cool-faraday-3b7318`. Needs
  merging to `main`. Standalone — no dependencies on Entries 3-5
  pending ports.

---

### 9. Activity pill: trigger = signed OR deposit-paid in window (2026-05-16)

- **Status:** active
- **Branch / commit:** `claude/cool-faraday-3b7318` @ (this commit)
- **Area:** Topbar activity pill / `_apComputeStats`
- **Files:**
  - `floor-map-editor.html`
- **Functions:**
  - `_apComputeStats` (~line 48157)
- **Bug it fixed:** Suite 425 (Trisha Redd) — deposit $500 paid 2026-05-14,
  lease starts 2026-06-05. Operator reported: "deposit paid this month
  but it's not in the Recent list." Root cause: filter required
  `leaseStart within MTD window` — a future-dated lease (June 5) was
  rejected even though the deal was closed in May.
- **History (full pendulum):**
  1. Originally: `depositPaidAt within window` → false POSITIVES when
     operator entered legacy data today (Suite 101, 2026-05-11).
  2. Fix `88eff0c` swapped criterion to `leaseStart within window` +
     deposit-paid sanity gate. Killed false positives but introduced
     false negatives (this bug — Suite 425).
  3. Fix Entry 9 (this entry): trigger = `u.signed in window` OR
     `depositPaidAt in window` (OR semantics, no AND). Both signals
     are real-event timestamps, not "when operator entered the data."
     Fallback `_tenantAddedAt` is DROPPED for `signedMs` resolution —
     that was the data-entry-timestamp leak that caused the original
     2026-05-11 false positive.
- **Invariant — DO NOT BREAK:**
  1. Inclusion in the activity pill / `newLeases[]` is decided by
     `signedInWindow || depositInWindow`. NEVER reintroduce a
     `leaseStart`-based filter — operator's rule is "how many deals
     closed THIS month, regardless of when tenant moves in."
  2. `signedMs` MUST come from `u.signed` only — no fallback to
     `u._tenantAddedAt` or any other data-entry timestamp. Those leak
     bulk-import dates into the live activity feed and cause false
     positives for ancient leases.
  3. `depositPaidAt` MUST come from `u.payments.deposit.date` (preferred)
     or `u.stripe.depositInvoice.paidAt` — both are real payment
     timestamps, not stamp-write timestamps.
  4. `signedAt` field on each `newLeases[]` entry now means "the
     in-window trigger timestamp" (`max(signedMs, depositPaidAt)` of
     those that fell in window), NOT lease-start. The popover row
     renderer (~line 48681) keeps using `depositPaidAt || signedAt`
     as the displayed "Activated [date]" — works correctly because
     both are real-event timestamps.
  5. **Sanity-gate (added 2026-05-16 after Suite 101 NUHS regression):**
     after computing `triggerYm`, reject any unit that has paid/free/
     waived rent payments in `u.payments[ym]` with `ym < triggerYm`.
     Rationale: if the tenant has been paying rent in months BEFORE
     the contract event, the contract event is a back-fill (legacy
     import or repeat deposit on existing tenant), not a new contract.
     This is a **post-trigger exclusion**, not a leaseStart-based
     inclusion check — does not contradict invariant #1. `ym ===
     'deposit'` is skipped (deposit is itself one of the triggers,
     not "history"). Do NOT relax this gate without a documented
     reason — Suite 101 NUHS appeared with $13,318/mo before it was
     added (operator screenshot 2026-05-16).
- **Verification:** Today's date is N. Create a unit, set `u.signed = N`
  (today) and `u.leaseStart = N + 90` (3 months out). Pay deposit.
  Open activity pill. Recent list MUST include this unit. Tooltip on
  the date line shows "Lease starts [N + 90 date]".
- **Regression test:** none — manual UI only.
- **Related PR / issue:** none
- **Porting note:** Lives on `claude/cool-faraday-3b7318`. Standalone.

---

### 10. Manager auto-attribution: `stripe.*.sentBy` (2026-05-16)

- **Status:** active
- **Branch / commit:** `claude/cool-faraday-3b7318` @ (this commit)
- **Area:** Stripe send paths + activity pill manager resolver
- **Files:**
  - `floor-map-editor.html`
- **Functions / sites:**
  - Write sites (6 fresh sends + 2 manual-link fallbacks + 2 backfill
    helpers): `_sendMoveInDirect.sendRent`, `_sendMoveInDirect.sendDeposit`,
    split-rent two-invoice path (success + partial-failure branches),
    `_ntoSendRent`, `_ntoSendDeposit`, manual-link fallbacks in
    `_attachInvoiceAsDeposit` / `_attachInvoiceAsMoveInRent`,
    `_backfillDepositStamp`, `_backfillRentStamp`
  - Read site: `_apUnitMgrUid`
  - Render: recent-rows + Top-deal blocks in `_renderActivityPopover`
    (manager chip with initials avatar + name)
- **Bug it fixed:** Operator's rule: "whoever sent the invoice to the
  client through the system is the client's manager." Previously only
  `u.filledByUid` (manual ✎ assignment) and `building.assignedManagerUid`
  (building fallback) drove attribution — Stripe send events were not
  stamped with the operator uid, so the activity pill's Recent list
  showed "Unassigned" for everything until someone manually assigned.
- **Invariant — DO NOT BREAK:**
  1. **Every fresh Stripe send** to `u.stripe.depositInvoice` or
     `u.stripe.moveInRent` MUST include `sentBy: fbSync?.uid || null`.
     If you add a NEW send path, add the stamp — otherwise auto-
     attribution silently degrades over time.
  2. **Backfill helpers** (`_backfillDepositStamp`, `_backfillRentStamp`)
     MUST preserve `existing.sentBy` when re-writing the stamp. For
     `manualLink: true` (operator linking an external Stripe invoice),
     also set `sentBy = fbSync.uid` — that's still a deal-closing
     operator action.
  3. **Manager resolver priority** in `_apUnitMgrUid`:
     `u.filledByUid` → `u.stripe?.depositInvoice?.sentBy` →
     `u.stripe?.moveInRent?.sentBy` → `b.assignedManagerUid` → null.
     The explicit `filledByUid` override MUST win over auto-attribution
     so the operator can correct misattributed deals via the ✎ pencil.
  4. **Historical stamps** (written before 2026-05-16) won't have
     `sentBy`. Resolver falls through to building-level / unassigned
     correctly — do not block on missing `sentBy`.
- **Verification:** Send a fresh move-in invoice (rent or deposit) as
  any logged-in user. Open the topbar activity pill → Recent → the new
  row must show a colored circular avatar with the sender's initials
  and their full name. ✎ pencil still works to override.
- **Regression test:** none — manual UI only.
- **Related PR / issue:** none
- **Porting note:** Lives on `claude/cool-faraday-3b7318`. Standalone.
  Schema change is additive (`sentBy` field on existing stamp objects);
  no migration needed.

---

### 11. Floor BG cache → IndexedDB (2026-05-17)

- **Status:** active
- **Branch / commit:** `claude/cool-faraday-3b7318` @ (this commit)
- **Area:** Storage layer / floor-plan background cache
- **Files:**
  - `floor-map-editor.html`
- **Functions:**
  - `_bgIdbOpen`, `_bgIdbExec` (new — IDB wrapper)
  - `_bgCachedDataUrl`, `_bgCacheDataUrl`, `_bgClearCache` (converted to async)
  - `_bgMigrateLocalStorageToIdb` (new — one-shot migration on boot)
  - Caller: `_unitFitToWalls` (line ~61720, added `await`)
  - Boot init block (line ~131665) runs migration + orphan-backup cleanup
- **Bug it fixed:** Operator console logs (2026-05-17): «localStorage usage
  5022KB / 4883KB (103%)» firing every saveState, plus «[lbk] gave up
  QuotaExceededError» on every backup attempt. Audit:
  - `sfa_bg_cache_*` (3 floor backgrounds, base64-encoded) — **2,784KB
    (55% of quota)**
  - `sfa_lbk_*` (orphan backups) — 1,437KB
  - `sfa_v5_state` (actual state) — 727KB (normal size, NOT the problem)
  Local backups (data-safety net) could not write. Eventually saveState
  itself would start failing too.
- **Invariant — DO NOT BREAK:**
  1. Floor BG cache MUST live in IndexedDB, NOT localStorage.
     `sfa_bg_cache_*` localStorage keys are migration-source only —
     read once on boot via `_bgMigrateLocalStorageToIdb`, then removed.
     If you bring back localStorage writes you re-introduce the 5MB
     hard-cap problem (3 floors × ~1MB base64 = 60% of total quota
     before any state or backups can fit).
  2. `_bgCachedDataUrl`, `_bgCacheDataUrl`, `_bgClearCache` are **async**.
     Any future caller must `await` reads (else `if (cached)` checks
     `if (Promise)` which is always truthy). Writes are fire-and-forget
     safe.
  3. localStorage fallback in `_bgCacheDataUrl` is intentional — covers
     Safari private-mode where IndexedDB is unavailable. Do NOT remove
     the fallback; it degrades gracefully without crashing the upload
     flow.
  4. Boot-time orphan-backup cleanup only removes `sfa_lbk_*` keys NOT
     listed in `sfa_lbk_index`. Indexed backups (real backup snapshots)
     stay intact. Do not relax this filter — operator-created manual
     backups would be deleted.
- **Verification:** Open DevTools → Application → Storage tab:
  - localStorage: `sfa_bg_cache_*` should be gone after one full reload
  - IndexedDB → `sfa_bg_cache` → `bg` object store should contain the
    cached floor BG data URLs (keys = floor IDs)
  - Console: `[bg-cache:migrate] moved N floor BG cache(s) to IndexedDB`
  - No more `[quota] localStorage usage > 80%` warnings
  - Fit-to-walls still works (uses cached BG via async path)
- **Regression test:** none — manual UI only.
- **Related PR / issue:** none
- **Porting note:** Lives on `claude/cool-faraday-3b7318`. Standalone.

---

### 17. Lease envelope id consistency + dual move-in pill (2026-05-17)

- **Status:** active
- **Branch / commit:** `fix/lease-envelope-id-mismatch` @ (this commit) — branched off `claude/cool-faraday-3b7318` @ `9e8dedb`
- **Area:** DocuSign envelopes / lease documents migration / unit panel header pills
- **Files:**
  - `floor-map-editor.html`
- **Functions:**
  - `_hasAnyLeaseDoc` (внутри `_renderUnitOverviewPane`) — Send-lease CTA gate
  - `_ensureLeaseDocuments` — envelope→doc migration
  - `_leaseDocLiveStatus`
  - `_leaseDocPdfUrl`
  - `_renderLeaseDocCard` — sourceLine
  - `_renderUnitV2Header` — pill compute + render блоки
- **Bug it fixed:** Оператор отправил DocuSign-договор Suite 20512 → email
  пришёл → но UI остался в исходном состоянии: (1) yellow «Lease not sent
  yet» CTA на Overview осталась с кнопкой «Send lease →», (2) сверху
  единственный pill «Awaiting Deposit» — без «Awaiting Signature», (3) на
  Lease tab "LEASE DOCUMENTS" показывал «No lease documents yet».
  Root cause: writer envelope'а (`openSendLeaseModal` + bulk-send) пишет
  объект с ключом `envelopeId`, а пять мест в коде (`_hasAnyLeaseDoc` gate,
  `_ensureLeaseDocuments` migration loop, `_leaseDocLiveStatus`,
  `_leaseDocPdfUrl`, sourceLine в `_renderLeaseDocCard`) искали по `e.id`,
  которого в объекте нет. Find()/some() возвращали undefined → CTA не
  пряталась, миграция не срабатывала, doc-card не рендерилась.
  Бонус: pill «Awaiting Signature» и «Awaiting Deposit» были mutually
  exclusive (else-if), хотя в реальности обе ноги move-in pipeline могут
  быть открыты одновременно.
- **Invariant — DO NOT BREAK:**
  1. Любой код, ищущий envelope в `u.leaseEnvelopes`, MUST принимать оба
     ключа: `e.envelopeId || e.id`. Никогда не сравнивать только по
     `e.id` — writer его не ставит.

     ```js
     // ❌ BAD — writer пишет envelopeId, не id
     const env = u.leaseEnvelopes.find(e => e && e.id === doc.envelopeId);
     // ✅ GOOD — оба ключа
     const env = u.leaseEnvelopes.find(e => e && (e.envelopeId || e.id) === doc.envelopeId);
     ```

  2. `_renderUnitV2Header` MUST поддерживать одновременный показ
     «Awaiting Signature» (primary) + «Awaiting Deposit» (secondary) когда
     обе ноги move-in pipeline активны. Не возвращать к else-if цепочке,
     которая теряла одну из двух нот.
  3. Secondary pill MUST использовать ту же clickable-логику что и
     primary deposit pill — кнопка `markUnitDepositPaid` для роли с
     `canEdit()`, иначе `<span>`.
- **Verification:**
  1. Создать tenant в Vacant unit с email, депозитом, lease-start в
     будущем. Открыть unit panel → клик «Send lease →» в Overview
     CTA → ввести данные → отправить. После redirect'а:
     - Yellow CTA исчезает.
     - Title bar показывает ДВА pill'а: «Awaiting Signature» (синий) +
       «Awaiting Deposit →» (фиолетовый, clickable).
     - Lease tab → «LEASE DOCUMENTS» (1) — карточка lease с
       «Awaiting signature» status pill.
  2. Кликнуть «Awaiting Deposit →» → подтверждает что pill всё ещё
     clickable как primary был.
- **Regression test:** none — manual UI only.
- **Related PR / issue:** none
- **Porting note:** Lives on `fix/lease-envelope-id-mismatch`. Standalone —
  не зависит от Entry 4 / 3. Конфликтов с main не будет (правки точечные
  внутри функций, которые на main отсутствуют — ветка должна сначала
  смерджиться через `claude/cool-faraday-3b7318`).

---

### 18. Prospect `stage:'signed'` does NOT imply envelope exists (2026-05-17)

- **Status:** active (invariant documentation — no code change)
- **Branch / commit:** documented on `main` at this commit
- **Area:** Prospects pipeline / lease document timeline / unit panel state
- **Files:**
  - `floor-map-editor.html`
- **Functions:**
  - `_convertProspectToTenant` (~95398) — explicit offline-signed shortcut
  - `_advanceProspect` (~95380) — manual stage advancement
  - `_promoteProspectToTenant` (~95477) — copies prospect → unit fields
  - DocuSign polling auto-promote (~109504) — separate path that DOES bind envelope
- **Bug it documented (not a bug, but a state worth knowing):** A prospect
  CAN reach `stage: 'signed'` via three independent paths, only one of which
  attaches a DocuSign envelope to `u.leaseEnvelopes`:
  1. DocuSign polling `completed` (~109504) — envelope-driven, sets
     `prospect.envelopeId`. **State is consistent.**
  2. `_advanceProspect` — operator clicks "Advance stage" through stages
     `lead → loi-sent → lease-sent → signed`. **No envelope binding;**
     operator may have signed paper offline.
  3. `_convertProspectToTenant` — explicit shortcut via prospect-row menu.
     Confirm dialog warns this is offline-signed. **No envelope binding.**

  Symptom observed 2026-05-17 on Suite 20512: prospect Tony reached
  `stage: 'signed'` via path (2) or (3) → `_promoteProspectToTenant`
  populated unit (tenant=Tony, leaseStart, contractRent, deposit) → unit
  panel shows "Awaiting Deposit" pill + "Lease not sent yet" Send-Lease CTA
  + Lease tab shows "No lease documents yet". This is **expected behavior**
  for an offline-signed flow, but operator was confused because a separate
  real DocuSign email arrived (likely from an LOI flow via `loiDocId`).
- **Invariant — DO NOT BREAK:** Any future code that *requires* an envelope
  to exist for a "signed" prospect MUST guard against the offline-signed
  state. Cannot use `prospect.stage === 'signed'` as a proxy for "envelope
  exists" — that breaks path (2)/(3). Check
  `u.leaseEnvelopes?.length > 0` OR `u.leaseDocuments?.some(d => d.type === 'lease')`
  separately.

  Inverse invariant: do NOT auto-create stub `leaseDocuments` entries in
  the promotion paths (2) and (3) — that would mis-represent a paper-signed
  lease as a tracked DocuSign envelope and break the migration loop in
  `_ensureLeaseDocuments`.
- **Verification:** Create vacant unit → "+ Add prospect" → advance through
  stages to "Signed" (or use "Convert to tenant" shortcut). Then check
  Overview: "Lease not sent yet" CTA should be visible (because no envelope).
  This is correct behavior — operator should explicitly send DocuSign lease
  OR upload signed PDF to complete the lease record.
- **Regression test:** none — invariant only.
- **Related PR / issue:** none
- **Suggested UX follow-up (out of scope here):** Overview CTA could detect
  "prospect signed but no lease doc" state and offer "📎 Upload signed PDF"
  as a peer button next to "Send via DocuSign" — clearer choice for
  offline-signed flow than the implicit "Send lease →" only path. **Done
  2026-05-17 in commit `7ed96f1`.**

---

### 19. View-As mode — client-only employee impersonation preview (2026-05-17)

- **Status:** active
- **Branch / commit:** main @ (this commit)
- **Area:** Permissions / user menu / topbar UX / support tooling
- **Files:**
  - `floor-map-editor.html`
- **Functions:**
  - `currentRole` — checks `_viewAsGet()` BEFORE `fbSync.role`
  - `canAccessBuilding` — uses `viewAs.buildings` scope when active
  - `_viewAsGet` / `_viewAsSet` — sessionStorage-backed state (key
    `sfa_view_as_v1`)
  - `_viewAsActive` / `_viewAsCanEnter` / `_viewAsInferRole`
  - `openViewAsModal` / `closeViewAsModal` / `_viewAsRenderList` /
    `_viewAsFilter` / `_viewAsSetFilterRole`
  - `_viewAsActivate(empId)` / `_viewAsExit()`
  - `_viewAsRenderBanner` (called from `applyRoleVisibility`)
- **Feature it added:** Operator (admin/manager) clicks their name → user
  menu → "Switch to employee…" → searchable modal with all employees
  (grouped by workspace role, with HR role + buildings shown). Click an
  employee → permissions immediately preview as that role. Sticky yellow
  banner at top shows "Viewing as X · role · buildings — Exit view".
- **Invariant — DO NOT BREAK:**
  1. **View-as is CLIENT-ONLY.** Firebase Auth NEVER swaps. `fbSync.user`
     stays the operator's real auth identity. ALL Firestore writes happen
     as the real user. `createdBy` / `updatedBy` / `sentBy` / etc. attribute
     to the real operator, not the impersonated employee.
  2. **`currentRole()` is the single funnel for view-as.** Don't bypass it
     by reading `fbSync.role` directly when checking permissions. Adding a
     new gate? Use `currentRole()` (it already honors view-as).
  3. **Building scope override.** `canAccessBuilding` must read
     `_viewAsGet().buildings` when active — NOT `fbSync.memberBuildings`
     (which is the real user's scope, irrelevant when previewing).
  4. **Non-root admin can NOT view-as another admin.** Modal disables
     admin rows for non-root operators. Without this gate, a workspace
     admin could preview-as another admin and try to take privileged
     actions — those still ride on real auth (Firestore rules enforce),
     but disabling at UI level prevents confusion / abuse vectors.
  5. **Cannot enter view-as while already in view-as.** `_viewAsCanEnter`
     returns false if `_viewAsActive()`. Operator must exit first to
     prevent nested impersonation confusion.
  6. **Tab-local persistence.** Storage is `sessionStorage` (not
     `localStorage`, not Firestore state.ui) — view-as state stays
     per-tab and disappears on browser close. Sharing it across tabs/
     devices would confuse multi-tab edit (Web Locks Entry 16).
  7. **No effect on Firestore rules.** Server-side rules continue to check
     the real auth UID's claims. View-as is preview-only — operator can't
     bypass rules even when "viewing as" a higher-permission employee
     (which is blocked at UI anyway by rule 4).
- **Verification:**
  1. As admin, click user badge → "Switch to employee…" → modal opens
     with all active employees.
  2. Pick a teamviewer employee → banner appears, `currentRole()` returns
     'teamviewer', `canSeeFinance()` returns false, finance UI hidden.
  3. Exit view-as → banner gone, full admin access restored.
  4. As non-root admin: admin rows in modal are aria-disabled.
  5. As manager: "Switch to employee…" item visible (manager can preview);
     "Switch to employee…" hidden for viewer/teamviewer/mapeditor.
  6. Open DevTools → Application → Session Storage → key
     `sfa_view_as_v1` present while in view-as, removed on exit.
  7. Write a note / edit something while in view-as → activity log shows
     real operator's email, not the impersonated employee's.
- **Regression test:** none — manual UI only.
- **Related PR / issue:** none
- **Suggested follow-up (out of scope here):** Real impersonation via Cloud
  Function-issued custom token + audit log + Firestore rules update —
  needed if operator wants writes attributed to the employee (e.g., for
  support sessions where employee asks operator to act on their behalf).
  That's a Path A change requiring server work; current Entry 19 is the
  Path B preview-only flow.

---

### 20. DocuSign JWT-grant proxy via Cloud Functions (2026-05-17)

- **Status:** active
- **Branch / commit:** main @ (this commit)
- **Area:** DocuSign integration / OAuth / Cloud Functions / firestore.rules
- **Files:**
  - `functions/index.js` (+~250 lines — new section "DocuSign JWT-grant proxy")
  - `firestore.rules` (integrations/{name} read opened to members + new docusign_log/{entryId} rules)
  - `floor-map-editor.html` (route docusignSendEnvelope/leaseResendEnvelope/leaseVoidEnvelope/_dsArchiveSignedEnvelope/status-polling via CFs when JWT mode active; `_dsHasValidToken`, `_dsLoadJwtMode`, `_dsCallCF` helpers; OAuth flow stays as fallback)
- **Functions / endpoints:**
  - CF `dsConfigureJwt(integrationKey, userId, accountId, apiAccountId, baseUri, oauthHost, env)` — one-time bootstrap; admin only; writes config to `workspaces/{id}/integrations/docusign`
  - CF `dsSendEnvelope({payload, recipientEmail})` — relays envelope creation to DocuSign with JWT auth
  - CF `dsGetEnvelope({envelopeId})` — single-envelope status
  - CF `dsListEnvelopes({envelopeIds, fromDate})` — batch status (used by polling tracker)
  - CF `dsResend({envelopeId})` — re-emails signing notification
  - CF `dsVoid({envelopeId, reason})` — cancels pending envelope
  - CF `dsListTemplates()` — returns up to 100 templates
  - CF `dsDownloadCombinedPdf({envelopeId})` — returns base64 PDF for archival
  - Internal helpers: `_dsLoadConfig`, `_dsGetAccessToken` (caches access token ~1h per CF instance), `_dsApi`, `_dsAssertCanSendLeases`, `_dsAudit`
- **Bug it fixed:** Two independent problems with the same root cause —
  client-side OAuth flow + admin-only Firestore rule on tokens doc:
  1. **Manager permission bug.** firestore.rules:256 restricted
     `integrations/docusign` to `isAdmin(wid)`. `canSendLeases()` client-side
     allowed manager → manager passed UI gate → `_dsSyncPullTokens()` got
     `FirebaseError: Missing or insufficient permissions` from Firestore →
     no token in manager's localStorage → toast «DocuSign not connected —
     authorize first». Rule comment said managers send via "existing CFs"
     but those CFs didn't exist.
  2. **30-day re-auth bug.** DocuSign Authorization Code grant refresh
     tokens are 30-day rolling. Refresh happens on demand only (when
     access_token expires AND user actively sends a lease). If 30+ days
     pass with no refresh attempt, the chain breaks → full OAuth re-auth.
- **Invariant — DO NOT BREAK:**
  1. **DocuSign private key MUST live in Firebase Secret Manager** as
     `DOCUSIGN_PRIVATE_KEY`. Never in the floor-map-editor.html, never in
     firestore, never in localStorage. The `defineSecret` declaration in
     functions/index.js binds the secret to CFs that need it via the
     `secrets:` array in onCall options. Adding a new CF that uses JWT
     auth → MUST add `DOCUSIGN_PRIVATE_KEY` to that CF's `secrets`.
  2. **Config doc at `workspaces/{id}/integrations/docusign` contains
     NON-SECRET fields only.** `integrationKey` (public client ID),
     `userId` (impersonated user GUID), `accountId`, `apiAccountId`,
     `baseUri`, `oauthHost`, `env`, `authMode: 'jwt'`, `consentedAt`,
     `consentedBy`. Never write access/refresh tokens here. Firestore rule
     `integrations/{name}` allows read by any member (config-only, safe).
  3. **JWT consent_for_life requires one-time admin consent.** URL pattern:
     `https://account.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=<KEY>&redirect_uri=<REGISTERED>`.
     If consent is revoked at DocuSign side, CF returns `consent_required` —
     admin must re-grant via the URL above.
  4. **Token cache `_dsTokenCache` is per CF instance.** Different
     instances (cold-started independently) each mint their own access
     token via JWT exchange. No cross-instance sharing needed because JWT
     mint is cheap (~200ms) and tokens live 1h. Don't add Firestore-backed
     access token storage — that's a footgun that re-introduces the
     refresh-rotation race condition we just got rid of.
  5. **`_dsAssertCanSendLeases` is the auth gate for ALL CFs.** Verifies
     caller's workspace member doc → role ∈ {admin, manager} ∧ NOT archived.
     Adding new ds* CF → MUST call this gate before any DocuSign API call.
  6. **Audit log writes to `docusign_log/{autoId}` MUST happen on every
     mutating action** (send, resend, void, download). Read-only listing
     (templates, status polling) can skip audit. Audit doc shape:
     `{action, callerUid, callerEmail, callerRole, envelopeId?, ...extra, at}`.
  7. **Client routes through CF only when `_dsIsJwtMode() === true`.**
     OAuth flow stays as fallback — older workspaces or rolled-back
     deploys without JWT setup keep working. Detection: read
     `workspaces/{id}/integrations/docusign.authMode === 'jwt'`, cache
     in `window._dsJwtModeCache`. Invalidate cache after `dsConfigureJwt`
     completes.
- **Verification:**
  1. As admin: open SuitesForAll → Send lease to a tenant → envelope
     arrives in tenant's email. CF logs show `[docusign:audit] send`.
  2. As manager (NOT admin): repeat → envelope sent successfully, no
     "DocuSign not connected" error. Previously this failed at the
     Firestore-rules layer.
  3. Wait >30 days → first lease send after that gap still works (no
     OAuth popup, no "Reconnect DocuSign" prompt). Old Auth Code refresh
     would have died; JWT mints fresh tokens via consent_for_life.
  4. Firestore Console → `workspaces/default/integrations/docusign` →
     `authMode: 'jwt'`, `consentedAt` set, NO access/refresh fields.
  5. Firebase Secret Manager → `DOCUSIGN_PRIVATE_KEY` exists with at
     least one version. Function service account has secretAccessor role.
- **Regression test:** none — manual UI only. Future: CF emulator-based
  test that mocks DocuSign /oauth/token + /envelopes endpoints and
  asserts dsSendEnvelope completes end-to-end without errors.
- **Related PR / issue:** none
- **Setup procedure (for re-onboarding a workspace):**
  1. Generate RSA keypair: `openssl genrsa -out private.pem 2048 &&
     openssl rsa -in private.pem -pubout -out public.pem`
  2. Upload `public.pem` to DocuSign Admin → Apps and Keys → app →
     Service Integration → Upload RSA → Save app
  3. Visit consent URL once as admin user: `https://account.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=<INTEGRATION_KEY>&redirect_uri=<REGISTERED_URI>`
     → click Allow Access
  4. Upload private key: `firebase functions:secrets:set
     DOCUSIGN_PRIVATE_KEY --data-file=- < private.pem`
  5. Deploy: `firebase deploy --only functions,firestore:rules`
  6. Initialize config: call `dsConfigureJwt` CF with integrationKey,
     userId, accountId, apiAccountId, baseUri, oauthHost, env
  7. Verify: call `dsListTemplates` CF → returns 200 with template list
- **Suggested follow-up (out of scope here):** Remove the legacy OAuth
  client code paths (`_dsRefreshAccess`, `_dsSyncPushTokens`,
  `_dsSyncPullTokens`, `_dsExchangeCode`, `docusignOAuth` popup flow,
  `DS_LS.ACCESS/REFRESH/EXPIRES/PKCE_*` localStorage keys) once all
  workspaces are confirmed migrated to JWT.

---

### 22. Server-authoritative envelope state-write + audit reconciliation (2026-05-18)

- **Status:** active
- **Branch / commit:** main @ (this commit)
- **Area:** DocuSign integration / state persistence / Web Locks interaction
- **Files:**
  - `functions/index.js` (CF `dsSendEnvelope` — Firestore transaction on
    state document)
  - `floor-map-editor.html` (`docusignSendEnvelope` passes unit context;
    post-send local push skipped in JWT mode; new `_dsReconcileEnvelopes`
    function + hooks)
- **Functions:**
  - Server: `dsSendEnvelope` (new required args + transactional state write)
  - Client: `docusignSendEnvelope` (unit-context propagation),
    `_dsReconcileEnvelopes` (new), `_dsSyncInit` (calls reconcile)
- **Bug it fixed:** Manager Drew sent a lease to Suite 403 / Daniel
  (booking@dimitryahhair.com) via the JWT CF on 2026-05-18 02:27 UTC.
  DocuSign delivered the envelope (email arrived), CF audit log recorded
  the send, but `state.leaseEnvelopes` stayed empty — admin couldn't see
  any record of the lease being sent. Root cause: Drew's tab was a Web
  Locks **follower** (FIXES_LOG Entry 16), so the client-side
  `u.leaseEnvelopes.push(...)` + `saveState()` after the CF returned hit
  the follower-skip gate and the local mutation never reached Firestore.
  Pre-JWT this had been masked by `_dsHasValidToken()` failing for
  managers entirely (Entry 20) — the moment JWT unlocked managers to
  send leases, the follower-skip data-loss became reachable in production.
- **Invariant — DO NOT BREAK:**
  1. **CF `dsSendEnvelope` MUST do the state write itself** via Firestore
     transaction on `workspaces/{wid}/data/state`. Don't move the write
     back to the client — Web Locks follower tabs skip writes silently
     and the data loss isn't observable until the operator looks for the
     envelope.
  2. **CF `dsSendEnvelope` MUST require `unitId + buildingId + floorId`
     in args.** Without these the transaction can't find the target unit
     and the envelope orphans (created in DocuSign, no state record).
     Reject with `invalid-argument` instead of guessing.
  3. **The transactional push MUST be idempotent.** A retry from the same
     caller (network blip, double-click) should NOT result in two
     envelope records. Implementation: scan
     `u.leaseEnvelopes.find(e => e.envelopeId === data.envelopeId)`
     before pushing.
  4. **Audit log entry MUST include `unitId + buildingId + floorId +
     stateWriteOk`** so `_dsReconcileEnvelopes` can find the target unit
     when backfilling. Without these the audit log is incomplete and
     reconciliation degrades to fuzzy email matching.
  5. **Client `_dsReconcileEnvelopes` MUST run on `_dsSyncInit`** (every
     sign-in) and **after every successful send the local tab performs**.
     The sign-in pass catches anything previously orphaned; the post-send
     pass catches anything the CF's own transaction couldn't write
     (edge case: target unit didn't exist in state at write time).
  6. **Reconciliation must NEVER overwrite an existing envelope record.**
     Treat the local state as the source of truth for fields like
     `signedPdfPath`, `lastChecked`, `archivedAt` — these only exist
     post-completion and reconciliation must respect them. Match by
     `envelopeId === audit.envelopeId` and skip if a match exists.
  7. **CF must NOT throw on state-write failure** when the DocuSign API
     call already succeeded. The envelope is real (email landed in
     tenant's inbox); throwing would mislead the operator into thinking
     the send failed. Instead: log the error, set `stateWriteOk: false`
     in the response + audit log, and let client-side reconciliation
     pick it up on next sign-in.
- **Verification:**
  1. Manager (NOT admin) opens the app in **two browsers**. Both tabs
     authenticate as the same manager. Web Locks elects one as leader,
     the other becomes a read-only follower.
  2. From the **follower** tab: open a unit → "+ Add lease document" →
     fill form → Save → "Send via DocuSign" → click Send.
  3. Wait ~5s for sync. Check the **leader** tab → unit panel → Lease
     tab. Envelope card "Awaiting signature" should appear with status
     pill. Audit log entry exists with `stateWriteOk: true`.
  4. Pre-fix, the envelope would NOT appear in either tab's view until
     manual backfill — the local push silently failed.
  5. Force-test the reconciliation path: from a one-off Firestore write
     (or by editing state to clear `u.leaseEnvelopes`), reload the page →
     `_dsReconcileEnvelopes` pulls the audit entry → backfills the
     envelope. Toast: "✓ Recovered N sent leases from server audit log".
- **Regression test:** none — manual UI only.
- **Related PR / issue:** none
- **First production loss:** Drew (manager) / Suite 403 / Daniel Maycon
  dos Santos Moreira / envelope `ed528919-1581-8333-8380-c8c934b66e96` /
  2026-05-18 02:27 UTC. Backfilled manually during diagnosis; would
  have been recovered automatically by `_dsReconcileEnvelopes` on next
  sign-in once this commit deployed.

---

### 30. Phantom bank transaction from orphan Stripe FC account (2026-05-21)

- **Status:** active
- **Branch / commit:** `claude/modest-curie-8a50ad` @ commits `eeb45f0`
  (UI defense) + `f10c446` + `f8e4bca` (cleanup CF)
- **Area:** financial integrity / bank reconciliation / Stripe Financial
  Connections lifecycle
- **Files:**
  - `floor-map-editor.html` — `_bankDetectDuplicates`, `_bankDayBucket`,
    `_bankDupDrillDown`; integration in `_mpmRenderBankSuggestions` and
    `_txnBrowserBuildRow`/`_txnBrowserNormBank`
  - `functions/index.js` — `cleanupOrphanBankTransactions` CF (~135 lines)
  - `scripts/admin-firestore.js` (untracked local) — `bank-list-dups`,
    `bank-list-orphan`, `bank-cleanup-orphan --confirm` mirror commands
- **Functions:**
  - Client: `_bankDetectDuplicates(txns)` → `{canonical, dups, dupCount}`;
    `_bankDayBucket(unix)` → NY-TZ day-string; `_bankDupDrillDown(id)` →
    side-by-side popover of dup-group candidates
  - Server: `cleanupOrphanBankTransactions({dryRun, targetAccountIds?,
    targetPrefix?})` — root-admin only; deletes orphans + writes
    `bank.txn.orphan-cleanup` audit entries
- **Bug it fixed:** Tony's Capital One mobile app showed ONE
  `Customer Deposit` on 4/21 for $13,318.33, but the SuitesForAll
  Payment Suggestions card showed **two** Customer Deposit rows for
  the same amount — one on 4/20 and one on 4/21, both flagged
  `+$0.33 over · unmatched`. If the operator clicked "Apply" on both
  rows, the tenant's rent would have been double-credited (one
  payment, two ledger entries).
  Root cause: Stripe Financial Connections reconnect on 2026-05-22
  ~00:48 UTC produced a **new** `fc_account_id`
  (`fca_1TZhGc2nq2bZh3q6isyTrFJe`), which re-pulled history with
  **new** transaction IDs. The disconnected account
  (`fca_1TSrMQ2nq2bZh3q6bnokrr8y`) still had 515 documents in
  `bankTransactions` — the server-side dedupe in
  `_pullTransactionsForAccount` (functions/index.js:5050) is keyed
  on `t.id`, so the same logical deposit under a new Stripe ID was
  written as a separate document instead of being recognized as a
  duplicate. Timezone display (`toLocaleDateString()` vs server
  UTC-midnight stamp) made the two appear on different dates.
- **Invariant — DO NOT BREAK:**
  1. **`_bankDetectDuplicates` MUST run before rendering bank
     suggestions** (`_mpmRenderBankSuggestions` and txn browser).
     Without this last-line-of-defense, future reconnects, pending→
     posted transitions, or CSV-overlap will re-introduce phantom
     duplicates that the operator can double-apply.
  2. **The fingerprint key is `(amount_cents, day-bucket-in-NY-TZ,
     ±2 days)`** — NOT description (Stripe sometimes changes
     description between pending/posted), NOT accountId (orphan
     accounts have different IDs by definition).
  3. **Canonical-row selection prefers `status='posted'` > newer
     `transactedAt` > longer `id`.** This biases toward the live
     account's view, which is what the operator expects.
  4. **`cleanupOrphanBankTransactions` defaults to `dryRun:true` and
     `targetPrefix:'fca_'`.** Never auto-delete `import:*` (CSV
     imports) — that data is operator-supplied and may be unique.
     Require explicit `targetAccountIds:[...]` whitelist for any
     non-`fca_*` cleanup.
  5. **Every deletion MUST write an audit entry to `workspaces/{ws}/
     audit`** with action `bank.txn.orphan-cleanup`, the deleted
     doc snapshot (accountId, amount, description, transactedAt,
     status, matchState, seenAt), the actor email, and the reason.
     Without the audit row a deletion is unrecoverable.
  6. **Server-side dedupe in `_pullTransactionsForAccount` (the actual
     root cause) is STILL keyed on `t.id` only.** This entry's fixes
     are reactive (UI defense + cleanup CF) — the **server-side
     fingerprint dedupe** (writing docs under a composite-fingerprint
     doc-id instead of `t.id`) is Tier 2 work still pending. Until
     then, the UI defense + orphan-cleanup CF is the only barrier.
- **Verification:**
  1. Open https://suitesforall.web.app, open Manual Payment modal on
     any unit. Suggestions card renders — if any two bank txns share
     a fingerprint, the row collapses and shows `⚠ N dups` chip.
  2. Click the chip → drill-down popover lists all dup-candidates
     with docId, accountId, transactedAt (NY TZ), status,
     matchState, description. Audit entry `bank.txn.dup_review`
     written to `workspaces/default/audit`.
  3. Run dry-run cleanup: `stripeCallable('cleanupOrphanBankTransactions')({dryRun:true})`
     → returns `{activeAccountIds, orphanAccountIds, wouldDelete,
     wouldKeep, sampleOrphan}`. Verify `orphanAccountIds` is the
     correct list (NO `import:*` entries by default).
  4. Confirm with `targetAccountIds:['fca_<orphan>'], dryRun:false`
     → deletes + writes audit. Re-run dry-run → orphan list empty.
  5. Re-open the unit's Manual Payment modal — phantom rows are
     gone from the suggestions card.
- **Regression test:** none — verified via live browser + Firestore
  query. Server-side `pollBankTransactions` does NOT re-create
  orphan docs on subsequent polls (it queries by current `fcAccountId`
  only).
- **Related PR / issue:** none
- **First production loss:** Tony / NUHS Suite 101 / 2026-05-22 ~01:10
  UTC. Tony spotted the discrepancy visually before applying — no
  double-credit occurred. Cleanup deleted 515 docs from
  `fca_1TSrMQ2nq2bZh3q6bnokrr8y`; 767 kept (active account + CSV
  imports). Audit trail: `workspaces/default/audit` with 515
  `bank.txn.orphan-cleanup` entries.

---

### 31. Auto-apply matched bank transactions to payments (2026-05-21)

- **Status:** active
- **Branch / commit:** `claude/modest-curie-8a50ad` @ commits `1ea15e6`
  (initial CF + UI) + `790e000` (direct candidate-finder fix)
- **Area:** financial automation / bank reconciliation / payments
  ingestion
- **Files:**
  - `functions/index.js` — `_findAutoApplyCandidate(state, txn)`,
    `_findOldestUnpaidYm(u, txn)`, `_autoApplyAfterPoll(fcAccountId)`,
    new callable `undoAutoAppliedPayment`
  - `floor-map-editor.html` — payment cell `🤖` chip CSS
    (`.ph-cell.auto-applied` + `.ph-cell-auto-dot`), `cells.push`
    propagation of `autoApplied` flag, MPM header «Auto-applied · Undo»
    pill in `_mpmRenderLinkedPill`, client wrapper `_mpmUndoAutoApplied`
- **Functions:**
  - Server: `_findAutoApplyCandidate(state, txn) → {eligible, candidate,
    reason}` — direct «exact rent ±$1 + single candidate + has unpaid
    month» check (bypasses matcher's 60-point threshold which is too
    strict for `Customer Deposit`-style descriptions).
  - Server: `_autoApplyAfterPoll(fcAccountId)` — called from
    `pollBankTransactions` after each account's pull. Scans
    `matchState in ['unmatched','suggested']`, applies eligible.
    Returns `{applied, skipped, candidates}`.
  - Server: `undoAutoAppliedPayment` callable — operator reverses an
    auto-apply via the MPM «↶ Undo» button.
  - Client: `_mpmUndoAutoApplied()` — calls undo CF, closes modal,
    re-renders unit detail.
- **Bug it fixed:** Tony asked «как мне теперь сделать чтобы следующий
  транзакция потянулась автоматически и применялось автоматически. Без
  моего участия». Before this entry, every bank-feed match required
  the operator to open the Manual Payment modal, find the suggestion,
  and click Apply. For a portfolio with dozens of monthly deposits,
  that was 30+ clicks/month of routine reconciliation.
- **Invariant — DO NOT BREAK:**
  1. **Strict mode by default** — Tony's choice (2026-05-21). Only
     auto-apply when bank amount is within ±$1.00 of expected rent
     AND there is **exactly one** candidate unit at that amount. Any
     ambiguity (2+ units with the same rent) → skip to manual review,
     never guess.
  2. **Posted only.** `txn.status !== 'posted'` → skip. Pending bank
     transactions can be reversed by the bank; auto-applying them
     creates phantom payments.
  3. **Credits only.** `txn.amount <= 0` → skip. Debits / refunds /
     chargebacks need operator review.
  4. **Idempotency double-checked.** Inside `mutateWorkspaceState`'s
     Firestore transaction, re-check `u.payments[ym]?.status === 'paid'
     || u.payments[ym]?.bankTxnId === txn.id` and skip. Without the
     second check, a race between two simultaneous polls could double-
     apply.
  5. **Per-unit opt-out** via `u.autoApplyDisabled === true`. Some
     tenants (irregular payment patterns, manual reconciliation only)
     must be excluded.
  6. **Global kill-switch** via `state.settings.autoApplyEnabled ===
     false`. Operator can pause all auto-apply if they suspect a bug.
  7. **Lease window respected.** `_findOldestUnpaidYm` filters
     candidate months to those within `u.leaseStart` … `u.until`.
     Auto-applying for a pre-lease or post-lease month creates a
     phantom liability.
  8. **Audit on EVERY apply** — `workspaces/{ws}/audit` entry with
     action `payment.auto-applied`, full match-decision snapshot
     (bankTxnId, amount, description, accountId, unitId, ym,
     deltaCents, rentCents). And **on every undo** — action
     `payment.auto-applied.undo`. Without the audit trail, an operator
     cannot answer «why was this month auto-paid» two weeks later.
  9. **Reversible.** `u.payments[ym].autoApplied === true` is the
     marker that lets the client render the «↶ Undo» button and the
     CF accept the undo (rejects with `failed-precondition` otherwise).
     Once an operator manually edits an auto-applied payment, the flag
     should NOT carry over — the new state is operator-authoritative.
 10. **Auto-apply does NOT raise rent.** When bank amount > rent by
     ≥ $1, the variance dialog (FIXES_LOG #29) must handle it via
     operator approval. Auto-apply silently ignores variance > $1.
     The two systems are complementary: auto-apply for routine on-
     amount matches; variance dialog for amount mismatches.
- **Verification:**
  1. Pull a bank-feed transaction via `pollBankTransactions` — auto-
     apply runs inline. Return value includes `autoApply: {applied,
     skipped, candidates}`.
  2. Reload the app. Open the affected unit's tenant drawer. Open
     Manual Payment modal for the matched month. Header pill shows
     «🤖 Auto-applied · ↶ Undo» AND «🔗 Linked: $X · YY/YY/YYYY».
  3. Click ↶ Undo → confirm → MPM closes → reload → MPM for the same
     month shows EMPTY form (payment removed) AND bank txn is back to
     `matchState='suggested'` in the suggestions card.
  4. Verify audit log: `workspaces/{ws}/audit` has entries with
     `action='payment.auto-applied'` (apply) and
     `action='payment.auto-applied.undo'` (revert), both with full
     context (unitId, ym, bankTxnId, deltaCents, rentCents).
  5. Edge case — global kill-switch: set
     `state.settings.autoApplyEnabled = false`, run
     `pollBankTransactions`, verify `autoApply.disabledGlobally =
     true` and 0 applied.
  6. Edge case — ambiguity: two units with identical rent + matching
     bank deposit → `_findAutoApplyCandidate` returns
     `{eligible: false, reason: 'ambiguous', candidates: 2}`. Skipped,
     manual review needed.
- **Regression test:** none — manual UI verification only. Future:
  add Playwright spec that fakes a bank txn, runs poll, asserts the
  unit's June payment is marked auto-applied + chip visible.
- **Related PR / issue:** none
- **First production validation:** Tony / Suite 433 (Lex Wagner) /
  2026-05-22 02:31 UTC. Auto-applied $1,500 ACH deposit (`fctxn_1TZhGy2nq2bZh3q6OnTtui8m`,
  delta = 0¢) to `u.payments['2026-06']` without operator
  intervention. Verified in MPM modal: `🤖 Auto-applied · ↶ Undo`
  pill visible alongside `🔗 Linked: $1,500.00 · 5/18/2026`.
  534 candidates scanned, 1 applied, 533 skipped (already paid,
  ambiguous, or no unpaid month).
- **2026-05-22 follow-up — future-only restriction + UI polish.**
  Per Tony's industry-research request (Yardi/AppFolio/Buildium/MRI/
  Stripe/QuickBooks pattern), added invariants 11–14:
  11. **Future-only auto-apply gate.** When the matched ym < current
      server month, `_findAutoApplyCandidate` returns
      `{eligible:false, reason:'past-month-needs-manual', candidate}`
      instead of applying. Past-period auto-apply закрывает старый
      долг без проверки и может скрыть chargeback / dispute /
      неправильный billing — все industry-standard PMS требуют
      manager approval для past period.
  12. **Past-month candidates → 'suggested'.** Not silently skipped.
      `_autoApplyAfterPoll` writes
      `matchState='suggested' + matchSource='auto-apply-past-month-
      deferred'` so the operator sees them in MPM Payment Suggestions
      with «🔒 Past month — approve manually» pill. One click → MPM
      → apply manually if appropriate.
  13. **Source-distinguished icons in payments grid.** Each paid
      cell shows ONE icon в правом нижнем углу: 🤖 auto-applied,
      📥 bank-import (CSV), 💳 stripe, 👤 manual. Operator scans
      ledger в один взгляд — Yardi/AppFolio pattern.
  14. **Auto-applied history panel** в Settings → Bank Connections.
      Listed apply events (newest-first) с Time / Suite / Tenant /
      Month / Amount / Delta / View / Undo columns. Reversed events
      shown faded with «↶ Undone» badge. Read via
      `listAutoAppliedHistory` callable, joins audit events
      `payment.auto-applied` + `payment.auto-applied.undo`. **Subtle
      bug fix (commit `dcc0995`):** ts-comparison joins ensure an
      apply event is marked undone ONLY if undo's ts > apply's ts.
      Without this, apply→undo→re-apply cycles mark the latest apply
      incorrectly undone.
- **2026-05-22 evening — current-month-only + method-consistency + verbose tooltip.**
  Lex Wagner Suite 433 incident: cron auto-applied a $1,500 ACH bank
  deposit to his June 2026 rent, but Lex always pays via Stripe / credit
  card. The deposit belonged to another tenant. Tony's three new rules:
  15. **Current-month-only (no future prepayment auto-apply).** When
      `ym > currentYm`, `_findAutoApplyCandidate` returns
      `{eligible:false, reason:'future-month-needs-manual', candidate}`.
      Mirrors AppFolio's «advance payment review» + Buildium's «Apply
      to past period?» modal (extended to prepayments). Future-month
      candidates go to deferred bucket with `matchSource='auto-apply-
      future-month-deferred'` so the MPM Payment Suggestions card
      shows «📅 Future month — approve manually» purple pill.
  16. **Payment-method consistency.** `_unitPrimaryPaymentMethod(u)`
      analyzes last 12 paid records (excluding backfill + auto-applied
      to avoid feedback loop). If ≥60% share a method family
      (`stripe` vs `bank`), that's the primary. When the incoming
      bank-txn's family differs from the unit's primary, candidate
      goes to `matchSource='auto-apply-method-mismatch-deferred'`
      with «🔀 Method mismatch — usually <X>» pink pill. Catches the
      Lex-Wagner-style case where a $1,500 bank deposit could match
      multiple tenants by amount but only one of them actually pays
      via ACH.
  17. **Verbose tooltip method labels.** Previously the tooltip on a
      paid cell showed `Method: Paid` (fallback when paidVia was
      unrecognized), which was useless. Now: full dictionary with
      emoji prefix (🧾 Check, 🏦 Bank transfer / ACH, 🏦 Wire transfer,
      💵 Cash, 💳 Stripe / Credit card, 💳 Stripe (linked), 💳 Stripe
      (advance / multi-month), 📜 Backfilled (migration), ❔ Other,
      ❔ Method not recorded). Auto-applied entries get
      `🤖 Auto-applied · ` prefix so operator immediately knows the
      source. Catches data-quality issues — operator can see at a
      glance which payments lack a recorded method.
  18. **State badge moved to amount-row.** Previously the deferred
      reason badges (🔒 / 📅 / 🔀) rendered after description in
      `mpm-bf-row-meta`, but ellipsis truncation hid them. Moved to
      `mpm-bf-row-amt` (top row) next to the amount. Always visible
      regardless of description length.

---

## Recommended porting order

The two source branches do not currently conflict, but they touch the same
file (`floor-map-editor.html`). Suggested merge sequence:

1. ~~**First:** `fix/autobilling-respect-archive-filters` → `main`~~ — **done
   2026-05-13.** Entries 1, 2, 6, 7 all cherry-picked. Source branch can be
   archived (or kept for reference; no further commits needed).
2. ~~**Next:** Entry 5 (commit `d5738e6`) standalone cherry-pick~~ — **done
   2026-05-13** in commit `c930613` (conflict with Entry 7 resolved).
3. ~~`feature/consolidate-overdue-formula` → `main`~~ — **done 2026-05-17**
   via the cool-faraday merge `5ad0661`, which brought:
   - Entry 3 (Stripe self-heal — was already ported earlier in commits
     `d1f6cb2` + `103a230`; the cool-faraday merge confirmed parity)
   - Entry 4 (proration via `_monthBilling` + `package.json` +
     `tests/overdue.test.js`) — landed in commit `5ff2be7`. Run
     `node tests/overdue.test.js` to confirm 9/9 pass.

All originally-listed source branches are now satisfied. Surviving
locally-ahead branches are duplicates with different SHAs — safe to
archive after diff review.

After each port, flip Status `needs-porting` → `active` for the affected
entry and add a corresponding `check_gate` line to
[scripts/check-invariants.sh](scripts/check-invariants.sh) if the invariant
is greppable.

## How to add a new entry

When you fix a non-trivial bug:

1. Pick the next entry number.
2. Fill out every field of the template. Empty fields are unacceptable —
   write "none" if there's no PR / no automated test / no porting concern.
3. Commit `FIXES_LOG.md` together with the code change. The PR description
   should reference the new entry number.
4. If you intentionally rewrite an older fix, mark the old entry
   `superseded` (do not delete it) and add a `Superseded by: Entry N` line
   to the old entry's "Bug it fixed" field.
