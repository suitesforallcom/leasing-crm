# Financial Module Synchronization Rules (FIN-TEST-03 — Gate 3)

> Six cross-module flows. Every financial PR must identify which
> flows it affects and prove that EVERY downstream module is
> consistent after the change.
>
> Master rule: `docs/BANKING_GRADE_FINANCIAL_INTEGRITY_GATE.md`.

If a PR touches a module in a flow but does not run the flow's
end-to-end sync test, the PR fails Gate 3.

---

## Flow A — Lease → Invoice → Payment → GL → Reports

### Trigger events

- Lease approval / amendment
- Recurring charge generation cron
- Invoice creation
- Payment receipt + allocation
- Late fee / NSF / chargeback

### Required sync invariants

1. Approved lease creates the expected rent schedule (per `docs/FINANCIAL_LOGIC_RULES.md` §rent-schedule).
2. Rent schedule generates correct invoice amounts (proration on partial periods, escalations on schedule).
3. Posted invoice increases AR + revenue (or unearned revenue per policy).
4. Payment allocation reduces invoice balance.
5. Payment allocation updates tenant ledger.
6. Cash receipt journal entry balances.
7. Rent Roll agrees with approved leases.
8. AR Aging agrees with invoice balances.
9. Cash Received report agrees with payment allocations + GL cash.
10. Owner Dashboard agrees with Cash Received + AR Aging.
11. Cash Flow agrees with GL/cash movements.
12. Lease amendment affects future charges only (unless explicitly approved retro).

### Test files (Gate 3A)

```
tests/unit/financial/sync/lease-invoice-payment/
  lease-to-rent-schedule.test.ts
  rent-schedule-to-invoice.test.ts
  invoice-to-ar.test.ts
  payment-to-allocation.test.ts
  payment-to-tenant-ledger.test.ts
  cash-receipt-je.test.ts
  rent-roll-consistency.test.ts
  ar-aging-consistency.test.ts
  cash-received-report-consistency.test.ts
  owner-dashboard-consistency.test.ts
  cash-flow-consistency.test.ts
  lease-amendment-future-only.test.ts
```

### Blocking rule

Any of the 12 invariants failing → PR fails Gate 3.

---

## Flow B — Loan → Amortization → Payment → Debt Service → DSCR → Owner Dashboard

### Trigger events

- Loan setup / refinance
- Loan payment processed
- Period end (DSCR calc)

### Required sync invariants

1. Loan terms create correct amortization schedule.
2. Interest-only period does not reduce principal.
3. Loan payment splits principal / interest / escrow / fees correctly.
4. Principal balance updates correctly.
5. Interest expense is separate from principal.
6. Loan-payment journal entry balances.
7. Loan liability equals remaining principal.
8. Debt Service report agrees with loan schedule + cash payments.
9. DSCR uses correct NOI + debt service (per policy).
10. Owner cash after debt service = operating cash − debt service.

### Test files (Gate 3B)

```
tests/unit/financial/sync/loan-amortization-debt/
  loan-to-amortization.test.ts
  interest-only-period.test.ts
  payment-split.test.ts
  principal-balance.test.ts
  interest-vs-principal.test.ts
  loan-payment-je.test.ts
  loan-liability-vs-principal.test.ts
  debt-service-report-consistency.test.ts
  dscr-formula.test.ts
  owner-cash-after-debt-service.test.ts
```

### Blocking rule

Any invariant failing → PR fails Gate 3.

---

## Flow C — Payment / Cash Received → Invoice Status → Tenant Balance → GL Cash → Reports

### Trigger events

- Payment recorded
- Allocation (single invoice, multiple invoices, unapplied)
- NSF / chargeback / refund / void
- Bank import matches a payment

### Required sync invariants

1. Payment amount is positive (unless approved reversal type).
2. Allocation sum equals payment amount.
3. A payment cannot be allocated twice.
4. Overpayment creates unapplied cash, NOT fake income.
5. NSF/chargeback reverses cash and restores receivable (or creates approved receivable).
6. Tenant balance agrees with AR subledger.
7. GL cash agrees with payment records.
8. Dashboard cash received agrees with GL + bank reconciliation.

### Test files (Gate 3C)

```
tests/unit/financial/sync/payment-status-cash/
  payment-amount-positive.test.ts
  allocation-sum.test.ts
  no-double-allocation.test.ts
  overpayment-unapplied-cash.test.ts
  nsf-chargeback.test.ts
  tenant-balance-vs-ar.test.ts
  gl-cash-vs-payments.test.ts
  dashboard-cash-vs-gl-bank.test.ts
```

