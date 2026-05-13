# Financial Integrity Test Suite (FIN-TEST-03)

> File / folder layout for the 500–800 tests in the Banking-Grade
> Financial Integrity Gate. Includes naming conventions, fixture
> patterns, and CI integration.
>
> Master rule: `docs/BANKING_GRADE_FINANCIAL_INTEGRITY_GATE.md`.
> Gate × module catalogue: `docs/FINANCIAL_TEST_MATRIX.md`.

---

## 1. Folder layout

```
tests/
  unit/
    financial/
      double-entry/                  ← Gate 1 — JE balances, TB balances, accounting eq
      source-to-report/              ← Gate 2 — traceability
      sync/                          ← Gate 3 — cross-module flows
        lease-invoice-payment/       ← flow A
        loan-amortization-debt/      ← flow B
        payment-status-cash/         ← flow C
        bank-import-recon/           ← flow D
        deposit-lifecycle/           ← flow E
        ap-vendor-bill/              ← flow F
      subledger-gl/                  ← Gate 4
        ar/                          ← AR subledger ↔ GL AR
        ap/                          ← AP subledger ↔ GL AP
        loans/                       ← loan ledger ↔ GL liability
        deposits/                    ← deposit ledger ↔ GL liability
        cash/                        ← bank cash ↔ GL cash
        fixed-assets/                ← FA register ↔ GL FA
        equity/                      ← owner equity ↔ GL equity
        portfolio-rollup/            ← property → portfolio
      bank-recon/                    ← Gate 5
      report-consistency/            ← Gate 6
        cash-received/
        ar-aging/
        owner-dashboard/
        noi-dscr/
        lender-package/
        rollup-mtd-qtd-ytd/
      duplicates/                    ← Gate 7
      money-precision/               ← Gate 8 (extends existing money-precision.test.ts)
      period-close/                  ← Gate 9
      audit-trail/                   ← Gate 10
      permissions/                   ← Gate 11
      import-migration/              ← Gate 12
      anomaly-detection/             ← Gate 13
      cre-domain/                    ← Gate 15
        rent-roll/
        cam-reconciliation/
        loan-amortization/
        dscr/
        owner-distributions/
        lender-package/
  integration/
    financial/
      ...                            ← integration-level versions of the above
  e2e/
    financial/
      lender-package-pdf.spec.ts     ← Gate 6 + 15 (PDF/CSV = screen)
      bank-recon-flow.spec.ts        ← Gate 3D + 5
  fixtures/
    financial/
      gl-chart-of-accounts.ts        ← canonical CoA per docs/FINANCIAL_GL_ACCOUNTS.md
      sample-leases.ts               ← deterministic lease fixtures
      sample-loans.ts                ← deterministic loan fixtures
      sample-bank-statements.ts      ← deterministic bank import fixtures
      sample-vendor-bills.ts         ← deterministic vendor bill fixtures
      sample-tenants.ts              ← deterministic tenant fixtures
      property-portfolio.ts          ← multi-property + multi-entity fixture
scripts/
  nightly-reconciliation/            ← Gate 14
    trial-balance-check.mjs
    ar-vs-gl-check.mjs
    ap-vs-gl-check.mjs
    bank-vs-gl-check.mjs
    deposit-vs-gl-check.mjs
    loan-vs-gl-check.mjs
    rent-roll-vs-lease-check.mjs
    owner-dashboard-vs-source-check.mjs
    exception-report.mjs
    anomaly-scan.mjs
    owner-summary.mjs
.github/
  workflows/
    nightly-financial-reconciliation.yml  ← Gate 14 cron
```

---

## 2. Test naming convention

Every test file is `<module>.test.ts` or `<flow>.test.ts`. Each test inside is named `it('<gate>: <invariant>', () => …)`:

```ts
describe('Gate 1 — Double-Entry — Journal Entry', () => {
  it('every posted JE has total debit == total credit', () => { … });
  it('JE with zero lines is rejected', () => { … });
  it('JE with one-sided lines is rejected', () => { … });
  it('JE line cannot have both debit and credit', () => { … });
  it('JE referring to inactive GL account is rejected', () => { … });
});
```

This makes the gate proof block in PR descriptions trivial: copy the failing/passing `it` names.

---

## 3. Required fixture invariants

Every fixture in `tests/fixtures/financial/` MUST:

- Be **deterministic** — same input every run, no random IDs (use sequential or hashed-from-input IDs).
- Be **balanced** — opening trial balance balances; opening A=L+E.
- Be **multi-currency-ready** even if we only use USD today (every amount carries currency).
- Use **decimal-safe types** (`Decimal` from `decimal.js`, never `number`).
- Cover the **edge cases** documented in `docs/FINANCIAL_EXAMPLES.md`.

---

## 4. Test type policy

