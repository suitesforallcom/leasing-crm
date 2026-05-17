# Financial test plan

The required test surface for any PR that touches money. Companion
to `FINANCIAL_LOGIC_RULES.md` — the rules say what the system must
do; this doc says what tests must prove it.

## Test layers we use

- **Unit (Vitest)** — `tests/unit/**`. Pure-function tests, no DB.
  Money math, allocation arithmetic, status state machine, late-fee
  eligibility predicates, etc.
- **Integration (Vitest + Supabase staging)** — runs against the
  staging Postgres with real RLS. Tests the full mutation path
  including journal entry posting + invariant assertions. Slower,
  fewer in number.
- **E2E (Playwright)** — UI-level CRUD freshness + cross-org
  isolation tests. Authored as smoke specs (always-on) and
  feature specs (per issue).

## §A. Money math precision tests (unit)

Every PR adding a new arithmetic path on money values must include
unit tests covering:

- `Money.add`, `.sub`, `.mul`, `.div` produce results matching
  hand-computed Decimal expectations
- Edge values: zero, very large (>$10M), very small ($0.01),
  negative
- The classic float trap: `0.1 + 0.2 === 0.3` (equivalent for
  Money — no floating drift)
- Rounding rules at the boundary — Money should round at display
  only, not at intermediate steps. Test that
  `m(1).div(3).mul(3).equals(m(1))` holds.

Skip allowed: PRs that touch Money only to display existing
values (no new arithmetic).

## §B. Journal entry balance tests (integration)

For every code path that creates a journal entry, an integration
test that:

1. Triggers the mutation
2. Reads back the inserted `acc.journal_entries` row
3. Asserts `total_debits === total_credits` to the cent
4. Asserts each `acc.journal_entry_lines` row's
   `debit_amount` XOR `credit_amount` (one is non-zero, never
   both, never neither)
5. Asserts the source linkage matches expectation (source_schema,
   source_type, source_id all populated and pointing at the
   operational record)

Tests must explicitly NOT trust the DB trigger to be the only
guard. Application-level assertions catch bugs the trigger
doesn't (e.g. wrong source linkage, missing GL account code).

## §C. Closed period rejection tests (integration)

For each mutation that posts to `acc.journal_entries`, one test
that:

1. Locks an `acc.accounting_periods` row covering a known date
2. Attempts the mutation with an effective date inside that period
3. Asserts the mutation is rejected with a clear error message
4. Asserts NO partial state was written (no orphan operational
   record, no orphan journal entry)

For each correction code path:

5. Locks the period
6. Records a "correction needed" via the reversing-entry path
7. Asserts a NEW journal entry is created in the next OPEN period
8. Asserts the original locked-period entry was NOT mutated

## §D. Idempotency / duplicate prevention tests

For each mutation that COULD be retried (Stripe webhook,
late-fee cron, recurring-invoice cron):

1. Run the mutation once — assert the expected operational +
   journal records exist
2. Run the EXACT SAME mutation again — assert no duplicate
   operational record, no duplicate journal entry
3. Verify the dedupe key being used (Stripe event ID,
   `(invoice_id, period)` for late fees, etc.)

Specific scenarios required:

- **Duplicate Stripe webhook delivery** → no duplicate payment,
  no duplicate journal entry
- **Late-fee cron run twice in same hour** → no duplicate fee
  line item
- **Recurring-invoice cron run twice on the 1st** → no duplicate
  invoice for the same lease+period
- **Concurrent invoice number requests** (10 parallel calls to
  `nextNumber()`) → 10 unique sequential numbers, no gaps from
  race-aborts

## §E. Required edge-case scenarios

The hard list of scenarios that **every financial PR is reviewed
against**. PR description must declare which of these scenarios
the change either covers (with test refs) or affirmatively
doesn't apply (with reason).

### E1. Partial payment

- Tenant pays $1,200 of $2,000 invoice
- Status flips to `'partial'`
- Balance due is $800
- Allocation row exists with $1,200
- Journal entry balanced: DR cash $1,200, CR AR $1,200
- Cross-tenant cache (if present, post X-08) does not stale

