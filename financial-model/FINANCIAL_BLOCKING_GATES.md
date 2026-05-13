# Financial Blocking Gates (FIN-TEST-03)

> Which missing or failing tests block merge.
> Which gates must pass before each financial feature can ship.
> Which gates must be planned before AGGRESSIVE_AUTONOMOUS_BUILD_MODE
> can be enabled for a financial module.
>
> Master rule: `docs/BANKING_GRADE_FINANCIAL_INTEGRITY_GATE.md`.

---

## 1. PR classification table

Every PR is one of seven categories. The required gates per category are listed below.

| Category                                             | Description                                                                                         | Required gates                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **A. Non-financial**                                 | No financial code, no financial reports/dashboards, no financial labels.                            | None — standard CI gates only.                                                    |
| **B. Financial docs / tests only**                   | Edits to `docs/FINANCIAL_*` or adds tests under `tests/*/financial/`.                               | Gate 16 (PR classification). May auto-merge if `safe-auto-merge` policy allows.   |
| **C. Financial intake / staging / review only**      | Upload UI, CSV preview, staging tables only. Does NOT post real financial effects.                  | Gate 12 (Import data quality), Gate 16.                                           |
| **D. Financial runtime logic**                       | Touches `lib/billing/`, `lib/money/`, `lib/accounting/`, server actions that post financial events. | Every gate touched by the affected modules — see `docs/FINANCIAL_TEST_MATRIX.md`. |
| **E. Accounting / GL / close / bank reconciliation** | Touches `lib/accounting/`, period-close logic, bank-reconciliation logic.                           | **Strictest set:** Gates 1, 4, 5, 9, 10, 11.                                      |
| **F. Financial reports / dashboards**                | New or modified financial report / dashboard.                                                       | Gates 2, 4, 6, plus export-consistency tests.                                     |
| **G. Import / migration**                            | Historical import or data migration.                                                                | Gates 12, 4, 7, plus opening-balance reconciliation.                              |

If a PR straddles multiple categories, ALL applicable gates apply.

---

## 2. Auto-merge blocking rule (Gate 16 enforcement)

Any PR that touches financial runtime, accounting, bank reconciliation, invoices, payments, expenses, loans, lease billing, owner dashboard, or lender reports AND does not declare which financial gates it passed MUST be labelled:

- `financial-gate-missing`
- `needs-review`
- `no-auto-merge`

`scripts/agent-dispatcher/pr-safety-check.mjs` includes all three in `FORBIDDEN_LABELS` (Rule 7). Auto-merge then hard-rejects.

The Safe Auto-Merge Lane (`safe-auto-merge.yml`) calls `pr-safety-check.mjs` immediately before each merge attempt. A PR with any of the labels above will be skipped and the workflow will log a Rule 7 violation.

### Full auto-merge rejection list (TOOL-35/36/37/38 + FIN-TEST-03)

A PR is rejected from auto-merge if it carries ANY of:

- **Operational holds:** `risk-high`, `blocked`, `needs-review`, `human-decision-needed`, `requires-tony-approval`
- **Risk areas:** `schema-change`, `auth-security`, `financial-runtime`, `production-integration`, `external-api`
- **Real / production:** `real-money`, `real-bank`, `real-email`
- **Legacy financial:** `stripe`, `docusign`, `payments`, `rls`, `lease-logic`, `invoice-logic`, `accounting`, `production-data`, `financial-critical`, `security-critical`, `auth-critical`, `database`, `migration`
- **FIN-TEST-03 financial-gate failures (NEW):** `financial-gate-missing`, `financial-integrity-failed`, `reconciliation-failed`, `trial-balance-failed`, `subledger-gl-failed`, `source-to-report-failed`
- **Manual review markers (NEW):** `no-auto-merge`, `review-required`, `manual-danger-dispatched`