| Type                   | When                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit (U)**           | Pure helper / formula tests — no DB, no network. Default for math.                                                                            |
| **Integration (I)**    | Multiple modules + DB (test schema). Required for cross-module sync (Gate 3) + subledger-vs-GL (Gate 4) + report consistency (Gate 6).        |
| **E2E (E)**            | Playwright through the UI. Required for export consistency (PDF=screen, Gate 6) + lender package (Gate 15).                                   |
| **Property-based (P)** | Generative — random valid inputs, assert invariants. Required for money math (Gate 8) + concurrency (Gate 7). Use `fast-check` or equivalent. |
| **Nightly (N)**        | `scripts/nightly-reconciliation/*.mjs` — runs against staging. Reports only, never mutates production.                                        |

---

## 5. Setup pattern (common)

Every financial test file starts with:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import { setupFinancialFixtures } from "@/tests/fixtures/financial/setup";
import {
  resetGL,
  postJournalEntry,
  getTrialBalance,
} from "@/lib/accounting/test-helpers";

describe("Gate 1 — Double-Entry — Journal Entry", () => {
  beforeEach(async () => {
    await resetGL();
    await setupFinancialFixtures();
  });
  // ... it() blocks
});
```

(`@/lib/accounting/test-helpers` is added in PR-T03-08; until then, tests stub the post / read functions.)

---

## 6. CI integration

Every financial test runs in the standard `pnpm test` step. They are NOT in a separate CI job — financial integrity is a first-class signal.

The Verify CI workflow's `Verify (typecheck, lint, test)` step covers them. PR safety check (Rule 9) requires this step to be green.

---

## 7. How a sub-issue is structured

Every FIN-TEST-03 sub-issue follows this template:

```markdown
## Scope

This sub-issue adds tests for **Gate <N> — <gate name>** covering modules <M-XX, M-YY, ...>.

## Test list

- [ ] `tests/unit/financial/<folder>/<file>.test.ts` — describe block: "Gate N — <invariant 1>"
- [ ] `tests/unit/financial/<folder>/<file>.test.ts` — describe block: "Gate N — <invariant 2>"
- ...

## Fixtures required

- `tests/fixtures/financial/<fixture>.ts`

## Out of scope

- Financial runtime code in `lib/` (separate PR; not blocking on this issue)
- Schema changes (separate approved schema-impact plan)
- Real external API calls

## Gate proof block (paste into PR description)

| Gate | Required? | Proof                                                        |
| ---- | --------- | ------------------------------------------------------------ |
| <N>  | YES       | `tests/unit/financial/<folder>/<file>.test.ts` (X new cases) |

## Labels to apply when complete

- `<gate>-passed` (e.g. `trial-balance-passed`)
- `financial-integrity-passed`
```

---

## 8. Sub-issue index

The 14 sub-issues filed under FIN-TEST-03 (#399), in the order they should land:

| #   | Title                                                  | Gate(s) | Estimated tests |
| --- | ------------------------------------------------------ | ------- | --------------- |
| 1   | PR-T03-01 — Double-entry & trial balance               | 1       | 40–60           |
| 2   | PR-T03-02 — Subledger vs GL reconciliation             | 4       | 40–60           |
| 3   | PR-T03-03 — Lease → Invoice → Payment → Reports sync   | 3A, 6   | 40–60           |
| 4   | PR-T03-04 — Bank reconciliation                        | 5       | 30–50           |
| 5   | PR-T03-05 — Payments / cash receipt                    | 3C, 7   | 30–50           |
| 6   | PR-T03-06 — Loan / debt service / DSCR                 | 3B, 15  | 40–60           |
| 7   | PR-T03-07 — AP / vendor bills / expense classification | 3F      | 30–50           |
| 8   | PR-T03-08 — Period close & audit trail                 | 9, 10   | 30–50           |
| 9   | PR-T03-09 — Cross-report consistency                   | 6       | 50–80           |
| 10  | PR-T03-10 — Data import / migration                    | 12      | 30–50           |
| 11  | PR-T03-11 — Nightly reconciliation jobs                | 14      | 10–20           |
| 12  | PR-T03-12 — Journal anomaly detection                  | 13      | 20–30           |
| 13  | PR-T03-13 — Permissions / SoD                          | 11      | 30–50           |
| 14  | PR-T03-14 — Owner / lender report consistency          | 6, 15   | 50–80           |

---

## 9. Cross-references

- `docs/BANKING_GRADE_FINANCIAL_INTEGRITY_GATE.md` — master rule
- `docs/FINANCIAL_TEST_MATRIX.md` — gate × module grid
- `docs/FINANCIAL_RECONCILIATION_TESTS.md` — reconciliation specs
- `docs/FINANCIAL_MODULE_SYNC_RULES.md` — Gate 3 detail
- `docs/FINANCIAL_BLOCKING_GATES.md` — what blocks merge / aggressive build
- `docs/FINANCIAL_LOGIC_RULES.md` — domain rules (existing)
- `docs/FINANCIAL_GL_ACCOUNTS.md` — chart of accounts (existing)
- `docs/FINANCIAL_EXAMPLES.md` — worked examples (existing)