### E2. Overpayment

- Tenant pays $2,500 against $2,000 invoice
- Allocation row $2,000, payment.unapplied_amount = $500
- Invoice status `'paid'`
- Journal entry: DR cash $2,500, CR AR $2,000, CR
  unapplied_customer_credit $500
- NEXT invoice for same tenant — applying the $500 credit
  produces correct allocation chain

### E3. Duplicate payment (idempotency)

- Stripe sends same `payment_intent.succeeded` event twice
- Only one `acc.payments` row, only one journal entry
- `core.webhook_events` shows the dedupe

### E4. Voided invoice

- Status set to `'void'`, deleted_at stays NULL
- Reversing journal entry posted in current period
- Original journal entry still queryable
- Status filters in reports respect `'void'` exclusion default
- DELETE attempt at DB level fails (RLS / trigger guard)

### E5. Backdated transaction (locked period)

- Operator tries to record a payment with `payment_date` 90 days
  ago (in a locked period)
- Mutation is rejected with `PERIOD_LOCKED` error message
- No partial write occurred
- Audit log shows the rejected attempt

### E6. Security deposit lifecycle

- Deposit collected → liability balance increases, no income
- Deposit applied to charges → liability decreases, AR
  decreases, no income
- Deposit forfeited → liability decreases, income increases
- Deposit refunded → liability decreases, cash decreases, no
  income

### E7. Late fee duplication

- Late-fee cron runs at 12:00 → fee assessed
- Late-fee cron retries at 12:01 → no second fee
- Late-fee cron runs the next day → no second fee until next
  cycle

### E8. Closed-period correction (reversing entry)

- Period 2026-Q3 locked
- A bug shows October revenue posted to September
- Operator triggers correction
- New reversing entry in current open period cancels the
  September posting
- New corrected entry posts to October
- Total revenue across all periods is unchanged from before the
  correction (mathematical invariant)

### E9. Concession application

- Residential lease with revenue concession → invoice line items
  include the negative concession line
- Commercial lease with operating concession → expense posting
  in same period
- Both paths' tests cover void / reversal

### E10. Concurrent allocation (race)

- Two operators try to allocate from the same payment to
  different invoices simultaneously
- Total allocations must NOT exceed payment amount (DB CHECK)
- Application surfaces a clean error rather than corrupting
  state

### E11. Loan payment split (§16)

- $1,500 mortgage payment cleared
- Amortization schedule expects $1,150 principal / $300
  interest / $40 escrow / $10 fees
- `acc.loan_payments` row stores all 4 components
- `acc.loans.principal_balance` decreases by exactly $1,150
- Journal entry has 4 DR lines (loan_principal, interest_expense,
  loan_escrow_held, finance_charges) summing to $1,500 against
  CR cash $1,500
- Extra principal payment in the same period: separate row,
  type `'extra_principal'`, amortization schedule
  `'modified'` flag set on the affected row

### E12. Duplicate bank import (§17 / §BR4 / §M7)

- Bank CSV imported once → N rows in `acc.bank_transactions`
- Same CSV imported again → still N rows (no duplicates)
- Same transaction from a DIFFERENT source format (e.g. CSV
  then Plaid) also dedupes via the natural key
  `(bank_account_id, posted_date, amount, source_provider_id)`
  OR the content-hash fallback
- A bank transaction matched to an `acc.payments` row, then
  re-imported, does NOT post a duplicate payment

### E13. Owner contribution / distribution (§18 / §OE1)

- Contribution of $50,000 → `equity:owner_contributions`
  increases, `asset:cash_operating` increases, NO income
  posted, NO expense posted
- Distribution of $10,000 → `equity:owner_distributions`
  increases, `asset:cash_operating` decreases, NO income
  posted, NO expense posted
- Per-owner basis updates correctly
- Year-end report shows distributions correctly classified as
  equity, NOT operating expense
- Income statement is unchanged by either event

### E14. Fixed asset disposal preserves history (§19 / §FA5)

