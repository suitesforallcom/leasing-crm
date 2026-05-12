# Financial Test Matrix (FIN-TEST-03)

> Per-gate × per-module test catalogue. Each cell lists the tests
> that must exist for a PR touching that module to claim it passed
> that gate. See `docs/BANKING_GRADE_FINANCIAL_INTEGRITY_GATE.md`
> for the master rule.

Test types abbreviation:

- **U** — unit (`tests/unit/financial/...`)
- **I** — integration (`tests/integration/financial/...`)
- **E** — end-to-end Playwright (`tests/e2e/financial/...`)
- **P** — property-based (deterministic, large input space)
- **N** — nightly cron job (`scripts/nightly-reconciliation/...`)

---

## 1. Modules

| ID   | Module                                          |
| ---- | ----------------------------------------------- |
| M-01 | Lease                                           |
| M-02 | Rent Roll                                       |
| M-03 | Invoice                                         |
| M-04 | Payment / Cash Received                         |
| M-05 | Bank Transaction                                |
| M-06 | Bank Reconciliation                             |
| M-07 | Vendor Bill                                     |
| M-08 | Expense Classification (OpEx/CapEx/CAM/Reserve) |
| M-09 | Accounts Payable (AP)                           |
| M-10 | Loan Setup                                      |
| M-11 | Amortization Schedule                           |
| M-12 | Debt Service                                    |
| M-13 | DSCR                                            |
| M-14 | Security Deposit                                |
| M-15 | Journal Entry / GL                              |
| M-16 | Trial Balance                                   |
| M-17 | AR Aging                                        |
| M-18 | AP Aging                                        |
| M-19 | Cash Received Report                            |
| M-20 | Cash Flow Report                                |
| M-21 | NOI                                             |
| M-22 | Budget vs Actual                                |
| M-23 | CAM Reconciliation                              |
| M-24 | Owner Dashboard                                 |
| M-25 | Lender Package                                  |
| M-26 | Period Close                                    |
| M-27 | Audit Log                                       |
| M-28 | Financial Permissions / SoD                     |

---

## 2. Test types per gate × module

Legend per cell: list of test types required.
`—` = gate doesn't apply to this module.

### Gate 1 — Double-Entry Accounting

| Module                | Required tests                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| M-15 Journal          | U + P (every JE balances; no zero-line; no one-side; valid GL accounts; reversal offsets; void preserves + reverses) |
| M-16 Trial Balance    | U + I (TB balances per period/property/entity/portfolio; opening + movement = closing)                               |
| M-04 Payment          | U (cash receipt JE balances)                                                                                         |
| M-07 Vendor Bill      | U (bill JE balances)                                                                                                 |
| M-10–M-12 Loan        | U (interest expense + principal split JE balances)                                                                   |
| M-14 Security Deposit | U (deposit collection JE balances; refund/forfeit JE balances)                                                       |
| M-26 Period Close     | I (close fails if TB unbalanced)                                                                                     |

### Gate 2 — Source-to-Report Traceability

| Module                | Required tests                                  |
| --------------------- | ----------------------------------------------- |
| M-02 Rent Roll        | I (rent roll number → lease record)             |
| M-17 AR Aging         | I (aging amount → invoice → lease)              |
| M-19 Cash Received    | I (report total → payment → bank tx)            |
| M-20 Cash Flow        | I (cash flow line → GL movement → source tx)    |
| M-21 NOI              | I (NOI components → operating GL accounts)      |
| M-22 Budget vs Actual | I (actual figure → GL → source tx)              |
| M-24 Owner Dashboard  | I (every dashboard tile → source report)        |
| M-25 Lender Package   | E (every PDF/CSV value → on-screen report → GL) |

### Gate 3 — Cross-Module Synchronization

See `docs/FINANCIAL_MODULE_SYNC_RULES.md` for the full flow specs.
Each flow needs an integration test suite covering every step.

| Flow                                                                     | Modules touched                                | Test type |
| ------------------------------------------------------------------------ | ---------------------------------------------- | --------- |
| A. Lease → Invoice → Payment → GL → Reports                              | M-01, M-03, M-04, M-15, M-17, M-19, M-20, M-24 | I + E     |
| B. Loan → Amortization → Payment → Debt Service → DSCR → Owner Dashboard | M-10, M-11, M-12, M-13, M-15, M-24             | I         |
| C. Payment → Invoice Status → Tenant Balance → GL Cash → Reports         | M-04, M-03, M-15, M-19, M-24                   | I         |
| D. Bank Import → Matching → Reconciliation → Cash Position               | M-05, M-06, M-15, M-19, M-20                   | I + E     |
| E. Security Deposit Lifecycle                                            | M-01, M-14, M-15                               | I         |
| F. Vendor Bill / Expense / AP                                            | M-07, M-08, M-09, M-15, M-18                   | I         |

