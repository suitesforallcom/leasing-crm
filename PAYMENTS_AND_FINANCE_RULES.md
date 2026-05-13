# PAYMENTS_AND_FINANCE_RULES.md

> Rules for any code/docs that touch money, invoices, payments, or financial state.
> **Most rules require Tony's explicit approval to modify.** See CLAUDE.md "Tony Approval Required".

## Top-line principle

**Every dollar matters.** A bug that creates wrong invoices or duplicate charges = real customer harm = trust loss. Conservative rules below — follow strictly.

---

## Field reference

### Per-unit financial fields

| Field | Type | Meaning | Who writes |
|---|---|---|---|
| `u.rent` | number | **Proforma asking rate** ($/mo) — what the unit is listed at, market rate | Operator (creating unit) |
| `u.contractRent` | number | **Contract rent** ($/mo) — what THIS specific tenant actually pays | Operator (signing lease) |
| `u.sqft` | number | Square feet (drives $/ft²/yr derivation) | Operator OR auto from polygon×scale |
| `u.payments[ym]` | object | Per-month payment record (status, amount, date, method, ref) | Operator (manual) OR webhook (Stripe) |
| `u.payments.deposit` | object | Deposit record (status, amount, date) | Operator |
| `u.lateFee` | object | Per-unit late-fee config: autoSend, pct, minUsd, graceDays, sentList | Operator |
| `u.autoSendInvoice` | boolean | Whether monthly Stripe auto-create is on | Operator |
| `u.stripe.customerId` | string | Stripe `cus_*` | Cloud Function (on first lease) |
| `u.stripe.depositInvoice` | object | Deposit invoice in Stripe | Cloud Function |
| `u.stripe.lastSentInvoice` | object | Most recent invoice sent | Cloud Function |
| `u.stripe.lastAutoInvoiceError` | object | If last auto-create failed (red border on map) | Cloud Function |

### Per-building financial overrides

`b.billingRulesOverride`:
- `paused` — boolean: pauses all auto-billing for this building
- `gracePct` — percentage grace (rare; usually graceDays is used)
- `lateFee.pct` — late-fee percentage override
- `lateFee.minUsd` — late-fee minimum dollar override
- `lateFee.graceDays` — grace period override

### Workspace-level financial settings

`state.settings.lateFee`:
- `autoSendLive` — boolean: false = dry-run mode (cron logs only, no real charges); true = real Stripe sends
- `pct` — workspace default percentage
- `minUsd` — workspace default minimum
- `graceDays` — workspace default grace period

---

## Effective rent (canonical)

Used by Rent Roll, Stacking, Avg Rent cards, A/R Aging:

```js
const effectiveMonthly = (u.status === 'occupied')
  ? (+u.contractRent || +u.rent || 0)   // tenant pays the contract; legacy fallback to u.rent
  : (+u.rent || 0)                       // vacant/reserved → asking proforma
```

**Why fallback to `u.rent` for occupied**: legacy units (pre-`contractRent` field) have rent in `u.rent` only. Don't break them.

**For multi-suite leases**: only the primary holds the combined rent; members hold `u.contractRent = 0`. Don't accidentally double-count by summing all members.

---

## Lease-start gate (CRITICAL — set 2026-05-13)

**Rule**: No money calculation runs for a unit until it has a valid lease-start date. If `u.leaseStart` AND `u.signed` are both empty/invalid, the tenant has not yet started — return zero everywhere (rent owed, late fees, unpaid months, DSO, A/R aging).

**Why**: a 12-month-back loop without this gate accrues 12 × $rent + 12 × $lateFee for a tenant added today with no lease info. Operator sees "12 months unpaid · $7,800 owed" + "$624 late fees" on a brand-new tenant — fictional debt that traumatizes the operator and pollutes A/R aging reports.

