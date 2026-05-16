# Financial Reconciliation Tests (FIN-TEST-03)

> Detailed spec for every reconciliation check the system must
> pass. Each check defines (a) inputs, (b) expected pass condition,
> (c) blocking rule on fail.
>
> Master rule: `docs/BANKING_GRADE_FINANCIAL_INTEGRITY_GATE.md`.

These checks combine to satisfy Gates 4 (Subledger-to-GL), 5 (Bank
Reconciliation), and 14 (Nightly Continuous Reconciliation).

---

## 1. AR subledger ↔ GL AR control

### Inputs

- `tenant_balances` view across all properties + entities + portfolios
- `invoices` table (open balance per invoice)
- GL `accounts_receivable_*` control account balances per property + entity

### Pass condition

```
sum(invoice.balance_remaining) over property P, entity E, period [start..end]
  == sum(tenant_balance) for same scope
  == GL AR control for same scope
```

### Blocking rule

Any difference > tolerance ($0.00 strict) without a documented reconciling item → PR fails Gate 4.

---

## 2. AP subledger ↔ GL AP control

### Inputs

- `vendor_bills` table (open balance per bill)
- GL `accounts_payable_*` control account balances per entity

### Pass condition

```
sum(vendor_bill.balance_remaining) over entity E, period [start..end]
  == GL AP control for same scope
```

### Blocking rule

Any difference > tolerance → PR fails Gate 4.

---

## 3. Loan principal ↔ GL loan liability

### Inputs

- Loan amortization schedule (calculated remaining principal as of date D)
- Actual loan payments applied
- GL loan liability account

### Pass condition

```
loan_principal_remaining(loan L, as_of D)
  == sum(amortization_principal_due[..D]) - sum(actual_principal_paid[..D]) + loan_balance_at_origination
  == GL loan liability for L as of D
```

### Blocking rule

Any difference (modulo approved escrow/fee adjustments) → PR fails Gate 4.

---

## 4. Security deposit ledger ↔ GL deposit liability

### Inputs

- `security_deposits` table (held amount per lease)
- GL `security_deposit_liability_*` per property/entity

### Pass condition

```
sum(security_deposits.held_amount where lease_active OR refund_pending)
  == GL deposit liability for same scope
```

### Blocking rule

Any difference → PR fails Gate 4. (Tenant trust funds — zero tolerance.)

---

## 5. Bank cash ↔ GL cash (per bank account)

### Inputs

- Bank statement balance as of statement date
- Outstanding deposits in transit
- Outstanding withdrawals (uncleared checks)
- Reconciling items (bank fees, interest credits)
- GL cash account balance

### Pass condition

```
statement_balance + outstanding_deposits - outstanding_withdrawals + reconciling_items
  == book_cash
  == GL cash for that bank account
```

### Blocking rule

- Any unexplained difference → reconciliation cannot complete (Gate 5).
- Any documented reconciling item must have a reason + approver + timestamp.

---

## 6. Statement totals ↔ parsed transactions

### Inputs

- Bank statement file (CSV / PDF / OFX / Plaid)
- Parsed transaction set

### Pass condition

```
parsed.beginning_balance + sum(parsed.deposits) - sum(parsed.withdrawals)
  == parsed.ending_balance
  == statement_file.ending_balance (extracted)
```

### Blocking rule

- Statement totals ≠ parsed totals → import is rejected (Gate 5 + Gate 12).
- Duplicate bank transaction hash → import rejected.

---

## 7. Fixed asset register ↔ GL fixed asset accounts

### Inputs

- Fixed asset register (cost basis + accumulated depreciation per asset)
- GL fixed asset accounts (cost + accum depreciation)

### Pass condition

```
sum(asset_register.cost_basis where active)        == GL fixed_assets_cost
sum(asset_register.accumulated_depreciation)       == GL accumulated_depreciation
```

### Blocking rule

Any difference → PR fails Gate 4 unless documented reconciling item.

---

## 8. Owner equity ledger ↔ GL equity

### Inputs

- Owner contribution / distribution ledger per owner
- GL `owner_equity_*` accounts per entity

### Pass condition

```
sum(contributions) - sum(distributions) + opening_balance
  == GL owner equity for that owner / entity
```

### Blocking rule

Any difference → PR fails Gate 4.

---

## 9. Property-level ↔ portfolio rollup

### Inputs

- Per-property GL trial balances
- Portfolio-level reports (NOI, cash flow, owner dashboard)

### Pass condition

```
portfolio_metric == sum(property_metric for property in portfolio)
                    - intercompany_eliminations (if multi-entity)
```

### Blocking rule

