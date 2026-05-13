# SuitesForAll — Error Memory

Full history of incidents that produced lasting rules. The active rule
list is in [`ERROR_RULES.md`](./ERROR_RULES.md). This file is the
detailed archive — long-form intentionally, not loaded at SessionStart.

## How to use this file

- **Before fixing a recurring-feeling bug**, search this file for
  similar symptoms. Many bugs in this codebase recur because the same
  formula is duplicated in 3–4 places and only some copies got fixed.
- **After resolving an incident worth remembering**, add an entry using
  the template at the bottom of this file. Then update
  `ERROR_RULES.md` if the lesson generalises.
- **Worth remembering** = root cause was non-obvious, OR the symptom
  fooled you, OR the bug is likely to recur in another code path.
- Keep entries dense. Code blocks for the actual diff are fine but
  prefer linking the commit over pasting hundreds of lines.

---

## Entries

### 2026-05-12 — Stale `lastChargeFailure` banner persisted after deposit paid

- **Commit:** `54ea663`
- **Symptom:** Suite right panel showed "Auto-charge failed for
  2026-05" banner even after the deposit invoice flipped to PAID.
- **Root cause:** The banner rendered unconditionally on
  `u.stripe.lastChargeFailure.invoiceId` existence. There was no
  self-heal pass to check whether the underlying invoice had since
  been paid / voided.
- **Fix:** Before rendering the banner, compute `cfIsStale` against
  three truth sources: (a) `_invoicesCache` bucket of the failed
  invoice is now `paid` / `void` / `uncollectible`; (b) the month's
  `u.payments[ym].status === 'paid'`; (c) the deposit invoice changed
  and is paid. If stale, `delete u.stripe.lastChargeFailure` +
  `saveState()` + `fbPushNow()` and skip the banner.
- **Rule produced:** `ERROR_RULES.md` §6 — self-heal stamps before
  rendering banners.
- **Prevention next time:** Any new "last error" stamp added to
  `u.stripe.*` MUST have a self-heal predicate written in the same
  commit. The stamp + the predicate are inseparable.

### 2026-05-12 — Rent-grid heatmap kept showing $700 owed after first fix

- **Commit:** `237dc8b`
- **Symptom:** Even after fixing `_computeUnitMoney`, the rent-grid
  heatmap on the suite panel still showed "1 month unpaid: May 26 ·
  $700 owed" for a tenant whose lease started today.
- **Root cause:** Multi-path computation drift. The same overdue
  formula was copy-pasted into the heatmap function (line ~49283),
  with the same lease-start grace bug and full-rent overcharge.
- **Fix:** Replicated proration + grace-anchor logic in the heatmap
  function (`_gridProration`, `_gridOverdueDate`, `_gridHasAliveInvoiceForYm`).
  Moved alive-invoice short-circuit to BEFORE the `unpaidCount`
  increment, not after, so the badge state is consistent.
- **Rule produced:** `ERROR_RULES.md` §1 — single source of truth.
- **Prevention next time:** Before declaring a money-formula bug
  fixed, grep for the literal `graceDays` / `unpaidMonths` /
  `dayOfMonth >` / `now > dueByDate` to find ALL copies. Fix
  every copy in the same commit. Long-term: consolidate into a
  single helper that returns `{owed, unpaidMonths, byYm}` and call
  it from every consumer.

### 2026-05-12 — New Invoice modal defaulted to $700 instead of prorated $451.61

- **Commit:** `03b6364`
- **Symptom:** Operator added new tenant whose lease starts today
  (12th). Opened "Send Invoice", got the next month preselected and
  the amount field hard-set to full contract rent.
- **Root cause:** `openCreateInvoiceModal` defaults to next-month
  (the common case for renewals), and `ciSelectSuggestion` hard-set
  `ciAmount = +u.contractRent`. No detection of "tenant doesn't have
  a paid invoice for the lease-start month yet" → no automatic
  switch to prorate mode.
- **Fix:** Added `_ciTryMoveInPrefill(u)` invoked from
  `ciSelectSuggestion`. When `_computeProrate` returns non-null AND
  the lease-start month is not already `paid` / `sent` / `free` AND
  there's no live move-in invoice, the modal auto-switches to
  prorate mode for the lease-start month with a toast explaining
  what happened.
- **Rule produced:** No new rule — this is a UX call, not a
  correctness invariant. The modal still accepts overrides; we just
  default to the right thing.
- **Prevention next time:** When adding a "smart default", emit a
  visible toast so the operator knows it happened. Silent smart
  defaults are worse than dumb defaults.

### 2026-05-12 — Prorated rent + lease-start grace in `_computeUnitMoney`

- **Commit:** `fd9a42a`
- **Symptom:** Tenant lease starts today. Right panel pill shows
  "Overdue" badge. Amount owed shows $700 (full month) instead of
  $451.61 (prorated 20/31 days).
- **Root cause:** Two compound bugs in `_computeUnitMoney`:
  1. The lease-start month used full contract rent in the unpaid
     accumulator, not the prorated amount.
  2. The grace-period cutoff was `now.getDate() > grace` (i.e. day
     of calendar month > grace), so a lease starting on the 12th
     with grace=5 was already past due on day 13.
- **Fix:** Compute `_computeProrate(rent, startIso)` once and use
  `proratedAmt` for `ym === proratedYm` in the unpaid loop. Add a
  `_ymToDue` helper that anchors the overdue cutoff to
  `leaseStart + graceDays` for the lease-start month and
  `monthStart + graceDays` for subsequent months.
- **Rule produced:** `ERROR_RULES.md` §2 (grace anchoring) + §3
  (prorate the first month).