### Blocking rule

Any invariant failing → PR fails Gate 3 + Gate 7 (concurrency for double-allocation).

---

## Flow D — Bank Import → Matching → Reconciliation → Cash Position

### Trigger events

- Bank statement file upload (CSV / PDF / OFX)
- Auto-match runs
- Manual match by accountant
- Reconciliation completion / reopen
- Inter-account transfer

### Required sync invariants

1. Imported statement totals equal parsed transaction totals.
2. Duplicate bank transaction hash is rejected.
3. A bank transaction cannot be matched twice.
4. Manual match requires user, timestamp, reason, source.
5. Unmatched deposits go to suspense / unapplied cash.
6. Inter-account transfer does NOT create income or expense.
7. Book cash reconciles to bank statement cash with outstanding items.
8. Reconciled period cannot be modified without reopen workflow.
9. Cash dashboard agrees with reconciled cash.

### Test files (Gate 3D)

```
tests/unit/financial/sync/bank-import-recon/
  import-totals.test.ts
  duplicate-hash-rejected.test.ts
  no-double-match.test.ts
  manual-match-audit.test.ts
  unmatched-to-suspense.test.ts
  inter-account-transfer.test.ts
  book-cash-vs-statement.test.ts
  reconciled-immutable.test.ts
  cash-dashboard-vs-recon.test.ts
```

### Blocking rule

Any invariant failing → PR fails Gate 3 + Gate 5.

---

## Flow E — Security Deposit Lifecycle

### Trigger events

- Lease signing → deposit collected
- Deposit application against unpaid balance
- Move-out → deposit refund / forfeiture
- Lease termination

### Required sync invariants

1. Deposit collection creates LIABILITY (not revenue).
2. Deposit application reduces liability AND reduces AR.
3. Deposit forfeiture moves liability to approved INCOME account.
4. Deposit refund reduces cash AND liability.
5. Deposit ledger balance = GL deposit liability.
6. Deposit history is immutable.

### Test files (Gate 3E)

```
tests/unit/financial/sync/deposit-lifecycle/
  deposit-collection-liability.test.ts
  deposit-application.test.ts
  deposit-forfeiture-income.test.ts
  deposit-refund.test.ts
  deposit-ledger-vs-gl.test.ts
  deposit-history-immutable.test.ts
```

### Blocking rule

Any invariant failing → PR fails Gate 3 + Gate 4 (subledger ↔ GL).

Tenant trust funds — zero tolerance for drift.

---

## Flow F — Vendor Bill / Expense / AP

### Trigger events

- Vendor bill creation
- Bill approval
- Bill payment
- Expense allocation across properties / entities
- CAM recoverable / non-recoverable classification

### Required sync invariants

1. Vendor bill line totals equal bill total.
2. Expense classification is required: OpEx / CapEx / CAM / reserve / other.
3. Allocation across properties / entities equals 100% of bill amount.
4. Approved bill creates AP liability.
5. Paying bill reduces AP and reduces cash.
6. AP aging equals AP subledger.
7. AP subledger equals AP control account.
8. CAM recoverable / non-recoverable classification is preserved through to CAM reconciliation.

### Test files (Gate 3F)

```
tests/unit/financial/sync/ap-vendor-bill/
  bill-line-totals.test.ts
  expense-classification-required.test.ts
  allocation-100-percent.test.ts
  approved-bill-ap-liability.test.ts
  bill-payment-cash.test.ts
  ap-aging-vs-subledger.test.ts
  ap-subledger-vs-gl.test.ts
  cam-classification-preserved.test.ts
```

### Blocking rule

Any invariant failing → PR fails Gate 3 + Gate 4 (AP subledger ↔ GL).

---

## How a PR proves Gate 3 sync

The PR description's gate proof block lists every flow it touches:

```markdown
## FIN-TEST-03 gate proof

| Gate                                                       | Required? | Proof                                                                       |
| ---------------------------------------------------------- | --------- | --------------------------------------------------------------------------- |
| 3A — Lease → Invoice → Payment → GL → Reports              | YES       | `tests/unit/financial/sync/lease-invoice-payment/*.test.ts` (12 cases pass) |
| 3C — Payment → Status → Tenant Balance → GL Cash → Reports | YES       | `tests/unit/financial/sync/payment-status-cash/*.test.ts` (8 cases pass)    |
| Other flows                                                | N/A       | (no scope overlap)                                                          |
```

If the PR touches a module and DOES NOT list the flows it affects, the agent or reviewer applies `financial-gate-missing` + `needs-review`. Auto-merge then rejects.
