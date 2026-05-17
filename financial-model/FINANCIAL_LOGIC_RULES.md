# Financial logic rules — Kiwi Rentals / PropertyPulse

**Version: 2.0** · **Updated: 2026-05-08**

Authoritative rulebook for any code that touches money. Every
finance-adjacent change must pass these rules; CI / review will not
accept exceptions without an explicit named carve-out from Tony.

> **Source hierarchy.** When two sources conflict, the higher row
> wins. Don't pick a side silently — escalate per
> `.agents/finance-guardian.md` §G-ESC.
>
> 1. Active law / IRS publication / FASB ASC
> 2. `docs/FINANCIAL_COMPLIANCE_NOTES.md` (jurisdiction overlays)
> 3. `docs/FINANCIAL_LOGIC_RULES.md` (this file)
> 4. `docs/FINANCIAL_EXAMPLES.md` (worked examples)
> 5. `docs/FINANCIAL_GL_ACCOUNTS.md` (code mapping)
> 6. `docs/FINANCIAL_TEST_PLAN.md` (test surface)
> 7. `docs/FINANCIAL_REVIEW_CHECKLIST.md` (handoff template)
> 8. `docs/FINANCIAL_MIGRATION_GUIDE.md` (imports only)
> 9. `.agents/finance-guardian.md` (working-memory cheat sheet)
> 10. `CLAUDE.md` "Financial Logic Gate" (pointer hub)

The rules below are derived from US tax authority and accounting
standards, applied to a residential + commercial property
management context. Citations:

- **IRS Publication 527** — _Residential Rental Property_. Defines
  what counts as rental income, when advance rent is taxable,
  treatment of security deposits, and when expenses are deductible.
  https://www.irs.gov/publications/p527
- **IRS Topic No. 414** — _Rental Income and Expenses_.
  https://www.irs.gov/taxtopics/tc414
- **FASB ASC 842** — _Leases_. The lessor accounting model;
  collectibility threshold for sales-type / direct-financing /
  operating leases; modification accounting; straight-line lease
  income recognition for operating leases.
- **AICPA / property-management CPA guidance** for rent
  receivables, deposits held in trust, property-level reporting,
  and audit controls in a multi-property operator context.
- **Double-entry accounting principles** — every transaction has
  equal debits and credits; the accounting equation
  (Assets = Liabilities + Equity) holds at all times.

Where a rule below cites one of the above, the citation is the
**why**. The rule itself is the contract.

---

## §1. Money type

**Rule M1 — Decimal-safe types only.** Every monetary amount is
represented as `numeric(15,2)` in PostgreSQL or `bigint` cents in
Drizzle, and traverses application code via `Money` from
`@/lib/money`. JavaScript `number`, `Number(...)`, `parseFloat`,
or `+` operator on currency strings are forbidden in finance code
paths.

> _Why._ IEEE 754 floats cannot exactly represent values like
> $0.10 — `0.1 + 0.2 !== 0.3`. A penny rounding error compounded
> across 12 monthly invoices produces an audit discrepancy.

**Rule M2 — One source of arithmetic.** All add/subtract/multiply
on money goes through the `Money` class. Reject PRs that compute
totals with raw arithmetic on `string` or `number` representations.

**Rule M3 — Negative amounts are explicit.** Refunds, credits,
adjusting entries with negative impact use a negative `Money`
value, never an "is_credit boolean" sidecar field. The sign is
the truth.

**Rule M4 — Currency is implicit USD for now.** Multi-currency is
not in scope. Any introduction of FX requires its own design issue
(out of scope of FIN-01).

---

## §2. Journal entries — double-entry invariants

**Rule J1 — Debit = credit at row level AND journal level.** Every
`acc.journal_entries` row has matched `total_debits` and
`total_credits`. The DB enforces via trigger (migration 0006); the
application MUST also assert before insert and surface a
human-readable error if violated.

**Rule J2 — No orphan postings.** Every `acc.journal_entries` row
sets `source_schema + source_type + source_id` pointing back to the
operational record (invoice, payment, lease, deposit, etc.) that
caused the posting. If you cannot name the source, the posting is
not authorized.