- **Prevention next time:** Any money calculation that takes a
  `ym` parameter MUST treat `ym === leaseStartYm` as a special case
  — both for amount (use prorate) AND for the due-date check (anchor
  to `leaseStart`, not month 1).

### 2026-05-09 — Partial invoice UI was missing despite backend support

- **Commit:** `4d85d89`
- **Symptom:** Operator could not bill less than a full month of rent
  from the Create Invoice modal, even though the backend
  (`stripeCreateInvoice`) already accepted `amountOverride`.
- **Root cause:** UI gap. The form only exposed the description and
  full-rent path. There was no source of truth for "rent amount being
  billed" separate from "contract rent".
- **Fix:** Added preset chips `[Full month] [½ month] [Prorate by
  days…]` + a proration calculator (`from` / `to` / `30-360 basis`).
  `ciAmount` became the single source of truth for the line. Manual
  typing in the field resets the preset to `full` to make precedence
  obvious.
- **Rule produced:** No new rule — feature gap, not a regression.
- **Prevention next time:** When a backend grows a new optional
  parameter, audit the UI surface for the gap in the same PR or open
  a follow-up issue.

### 2026-05-09 — Vacant suite kept "Vacant" pill after operator typed tenant

- **Commit:** `e0daadf`
- **Symptom:** Operator types a tenant name in the Tenant tab,
  saves. Suite stays Vacant in every UI surface (right-panel pill,
  kebab menu gates, floor-plan map color).
- **Root cause:** `saveDetail()` wrote `u.tenant` / `u.company` but
  never touched `u.status`. The status gate on the kebab menu was
  `u.status === 'occupied' && u.tenant`, so "Send invoice" / "Record
  payment" were hidden even though a tenant existed.
- **Fix:** When tenant or company become non-empty in `saveDetail`,
  auto-flip `u.status` to `occupied`. Reverse direction stays in the
  move-out flow (which already does this correctly).
- **Rule produced:** `ERROR_RULES.md` §7 — implied status changes
  must be written in the same save.
- **Prevention next time:** When a UI gate checks both a flag and a
  value (e.g. `status === X && field`), the field write should imply
  the flag. Don't leave the operator to remember.

### 2026-05-08 — Manual deposit/rent links vanished on page refresh

- **Commits:** `1025ee2`, then follow-up `6496f71`.
- **Symptom:** Operator clicks "Link as deposit" on an old Stripe
  invoice (created before lease start). Stamp shows correctly. Next
  page load — stamp is gone. Reload again — still gone. Only
  `u.payments.deposit` ledger entry remains.
- **Root cause (1025ee2):** `_healStaleStripeStamps` saw stamp
  `sentAt` (= invoice creation date, sometimes months before lease)
  was older than `leaseStart - 7d` and deleted the stamp on every
  page load. The heal was originally meant to clear stamps left over
  from previous tenants, but it had no way to distinguish those from
  legitimate manual links.
- **Fix (1025ee2):** Tag manual stamps with `manualLink: true`. Heal
  skips stale-check on those.
- **Follow-up root cause (6496f71):** Even after the fix landed, some
  operators still saw the regression. Cause: stale service worker
  cache. Old `sw.js` used `stale-while-revalidate` for HTML, so on
  the first page load after deploy the browser ran pre-fix JS while
  the new HTML downloaded in the background. The pre-fix JS would
  run the old heal pass, wipe the manual stamps, and push the gutted
  state to Firestore before the new HTML even rendered.
- **Fix (6496f71):** Bumped `CACHE_NAME` to `sfa-shell-v2`. Switched
  HTML strategy to network-first (cache only as offline fallback).
  Mirrored manual links into `u.payments.deposit` as a belt-and-
  suspenders truth source the old JS would never have touched.
- **Rules produced:** `ERROR_RULES.md` §4 (mirror manual links into
  truth source), §5 (`manualLink: true` is sacred), §8 (bump
  `CACHE_NAME`), §9 (HTML is network-first).
- **Prevention next time:** Any time you write a `_healStale*`
  function, ask: "what does a legitimately-old-but-still-valid entry
  look like, and how do I distinguish it from cruft?" If you can't
  answer that, the heal will erase real data sooner or later.

### 2026-05-07 — Voided invoice "Delete" was non-persistent

- **Commit:** `564e63e`
- **Symptom:** Operator clicks Delete on a void/refunded invoice in
  the invoice list. Row disappears. Refresh — row is back.
- **Root cause:** "Hide deleted void invoices" lived in an in-memory
  variable, not in `state.ui`. Never persisted, never synced.
- **Fix:** Wrote the hidden list to `state.ui.hiddenInvoiceIds` (a
  Set serialized to an array on save). Reads back through the same
  state slice.
- **Rule produced:** `ERROR_RULES.md` §11 — operator actions that
  need to survive a refresh go in `state.ui.*`.
- **Prevention next time:** When you add a UI toggle that filters a
  list, ask "should this survive a refresh?" If yes — `state.ui`,
  not `let`.

---

## Template (copy this when adding new entries)

```markdown
### YYYY-MM-DD — One-line title

- **Commit:** `<sha>` (link to fix, plus follow-ups if any)
- **Symptom:** What the operator saw. Be concrete — exact text in
  the UI, exact reproduction steps.
- **Root cause:** What was actually wrong in the code. Name the
  function(s) and the false assumption.
- **Fix:** What changed and why that fixes it. If the fix is in
  multiple places (multi-path drift), say so explicitly.
- **Rule produced:** Reference to `ERROR_RULES.md` §N, or "no new
  rule" with reason.
- **Prevention next time:** The actionable pattern. What should a
  future fix or code review check for so this class of bug never
  recurs?
```