### Gate 4 — Subledger-to-GL Reconciliation

| Module                | Required tests                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| M-17 AR Aging         | I (AR subledger total = GL AR control)                                                         |
| M-18 AP Aging         | I (AP subledger total = GL AP control)                                                         |
| M-12 Debt Service     | I (loan principal balances = GL loan liability)                                                |
| M-14 Security Deposit | I (deposit ledger = GL deposit liability)                                                      |
| M-15 GL               | I (cash subledger = GL cash; fixed asset register = GL FA accounts; equity ledger = GL equity) |
| M-24 Owner Dashboard  | I (property-level numbers = property-level GL; portfolio = sum of properties)                  |
| (nightly)             | N (all of the above run nightly — Gate 14)                                                     |

### Gate 5 — Bank Reconciliation

| Module                   | Required tests                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-05 Bank Transaction    | U (import totals = parsed totals; duplicate hash rejected)                                                                                                                               |
| M-06 Bank Reconciliation | I + E (statement begin + deposits − withdrawals = end; book + outstanding = statement; GL cash = reconciled cash; reopen requires approval; exception report includes unmatched + stale) |

### Gate 6 — Report Consistency

| Module pair                                  | Required tests                                                  |
| -------------------------------------------- | --------------------------------------------------------------- |
| M-02 Rent Roll vs M-01 Lease                 | I (rent roll ↔ approved leases & charge schedules)              |
| M-17 AR Aging vs M-03 Invoice                | I (aging ↔ invoice subledger)                                   |
| M-19 Cash Received vs M-04 Payment + M-15 GL | I (3-way match)                                                 |
| M-24 Owner Dashboard vs M-19/M-20/M-22       | I (every tile ↔ source report)                                  |
| M-21 NOI vs M-15 GL                          | I (NOI = operating income − operating expenses; CapEx excluded) |
| M-13 DSCR vs M-21 NOI + M-12 Debt Service    | I (DSCR = NOI / debt service)                                   |
| M-25 Lender Package vs internal reports      | E (PDF/CSV = screen)                                            |
| MTD/QTD/YTD/cumulative                       | I (period rollups reconcile)                                    |

### Gate 7 — Duplicate / Idempotency / Concurrency

| Module                | Required tests                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------- |
| M-05 Bank Transaction | U + P (re-run import → no dup; webhook retry → no dup posting)                                |
| M-04 Payment          | U + P (re-run payment import → no dup; concurrent allocation by 2 users → at most 1 succeeds) |
| M-03 Invoice          | U + P (recurring charge cron → no dup; concurrent invoice number generation → unique)         |
| M-07 Vendor Bill      | U (concurrent approval by 2 users → at most 1 succeeds)                                       |
| M-15 Journal          | U + P (concurrent posting → JE balances; failed retry → no partial duplicate)                 |
| Late fee cron         | U (re-run → no dup)                                                                           |

### Gate 8 — Precision / Money Math

| Module                   | Required tests                                                                   |
| ------------------------ | -------------------------------------------------------------------------------- |
| M-04 Payment             | U + P (decimal-safe; allocation pennies deterministic; no float drift)           |
| M-03 Invoice             | U + P (proration; partial periods; rounding only at policy boundary)             |
| M-11 Amortization        | U + P (long-period accuracy; interest rounding policy)                           |
| M-23 CAM Reconciliation  | U (share % totals correctly; rounding)                                           |
| M-15 Journal             | U (negative allowed only for approved reversals; zero rejected unless memo/void) |
| Multi-period recognition | U + P (no drift over time)                                                       |

### Gate 9 — Period Close / Locking

| Module            | Required tests                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M-26 Period Close | I (close fails if TB unbalanced; close fails if banks unreconciled; close fails if suspense unresolved; close creates immutable snapshot; reopen requires approval + reason; lock applies across GL/AR/AP/bank/loans/expenses) |
| M-15 Journal      | U (closed period rejects postings; reversing entry posts to next open period)                                                                                                                                                  |

### Gate 10 — Audit Trail / Immutability