**Where this MUST be enforced** (every function that loops months back):
- `_computeUnitMoney` ✓ guarded — drives the unit-panel "$X owed" + red overdue overlay
- `_renderUnitLateFeeOwed` ✓ guarded — drives the "Unbilled late fees $X" card
- `_renderUnitPaymentHealth` ✓ guarded — drives the 13-month Payment History grid (red squares per month). Without the gate, the grid rendered 7 red "Late (>5d)" squares for a brand-new tenant because the rangeStart fell back to `curM - 6` and every past month with no payment record got `cls='overdue'`. The gate replaces the grid with a friendly "Lease start not set" amber banner.
- `_bvComputeTenantBalance` ✓ guarded, `_bvCountOutstandingMonths` ✓ guarded — Building View summaries
- `dsoForTenant` ✓ guarded, `trendForTenant` ✓ guarded — A/R Aging metrics
- `buildAgingRows` ✓ guarded (`continue;` skips the whole tenant when startDate is missing — they don't appear in the aging report at all) — A/R Aging report rows
- Any future helper that iterates `for (let i = 0; i < N; i++)` over months

**Implementation pattern** (apply at the TOP of every such function, before any loop):

```js
const startIso = u.leaseStart || u.signed || '';
const startDate = startIso ? new Date(startIso + 'T00:00:00') : null;
if (!startDate || isNaN(startDate.getTime())) {
  return /* zero-valued result of the function's contract */;
}
```

**Inside the loop**, additionally skip months whose `lastDay < startDate` — that handles partial-month overlap for tenants who joined mid-month (already implemented in `_computeUnitMoney` and `_renderUnitLateFeeOwed`, just make sure the outer gate exists too).

**Test for this rule** (manual, until automated):
1. Create a new tenant on a vacant unit. Fill name + rent. Skip lease-start.
2. Open the unit panel. The "Overdue" badge must NOT appear. "Outstanding" must be $0. "Unbilled late fees" panel must be HIDDEN.
3. Same for A/R Aging report — the new tenant must NOT appear there.

**Do NOT remove this gate** under any circumstance without explicit approval from Tony. Removing it = financial chaos visible to operators.

---

## Multi-suite lease (`groupId`) handling

**Rule**: One tenant + one contract + one set of invoices/overdue/payments.

Implementation:
- Group joined via `u.groupId = <uuid>`; primary marked `u.groupRole = 'primary'`
- Primary holds `u.contractRent = combinedRent`; members have `u.contractRent = 0`
- Tenant identity (name, email, phone) duplicated to all members for display consistency
- `_isFinanceShadow(u)` returns true for non-primary members; finance code skips them
- `_unitsInGroup(groupId)` returns all members for whole-group operations

**Where this MUST be honored**:
- Rent Roll → 1 row per multi-suite lease
- A/R Aging → 1 row per overdue lease (not per member)
- Auto-billing → 1 invoice per primary, not per member
- Payments matrix → 1 cell per primary
- Late-fee triggers → on primary only

**Past complaint** (MEMORY.md → `feedback_grouped_suites_one_lease.md`): operator hit this 2+ times. Don't regress.

---

## Sub-rooms (`parentId`) handling

**Rule**: Sub-rooms whose parent is whole-rented or part of a tenant group are "inactive" — skip in MRR / aging / vacancy aggregations.

Implementation: `_isInactiveSubRoom(u)` returns true when:
- `u.parentId` is set
- Parent exists
- Parent is occupied OR part of a multi-suite group

Why: parent's rent already covers the area; counting child would double-count sqft + rent.

---

## Status semantics

| `u.status` | Meaning | Rent counted in MRR? |
|---|---|---|
| `'occupied'` | Active tenant paying | YES (`contractRent`) |
| `'vacant'` | No tenant; advertising at `u.rent` | No (but counted in `pot` as potential) |
| `'reserved'` | Held for incoming tenant; not yet rent-collecting | No (counted as potential) |

Common gotcha: `u.tenant` lingering after move-out. Trust `u.status === 'occupied'` as the canonical occupancy signal, not `!!u.tenant`.

---

## Payment record shape (`u.payments[ym]`)

```js
u.payments['2026-05'] = {
  status: 'paid' | 'past_due' | 'free' | 'partial' | 'pending',
  amount: number,                       // dollars
  date: 'YYYY-MM-DD',                  // payment date (operator-set)
  paidVia: 'stripe' | 'check' | 'ach' | 'wire' | 'cash' | 'other' | 'waived',
  paidMethod: string,                   // sometimes duplicates paidVia
  ref: string,                          // check number, ACH conf #, wire conf #
  memo: string,
  receiptUrl: string,                   // Storage URL for uploaded receipt photo
  receiptPath: string,                  // Storage path (for cleanup)
  paidBy: string,                       // operator email
  recordedAt: ISO8601,
  // Waiver-only (when status='free'):
  waiverReason: 'referral' | 'promotion' | 'goodwill' | 'comp' | 'other',
  referredSuite: string | null,
  waiverStart: 'YYYY-MM-DD',
  waiverEnd: 'YYYY-MM-DD',
}
```

`u.payments.deposit` follows similar shape but tracks the deposit invoice.

---

## Invoice generation rules (`functions/index.js` cron + manual)

The auto-billing daily cron walks all units. For each:

1. **Skip filters** (apply ALL):
   - Archived → skip
   - Not rentable → skip
   - Not office type → skip
   - `_isFinanceShadow(u)` → skip (group member)
   - `_isInactiveSubRoom(u)` → skip (child of whole-rented parent)
   - `b.billingRulesOverride.paused === true` → skip
   - `u.status !== 'occupied'` → skip
   - No tenant on file → skip
   - `u.payments[currentYm]?.status === 'paid'` → skip (already paid)
   - `u.lateFee.autoSend !== true` → skip (per-unit opt-out)
   - Within grace period → skip
2. **Compute amount**: `u.contractRent || u.rent || 0`. If 0 → skip (no contract recorded).
3. **Apply late fee** if past grace: `lateFee = max(amount × pct/100, minUsd)`.
4. **Create + finalize Stripe invoice** with rent + late-fee line items.
5. **Update**:
   - `u.lateFee.sentList.push({ ym, sentAt, invoiceId })`
   - `u.stripe.lastSentInvoice = { ... }`
6. On Stripe error: `u.stripe.lastAutoInvoiceError = { ym, ts, message }` (red border on map).

**Workspace-level dry-run**: if `state.settings.lateFee.autoSendLive !== true`, the cron logs what WOULD be sent but doesn't actually call Stripe API. Used for safety verification.

---

## Manual payment recording

`submitManualPayment()` in `floor-map-editor.html`:

1. Captures method, amount, date, memo, optional receipt
2. **5× over-record guard**: if `amount > 5 × rent` → confirm dialog (catches typo `$75000` instead of `$750`)
3. **Defense-in-depth role check**: `_assertCanEditFinance('record manual payments')` throws on JS side
4. Uploads receipt to Storage if provided; deletes prior receipt to avoid orphans
5. Writes `u.payments[ym] = { status, amount, ... }` via optimistic-locked Firestore tx
6. Updates `_rev`

**Required for waivers** (status='free'):
- `waiverReason` (operator picks from dropdown)
- `referredSuite` (only required if reason = 'referral')
- `waiverStart` + `waiverEnd` (operator-configurable date range)

---

## Waiver pro-rate (helper exists, wiring deferred)

`_unitProrationCredit(u, ym)` returns the fraction of rent (0..1) that should be credited for a given month:

```js
const credit = _unitProrationCredit(u, '2026-06');  // → e.g. 0.4 if 12 of 30 days waived
const billable = rent * (1 - credit);
```

Walks all `u.payments[*]` with `status='free'` and `waiverStart`/`waiverEnd`, computes per-month coverage, sums fractions, clamps to `[0, 1]`.

⚠️ **NOT YET WIRED** into invoice generation. See KNOWN_ISSUES.md #1. When wired, must be called from:
- Auto-billing cron in `functions/index.js`
- Manual invoice creation in `submitManualPayment` related flows
- Stripe sync handlers

---

## Recovery cases (`state.recoveryCases[]`)

Tracks moved-out tenants who left owing money. Each entry:

- Snapshot of tenant identity + amount owed at move-out
- Agency assignment (free text)
- Status: `in_collections` / `written_off` / `recovered`
- Events log (calls, letters, payments received)

`buildAgingRows` (A/R Aging) — DOES include recovery cases? Check before assuming. Currently A/R focuses on active tenants; recovery is its own panel.

---

## Stripe webhooks (`functions/index.js`)

Bidirectional sync. Events handled:

| Event | Effect on state |
|---|---|
| `invoice.payment_succeeded` | Mark `u.payments[ym].status = 'paid'`, set `paidVia = 'stripe'`, set `amount`, `date` |
| `invoice.payment_failed` | Mark `u.payments[ym].status = 'past_due'`; record reason |
| `charge.refunded` | Reverse the payment record; mark refund event |
| `customer.created` | Set `u.stripe.customerId` |
| Deposit-specific events | Update `u.payments.deposit` shape |

**Webhook signing** required: each call verified via `STRIPE_WEBHOOK_SECRET`. Don't disable verification.

---

## Cap rate / valuation (Investment Analysis)

For Building Value: `Building Value = NOI / cap rate`.

Defaults:
- Forecast hero «Potential Value»: 9% cap, 0% vacancy (proforma 100% leased), 35% expenses
- Investment Analysis quick-estimate: 7% cap, 5% vacancy, 35% opex
- Investment Analysis full record: per-building configurable sliders

NOI computation:
```
GPR = Σ(u.rent × 12) for rentable office units
EGI = GPR × (1 - vacancyPct/100)
NOI = EGI × (1 - opexPct/100)
```

These are PRESENTATION calculations — they don't drive billing. They drive analytics.

---

## What requires Tony's explicit approval

ALWAYS ask:

- New Stripe API call from any code path
- Changing late-fee formula
- Changing grace period default
- Changing `STRIPE_MODE` env var
- Editing `functions/index.js` (Cloud Functions code)
- Modifying webhook handlers
- Changing how `_isFinanceShadow` / `_isInactiveSubRoom` work
- Changing optimistic-lock `_rev` flow
- Bulk-modifying `u.payments[*]` records
- Voiding Stripe invoices
- Issuing refunds
- Changing dry-run flag (`autoSendLive`)
- Per-building or per-unit pause flag changes

## What's safe without approval

- Reading payment records (display)
- Computing derived metrics (effective rent, MRR, GPR, etc.) for display
- Adding read-only display features (new column in Rent Roll, new chart)
- Updating documentation about payment rules

## Test mode discipline

When verifying billing changes locally:

1. Set `STRIPE_MODE=test` in `functions/.env`
2. Use Stripe test API keys (`sk_test_*`, `pk_test_*`)
3. Use Stripe test webhook secret (`whsec_test_*`)
4. Use Stripe CLI to forward webhooks: `stripe listen --forward-to ...`
5. Use test customer / test card numbers (4242 4242 4242 4242)

Tony does this manually; Claude doesn't run Stripe CLI.

## Audit trail

Every payment record includes:
- `paidBy` (operator email)
- `recordedAt` (timestamp)
- `paidMethod` (how it came in)
- `ref` (check #, conf #, etc.)
- `memo` (operator notes)

These are required for legal / accounting reconciliation. Don't strip them.

---

## Common pitfalls

| Pitfall | How to avoid |
|---|---|
| Counting member rent in addition to primary rent (multi-suite) | Use `_isFinanceShadow` skip in iterator |
| Counting child sqft in addition to parent (sub-room) | Use `_isInactiveSubRoom` skip |
| Treating `u.tenant` truthy as occupied | Trust `u.status === 'occupied'` instead |
| Confusing `u.rent` (proforma) with `u.contractRent` (actual) | Use the canonical `effectiveMonthly` formula above |
| Auto-billing fires for archived units | Apply archived skip BEFORE iteration |
| Sending invoice without per-unit `lateFee.autoSend = true` | Always check this flag |
| Bypassing dry-run flag | Always check `state.settings.lateFee.autoSendLive` |
| Editing `functions/.env` in chat | Never touch — let Tony do it locally |
| Computing pro-rate but not applying to invoice | Currently helper only; wiring is KNOWN_ISSUES.md #1 |

---

## Reporting financial discrepancies

If Tony reports "Stripe shows X but app shows Y":

1. Don't auto-correct — find root cause
2. Check `u.payments[ym]` shape vs Stripe invoice
3. Check webhook delivery (Stripe Dashboard → Webhooks → Recent deliveries)
4. Check `u.stripe.lastAutoInvoiceError` for any error trail
5. Cross-reference timestamps (Firestore `_rev` vs Stripe webhook arrival)
6. Report findings + propose fix; let Tony decide

Don't bulk-modify `u.payments` records to "make them match Stripe" — could mask a real bug.

---

## Doc cross-references

- DECISIONS.md § 3 — formulas (effective rent, valuation, waiver pro-rate, activity pill)
- DATA_MODEL.md — full payment record shape
- USER_FLOWS.md — F4 (add tenant), F6 (record payment), F7 (waiver), F8 (Stripe invoice), F9 (auto-billing cron)
- RISK_MATRIX.md — R-1, R-7, R-8, R-18 (financial risks)
- KNOWN_ISSUES.md #1 — pro-rate wiring deferred
