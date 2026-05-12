# Financial examples — debit/credit reference

Concrete journal-entry examples for the most common posting paths
in Kiwi Rentals. Cross-references back to the rules in
`FINANCIAL_LOGIC_RULES.md`.

GL account codes used below are placeholders — the real codes
come from `acc.chart_of_accounts` (seeded by migration 0008). Use
codes from the seed data, not these literal strings, in code.

Every example uses **accrual basis** unless noted otherwise (per
§6.AR3). Cash basis is the same shape but the timing differs.

---

## 1. New monthly rent invoice (bill the tenant)

**Scenario.** Lease for unit 101A, $2,000/mo, monthly cron creates
the November invoice on the 1st.

**Operational record.** Insert into `acc.invoices` + one
`acc.invoice_line_items` row.

**Journal entry (per §J).**

```
DR  asset:accounts_receivable           2,000.00
CR  income:rental_revenue                            2,000.00
```

**Source linkage.**

```
source_schema = 'acc'
source_type   = 'invoice'
source_id     = <new invoice's id>
```

**Notes.**

- Posted at `issue_date`, not `due_date`.
- For commercial leases on straight-line recognition (§CN2), the
  CR side splits between `income:rental_revenue` (the straight-
  line monthly amount) and `liability:deferred_rent_credit` or
  `asset:deferred_rent_receivable` for the difference.

---

## 2. Tenant pays in full

**Scenario.** Tenant pays the full $2,000 of the invoice above
via Stripe.

**Operational records.**

- Insert into `acc.payments` (amount $2,000)
- Insert into `acc.payment_allocations` (one row, $2,000 to that
  invoice)
- Update `acc.invoices.balance_due` from $2,000 to $0
- Update `acc.invoices.status` from `'sent'` to `'paid'`

**Journal entry.**

```
DR  asset:cash_operating                2,000.00
CR  asset:accounts_receivable                        2,000.00
```

**Idempotency (§J4).** Stripe webhook may retry. Check
`core.webhook_events` for the event ID before posting.

---

## 3. Tenant pays partially (Rule PP1, PP2)

**Scenario.** Tenant pays $1,200 of the $2,000 invoice.

**Operational records.**

- `acc.payments` row, amount $1,200
- `acc.payment_allocations` row, $1,200 to invoice X
- `acc.invoices.balance_due` updates to $800
- `acc.invoices.status` updates to `'partial'`

**Journal entry.**

```
DR  asset:cash_operating                1,200.00
CR  asset:accounts_receivable                        1,200.00
```

**Notes.**

- Status update is in the **same DB transaction** as the
  allocation (§PP3) — never trust a follow-up cron.

---

## 4. Tenant overpays (Rule OP1)

**Scenario.** Tenant pays $2,500 against the $2,000 invoice.

**Operational records.**

- `acc.payments` row, amount $2,500
- `acc.payment_allocations` row, $2,000 to invoice X (matches
  invoice total)
- `acc.payments.unapplied_amount` = $500
- Invoice X status → `'paid'`

**Journal entry.**

```
DR  asset:cash_operating                2,500.00
CR  asset:accounts_receivable                        2,000.00
CR  liability:unapplied_customer_credit                500.00
```

**Wrong way (audit-failing).**

```
CR  income:rental_revenue                            2,500.00
```