| Module                   | Required tests                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| M-15 Journal             | U (every mutation logged with before/after; posted JE can't be edited; void/reverse only) |
| M-03 Invoice             | U (posted invoice immutable; void/credit only)                                            |
| M-04 Payment             | U (posted payment immutable; void/refund only)                                            |
| M-06 Bank Reconciliation | U (posted recon immutable; reopen approved + reasoned)                                    |
| M-07 Vendor Bill         | U (posted bill immutable)                                                                 |
| M-15 Manual adjustments  | U (require reason + user + timestamp + attachment/source)                                 |
| M-27 Audit Log           | I (service role cannot bypass; import batches preserve original file ref)                 |

### Gate 11 — Permission / Segregation of Duties

| Module            | Required tests                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| M-28 Permissions  | I (viewer cannot edit; PM cannot access unauth property; SoD: creator ≠ approver for vendor bills; importer ≠ recon approver) |
| M-04 Payment      | I (high-risk override → owner/admin approval; API rejects unauth mutation)                                                    |
| Sensitive actions | I (record user/session/time; permission changes audited)                                                                      |

### Gate 12 — Import / Migration / Data Quality

| Module              | Required tests                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------- |
| M-01 Lease import   | U + I (draft/review status first; failed rows don't partial-post)                           |
| M-10 Loan import    | U + I (validates balance + amortization)                                                    |
| M-04 Payment import | U + I (deduplicate by business key)                                                         |
| M-05 Bank import    | U + I (totals = statement; idempotent)                                                      |
| Migration           | I (cannot create unbalanced entries; cannot create orphans; reconciles to opening balances) |
| Import batch        | U (stores source file, checksum, row count, error count, legacy IDs)                        |
| Dirty data          | I (goes to exception queue)                                                                 |

### Gate 13 — Journal Anomaly Detection

| Module           | Required tests                                                                                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-15 Journal     | U (large round-dollar flagged; period-end manual flagged; post-close without explanation flagged; unusual account combos flagged; rare-user manual flagged; repeated same amount/ref flagged; force-balance entries flagged; weekend/after-hours flagged if policy enabled) |
| (optional)       | P (Benford-style anomaly scan over large synthetic dataset)                                                                                                                                                                                                                 |
| Anomaly handling | I (flagged for review; never auto-posted or auto-reversed)                                                                                                                                                                                                                  |

### Gate 14 — Nightly Continuous Reconciliation

Planning gate; tests + jobs are added in PR-T03-11. Required artefacts:

- `scripts/nightly-reconciliation/trial-balance-check.mjs`
- `scripts/nightly-reconciliation/ar-vs-gl-check.mjs`
- `scripts/nightly-reconciliation/ap-vs-gl-check.mjs`
- `scripts/nightly-reconciliation/bank-vs-gl-check.mjs`
- `scripts/nightly-reconciliation/deposit-vs-gl-check.mjs`
- `scripts/nightly-reconciliation/loan-vs-gl-check.mjs`
- `scripts/nightly-reconciliation/rent-roll-vs-lease-check.mjs`
- `scripts/nightly-reconciliation/owner-dashboard-vs-source-check.mjs`
- `scripts/nightly-reconciliation/exception-report.mjs`
- `scripts/nightly-reconciliation/anomaly-scan.mjs`
- `.github/workflows/nightly-financial-reconciliation.yml`

### Gate 15 — CRE Domain-Specific

| Module                | Required tests                                                                          |
| --------------------- | --------------------------------------------------------------------------------------- |
| M-02 Rent Roll        | I (only approved leases; concessions/escalations/vacancies; move-in/move-out proration) |
| M-14 Security Deposit | I (lease-term deposit = held amount)                                                    |
| M-23 CAM              | I (recoverable pool correct; tenant pro-rata correct; true-up audit trail preserved)    |
| M-11 Amortization     | I (follows loan terms + actual payments; escrow/reserve separate)                       |
| M-12 Debt Service     | I (covenant compliance flags; maturity/refinance alerts; expected vs actual)            |
| M-13 DSCR             | I (per property + portfolio)                                                            |
| M-24 Owner Dashboard  | I (distributions/contributions affect equity; portfolio = sum of properties)            |
| M-25 Lender Package   | E (lender values = internal reports)                                                    |

### Gate 16 — PR Classification & Blocking

Implemented at the dispatcher / pr-safety-check layer; not per-module.
Tests live in `tests/unit/scripts/pr-safety-check-financial-gate.test.ts`.

---

## 3. Total estimate

Sum of approximate counts per Gate 1–15: **500–800 tests** across the 14 sub-issues.

Gate 16's enforcement is fully tested in this PR (30 tests in `pr-safety-check-financial-gate.test.ts`).
