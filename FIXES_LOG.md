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