(Recognizes income that hasn't been earned. §OP1.)

---

## 5. Apply unapplied credit to next invoice

**Scenario.** Next month's $2,000 invoice lands. The tenant has
$500 unapplied from §4. Operator (or auto-apply) allocates the
$500 to the new invoice.

**Operational records.**

- `acc.payment_allocations` row, $500, FROM the original payment,
  TO the new invoice
- New invoice's `balance_due` = $1,500, status = `'partial'`

**Journal entry.**

```
DR  liability:unapplied_customer_credit   500.00
CR  asset:accounts_receivable                          500.00
```

---

## 6. Late fee assessed (§LF1, §LF3, §LF4)

**Scenario.** November rent invoice is 6 days past due. Lease
allows late fee of $50 with 5-day grace period. Cron fires.

**Operational records.**

- New `acc.invoice_line_items` row on the EXISTING invoice with
  `kind = 'late_fee'`, amount $50
- `acc.invoices.total_amount` increases by $50
- `acc.invoices.balance_due` increases by $50
- A dedupe key like `(invoice_id, '2026-11')` prevents
  re-assessment if the cron retries.

**Journal entry.**

```
DR  asset:accounts_receivable              50.00
CR  income:late_fee_revenue                             50.00
```

**Wrong way.** Creating a separate `INV-2026-LATE-FEE-...`
invoice. Forbidden by §LF1.

---

## 7. Invoice voided (§D1, §D2)

**Scenario.** Invoice was created in error. Tenant has not paid.

**Operational records.**

- `acc.invoices.status` updates to `'void'`
- `acc.invoices.deleted_at` stays NULL (void is its own state, not
  a delete)
- All `acc.invoice_line_items` for this invoice stay in place
- The invoice remains queryable by status filter

**Journal entry.**

```
DR  income:rental_revenue               2,000.00     (reverses original CR)
CR  asset:accounts_receivable                        2,000.00 (reverses original DR)
```

**Source linkage.** New journal entry's
`source_id = <original invoice's id>`,
`reason = 'void'`. The original entry is NOT deleted.

**Wrong way.** `DELETE FROM acc.invoices WHERE id = ...` —
forbidden by §D1.

---

## 8. Reversal of a posting in a closed period (§C2)

**Scenario.** Period 2026-Q3 is locked. We discover an October
invoice was posted to September by mistake.

**Operational records.**

- The original posting in September stays untouched.
- A reversing entry is posted in the next OPEN period (e.g.
  current month) that cancels the original:

```
DR  income:rental_revenue               2,000.00     (cancels Sep CR)
CR  asset:accounts_receivable                        2,000.00 (cancels Sep DR)
```

- A new fresh entry is posted with the correct October date:

```
DR  asset:accounts_receivable           2,000.00
CR  income:rental_revenue                            2,000.00
```

**Source linkage.** The reversing entry's `source_id` points at
the ORIGINAL invoice's id; `notes` explains the correction. The
fresh entry has its own source linkage to the corrected invoice
(or a new corrected invoice if needed).

**Wrong way.** Editing the locked-period entry directly.
Forbidden by §C1 — the DB trigger should reject; if it doesn't,
that's a P0 bug.

---

## 9. Security deposit collected (§SD1)

**Scenario.** New tenant move-in, $2,000 deposit collected.

**Operational records.**

- Insert into `pm.security_deposits` (amount $2,000, status
  `'held'`)
- May insert into `acc.payments` if collected via the same Stripe
  flow as rent (then allocated to the deposit record vs an
  invoice)

**Journal entry.**

```
DR  asset:cash_security_deposits        2,000.00
CR  liability:security_deposits_held                 2,000.00
```

**Wrong way.**

```
CR  income:rental_revenue                            2,000.00
```

Critical violation of §SD1 + IRS Pub 527.

---

## 10. Security deposit applied to unpaid charges (§SD2)

**Scenario.** Tenant moves out owing $800. Operator applies
$800 of the $2,000 deposit.

**Operational records.**

- Insert into `acc.security_deposit_applications`
  (deposit_id, target_invoice_id, amount $800)
- `pm.security_deposits.amount_held` decreases by $800
- The unpaid invoice's `balance_due` goes to $0, status
  `'paid'`

**Journal entry.**

```
DR  liability:security_deposits_held      800.00
CR  asset:accounts_receivable                          800.00
```

(No income movement — see §SD2.)

---

## 11. Security deposit forfeited (§SD3)

**Scenario.** Of the $1,200 remaining after §10, the operator
legally forfeits $500 for cleaning, returns $700.

**Two postings.**

**Forfeiture (the income event).**

```
DR  liability:security_deposits_held      500.00
CR  income:forfeited_deposits                          500.00
```

**Refund of remainder.**

```
DR  liability:security_deposits_held      700.00
CR  asset:cash_security_deposits                       700.00
```

**Operational records.**

- `acc.security_deposit_forfeitures` (deposit_id, amount $500,
  reason, lease_term_clause, state_law_citation)
- `acc.payment_refunds` for the $700 wire/check back to tenant
- `pm.security_deposits.status` → `'closed'`

---

## 12. Advance rent / first-month-rent (§AR2, §AR4)

**Scenario.** Tenant signs lease in December for January 1
move-in, pays first month's $2,000 in December.

**Posting at receipt (December).**

```
DR  asset:cash_operating                2,000.00
CR  liability:unearned_rent                          2,000.00
```

**Posting at month-earned (January 1).**

```
DR  liability:unearned_rent             2,000.00
CR  income:rental_revenue                            2,000.00
```

**Operational records.**

- Insert into `acc.unearned_revenue_schedule` at receipt
- Settled at the recognition date (or by month-end recognition
  cron)

**Last-month-rent prepayment (also §AR4).** Same shape. NOT a
security deposit.

---

## 13. Concession applied — revenue concession (§CN1, §CN3)

**Scenario.** Residential lease has "$200 off month 1" concession.

**Operational records.**

- `pm.concessions` row (kind = `'revenue'`, amount $200, scope =
  month 1)
- November invoice line item: rent $2,000, concession line item
  −$200, total $1,800

**Journal entry (residential, as-billed §CN3).**

```
DR  asset:accounts_receivable           1,800.00
CR  income:rental_revenue                            1,800.00
```

(The concession is a reduction of revenue, not an expense.)

---

## 14. Concession applied — operating concession (§CN1)

**Scenario.** Commercial lease has a "$5,000 cash signing
incentive paid at lease signing."

**Operational records.**

- `pm.concessions` row (kind = `'operating'`, amount $5,000)
- Outflow tracked as an expense, NOT a revenue reduction

**Journal entry.**

```
DR  expense:lease_incentive_amortization  5,000.00
CR  asset:cash_operating                              5,000.00
```

(For ASC 842 commercial leases, this incentive is amortized over
the lease term — a deferred-asset alternative is used. Out of
scope of this example; the rule is "operating concessions are
expenses, not revenue reductions.")

---

## 15. Refund of an unapplied overpayment (§OP3)

**Scenario.** Tenant has $500 unapplied (from §4). Operator
refunds.

**Operational records.**

- Insert into `acc.payment_refunds` (payment_id, amount $500,
  method)
- `acc.payments.unapplied_amount` decreases to $0

**Journal entry.**

```
DR  liability:unapplied_customer_credit   500.00
CR  asset:cash_operating                               500.00
```

---

## 16. Bank deposit matched to multiple invoices

**Scenario.** A wire deposit of $5,000 matches three invoices
($2,000 + $2,000 + $1,000). Operator allocates manually OR
auto-matcher (gated by `ENABLE_PAYMENT_MATCHING`) does it.

**Operational records.**

- One `acc.payments` row (amount $5,000)
- Three `acc.payment_allocations` rows
- All three invoices update to `'paid'`

**Journal entry.**

```
DR  asset:cash_operating                5,000.00
CR  asset:accounts_receivable                        5,000.00
```

(One DR, one CR — the allocation table tracks the per-invoice
split. The journal entry doesn't need three CR rows.)

---

## 17. Loan payment received (mortgage debit)

**Scenario.** $1,500 monthly mortgage payment cleared from the
operating account: $1,200 principal, $300 interest.

**Operational records.**

- Insert into `acc.loan_payments` (loan_id, amount $1,500,
  principal $1,200, interest $300)
- `acc.loans.principal_balance` decreases by $1,200

**Journal entry.**

```
DR  liability:loan_principal            1,200.00
DR  expense:interest_expense              300.00
CR  asset:cash_operating                             1,500.00
```

---

## 18. Refund of a partial payment (§PP4)

**Scenario.** Tenant paid $1,200 against a $2,000 invoice via
Stripe. The payment was wrongly applied — the operator wants to
refund the $1,200 and reverse the allocation.

**Operational records (in this order, single DB transaction).**

1. Reverse the allocation:
   - Insert a NEW `acc.payment_allocations` row with amount
     `-1,200.00` referencing the same invoice. (Or mark the
     original allocation `status = 'reversed'` plus a new
     reversing row — the schema decision is per-implementation.)
   - `acc.invoices.balance_due` returns to $2,000.
   - `acc.invoices.status` returns to `'overdue'` (or whatever
     the pre-allocation state was).
2. Refund the cash:
   - Insert into `acc.payment_refunds` (payment_id, amount
     $1,200, method, refund_provider_ref).
   - `acc.payments.refunded_amount` updates.

**Journal entries (two postings, single DB transaction).**

Allocation reversal:

```
DR  asset:accounts_receivable           1,200.00
CR  asset:cash_operating                            1,200.00
```

(This is the reverse of Examples §3.)

OR equivalently, if you prefer to think of it as undoing the
allocation half AND moving cash separately:

Allocation reversal only (no cash movement yet):

```
DR  asset:accounts_receivable           1,200.00
CR  liability:unapplied_customer_credit              1,200.00
```

Then the refund cash movement:

```
DR  liability:unapplied_customer_credit  1,200.00
CR  asset:cash_operating                             1,200.00
```

The two-step pattern is preferred for refunds initiated AFTER
period close on the original payment — it makes the audit
trail unambiguous about when the cash actually moved.

**Wrong way.** Directly editing `acc.invoices.balance_due` from
$800 to $2,000 to "undo" the payment. Forbidden by §PP4 — go
through the allocation table.

**Notes.**

- If the original payment was Stripe-processed, the refund
  flows through Stripe's refund API; the resulting webhook
  posts the cash leg per Examples §3 reversed.
- Stripe processor fees on the original payment are typically
  NOT refunded by Stripe — that's an operating expense
  retained. Surface the discrepancy on the refund record.

---

## 19. Loan payment with full split (§16 / §LN1)

**Scenario.** $1,500 monthly mortgage payment cleared from the
operating account. The amortization schedule says: $1,150
principal, $300 interest, $40 escrow (taxes/insurance held by
lender), $10 fees (lender's monthly servicing fee).

**Operational records.**

- Insert `acc.loan_payments` (loan_id, amount $1,500,
  principal $1,150, interest $300, escrow $40, fees $10, type
  `'scheduled'`).
- `acc.loans.principal_balance` decreases by $1,150.
- `acc.loan_amortization_schedule` row for this period marked
  paid.

**Journal entry.**

```
DR  liability:loan_principal           1,150.00
DR  expense:interest_expense             300.00
DR  liability:loan_escrow_held            40.00
DR  expense:finance_charges               10.00
CR  asset:cash_operating                             1,500.00
```

(Sum of debits = $1,500 = sum of credits. §LN1 asserts the
four-way split totals.)

---

## 20. Bank reconciliation match (§17 / §BR3)

**Scenario.** Operator runs the bank reconciliation flow for
October 2026. A $2,000 deposit appeared on the bank statement
on 2026-10-15. It corresponds to the Stripe payment recorded
on 2026-10-14 (which already posted via Examples §2).

**Operational records.**

- Insert `acc.bank_transactions` (already done at import;
  status `'unmatched'`).
- Operator confirms match → insert `acc.bank_transaction_matches`
  (bank_transaction_id, target_type=`'payment'`,
  target_id=<payment_id>).
- `acc.bank_transactions.status` → `'matched'`.

**Journal entry.**

NONE. The cash movement was already recorded by the Stripe
webhook (Examples §2). The match step labels reality, doesn't
move money. §BR3.

---

## 21. Bank-fee transaction (§BR7)

**Scenario.** Bank statement shows a $25 monthly account fee on
2026-10-31. No corresponding application record exists.

**Operational records.**

- `acc.bank_transactions` row exists (status `'unmatched'`).
- Operator categorizes as bank fee.
- Status → `'written_off'`.
- Single new journal entry posts the expense.

**Journal entry.**

```
DR  expense:processor_fees                25.00
CR  asset:cash_operating                                25.00
```

---

## 22. Owner contribution (§18 / §OE1)

**Scenario.** The operator (sole owner) puts $50,000 into the
LLC's operating account to fund a renovation.

**Operational records.**

- Insert `acc.owner_contributions` (entity_id, owner_contact_id,
  amount $50,000, date, method).
- `acc.partner_capital_balances` (or equivalent) updates the
  owner's basis.

**Journal entry.**

```
DR  asset:cash_operating              50,000.00
CR  equity:owner_contributions                      50,000.00
```

(NOT income. §OE1.)

---

## 23. Owner distribution (§18 / §OE1)

**Scenario.** End-of-quarter cash distribution of $10,000 to the
sole owner.

**Operational records.**

- Insert `acc.owner_distributions` (entity_id,
  owner_contact_id, amount $10,000, date, method).
- Capital balance decreases.

**Journal entry.**

```
DR  equity:owner_distributions        10,000.00
CR  asset:cash_operating                            10,000.00
```

(NOT expense. §OE1.)

---

## 24. Intercompany transfer (§18 / §OE3)

**Scenario.** Crestview Holdings LLC (parent, entity A) wires
$25,000 to Crestview Property 12 LLC (subsidiary, entity B) to
fund a roof replacement.

**Operational records.**

- Insert `acc.intercompany_transfers` (entity_id_from = A,
  entity_id_to = B, amount $25,000, date, purpose).

**Journal entries (two halves, single DB transaction).**

On entity A's books:

```
DR  equity:intercompany_due_from_<B_id>     25,000.00
CR  asset:cash_operating                                25,000.00
```

On entity B's books:

```
DR  asset:cash_operating                    25,000.00
CR  equity:intercompany_due_to_<A_id>                   25,000.00
```

(Both halves posted atomically. §OE3.)

---

## 25. Property disposal at a gain (§19 / §FA5)

**Scenario.** Property purchased for $300,000 with $50,000
accumulated depreciation. Sold for $400,000 cash.

Net book value = $300,000 − $50,000 = $250,000.
Sale proceeds = $400,000.
Book gain = $400,000 − $250,000 = $150,000.

**Operational records.**

- `pm.properties.disposed_at` set; `disposed_via` = `'sale'`;
  `sale_proceeds` = $400,000; `sale_date` = today.
- Property no longer appears on active rent roll; depreciation
  schedule for this property stops.

**Journal entry (single combined posting).**

```
DR  asset:cash_operating                 400,000.00
DR  asset:accumulated_depreciation        50,000.00
CR  asset:property_book_value                            300,000.00
CR  income:gain_on_disposal                              150,000.00
```

Total debits $450,000 = total credits $450,000. §J1.

**Tax treatment.** The book gain $150,000 ≠ tax gain. §1250
recapture rules apply to the depreciation portion ($50,000 may
recapture as ordinary income at 25% maximum), and §1231 rules
apply to the rest. The Tax Center surfaces the book/tax delta;
the actual tax computation is the operator's CPA's job.

---

## 26. Partial property disposal (§19 / §FA6)

**Scenario.** A property's roof was capitalized at $40,000
five years ago. It's been depreciating at $1,333/year (30-year
schedule). Now the roof is replaced. Old roof book value =
$40,000 − $6,667 (5 years × $1,333) = $33,333. Old roof has
no salvage value (hauled away as junk).

**Operational records.**

- Mark the old-roof depreciation-schedule row as
  `'disposed'`.
- Don't touch the rest of the property's depreciation
  schedule.

**Journal entry.**

```
DR  asset:accumulated_depreciation        6,667.00
DR  expense:loss_on_disposal             33,333.00
CR  asset:property_book_value                            40,000.00
```

Then the new roof installation is its own capital improvement
(separate entry):

```
DR  asset:property_book_value            55,000.00     (cost of new roof)
CR  asset:cash_operating                                 55,000.00
```

A new depreciation schedule starts for the new roof.

---

## What these examples are NOT

- They are **not** the implementation. The implementation lives in
  `lib/billing/`, `lib/banking/`, and the various `actions.ts`
  files.
- They are **not** the test plan. Test scenarios live in
  `FINANCIAL_TEST_PLAN.md`.
- They are **not** legal advice. State landlord-tenant law,
  IRS rulings, and FASB updates change. Citations in
  `FINANCIAL_LOGIC_RULES.md` are authoritative; check current
  versions before implementation.
- The GL account names used here are **placeholders**. Real
  codes come from `acc.chart_of_accounts` per
  `FINANCIAL_GL_ACCOUNTS.md`.