**Rule J3 — Posting is part of the transaction.** A mutation that
should produce a journal entry MUST post it inside the same DB
transaction. Half-completed financial state (operational record
exists, journal entry doesn't) is the worst possible bug — reject
PRs that "post journal entry as a follow-up step."

**Rule J4 — Idempotency for posted entries.** Re-running a
mutation (e.g. retried Stripe webhook) must NOT create duplicate
journal entries. Use the source `(source_type, source_id)`
uniqueness key, the `core.webhook_events` dedup, or both.

**Rule J5 — GL accounts must exist before posting.** Reference
`acc.chart_of_accounts` rows by code (not by name string). If the
needed account doesn't exist, fail loudly — don't auto-create.

---

## §3. Closed accounting periods

**Rule C1 — Closed periods are immutable.** If
`acc.accounting_periods.is_locked = true` for the period covering
the entry date, no UPDATE or DELETE may touch journal entries,
payments, invoices, or any record posting into that period.

**Rule C2 — Corrections via reversing entries only.** A correction
discovered after period close goes into the next OPEN period as a
**reversing journal entry** that cancels the original, plus a
fresh entry with the correct values. The original posting stays
untouched as audit history.

**Rule C3 — Backdating into closed periods is a hard error.** A
mutation whose effective date falls in a locked period must be
rejected at the application layer with a clear error pointing at
the lock. Never silently re-date to "today."

> _Why._ Closed periods feed tax filings, lender reports, and
> investor distributions. Mutating them post-close changes
> documents that have already been signed and shipped.

---

## §4. Soft delete only on financial records

**Rule D1 — No hard DELETE on `acc.*` or `pm.*` financial
records.** Invoices, payments, journal entries, allocations,
loan payments, security deposit records, bank transactions: all
preserve history. Use `void` status, `deleted_at` timestamp, or
reversing entries.

**Rule D2 — Void is terminal and visible.** A `void` invoice stays
in the table, in reports filtered by status, and in the audit log.
Reports default to excluding void rows but must let the operator
opt them in.

**Rule D3 — Service-role cannot bypass.** RLS policies on
financial tables forbid DELETE even from `SUPABASE_SERVICE_ROLE_KEY`.
If you find a code path that uses the service-role to delete a
financial record, that is a P0 bug.

---

## §5. Security deposits

**Rule SD1 — Held = liability, not income.** When collected, a
security deposit posts:

```
DR  asset:cash_security_deposits
CR  liability:security_deposits_held
```

Until forfeited or applied, it stays on the balance sheet as a
liability. It does NOT hit the income statement.

**Rule SD2 — Application to charges is a transfer.** When a
deposit is applied to an unpaid invoice:

```
DR  liability:security_deposits_held
CR  acc.invoices.balance_due (via payment + allocation)
```

Recorded in `acc.security_deposit_applications` linking the deposit
to the application target. No revenue movement.

**Rule SD3 — Forfeiture is the income event.** Only when the
operator legally forfeits a deposit (per state law + lease terms)
does it convert to income:

```
DR  liability:security_deposits_held
CR  income:forfeited_deposits
```

Recorded in `acc.security_deposit_forfeitures` with reason +
governing lease + state-law citation in `notes`.

**Rule SD4 — Trust-account separation where required.** Some US
states (e.g. NJ, MA, NY) require deposits held in segregated
trust accounts. The application must support a flag
`core.bank_accounts.is_trust_account` (default `false` —
commingled until proven otherwise; the operator opts in per
account). Per-state requirements live in
`docs/FINANCIAL_COMPLIANCE_NOTES.md` §CN-DEPOSITS. Code that
holds deposits in a non-trust account when state law requires
trust must surface a clear error to the operator, not silently
proceed.

**Rule SD5 — Distinguish deposit categories.** A "deposit" in
common speech may be any of FIVE distinct things, each with its
own GL treatment:

| Category                                                                 | GL on collection                                         | Income event?                                                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Refundable security deposit** (the default)                            | DR cash_security_deposits / CR security_deposits_held    | Only on forfeiture (§SD3)                                                                              |
| **Final-month-rent deposit**                                             | DR cash_operating / CR unearned_rent                     | At the start of the final month (becomes recognized rental revenue, §AR2)                              |
| **Forfeited deposit**                                                    | (state of an originally-refundable one after §SD3 fires) | DR security_deposits_held / CR forfeited_deposits                                                      |
| **Damage / repair retention** (post-move-out, pending repair completion) | DR security_deposits_held / CR liability:repair_holdback | Becomes either repair-expense offset (when work is done and tenant absorbs cost) or refunded to tenant |
| **Refund of deposit (whole or partial)**                                 | DR security_deposits_held / CR cash_security_deposits    | NOT an income event — straight cash-out                                                                |

Each category has its own row schema in `pm.security_deposits`
and its own lifecycle. Reclassification between categories
(e.g. tenant asks "apply my security deposit to last month's
rent") = explicit operator decision + audit log entry, NOT a
silent re-tagging.

> _Why._ IRS Pub 527 and most state landlord-tenant statutes
> treat security deposits as held in trust until earned.
> Misclassifying them as income is the most common audit finding
> in residential property management.

---

## §6. Advance rent vs earned rent

> **Important — separate IRS tax treatment from book / accrual
> treatment.** "Advance rent" has TWO meanings depending on the
> question:
>
> - **Tax (IRS Pub 527).** Advance rent is included in income
>   in the year received, regardless of accounting method,
>   regardless of the period covered. This is a tax-return
>   reporting rule.
> - **Book (this codebase, accrual default).** Advance rent
>   sits as a liability (`liability:unearned_rent`) until the
>   period covered, at which point it's recognized as
>   `income:rental_revenue`.
>
> The book-vs-tax difference is reconciled at year-end on
> Schedule E (or the entity's tax return) by the operator's CPA.
> The implementation tracks the book ledger here and surfaces
> the tax-difference data on the Tax Center page.
>
> Rule AR1 below is the BOOK rule. The tax treatment is
> documented for awareness but is reported separately, not
> posted directly to the GL.

**Rule AR1 — Default book treatment is accrual.** When the
tenant prepays for a future period:

```
DR  asset:cash
CR  liability:unearned_rent
```

At month-end of the period earned:

```
DR  liability:unearned_rent
CR  income:rental_revenue
```

Tracked in `acc.unearned_revenue_schedule` (table to be added in
the implementation issue, NOT this rules doc).

**Rule AR2 — IRS treats advance rent as income at receipt.** Per
IRS Pub 527: "Advance rent is any amount you receive before the
period that it covers. Include advance rent in your rental
income in the year you receive it regardless of the period
covered or the method of accounting you use." The Tax Center
page must surface the BOOK-vs-TAX delta so the operator's CPA
can include the IRS adjustment on Schedule E. The GL itself
does NOT post the tax view; only the book view per §AR1.

**Rule AR3 — Cash-basis carve-out per legal entity.** Some LLCs
elect cash-basis accounting (separate from the IRS rule above).
`core.legal_entities.accounting_basis` flag
(`'cash' | 'accrual'`) drives which posting pattern applies for
that entity's BOOK ledger. Default `'accrual'`.

**Rule AR3a — `accounting_basis` is immutable per legal entity.**
Once set on a legal entity, the field cannot be changed without
a structured re-classification process: full re-statement of
prior-period entries from cash → accrual or vice-versa, CPA
sign-off, and a §M11-style batch reversal of all prior
postings under the old basis followed by a re-import under the
new basis. Silent flip is forbidden.

**Rule AR4 — First-month/last-month-rent.** Treat first-month rent
as earned in month 1 (normal posting). Treat last-month-rent
deposit as **a separate prepayment** under §AR1, NOT as a
security deposit under §5 — different legal treatment, different
balance-sheet category. See §SD5 for the deposit-category
distinction.

**Rule AR5 — ASC 842 straight-line is CPA-approved policy, not
universal default.** Straight-line lease income recognition for
operating leases (per ASC 842) applies to commercial leases
where the entity has elected GAAP / ASC 842 reporting. NOT
every Crestview entity is automatically on ASC 842. Whether
straight-line applies to a given lease is determined by:

1. Lease class (`pm.leases.kind = 'commercial'`)
2. Entity's reporting framework
   (`core.legal_entities.reporting_framework` flag — value
   `'asc_842'` enables straight-line; `'tax_basis'` or
   `'cash_basis'` does not). The column needs to be added by
   a future schema issue (not in scope of FIN-01).
3. CPA approval recorded in
   `core.legal_entities.cpa_policy_notes`.

If `kind = 'commercial'` but no ASC 842 election exists,
default to as-billed (§CN3) and surface a warning that the
entity should confirm its reporting framework with its CPA.

---

## §7. Late fees

**Rule LF1 — Late fees are line items on the existing invoice.**
Never create a second invoice. The existing overdue invoice gets
a new `acc.invoice_line_items` row with `kind = 'late_fee'`.

**Rule LF2 — One assessment per invoice per cycle.** The late-fee
cron must use a dedupe key like
`(invoice_id, assessment_period_start)` to prevent double-charging
on a retry.

**Rule LF3 — Late fee posting hits a separate revenue account.**

```
DR  acc.invoices.balance_due (via line item)
CR  income:late_fee_revenue
```

Separated for audit and tax reporting clarity (some states cap
late-fee income).

**Rule LF4 — Lease terms govern eligibility.** Don't assess a late
fee unless the lease's `pm.leases.late_fee_amount` and
`pm.leases.grace_period_days` permit. Lease overrides any global
default.

**Rule LF5 — Reversal of erroneously assessed late fees.** Use a
negative line item (Rule M3) on the same invoice + `notes`
explaining. Never modify the original line item.

---

## §8. Concessions

**Rule CN1 — Classify upfront.** A concession is either:

- **Revenue concession** — a rent reduction (e.g. "$200 off month
  1"). Posted as a negative line item on the rent invoice or as
  a reduction of monthly_rent in the lease, depending on type.
- **Operating expense concession** — a cash incentive (e.g. "$500
  signing bonus paid out"). Posted as an expense, not a revenue
  reduction.

The classification is recorded in `pm.concessions.kind` and is
**immutable after first posting**. Reclassification = void +
new record.

**Rule CN2 — Straight-line lease income recognition (ASC 842).**
For commercial leases, total contract value (rent − concessions

- escalations) is divided across the term and recognized linearly.
  A free month doesn't show as zero income that month — it's
  spread across all months. Tracked via
  `acc.straight_line_lease_revenue_schedule`.

**Rule CN3 — Residential leases default to as-billed
recognition.** Residential operators typically don't apply ASC 842
straight-line to short-term leases. Drive via
`pm.leases.kind`: `'residential'` → as-billed, `'commercial'` →
straight-line.

**Rule CN4 — Concessions must be tested.** Any code path adding,
modifying, or applying a concession requires test coverage of:

- Both `kind` paths (revenue vs operating)
- Both lease classes (residential vs commercial)
- Reversal / void behavior

---

## §9. Overpayments

**Rule OP1 — Overpayments are unapplied cash, never income.** When
a payment exceeds the allocated invoices, the excess sits in
`acc.payments.unapplied_amount` and posts:

```
DR  asset:cash
CR  liability:unapplied_customer_credit
```

It does NOT hit revenue. Showing an overpayment as income is
revenue-recognition fraud.

**Rule OP2 — Apply to next invoice as customer credit.** When the
next invoice for the same tenant lands, the operator (or auto-apply
logic) creates an allocation from the unapplied payment to the
new invoice. Posting:

```
DR  liability:unapplied_customer_credit
CR  acc.invoices.balance_due (via allocation)
```

**Rule OP3 — Refund is the cash-out path.** Refunding an unapplied
overpayment back to the tenant:

```
DR  liability:unapplied_customer_credit
CR  asset:cash
```

Tracked in `acc.payment_refunds`.

---

## §10. Partial payments

**Rule PP1 — Allocations sum to ≤ payment amount.** A payment may
allocate to multiple invoices, but
`SUM(acc.payment_allocations.amount) ≤ acc.payments.amount`. The
DB has a CHECK; the application must pre-validate to give a
human-readable error.

**Rule PP2 — Invoice status reflects balance.** After allocation:

- `balance_due > 0` AND `balance_due < total_amount` → status =
  `'partial'`
- `balance_due == 0` → status = `'paid'`
- `balance_due == total_amount` AND `due_date < today` → status =
  `'overdue'`
- (etc per the state machine)

**Rule PP3 — Status changes are atomic with allocation.** Update
status in the same transaction as the allocation insert. Never
trust a follow-up "compute status" cron — race condition during
multi-payment days.

**Rule PP4 — Refunding a partial payment reverses the allocation
first.** Don't directly modify `balance_due` — go through the
allocation table.

---

## §11. Invoice numbering

**Rule IN1 — Numbers are atomic.** Source of truth is
`core.doc_counters` via `lib/billing/numbering.ts::nextNumber()`,
which uses an UPSERT-RETURNING pattern (race-safe).

**Rule IN2 — Never compute client-side.** Client cannot see other
orgs' counters; computing `MAX(invoice_number) + 1` races and may
show duplicates. Always call the helper.

**Rule IN3 — Numbers are immutable after assignment.** Even if the
invoice is voided, its number stays. Don't reuse numbers.

**Rule IN4 — Format is `INV-YYYY-NNNNN` per org per fiscal year.**
Configurable per org in `core.app_settings.key =
'billing.invoice_number_format'`. Default lives in code.

---

## §12. Feature flags — ALL financial automation defaults OFF

Every financial automation ships **disabled by default**, gated by
either an env var OR a `core.app_settings` row. Operator must
explicitly opt in per org.

The current canonical flags:

| Flag                               | Default   | Where stored                                     | Enables                                                   |
| ---------------------------------- | --------- | ------------------------------------------------ | --------------------------------------------------------- |
| `ENABLE_AUTO_INVOICE_CRON`         | `false`   | env (cron handler)                               | Monthly recurring rent invoice generation                 |
| `ENABLE_LATE_FEES`                 | `false`   | env (cron handler) + per-org `core.app_settings` | Late-fee assessment cron                                  |
| `ENABLE_BANK_IMPORT`               | `false`   | env                                              | Bank-feed sync from Plaid / Stripe Financial Connections  |
| `ENABLE_PAYMENT_MATCHING`          | `false`   | per-org `core.app_settings`                      | Auto-match bank transactions to invoices                  |
| `ENABLE_GL_POSTING`                | `true` ⚠️ | always-on (the entire accounting layer)          | Posts journal entries from operational mutations          |
| `ENABLE_TENANT_BALANCE_AUTOCALC`   | `false`   | per-org `core.app_settings`                      | Materialized tenant ledger view refresh                   |
| `ENABLE_VENDOR_INVOICE_AUTOMATION` | `false`   | per-org `core.app_settings`                      | Auto-create AP invoice from vendor maintenance work order |

⚠️ `ENABLE_GL_POSTING` is intentionally always-on because the
accounting layer cannot be partially-posted without breaking
debit=credit. **Production financial mutations may NEVER bypass
GL posting**, regardless of any other flag, regardless of org
setting, regardless of who's calling. The only legitimate way to
suppress GL is a Tony-approved data migration with a documented
opening-balance import path per `FINANCIAL_MIGRATION_GUIDE.md`,
and even then GL is restored before the operator can mutate
data through the normal app paths.

**Rule FF1 — New financial behavior MUST add a flag.** No
exceptions. Default OFF.

**Rule FF2 — Flag check is at the edge.** Cron handlers, server
actions, and webhook handlers check the flag at the entry point,
not deep inside business logic. A flipped flag should disable the
feature without leaving partial state.

**Rule FF3 — Flag flips are audit events.** Changing
`core.app_settings` for any of the above writes to
`core.audit_log` automatically (existing audit trigger covers
this; verify before relying).

---

## §13. Sandbox-only restriction

**Rule SB1 — Test mode for all third-party integrations until
Tony approves.** Stripe test keys, Resend with unverified domain,
Supabase staging project. Live cutover for each is gated by a
named blocker in `BLOCKERS.md` (B-01..B-05).

**Rule SB2 — Never construct a live key in code.** No
`if (env.NODE_ENV === 'production') return liveKey`. Keys come
from env vars Tony populates in Vercel; if `STRIPE_SECRET_KEY`
starts with `sk_test_`, you're in test mode and that's correct.

**Rule SB3 — No automated emails to real customer addresses
without verified Resend domain.** Until B-04 lifts, the dispatcher
either no-ops or routes to a sandbox inbox. Hardcoding a "real"
address in tests or fixtures is forbidden.

---

## §14. Financial PR handoff requirement

**Rule HF1 — Every PR touching finance code must include a
Financial Handoff comment** on the issue when moving to `Review`.
Template lives in `docs/FINANCIAL_REVIEW_CHECKLIST.md`.

The comment must answer the 9 pre-implementation questions and
prove the 6 post-implementation invariants from the FIN-01 issue
spec (see also `.github/ISSUE_TEMPLATE/financial-task.md` for the
authoring side).

**Rule HF2 — A finance PR cannot move to `Review` if the handoff
comment is missing or incomplete.** CLAUDE.md "Financial Logic
Gate" section encodes this. Reviewers reject silently-missing
handoffs.

---

## §15. What "financial code" means (scope of these rules)

A change is **financial** if it touches any of:

- `acc.*` schema
- `pm.invoices`, `pm.payments`, `pm.security_deposits`,
  `pm.recurring_charges`, `pm.lease_tenants`, anything with
  `monthly_rent`, anything with `balance_due`
- `lib/billing/`, `lib/banking/`, `lib/money/`
- `app/(app)/{invoices,payments,banking,loans,mortgages,tax-center}/`
  server-side code (page renders OK; server actions, API routes,
  cron handlers — all in scope)
- `app/api/cron/{mark-overdue,generate-recurring-invoices,
assess-late-fees,renewal-reminders,expire-leases}/`
- `app/api/webhooks/stripe/`
- Email templates that quote balances or invoice numbers
- PDF rent-roll / invoice exports
- Reports under `app/(app)/reports/{cash-flow,ar-aging,rent-roll}/`
- Tax Center calculations

A change is **NOT financial** if it only touches:

- Pure UI presentation (typography, spacing, colors)
- Non-financial CRUD (vendors that aren't payees, contacts that
  aren't tenants/landlords, properties' physical attributes)
- Documentation, build config, CI workflows, lint config
- Test infrastructure that doesn't assert on money values

When in doubt, treat as financial and run the gate. Cost of a
false positive (extra checklist) is low; cost of a false negative
(unhandled money bug) is high.

---

## §16. Loans, Mortgages & Debt Servicing

**Rule LN1 — Loan payments split into 4 components.** Every
`acc.loan_payments` row carries:

- `principal_amount` — reduces `acc.loans.principal_balance`
- `interest_amount` — expense
- `escrow_amount` — held by lender for tax/insurance
- `fees_amount` — late fees / processing fees / NSF fees

Sum of the four equals the total payment amount. The DB CHECK
enforces this; the application must also pre-validate.

**Rule LN2 — Posting pattern.** Standard P&I payment:

```
DR  liability:loan_principal     <principal_amount>
DR  expense:interest_expense     <interest_amount>
DR  liability:loan_escrow_held   <escrow_amount>
DR  expense:finance_charges      <fees_amount>
CR  asset:cash_operating         <total>
```

(Escrow is a DR to a liability because the liability decreases
when we hand cash to the lender to hold; from our books'
perspective the cash moves from our cash account to the
lender's escrow account that we still own — modeled as a
liability decrease for simplicity. CPA review for whether to
model escrow as an asset on our books instead.)

**Rule LN3 — Amortization schedule is the source of truth.** The
expected split per payment is computed from
`acc.loan_amortization_schedule`. If the actual payment differs
(e.g. extra principal payment), record the actual split and
mark the schedule row as `'modified'`; don't silently overwrite
the expected schedule.

**Rule LN4 — Extra principal payments are explicit.** When the
operator pays extra principal:

- Capture the extra as a separate `acc.loan_payments` row with
  type `'extra_principal'`
- Recompute the remaining amortization schedule (fewer
  payments OR same number with reduced final-payment amount,
  per loan terms)
- Record the recomputation source in `acc.loan_payments.notes`

**Rule LN5 — Loan modifications are events, not edits.** Rate
change, term extension, refinance — all create a NEW
`acc.loans` row with `predecessor_loan_id` pointing at the old
one. Old loan keeps its history; new loan starts a fresh
amortization. Don't mutate the original loan's principal_rate
or term.

**Rule LN6 — Lender-issued 1098.** Annually, reconcile the
lender's 1098 (mortgage interest reported) against the sum of
`acc.loan_payments.interest_amount` for the year. Surface the
delta on the Tax Center page. Do NOT auto-adjust to match
the 1098 — surface the discrepancy to the operator.

**Rule LN7 — Mortgage tracker plan-vs-actual.** The mortgage
tracker UI computes deltas between scheduled and actual
payments. The delta is a derived view, never stored — recompute
on read.

---

## §17. Bank Reconciliation & Transaction Matching

**Rule BR1 — Bank transactions have their own state machine.**
`acc.bank_transactions.status` values:

- `'unmatched'` — imported but not yet matched to any
  application record
- `'matched'` — linked to a `acc.payments` (or expense, or loan
  payment) via `acc.bank_transaction_matches`
- `'disputed'` — operator has flagged the transaction as wrong
  (wrong amount, double-charged, fraudulent)
- `'written_off'` — accepted but no application record (e.g.
  bank fee, interest income on operating account)
- `'voided'` — bank reversed it (NSF, ACH return)

Status transitions are auditable; never mutate without a
state-transition log entry.

**Rule BR2 — Matching is a separate operational record.** Each
match goes into `acc.bank_transaction_matches` linking the
transaction to the operational record (payment, expense, loan
payment). Many-to-many: one bank deposit can match multiple
invoice payments (per Examples §16); one rent invoice
collection might be split across two bank deposits.

**Rule BR3 — Match doesn't move money — it labels it.** No
journal entry is posted at match time IF the application
record was already posted (e.g. the Stripe payment was
recorded when Stripe webhook fired; the bank transaction
match just confirms it cleared). Only post a journal entry if
the match REVEALS an unrecorded movement (e.g. a manual ACH
the operator forgot to enter).

**Rule BR4 — Idempotent re-import.** The same bank transaction
imported twice must NOT create two `acc.bank_transactions`
rows. Dedupe key per the rules in
`FINANCIAL_MIGRATION_GUIDE.md` §M7.

**Rule BR5 — Disputed transactions don't auto-reverse.** Marking
a transaction `'disputed'` is a flag for human attention; it
does NOT post a reversing entry. A separate reconciliation step
posts the reversal once the dispute resolves.

**Rule BR6 — Reconciliation sessions are immutable after
finalization.** `acc.bank_reconciliation_sessions.is_finalized
= true` locks the session. Re-opening requires a new session
and explicit operator action (audit logged).

**Rule BR7 — Bank fees + interest income post automatically.**
When a bank transaction with no match is identified as a fee
(by description heuristic or operator tag), post:

```
DR  expense:processor_fees       <amount>
CR  asset:cash_operating         <amount>
```

For bank-credited interest:

```
DR  asset:cash_operating         <amount>
CR  income:other_property_revenue <amount>  (or income:interest_income)
```

Heuristic-driven auto-categorization must be feature-flagged
(`ENABLE_PAYMENT_MATCHING`) and operator-confirmable per
match.

---

## §18. Owner Distributions, Contributions & Intercompany

**Rule OE1 — Owner contributions and distributions are equity
events, NEVER income or expense.**

Contribution (owner puts cash into the entity):

```
DR  asset:cash_operating         <amount>
CR  equity:owner_contributions   <amount>
```

Distribution (entity pays cash to owner):

```
DR  equity:owner_distributions   <amount>
CR  asset:cash_operating         <amount>
```

Recorded in `acc.owner_contributions` / `acc.owner_distributions`
with the receiving / paying owner contact, the date, and the
basis-tracking notes.

**Rule OE2 — Per-owner basis tracking.** For partnerships and
multi-member LLCs, each owner has a separate capital account
balance. The implementation tracks per-owner basis via
`pm.entity_ownerships.ownership_pct` (or explicit
`acc.partner_capital_balances` table — schema decision belongs
to the implementation issue).

**Rule OE3 — Intercompany transfers are paired entries.** When
entity A sends cash to entity B (e.g. parent funds a subsidiary):

Entity A side:

```
DR  equity:intercompany_due_from_<entity_B_id>   <amount>
CR  asset:cash_operating                         <amount>
```

Entity B side:

```
DR  asset:cash_operating                         <amount>
CR  equity:intercompany_due_to_<entity_A_id>     <amount>
```

Recorded in `acc.intercompany_transfers` with both
entity_id_from and entity_id_to. The two halves are posted as
ONE atomic operation (single DB transaction); never half-state.

**Rule OE4 — Intercompany balances reconcile.** At any point,
sum of "due from B on A's books" must equal sum of "due to A
on B's books." Implement an integrity check that runs nightly
and flags any imbalance.

**Rule OE5 — Year-end equity close.** At fiscal year-end,
`equity:current_year_earnings` closes into
`equity:retained_earnings`. The close is a single posting
with `source_type = 'fiscal_year_close'`, dated 12/31 (or per
fiscal calendar). Closed-period rules (§C1) apply once the
close lands.

**Rule OE6 — Owner statement / property statement.** Per-owner
and per-property reports are derived views — never stored
balances. Compute on read from journal_entries filtered by
the relevant dimension. Tax Center and Mortgage Tracker
already follow this pattern.

---

## §19. Fixed Assets, Depreciation & Dispositions

**Rule FA1 — Property book value lives in `pm.properties`.**
Acquisition cost, improvements, and depreciation history are
tracked. Book value at any date = original cost +
capitalized improvements − accumulated depreciation through
that date.

**Rule FA2 — Depreciation is periodic and reversible.** Monthly
or yearly depreciation posting:

```
DR  expense:depreciation                  <period_amount>
CR  asset:accumulated_depreciation        <period_amount>
```

`acc.depreciation_schedule` table holds the per-period plan.
Re-running the schedule is idempotent (uses period as dedupe
key).

**Rule FA3 — Book vs tax depreciation diverge.** GAAP / book
uses the operator's elected method (often straight-line).
IRS uses MACRS (per `FINANCIAL_COMPLIANCE_NOTES.md`
§CN-DEPRECIATION-MACRS). The implementation tracks BOTH:

- Book depreciation posts to GL via §FA2.
- Tax depreciation lives in
  `acc.tax_depreciation_schedule` (separate table) and feeds
  the Tax Center / Schedule E preview.
- Year-end book/tax delta surfaces as a reconciling adjustment
  on the tax return.

**Rule FA4 — Improvements capitalize, repairs expense.**
Capital improvements increase property book value (DR property
asset / CR cash); operating repairs expense (DR repairs_expense
/ CR cash). The threshold is policy-driven — typically the de
minimis safe harbor ($2,500 per item) under IRS §1.263(a)-1,
but operators can elect a different threshold.

The implementation surfaces a "capitalize or expense?" prompt
when a new expense exceeds the threshold; doesn't auto-decide.

**Rule FA5 — Asset disposal preserves history + separates book
gain/loss from tax treatment.** When a property is sold:

1. Compute book gain/loss = sale_proceeds − net_book_value.
2. Reverse accumulated depreciation:
   ```
   DR  asset:accumulated_depreciation  <full accumulated>
   CR  asset:property_book_value       <original cost>
   ```
3. Record cash receipt:
   ```
   DR  asset:cash_operating            <sale_proceeds>
   ```
4. Plug the difference to gain or loss:
   ```
   CR  income:gain_on_disposal         <amount>  (if gain)
   ```
   OR
   ```
   DR  expense:loss_on_disposal        <amount>  (if loss)
   ```
5. The original `pm.properties` row keeps its history; mark
   `disposed_at` instead of deleting.
6. Tax treatment of gain/loss (§1231, §1250 recapture) is
   computed separately for the tax return and surfaces on
   Tax Center. Book gain ≠ tax gain in most cases.

**Rule FA6 — Partial dispositions.** Removing a roof, a single
unit, etc. follows the same pattern as a full disposition,
proportionally applied. The implementation must compute the
allocated original cost + accumulated depreciation for the
disposed component.

**Rule FA7 — Improvements during ownership trigger schedule
update.** Adding a capital improvement extends or restarts the
depreciation schedule per IRS rules (typically a separate
depreciation schedule for each improvement, not a re-baseline
of the original).

---

## Integration with the existing PropertyPulse schema

These v2 rules slot into the existing schema:

| Rule | Existing schema                                                                    | Notes                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| §16  | `acc.loans`, `acc.loan_payments`, `acc.loan_amortization_schedule`                 | Already exists. May need columns for `escrow_amount`, `fees_amount`, `type` enum on `loan_payments`.                               |
| §17  | `acc.bank_accounts`, `acc.bank_transactions`, `acc.bank_reconciliation_sessions`   | Tables exist but `status` enum + `acc.bank_transaction_matches` table need expansion.                                              |
| §18  | `acc.owner_contributions`, `acc.owner_distributions`, `acc.intercompany_transfers` | Tables exist; per-owner basis tracking may need a new `acc.partner_capital_balances` table.                                        |
| §19  | `pm.properties` (cost + book value), `acc.depreciation_schedule` (proposed)        | Depreciation schedule + book/tax dual-tracking + disposal flow are NEW; require schema additions in a future implementation issue. |

Implementation issues that pick up §16-§19 must list every
schema addition / column change in their issue body's "Data
model impact" section per the financial-task template. Schema
changes go through a separate migration PR — never in the same
PR as the financial-feature implementation.

---

## Performance & Concurrency

**Rule PC1 — Atomic mutations only.** Every financial mutation
runs in a single DB transaction. No multi-step "first insert
the operational record, then post the journal entry" patterns.

**Rule PC2 — Idempotency keys are required.** Every cron
handler, webhook handler, and bulk operation must have an
idempotency key. Dedupe at the application layer (table
constraint OR pre-check), not "rely on retry behavior."

**Rule PC3 — Race-prone aggregates use SELECT FOR UPDATE.**
Computing `nextNumber()` (§IN1), allocating against an
already-partially-allocated payment, updating
`acc.loans.principal_balance` after a loan payment — all
require `SELECT ... FOR UPDATE` to serialize concurrent
mutations.

**Rule PC4 — Long-running operations (imports, year-end
close) acquire an org-wide lock.** Per
`FINANCIAL_MIGRATION_GUIDE.md` §M12 and §OE5 — set a
`core.app_settings` flag; mutations check at entry; release
in `finally`. Never leave a stale lock.

**Rule PC5 — Concurrent invoice generation must not collide.**
The monthly recurring-invoice cron and a manual "Generate
rent" button click could race on the 1st of the month. Both
paths use the same `nextNumber()` helper, but also share an
idempotency key per `(lease_id, period)` so the second
attempt no-ops.

**Rule PC6 — Concurrent late-fee assessment must not
duplicate.** Hourly cron retries within a single grace-period
window. Dedupe per `(invoice_id, assessment_period_start)`.

**Rule PC7 — Concurrent bank-match application must not
double-count.** Two operators viewing the same unmatched
transaction could both click "Match to invoice X." The match
table has UNIQUE on `(bank_transaction_id, target_id,
target_type)` and the second click gets a clean
"already matched" error.

**Rule PC8 — Performance budget.** Financial mutations are
write-heavy and atomic. They should NOT cache aggressively
(per §X-08 of TASKS.md, the data-cache layer never caches
write paths). Read paths (reports, dashboards) MAY cache via
the `cachedByOrg` helper proposed in #28.

---

## Self-Improvement Hooks

Mechanically, today, the agent improves the rulebook only via
the protocol in `.agents/finance-guardian.md` §G-SI:

- Typos / clarifications: OK in any PR
- New worked examples for existing rules: OK in any PR
- New rule changes (semantics, defaults, hard rules): require a
  separate `[FIN-NN] Rule change: <topic>` PR, never bundled
  with feature implementation

Future automation (NOT built today) is documented in the
`.agents/finance-guardian.md` §G-SHIP section. Tony's call
when / if to build:

- Automated invariant checker in CI
- Nightly self-improvement agent
- Inngest workflow for multi-step financial flows
- Production financial monitoring dashboards

---

## Versioning + changelog

Versions are SemVer-ish for documentation:

- **MAJOR** bump (v2 → v3): a hard rule changes meaning, or
  the source-hierarchy is reordered, or a forbidden action is
  added/removed.
- **MINOR** bump (v2.0 → v2.1): a new section is added that
  doesn't conflict with prior rules, OR a new rule with a
  letter suffix (e.g. §AR3a) is appended.
- **PATCH** bump (v2.0.0 → v2.0.1): a typo / clarification
  that doesn't change meaning.

### Changelog

#### v2.0 (2026-05-08)

- **Source hierarchy** added at the top — explicit ranking when
  two docs conflict.
- **§5 / §SD5 added** — distinguishing 5 deposit categories
  (refundable, final-month-rent, forfeited, repair retention,
  refund). Replaces the implicit "all deposits look the same"
  assumption from v1.
- **§5 / §SD4 clarified** — `is_trust_account` defaults
  `false`; per-state requirements live in compliance notes.
- **§6 restructured** — explicit separation of IRS tax
  treatment (income at receipt) vs book treatment (unearned
  liability until earned). New §AR2 covers IRS view; new
  §AR3a makes `accounting_basis` immutable per entity.
- **§AR5 added** — ASC 842 straight-line is CPA-approved
  policy gated by `core.legal_entities.reporting_framework`,
  not universal default.
- **§12 / `ENABLE_GL_POSTING` clarified** — production
  financial mutations may NEVER bypass GL posting.
- **§16 added** — Loans, Mortgages & Debt Servicing (7 rules
  covering principal/interest/escrow/fees split, amortization
  schedule, extra principal, modifications, 1098
  reconciliation, mortgage tracker).
- **§17 added** — Bank Reconciliation & Transaction Matching
  (7 rules covering state machine, match-as-label semantics,
  idempotent re-import, disputed-doesn't-auto-reverse,
  reconciliation session immutability, fee/interest auto-post).
- **§18 added** — Owner Distributions, Contributions &
  Intercompany (6 rules covering equity-not-income posting,
  per-owner basis, paired intercompany entries, balance
  reconciliation, year-end close, derived owner statements).
- **§19 added** — Fixed Assets, Depreciation & Dispositions
  (7 rules covering book value tracking, periodic depreciation,
  book/tax divergence, capitalize-vs-expense, disposal
  pattern, partial dispositions, improvement schedule).
- **Integration with PropertyPulse Schema section added** —
  per-rule mapping to existing tables + identification of
  schema additions needed for §16-§19.
- **Performance & Concurrency section added** — 8 rules on
  atomic mutations, idempotency keys, FOR UPDATE on race-prone
  aggregates, org-wide locks for long ops, dedupe for crons +
  bank matching.
- **Self-Improvement Hooks section added** — references
  `.agents/finance-guardian.md` §G-SI protocol.
- **Versioning + changelog section added** (this section).

#### v1.0 (2026-05-08, earlier in same day — superseded)

- Initial 15 sections covering money type, journal-entry
  invariants, closed-period immutability, soft-delete,
  security deposits (basic), advance rent (basic), late fees,
  concessions, overpayments, partial payments, invoice
  numbering, feature flags, sandbox-only, scope.
- Cited IRS Pub 527, IRS Topic 414, FASB ASC 842, AICPA
  guidance, double-entry principles.

---

## How to extend these rules

If a real situation surfaces that the rules don't cover:

1. Open a GitHub issue with the `[FIN-NN]` prefix describing the
   gap.
2. Cite the authoritative source (IRS / FASB / state law / CPA
   guidance).
3. Propose the rule wording.
4. Tony reviews, approves, this doc gets a new section.
5. Bump the version per the rules above.
6. Add a changelog entry.

Don't apply unwritten rules silently — every rule above is
contract, every contract has a paper trail.