(See `pr-safety-check.mjs#FORBIDDEN_LABELS` for the canonical list. Length grows from 27 → 36 with FIN-TEST-03's additions.)

---

## 3. Per-feature unblock matrix

Before each financial feature can ship to staging (and certainly before any production toggle), these gates must be PROVEN PASSING:

### Payment upload (intake / staging only)

Required gates:

- Gate 8 (Money math precision) — every amount decimal-safe
- Gate 12 (Import data quality) — idempotent, deduplicated, exception queue
- Gate 16 (PR classification) — labelled correctly

Not required for INTAKE-ONLY (no posting, no allocation):

- Gate 1, 4 (no JE, no subledger update yet)

When the feature transitions from staging to live posting, ADD: Gates 1, 3C, 4 (AR ↔ GL), 7, 10.

### Bank transaction upload (intake / staging only)

Required gates:

- Gate 8 (Money math)
- Gate 12 (Import) — including: parse totals = file totals, duplicate hash rejected
- Gate 16

Not required for INTAKE-ONLY:

- Gate 5 (no reconciliation yet)

When transitioning to live matching + reconciliation, ADD: Gates 3D, 5, 7, 10.

### Invoice automation (recurring charges, late fees)

Required gates:

- Gate 1 (every invoice posts a balanced JE)
- Gate 3A (lease → invoice consistency)
- Gate 7 (recurring charge cron does NOT duplicate; late-fee cron does NOT duplicate)
- Gate 8 (decimal-safe; proration correct)
- Gate 16

### GL / accounting

Required gates (the strictest set):

- Gate 1 (double-entry)
- Gate 2 (source-to-report)
- Gate 4 (subledger ↔ GL)
- Gate 9 (period close)
- Gate 10 (audit trail)
- Gate 11 (permissions / SoD)
- Gate 13 (anomaly detection)
- Gate 16

### AP / expenses

Required gates:

- Gate 1 (every bill posts a balanced JE)
- Gate 3F (vendor bill / AP flow)
- Gate 4 (AP subledger ↔ GL)
- Gate 7 (no double-approval)
- Gate 8 (allocation pennies)
- Gate 11 (SoD: creator ≠ approver)
- Gate 16

### Loans / debt service

Required gates:

- Gate 1 (loan-payment JE balances)
- Gate 3B (loan flow)
- Gate 4 (loan ledger ↔ GL liability)
- Gate 8 (amortization precision over long periods)
- Gate 15 (CRE-domain — covenant compliance, maturity alerts)
- Gate 16

### Owner dashboard

Required gates:

- Gate 2 (every dashboard tile traceable to source)
- Gate 4 (property-level → portfolio rollup matches)
- Gate 6 (cross-report consistency)
- Gate 15 (owner / lender-facing KPIs reconcile to source + GL)
- Gate 16

### Financial reports (Rent Roll, AR Aging, Cash Received, Cash Flow, NOI, DSCR, Budget vs Actual, CAM)

Required gates:

- Gate 2 (source-to-report)
- Gate 4 (relevant subledger ↔ GL)
- Gate 6 (cross-report consistency + PDF/CSV = screen + MTD/QTD/YTD rollups)
- Gate 16

### Period close

Required gates (the strictest set, plus pre-flight):

- Gate 1 (TB must balance)
- Gate 4 (all subledgers must reconcile to GL)
- Gate 5 (all banks must reconcile)
- Gate 9 (close locks period; reopen requires approval + reason)
- Gate 10 (audit trail; immutable snapshot)
- Gate 11 (only authorized users)
- Gate 14 (nightly continuous reconciliation must be in place — see below)
- Gate 16

---

## 4. Gates required before AGGRESSIVE_AUTONOMOUS_BUILD_MODE may apply to a financial module

`AGGRESSIVE_AUTONOMOUS_BUILD_MODE=true` (TOOL-38) lets the dispatcher pick up dangerous issues. For a financial module to be eligible for aggressive build, the following plan must exist:

- Gate 14 (Nightly Continuous Reconciliation) **plan must be defined** for the module: what nightly check detects drift, what alert level fires, who is paged.
- The relevant per-feature gate set above must have at least 50% of expected tests in `tests/unit/financial/`.
- The module must have a corresponding GitHub label (e.g. `cat:financial`, `cat:accounting`, `lease-logic`, etc.) so the dispatcher can identify dangerous PRs.

If the plan doesn't exist, aggressive mode still picks up the issue BUT the agent's PR is labelled `financial-gate-missing` and auto-merge rejects.

This is the meaning of "Aggressive mode opens dispatch; it does NOT lower merge safety."

---

## 5. Gate-by-gate "what blocks" summary

| Gate                                     | What blocks merge                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| 1 — Double-entry                         | TB doesn't balance, JE doesn't balance, accounting eq violated                   |
| 2 — Source-to-report                     | A report number can't trace to source data                                       |
| 3 — Cross-module sync                    | Any flow's downstream module disagrees with source                               |
| 4 — Subledger ↔ GL                       | Any subledger ≠ GL control without documented reconciling item                   |
| 5 — Bank reconciliation                  | Any unexplained bank/book/GL difference                                          |
| 6 — Report consistency                   | Two reports show different numbers for same metric                               |
| 7 — Idempotency / concurrency            | Duplicate or partial inconsistent state possible                                 |
| 8 — Precision                            | Penny drift or non-deterministic calc                                            |
| 9 — Period close                         | Posting allowed in locked period                                                 |
| 10 — Audit trail                         | Mutation without audit log                                                       |
| 11 — Permissions / SoD                   | Unauthorized financial mutation possible                                         |
| 12 — Import / data quality               | Import can silently create dirty data                                            |
| 13 — Anomaly detection                   | Anomaly auto-corrected (instead of flagged for review)                           |
| 14 — Nightly continuous recon (planning) | Plan missing for the module before aggressive mode dispatches it                 |
| 15 — CRE domain-specific                 | Owner / lender KPI doesn't reconcile to source + GL                              |
| 16 — PR classification                   | PR touches financial without declaring gates → labelled `financial-gate-missing` |

---

## 6. Cross-references

- `docs/BANKING_GRADE_FINANCIAL_INTEGRITY_GATE.md` — master rule
- `docs/FINANCIAL_TEST_MATRIX.md` — gates × modules grid
- `docs/FINANCIAL_RECONCILIATION_TESTS.md` — reconciliation specs
- `docs/FINANCIAL_INTEGRITY_TEST_SUITE.md` — file/folder layout
- `docs/FINANCIAL_MODULE_SYNC_RULES.md` — Gate 3 detail
- `docs/SAFE_AUTO_MERGE_POLICY.md` — auto-merge gating policy (Rule 4 expanded by FIN-TEST-03)
- `docs/SCHEDULED_AUTONOMOUS_LOOP.md` — TOOL-37 schedule context
- `docs/AGGRESSIVE_AUTONOMOUS_BUILD_MODE.md` (TOOL-38) — aggressive mode interaction
- `scripts/agent-dispatcher/pr-safety-check.mjs` — `FORBIDDEN_LABELS` enforcement