Any difference > $0.00 → PR fails Gate 4 + Gate 6. Eliminations must be documented.

---

## 10. Cross-report metric consistency

### Cases

| Metric                       | Reports that must agree                                             | Pass condition                               |
| ---------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| Cash received                | Cash Received report, Owner Dashboard, Cash Flow, GL cash movements | All four agree for the same period           |
| AR aging total               | AR Aging report, AR subledger, GL AR control                        | All three agree                              |
| NOI                          | NOI report, Owner Dashboard, Lender Package                         | All three agree                              |
| DSCR                         | DSCR per property, DSCR per portfolio, Lender Package               | All agree using same NOI + same debt service |
| Rent roll total monthly rent | Rent Roll, Owner Dashboard "Annual Rent" / 12                       | Agree                                        |
| Cash after debt service      | Cash Flow, Owner Dashboard, Lender Package                          | All three agree                              |

### Blocking rule

Any disagreement → PR fails Gate 6.

---

## 11. PDF / CSV export ↔ on-screen values

### Inputs

- The on-screen report state at time T
- The PDF / CSV exported at time T

### Pass condition

Every numeric value in the export equals the on-screen value, byte-identical (after rounding rules applied).

### Blocking rule

Any difference → PR fails Gate 6.

---

## 12. MTD / QTD / YTD / cumulative rollups

### Pass condition

```
YTD(metric, period_end)   == sum(monthly(metric)   for m in YTD)
QTD(metric, period_end)   == sum(monthly(metric)   for m in QTD)
MTD(metric, period_end)   == monthly(metric, period_end_month)
cumulative(metric, end)   == cumulative(metric, end-1) + period_increment(metric, end)
```

### Blocking rule

Any rollup discrepancy → PR fails Gate 6.

---

## 13. Period close pre-flight

### Required pre-close checks (all must pass)

| Check                                                             | Source |
| ----------------------------------------------------------------- | ------ |
| Trial balance balances                                            | Gate 1 |
| All bank accounts reconciled for the period                       | Gate 5 |
| Suspense / unapplied cash account = $0 (or documented + approved) | Gate 7 |
| AR subledger = GL AR                                              | Gate 4 |
| AP subledger = GL AP                                              | Gate 4 |
| Loan balances = GL loan liability                                 | Gate 4 |
| Deposit ledger = GL deposit liability                             | Gate 4 |
| No unposted journal entries in period                             | Gate 1 |

### Blocking rule

Period close fails atomically if any pre-flight check fails (Gate 9). The system creates an immutable snapshot only after all checks pass.

---

## 14. Nightly continuous reconciliation (Gate 14)

A `.github/workflows/nightly-financial-reconciliation.yml` runs the following checks against the staging environment every night and emails Tony (NEVER production financial data). Each check is a `scripts/nightly-reconciliation/*.mjs`:

| Check                                               | Frequency | Alert level       |
| --------------------------------------------------- | --------- | ----------------- |
| Trial balance balances (cross-period)               | nightly   | RED if fail       |
| AR subledger vs GL                                  | nightly   | RED if fail       |
| AP subledger vs GL                                  | nightly   | RED if fail       |
| Bank cash vs GL cash                                | nightly   | RED if fail       |
| Deposit liability vs held deposits                  | nightly   | RED if fail       |
| Loan principal vs GL liability                      | nightly   | RED if fail       |
| Rent roll vs lease source                           | nightly   | YELLOW if drift   |
| Owner dashboard vs source reports                   | nightly   | RED if fail       |
| Exception report (suspense / unapplied / unmatched) | nightly   | RED if any        |
| Anomaly scan                                        | nightly   | YELLOW for review |
| Owner-report summary                                | nightly   | INFO              |

### Blocking rule for Gate 14 (planning gate)

Before AGGRESSIVE_AUTONOMOUS_BUILD_MODE may be enabled for financial features, the nightly reconciliation plan above must define how drift detection escalates exceptions. The plan is approved when all 11 check scripts exist (even as stubs that report "not yet implemented") and the workflow file exists.

---

## 15. How to add a new reconciliation test

1. Add the spec here (this file) with inputs / pass condition / blocking rule.
2. Add the test under `tests/unit/financial/reconciliation/<check>.test.ts`.
3. Add a nightly stub under `scripts/nightly-reconciliation/<check>.mjs` (Gate 14).
4. Update the relevant FIN-TEST-03 sub-issue and link the PR.
5. Apply the relevant `*-passed` label on the PR (e.g. `subledger-gl-passed`).
6. Update the test count in `docs/FINANCIAL_TEST_MATRIX.md` if the count materially changed.