- Property with $300K cost / $50K accumulated depreciation
  sold for $400K
- `pm.properties` row remains, `disposed_at` set, NOT deleted
- Original cost row + all depreciation history preserved
- Journal entry: DR cash $400K + DR accumulated_depreciation
  $50K + CR property_book_value $300K + CR gain_on_disposal
  $150K
- Book gain $150K is recorded in income; tax treatment
  (§1250 recapture, §1231) tracked SEPARATELY in
  `acc.tax_depreciation_schedule` and surfaced on Tax
  Center, NOT auto-posted to GL
- Rent roll no longer includes this property
- Reports filtered by date BEFORE disposal still show the
  property correctly

### E15. Concurrent generation must not duplicate (§PC5-§PC8)

The umbrella concurrency test. Run all of the following in
parallel against the same org and assert no duplicates:

- 5 simultaneous calls to `nextNumber()` for invoices →
  5 unique sequential numbers, no race-aborts, no gaps
- 2 simultaneous "Generate rent" clicks for the same period →
  exactly 1 invoice per active lease (idempotent per
  `(lease_id, period)`)
- 2 simultaneous `assess-late-fees` cron runs → exactly 1
  late fee per qualifying invoice (idempotent per
  `(invoice_id, assessment_period)`)
- 2 simultaneous bank-match clicks on the same unmatched
  transaction → first wins, second gets clean
  "already matched" error, no duplicate `acc.bank_transaction_matches` row
- 2 simultaneous allocations against the same payment to
  different invoices → both succeed if total ≤ payment
  amount, otherwise the second gets clean "would exceed
  payment amount" error

## §F. Cross-org leak tests (integration / E2E)

After any mutation, verify a different org cannot see it:

- User A in org X creates an invoice
- User B in org Y queries `/invoices` → sees only org Y's
  invoices, not org X's
- User B queries `/dashboard` aggregates → totals reflect ONLY
  org Y's data
- This protects against cache-key bugs (X-08), RLS-bypass bugs,
  and Drizzle query bugs (forgot org_id filter)

## §G. Audit log presence tests

Every financial mutation should leave a `core.audit_log` row.
Tests assert:

- The row exists for the mutated table
- The actor (user_id) is populated
- The before/after JSON payload includes the changed fields
- The audit row is NOT mutable (UPDATE/DELETE attempts fail)

## §H. Feature-flag gate tests

For each flag in §12 of `FINANCIAL_LOGIC_RULES.md`:

