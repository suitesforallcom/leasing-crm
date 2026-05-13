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

> _All seven seeded entries below are currently `needs-porting`. See
> "Recommended porting order" at the bottom._

---

### 1. Lease-start gate — anti phantom $7,800 (2026-05-13)

- **Status:** needs-porting
- **Branch / commit:** `fix/autobilling-respect-archive-filters` @ `bf3ef99` +
  `36534d9` + `24e68e8` + `f7d9f6c` (worktree dir
  `.claude/worktrees/angry-tu-472a94/`)
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
- **Related PR / issue:** none
- **Porting note:** Exists on branch `fix/autobilling-respect-archive-filters`
  (worktree dir `angry-tu-472a94/`). Commits `bf3ef99` `36534d9` `24e68e8`
  `f7d9f6c` (oldest-first). Cherry-pick or merge to `main`. Same merge
  resolves Entry 2 (anti-pattern fix lives in `f7d9f6c`).

---

### 2. `if (X && cond) break` anti-pattern (2026-05-13)

- **Status:** needs-porting
- **Branch / commit:** `fix/autobilling-respect-archive-filters` @ `f7d9f6c`
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
- **Related PR / issue:** none
- **Porting note:** Same merge as Entry 1 — `fix/autobilling-respect-archive-filters` @ `f7d9f6c`.

---

### 3. Stripe stale-cache self-heal must not wipe manual bindings (2026-05-12)

- **Status:** needs-porting
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

- **Status:** needs-porting
- **Branch / commit:** `feature/consolidate-overdue-formula` @ `357b0c0`
  (consolidation) + `fd9a42a` + `4d85d89` + `03b6364` + `237dc8b` (consumers
  + tests)
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
- **Porting note:** Exists on branch `feature/consolidate-overdue-formula`.
  Commits `357b0c0` + `fd9a42a` + `4d85d89` + `03b6364` + `237dc8b`. Porting
  is non-trivial: brings new `tests/` directory and `package.json` to a
  repo that currently has neither on `main`. Recommend merging the whole
  branch rather than cherry-picking.

---

### 5. Invoice month overrides — `state.ui.invoiceMonthOverrides` (2026-05-12)

- **Status:** needs-porting
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

- **Status:** needs-porting
- **Branch / commit:** `fix/autobilling-respect-archive-filters` @ `d73dc7c`
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
- **Porting note:** Same merge as Entries 1, 2, 7 —
  `fix/autobilling-respect-archive-filters` @ `d73dc7c`.

---

### 7. Deposit display in `fmtBillingMonth` (2026-05-13)

- **Status:** needs-porting
- **Branch / commit:** `fix/autobilling-respect-archive-filters` @ `89eb152`
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
- **Porting note:** Same merge as Entries 1, 2, 6 —
  `fix/autobilling-respect-archive-filters` @ `89eb152`.

---

## Recommended porting order

The two source branches do not currently conflict, but they touch the same
file (`floor-map-editor.html`). Suggested merge sequence:

1. **First:** `fix/autobilling-respect-archive-filters` → `main`
   (Entries 1, 2, 6, 7 — six commits, none with new file dependencies)
2. **Then:** `feature/consolidate-overdue-formula` → `main`
   (Entries 3, 4, 5 — adds `tests/` and `package.json`; will rebase cleanly
   on top of the first merge)

After both merges, every entry above flips from `needs-porting` → `active`
in this file. Update the Status field and the "Recommended porting order"
section in the same commit as the merge.

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