- Flag OFF → mutation is rejected (or no-op'd) with a clear
  message
- Flag ON for a specific org → mutation proceeds for that org
  only
- Flag flip writes to `core.audit_log`

## §I. What's NOT in scope of these tests

- Performance / TTFB / Lighthouse — separate (X-08)
- UI presentation — covered by Playwright smoke + design system
  tests (UX-01)
- Email content / Resend integration — separate test surface
- Production secret rotation — operations runbook, not test
  surface

## §J. v2 test category requirements

The v2 sections (§16-§19 of `FINANCIAL_LOGIC_RULES.md`) introduce
new test surfaces. Coverage required for the corresponding
implementation PRs.

### §J1. Loans and debt servicing (§16)

- 4-component split (principal/interest/escrow/fees) sums to
  total payment
- `acc.loans.principal_balance` math verified to the cent
  across many payments
- Extra principal payment recomputes amortization correctly
- Loan modification creates a new `acc.loans` row with
  `predecessor_loan_id`, original loan untouched
- 1098 reconciliation surface shows lender-reported vs
  recorded interest delta
- Mortgage tracker plan-vs-actual computed on read (no stale
  storage)

### §J2. Bank reconciliation and matching (§17)

- State machine transitions follow §BR1 (no skipping states)
- Match doesn't post journal entry if app record already exists
  (§BR3)
- Re-import is idempotent per §M7 dedupe key
- Reconciliation session immutable after finalization
- Bank fee auto-categorization gated by `ENABLE_PAYMENT_MATCHING`
  - operator-confirmable per match
- Unmatched bank transaction can be written off without
  posting an unmatched journal entry

### §J3. Owner equity / contributions / distributions (§18)

- Contribution and distribution NEVER touch income/expense
  accounts (§OE1)
- Per-owner basis updates correctly
- Owner statement / property statement derived on read
- Year-end close (§OE5) creates one balanced posting that
  zeros `current_year_earnings` to `retained_earnings`

### §J4. Intercompany transfers (§18 / §OE3)

- Two-half posting is atomic — both halves succeed or both
  fail
- Sum of "due from B on A's books" = sum of "due to A on B's
  books" — nightly integrity check
- Reversal of an intercompany transfer reverses BOTH halves
  atomically

### §J5. Depreciation and asset disposition (§19)

- Periodic depreciation idempotent per (asset_id, period)
- Book vs tax depreciation tracked in separate tables, both
  computed correctly
- Capital improvements add to property book value, do NOT
  re-baseline the original schedule
- Asset disposal preserves history (§FA5 / §E14)
- Partial dispositions allocate cost + accumulated
  depreciation proportionally
- Improvement during ownership starts a NEW depreciation
  schedule for that improvement (§FA7)

### §J6. Concurrency / idempotency (§PC1-§PC8)

- Tests in §E15 cover the umbrella concurrency scenarios
- Per-mutation: each new mutation path with idempotency claim
  has a test that runs it twice and asserts no duplicate
  state
- Race-prone aggregates (allocation totals, principal
  balances) tested with 5+ parallel mutations; no
  inconsistency
- Org-wide locks (§PC4) tested: mid-import, a normal
  mutation rejects with the import-in-progress error;
  cleanup releases the lock even on crash

### §J7. Florida commercial rent tax period-awareness (§CN-FL)

- Invoice for FL commercial lease with occupancy in
  pre-Oct-2025 → tax line item posts at the
  rate-window-appropriate rate
- Invoice for FL commercial lease with occupancy in
  Oct-2025-onward → no tax line item posts
- Invoice spanning the boundary (e.g. quarterly invoice for
  Sep-Nov 2025) → splits the rent across rate windows and
  posts the right tax per window
- Operator change of state (property moves states) doesn't
  retroactively change historical tax postings — only
  affects new invoices
- The lookup table is data-driven (per-period rates in
  `core.app_settings` or a dedicated config table); changing
  a future rate doesn't require a code change

### §J8. Write-offs, chargebacks, refunds, and processor fees

#### Write-offs

- Bad-debt write-off posts: DR expense:bad_debt_writeoff /
  CR asset:accounts_receivable
- Original invoice stays queryable with status `'written_off'`
  (or equivalent)
- Tax-side recovery if subsequently collected handled per
  CPA review

#### Chargebacks

- Stripe chargeback: original payment record stays; new
  reversing entry + a chargeback-fee expense entry posts
- The original allocation reverses; the source invoice
  status returns to `'overdue'`

#### Refunds

- Full refund: see Examples §15
- Partial refund: see Examples §18
- Refunds post in the SAME period as the original payment
  ONLY if the period is still open; otherwise post in the
  current open period and surface the date delta in notes

#### Processor fees

- Fee posts at the time the payment record is created (or
  the bank match confirms the fee), as a separate journal
  entry from the payment
- Refunds typically don't refund the fee — surface that on
  the refund record

## Coverage targets (v2 update)

For a PR to merge:

- New money math: 100% line + branch coverage on the touched
  arithmetic
- New journal-entry posting paths: 100% statement coverage on
  the posting function plus all §B assertions
- New mutation paths: at least one test covering each §E1-§E15
  scenario that applies
- Cross-org isolation: at least one test if the mutation
  introduces a new query path
- v2-specific: at least one test from §J1-§J8 for each
  affected category (per the financial-task issue body's
  declared impact)

Tests live under `tests/unit/` and `tests/integration/`. The
integration test runner is gated on `TEST_DATABASE_URL` being set
(see `.env.template`). CI runs unit always; integration runs on
PR + nightly.
