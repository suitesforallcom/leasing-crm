# Kiwi Rentals — Financial Rules Bundle

_Single-file export of every financial rule, schema, test policy, and AI-agent gate used in this project. Generated 2026-05-12 02:26 UTC. Source: kiwi-rentals repo._

**What's in here:** the canonical rules an LLM (or human) needs to safely build, test, and review financial code for a multi-LLC property-management / accounting system.

**Table of contents:**
- [---](#---) — `.agents/finance-guardian.md` (23056 bytes)
- [Financial logic rules — Kiwi Rentals / PropertyPulse](#financial-logic-rules--kiwi-rentals--propertypulse) — `docs/FINANCIAL_LOGIC_RULES.md` (43555 bytes)
- [Financial compliance notes](#financial-compliance-notes) — `docs/FINANCIAL_COMPLIANCE_NOTES.md` (11252 bytes)
- [Financial examples — debit/credit reference](#financial-examples--debitcredit-reference) — `docs/FINANCIAL_EXAMPLES.md` (20667 bytes)
- [GL account codes — inventory and mapping guidance](#gl-account-codes--inventory-and-mapping-guidance) — `docs/FINANCIAL_GL_ACCOUNTS.md` (13809 bytes)
- [Financial test plan](#financial-test-plan) — `docs/FINANCIAL_TEST_PLAN.md` (16656 bytes)
- [Financial Test Matrix (FIN-TEST-03)](#financial-test-matrix-fin-test-03) — `docs/FINANCIAL_TEST_MATRIX.md` (19208 bytes)
- [Financial Integrity Test Suite (FIN-TEST-03)](#financial-integrity-test-suite-fin-test-03) — `docs/FINANCIAL_INTEGRITY_TEST_SUITE.md` (10207 bytes)
- [Financial Reconciliation Tests (FIN-TEST-03)](#financial-reconciliation-tests-fin-test-03) — `docs/FINANCIAL_RECONCILIATION_TESTS.md` (9978 bytes)
- [Financial Blocking Gates (FIN-TEST-03)](#financial-blocking-gates-fin-test-03) — `docs/FINANCIAL_BLOCKING_GATES.md` (11489 bytes)
- [Financial Module Synchronization Rules (FIN-TEST-03 — Gate 3)](#financial-module-synchronization-rules-fin-test-03--gate-3) — `docs/FINANCIAL_MODULE_SYNC_RULES.md` (8832 bytes)
- [Financial PR review checklist](#financial-pr-review-checklist) — `docs/FINANCIAL_REVIEW_CHECKLIST.md` (7999 bytes)
- [Financial migration guide](#financial-migration-guide) — `docs/FINANCIAL_MIGRATION_GUIDE.md` (10672 bytes)
- [Drizzle schema — accounting tables (`db/schema/acc/*.ts`)](#drizzle-schema--accounting-tables)

---


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- FILE: .agents/finance-guardian.md -->
<!-- ─────────────────────────────────────────────────────────────── -->

---
name: finance-guardian
version: 3.0
description: >
  Working-memory cheat sheet + escalation protocol for any
  autonomous session that touches financial code paths in
  kiwi-rentals. v3 (FIN-TEST-03) adds the Banking-Grade Financial
  Integrity Gate enforcement protocol: agent MUST declare which of
  the 16 gates each financial PR proves it passed, and apply the
  correct labels.
status: reference-only — not symlinked into .claude/skills
---

# Finance Guardian — v3 (with FIN-TEST-03 Banking-Grade Integrity Gate)

## §0a — Banking-Grade Financial Integrity Gate (FIN-TEST-03) — READ FIRST

Per `docs/BANKING_GRADE_FINANCIAL_INTEGRITY_GATE.md`.

**Hard rule (Gate 16):** any PR you open that touches financial
runtime, accounting, bank reconciliation, invoices, payments,
expenses, loans, lease billing, owner dashboard, or lender reports
MUST include in its description a **gate proof block**:

```markdown
## FIN-TEST-03 gate proof

| Gate                             | Required? | Proof                                              |
| -------------------------------- | --------- | -------------------------------------------------- |
| 1. Double-entry / trial balance  | YES/NO    | `tests/unit/financial/.../*.test.ts` (N new cases) |
| 2. Source-to-report traceability | YES/NO    | ...                                                |
| 3. Cross-module sync (flows A–F) | YES/NO    | ...                                                |
| 4. Subledger ↔ GL                | YES/NO    | ...                                                |
| 5. Bank reconciliation           | YES/NO    | ...                                                |
| 6. Report consistency            | YES/NO    | ...                                                |
| 7. Idempotency / concurrency     | YES/NO    | ...                                                |
| 8. Money math precision          | YES/NO    | ...                                                |
| 9. Period close                  | YES/NO    | ...                                                |
| 10. Audit trail                  | YES/NO    | ...                                                |
| 11. Permissions / SoD            | YES/NO    | ...                                                |
| 12. Import / data quality        | YES/NO    | ...                                                |
| 13. Anomaly detection            | YES/NO    | ...                                                |
| 15. CRE domain-specific          | YES/NO    | ...                                                |
```

(Gate 14 is framework planning; Gate 16 is enforced by labels.)

**If you cannot fill in the gate proof block honestly:**

1. Apply labels `financial-gate-missing` + `needs-review` + `no-auto-merge`.
2. STOP. Do not push for auto-merge.
3. File a follow-up sub-issue under FIN-TEST-03 (#399) for the missing tests.

**`pr-safety-check.mjs` hard-rejects auto-merge for any PR carrying:**
`financial-gate-missing`, `financial-integrity-failed`,
`reconciliation-failed`, `trial-balance-failed`, `subledger-gl-failed`,
`source-to-report-failed`, `no-auto-merge`, `review-required`,
`manual-danger-dispatched`, plus the existing 27 forbidden labels.

**Apply `*-passed` labels** when the corresponding gate's tests are
green: `trial-balance-passed`, `subledger-gl-passed`,
`source-to-report-passed`, `reconciliation-passed`,
`financial-integrity-passed`.

**Cross-references:**

- `docs/BANKING_GRADE_FINANCIAL_INTEGRITY_GATE.md` — master rule
- `docs/FINANCIAL_TEST_MATRIX.md` — gate × module grid
- `docs/FINANCIAL_RECONCILIATION_TESTS.md` — reconciliation specs
- `docs/FINANCIAL_INTEGRITY_TEST_SUITE.md` — file/folder layout
- `docs/FINANCIAL_MODULE_SYNC_RULES.md` — Gate 3 detail (6 flows)
- `docs/FINANCIAL_BLOCKING_GATES.md` — what blocks merge

---

# Finance Guardian — v2 (carried forward)

This document **supersedes** the v1 finance-guardian. New in v2:

- **Escalation Protocol** (§G-ESC) — explicit triggers and the
  exact action to take
- **Self-Improvement Hooks** (§G-SI) — how the guardian evolves
  without silent behavior change
- **Stop conditions** (§G-STOP) — non-negotiable halts
- **Forbidden actions** (§G-FORBID) — patterns that are never
  acceptable, no exceptions
- **Financial handoff requirements** (§G-HANDOFF) — exact
  contents needed before moving any financial issue to `Review`

## Authoritative source hierarchy

When two sources conflict, the higher row wins:

1. **Active law / IRS publication / FASB ASC.** Cite the specific
   publication.
2. **`docs/FINANCIAL_COMPLIANCE_NOTES.md`** — jurisdiction- and
   policy-specific overlays.
3. **`docs/FINANCIAL_LOGIC_RULES.md`** — the project rulebook.
4. **`docs/FINANCIAL_EXAMPLES.md`** — worked examples.
5. **`docs/FINANCIAL_GL_ACCOUNTS.md`** — code mapping.
6. **`docs/FINANCIAL_TEST_PLAN.md`** — test surface.
7. **`docs/FINANCIAL_REVIEW_CHECKLIST.md`** — handoff template.
8. **`docs/FINANCIAL_MIGRATION_GUIDE.md`** — for import code only.
9. **This file (Finance Guardian)** — when in doubt mid-task.
10. **CLAUDE.md "Financial Logic Gate"** — the gate that points
    at all of the above.

If you find a conflict between two of the above, **escalate**
(§G-ESC) — don't pick a side silently.

## When this file applies

Any task touching: `acc.*` schema, `pm.invoices`, `pm.payments`,
`pm.security_deposits`, `pm.recurring_charges`, anything with
`monthly_rent` or `balance_due`, `lib/billing/`, `lib/banking/`,
`lib/money/`, `app/(app)/{invoices,payments,banking,loans,mortgages,
tax-center}/` server-side, `app/api/cron/*`,
`app/api/webhooks/stripe/`, finance email templates, PDF rent-
roll/invoice exports, finance reports, Tax Center calculations.

When in doubt, treat as financial. False positive = checklist;
false negative = money bug.

## §G-RULES. The 14 hard rules (compressed reference)

Full text in `FINANCIAL_LOGIC_RULES.md`. One-line each:

1. Money is `Money` — no float, no `Number()`, no `+` on currency strings
2. Debit = credit asserted at app AND DB layer
3. No orphan postings — source linkage required
4. Posting in same DB tx as operational write
5. Closed periods immutable — corrections via reversing entry
6. No DELETE on `acc.*` or `pm.*` financial tables
7. Security deposits are liabilities until forfeited or applied
8. Advance rent is unearned revenue (accrual basis); §6 distinguishes book vs IRS tax treatment
9. Late fees are line items on existing invoice, dedupe per cycle
10. Concessions classified upfront (revenue vs operating), immutable after first posting
11. Overpayments are unapplied cash, never income
12. Allocations sum to ≤ payment amount, status atomic with allocation
13. Invoice numbers via atomic `nextNumber()`, never reused
14. All financial automation defaults OFF behind a feature flag, sandbox/test only until Tony approves

Plus, NEW in v2 from `FINANCIAL_LOGIC_RULES.md` §16-§19:

15. Loan payments split across principal/interest/escrow/fees per the amortization schedule (§16)
16. Bank reconciliation is its own state machine — matched/unmatched/disputed/written-off — never a silent edit (§17)
17. Owner contributions/distributions are equity events, NEVER income/expense (§18)
18. Fixed asset disposals separate book gain/loss from tax treatment, preserve the asset history (§19)

## §G-ESC. Escalation Protocol

The agent **MUST stop and ask Tony** when any of the following
trigger. Do not paper over with a workaround. Do not proceed with
"a sensible default."

### Triggers — escalate immediately

1. **Conflict between rules.** Two of the source-hierarchy
   documents say different things about the same scenario.
2. **A rule references a column / table that doesn't exist.**
   E.g. §AR3 references `core.legal_entities.accounting_basis`
   but the column hasn't been added yet. **Don't add the column
   silently** — that's a schema change requiring approval.
3. **A required GL account is missing from the seed.** See
   `FINANCIAL_GL_ACCOUNTS.md` "Seed status" column. The agent
   may NOT auto-create accounts at runtime per §J5.
4. **A scenario isn't covered by any rule.** E.g. a tenant pays
   the wrong invoice and asks the operator to "move the
   payment." There's no canonical reversal-and-reallocate path
   documented. Stop, propose a rule for review, don't
   improvise.
5. **A jurisdiction-specific rule applies but
   `FINANCIAL_COMPLIANCE_NOTES.md` doesn't list the
   jurisdiction.** E.g. Texas-specific late fee cap not
   documented.
6. **The 9 pre-implementation answers in the issue body are
   incomplete or hand-wavy.** Per §G-HANDOFF and the financial-
   task issue template, all 9 must be answered concretely
   before code starts.
7. **A test in §E of `FINANCIAL_TEST_PLAN.md` (or §E11-E15
   added in v2) cannot be written for a structural reason.**
   E.g. there's no auth fixture for cross-org leak testing
   yet. Don't skip the test silently — escalate.
8. **A change would touch a closed accounting period.** Even
   "to fix one record." §C1 forbids; escalate to discuss
   reversing-entry approach.
9. **An operator has asked to "delete" something that's a
   financial record.** Offer void / soft-delete / reversing
   entry. If they push back, escalate.
10. **Sandbox / production boundary unclear.** A code path
    might call a real Stripe live key, a real customer email,
    or production Supabase. STOP — verify and escalate.
11. **Florida commercial rent tax applies but the period or
    rate is uncertain.** Per §CN-FL of compliance notes.
12. **Migration / import scenarios beyond
    `FINANCIAL_MIGRATION_GUIDE.md`.** E.g. importing from a
    source not yet covered (Yardi, Buildium variant).
13. **Concurrency or race-condition risk you can't prove
    absent.** E.g. two crons might post the same journal entry
    at the same minute and the dedupe key isn't airtight.
14. **CPA / legal review is plausibly required** but the
    issue body doesn't mention it. Per the §CN-LEGAL
    disclaimer, escalate to Tony to arrange the review.

### Escalation action

When a trigger fires:

1. **Stop writing code immediately.** Do NOT commit
   half-finished work to "save progress."
2. **Post a comment on the issue** with:
   - Which trigger fired (reference §G-ESC.1 through .14)
   - What you were about to do
   - The specific question Tony needs to answer
   - A 2-3 line proposed default and the trade-off, if you
     have one
3. **Update the issue label** to add `human-decision-needed`
   AND remove `in-progress`.
4. **Wait for Tony's response in the issue thread.** Don't DM,
   don't ping in another channel — keep it in the audit trail.
5. When Tony answers, the answer becomes part of the rule
   record. Update `FINANCIAL_LOGIC_RULES.md` (or the relevant
   doc) in a follow-up commit if the answer reveals a rule
   gap (per §G-SI).

## §G-SI. Self-Improvement Hooks

The guardrails evolve as new scenarios surface. Improvements
must follow this protocol — silent rule changes are forbidden.

### Allowed changes (without escalation)

- Fixing a typo or clarifying ambiguous wording in any rule
  doc, IF the change does NOT alter the meaning of any rule.
- Adding a NEW worked example to `FINANCIAL_EXAMPLES.md` that
  illustrates an existing rule (no new rule introduced).
- Adding a NEW row to the GL inventory in
  `FINANCIAL_GL_ACCOUNTS.md` IF the account is being added in
  a separate seed migration (Tony-approved).

### Requires escalation (per §G-ESC)

- Any rule change that alters intended behavior (e.g. changing
  a default, adding/removing a hard rule, changing the meaning
  of an existing rule's posting pattern).
- Adding a new section to `FINANCIAL_LOGIC_RULES.md` — even
  if it documents existing behavior — because it becomes
  contract.
- Changing the source-hierarchy ordering above.
- Marking a rule as "deprecated" or "superseded."
- Changing the escalation triggers in this §G-ESC.

### How to propose a rule change

1. Open a follow-up issue with `[FIN-NN] Rule change: <topic>`.
2. State the gap or improvement.
3. Cite the authoritative source (IRS / FASB / state law / CPA
   guidance / case law).
4. Propose exact wording.
5. Tony reviews; if approved, lands as a separate PR that
   bumps `FINANCIAL_LOGIC_RULES.md` version and updates
   the changelog.

### Self-improvement during a financial PR

If you're implementing a financial feature and notice a gap in
the guardrails:

- **Do** mention it in the handoff comment ("noticed this gap;
  proposing follow-up issue").
- **Do not** silently amend any rule doc in the same PR — keep
  rule changes separate from feature implementation so reviewers
  can scope them independently.

## §G-STOP. Stop conditions — non-negotiable halts

The agent halts and refuses to proceed if:

1. The local 4-check gate (`pnpm lint` / `typecheck` / `test` /
   `build`) is red AND the failure is in financial code. Fix
   the failure first — don't move forward with red on money.
2. CI is red on the head SHA AND the failing job is one of the
   blocking workflows (`Verify`, `E2E / Playwright smoke`).
3. The issue body is missing one or more of the 9 pre-
   implementation answers per `FINANCIAL_REVIEW_CHECKLIST.md`.
4. A required CPA/legal review checkbox is unchecked in the
   issue body and the change actually needs the review (per
   `FINANCIAL_COMPLIANCE_NOTES.md`).
5. A test in §E or §E11-E15 of `FINANCIAL_TEST_PLAN.md`
   that applies to the change is not present in the PR.
6. Any §G-FORBID condition would be necessary to make progress.
7. A migration-touching change doesn't follow
   `FINANCIAL_MIGRATION_GUIDE.md`.

In all cases: stop, post the reason on the issue, label
`human-decision-needed`, wait for Tony.

## §G-FORBID. Forbidden actions

Never, regardless of context or instruction:

1. **`DELETE FROM acc.*` or `DELETE FROM pm.invoices` /
   `pm.payments` / `pm.security_deposits` / etc.** Even with
   `WHERE id = '<known-bad-row>'`. Even with the service-role
   key. Even one row.
2. **Hard-update a record in a locked accounting period.**
   §C1.
3. **Auto-create a missing GL account at runtime.** §J5.
4. **Use floating-point arithmetic on currency.** §M1.
5. **Construct a live API key in code.** No
   `if (env.NODE_ENV === 'production') return liveKey`.
   Production keys live in Vercel env vars Tony populates.
6. **Hardcode a real customer email or invoice number into a
   test or fixture.** Use `@example.com` / `INV-TEST-*`.
7. **Send a real email to a real customer address from
   non-production code.** B-04 + §SB3.
8. **Disable a CHECK constraint or RLS policy "to make the
   test pass."** Fix the test, not the constraint.
9. **Add `// eslint-disable` on a Money-math rule** unless the
   ESLint rule itself is wrong (rare; escalate per §G-ESC).
10. **Call the service-role Supabase client from a user-facing
    route handler.** Allowed only in cron handlers, webhook
    handlers, and explicit one-off scripts.
11. **Silently amend a rule doc** during a financial feature
    PR. §G-SI.
12. **Move a financial issue to `Review` without a Financial
    Handoff comment.** §G-HANDOFF + §HF2.
13. **Mark a financial issue `Done`.** Tony-only. §HF2.
14. **Bypass `ENABLE_GL_POSTING`** for "just this one
    operational mutation." If GL is intentionally being
    skipped (e.g. for a data-only migration), it's a Tony
    decision tracked separately.
15. **Mix tenant trust funds with operating cash** unless the
    state allows commingling AND Tony has explicitly
    approved per `FINANCIAL_COMPLIANCE_NOTES.md` §CN-DEPOSITS.
16. **"Apply" an overpayment to revenue** instead of
    `liability:unapplied_customer_credit`. §OP1.
17. **Treat a security deposit as income** at any point other
    than legitimate forfeiture per §SD3. The most common audit
    finding in property management.
18. **Run an import that hard-deletes anything** in
    `acc.*` / `pm.*`. §M1.
19. **Skip the §M8 trial-balance check** before accepting an
    opening-balance import.
20. **Bypass branch protection or required CI checks** to
    force a financial PR through.

## §G-HANDOFF. Financial handoff requirements

Every financial PR's `Review` move requires a comment on the
issue with EVERY field below filled. Fields with no relevance get
"N/A — <reason>", never blank.

### 1. Re-stated 9 pre-implementation answers

(From the issue body / financial-task template — restate them
here for the immutable record at handoff time.)

- Business logic summary
- Entities affected (R / W / RW)
- GL impact (specific accounts)
- Debit/credit example with realistic numbers
- Edge cases (each of E1-E15 — covered with test ref OR N/A)
- Data model impact
- Test plan
- Rollback plan
- Feature flag plan

### 2. The 6 post-implementation proofs

(From `FINANCIAL_REVIEW_CHECKLIST.md`)

1. Debit = credit (test ref)
2. Money math is decimal-safe (test ref)
3. No financial records deleted
4. Closed periods not mutated (test ref)
5. Duplicate prevention in place (test ref)
6. Edge case test coverage E1-E15 (per §5 above)

### 3. v2-specific impact disclosures

For each, "Yes — <details>" or "No":

- §16 (Loans / Debt) touched?
- §17 (Bank reconciliation) touched?
- §18 (Owner distributions / intercompany) touched?
- §19 (Fixed assets / depreciation) touched?
- Florida commercial rent tax (§CN-FL) impact?
- Migration / historical data (per `FINANCIAL_MIGRATION_GUIDE.md`)
  touched?
- Concurrency / idempotency risk introduced?
- Source-hierarchy category cited (which document is
  authoritative for this change)?
- CPA / legal review required AND scheduled / completed?
- Escalation triggered during implementation? If yes, link the
  escalation comment.

### 4. Health check evidence

- Local 4-check + format:check results
- CI workflow links on head SHA
- Browser QA evidence (if UI-touching) or "N/A — non-UI"

### 5. Reviewer sweep checks A-E pre-completed

(See `FINANCIAL_REVIEW_CHECKLIST.md`. Implementer ticks them
before handoff so reviewer verifies, doesn't fill in.)

A handoff missing any of the above → reject silently. Move
issue back to `in-progress`, request the missing fields.

## §G-DECISION. Decision flowchart at implementation time

```
Am I about to write money math?
├── Through Money class? → ✓ continue
└── Direct number/string arithmetic? → STOP, refactor

Am I about to insert into acc.* or pm.* financial table?
├── Did I check the period is open? → ✓ continue
└── Skipped the check? → STOP, add the period guard

Am I about to insert into acc.journal_entries?
├── Same DB tx as operational write? → ✓ continue
├── Source linkage populated? → ✓ continue
├── Total debits === total credits asserted? → ✓ continue
└── Any "no" above? → STOP, fix before posting

Am I about to DELETE from acc.* or pm.*?
└── STOP. Use void / soft-delete / reversing entry. §G-FORBID.1.

Am I about to send a real email to a real customer?
├── Through Resend with verified domain? Probably not (B-04 open)
└── STOP. Sandbox inbox, render-only test, or no-op the dispatch.

Am I about to add new automation (cron, webhook, server action)?
├── Behind a feature flag? → ✓ continue
└── No flag? → STOP, add flag with default false. §FF1.

Am I about to touch a Florida commercial rent invoice?
├── Period-aware tax computed per §CN-FL? → ✓ continue
└── Skipped or guessed at rate? → STOP, escalate. §G-ESC.11.

Am I about to import historical data?
└── Read FINANCIAL_MIGRATION_GUIDE.md first. If anything is
    unclear → STOP, escalate. §G-ESC.12.

Did I encounter a rule conflict or unwritten scenario?
└── STOP. Escalate per §G-ESC. Do NOT improvise.
```

## §G-SCENARIOS. Common scenarios and canonical answers

(See `FINANCIAL_EXAMPLES.md` for full worked examples.)

- **Tenant pays $X against $Y invoice (X < Y)** — partial; see
  Examples §3.
- **Tenant pays $X against $Y invoice (X > Y)** — overpayment
  → `liability:unapplied_customer_credit`; see Examples §4.
- **Late-fee cron retried within the hour** — dedupe by
  `(invoice_id, period)`; no-op.
- **Stripe webhook delivered twice** — dedupe via
  `core.webhook_events.event_id` UNIQUE; no-op.
- **Operator wants to "delete that wrong invoice"** — offer void;
  if already paid, reversing entry + refund. §G-FORBID.1.
- **Operator records payment with locked-period date** — reject
  with clear `PERIOD_LOCKED` error.
- **Forfeited deposit income** — `DR
liability:security_deposits_held / CR
income:forfeited_deposits`; refund of remainder is separate
  cash entry.
- **Concession added mid-lease** — new `pm.concessions` row;
  reclassification = void + new.
- **New automatic action** — new feature flag, default false.
- **Loan payment received** — split principal / interest /
  escrow / fees per §16; see Examples §17 + the new loan-
  servicing example.
- **Bank deposit matches multiple invoices** — single payment,
  multiple allocations; see Examples §16.
- **Owner distribution check** — equity event, NOT expense;
  see §18.
- **Property sold above book value** — disposal entry separates
  book gain (income) from cash receipt; see §19.

## §G-SHIP. Future hooks (not enforced today)

When the autonomous-dev hooks are eventually adopted (currently
disabled per `.agents/README.md`), the bundle's
`check-test-plan.sh` and `check-pr-review.sh` are the natural
surface for mechanically asserting the §G-HANDOFF requirements.
Until then, enforcement is manual via this doc + the issue
template + the review checklist.

The proposed but-not-yet-built automation (Tony's call when /
if to build):

- **Automated invariant checker in CI** — runs after every
  financial PR's tests, asserts: every new `acc.journal_entries`
  insert in the diff has matched debits/credits + source
  linkage, no `db.delete` against financial tables, no
  `Number()` on money.
- **Nightly self-improvement agent** — sweeps the day's PRs +
  comments for unwritten rules surfacing organically; opens
  follow-up issues per §G-SI.
- **Inngest workflow** — for multi-step financial reconciliation
  flows (e.g. month-end close).
- **Production financial monitoring** — Sentry / PostHog
  dashboards on financial mutation rates, error rates, and
  invariant violations.

These are documented as future work; they do NOT exist today
and this PR does NOT create them.

## Changelog

- **v2** (this revision) — Added §G-ESC, §G-SI, §G-STOP,
  §G-FORBID expanded to 20 items, §G-HANDOFF restructured to
  reflect v2 rule sections (§16-§19 + Florida + migration +
  concurrency + source hierarchy + CPA review + escalation
  status). Source hierarchy made explicit. Self-improvement
  protocol formalized. Decision flowchart extended with
  Florida + import branches.
- **v1** — Initial cheat sheet (compressed 14-rule reference).


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- FILE: docs/FINANCIAL_LOGIC_RULES.md -->
<!-- ─────────────────────────────────────────────────────────────── -->

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


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- FILE: docs/FINANCIAL_COMPLIANCE_NOTES.md -->
<!-- ─────────────────────────────────────────────────────────────── -->

# Financial compliance notes

Jurisdiction- and policy-specific rules that go beyond GAAP /
ASC 842 / IRS Pub 527. These are the items that vary by state,
by city, and by business decision — they don't belong in the
main rulebook because they may not apply to every operator, but
they DO belong somewhere reviewable.

> **Not legal or tax advice.** Every section below cites a
> jurisdiction-level rule that changes over time. The dates,
> percentages, and statute numbers reflect Claude's best research
> at authoring time and **must be re-verified** against the
> current state-agency or IRS publication before relying on them
> in a financial implementation. Section §CN-LEGAL at the bottom
> spells out the disclaimer in full.

## §CN-FL. Florida commercial rent sales tax (period-aware)

**Status.** Florida is the only US state that imposes a state
sales tax on commercial real estate rent. The tax has been on a
**multi-year phase-down**, with the most recent change
**eliminating the tax on rent for occupancy periods beginning
October 1, 2025 or later** (per Florida House Bill 7031,
effective in mid-2025). Rent for occupancy periods through
September 30, 2025 may still be subject to the prior rate, even
if invoiced or collected after October 1, 2025.

**The implementation rule.** Tax liability is keyed to the
**occupancy period**, NOT the invoice date or the payment date.
A January 2025 lease invoiced in November 2025 still owes the
2025-rate tax on the January 2025 occupancy.

Required for any code that touches commercial-rent invoices in
Florida properties:

1. Determine if the property is located in Florida
   (`pm.properties.state = 'FL'`) AND if the lease is commercial
   (`pm.leases.kind = 'commercial'`).
2. For each invoice line item that represents rent, compute the
   occupancy period the line covers.
3. Apply the FL rate effective for that occupancy period (lookup
   table — recent rates: pre-2024 ~5.5%, 2024 ~4.5%, Jan-Sep
   2025 ~2.0%, Oct 2025 onward ~0%).
4. Post the tax line item to `acc.invoices` with
   `kind = 'fl_commercial_rent_tax'` and a separate
   `liability:florida_commercial_rent_tax_payable` GL account
   (see `FINANCIAL_GL_ACCOUNTS.md`).
5. Remit per the operator's Florida sales-tax filing schedule
   (out of scope of FIN-01 — separate compliance feature).

**CPA / legal review requirement.** Before any code that computes
FL commercial rent tax goes live:

- A licensed Florida CPA or sales-tax specialist must confirm:
  - The current rate for each rate-window
  - The boundary dates (county discretionary surtaxes also exist
    and may not phase out in lockstep with the state portion)
  - The correct GL account categorization for the payable
- Operator must register with the Florida Department of
  Revenue if they haven't already

**Test requirement.** §CN-FL is on the test plan as a per-period
boundary check (see `FINANCIAL_TEST_PLAN.md` — Florida
period-awareness scenarios).

## §CN-DEPOSITS. Security deposits — state-by-state rules

US landlord-tenant law on security deposits varies on
**five dimensions**, every one of which has implementation
implications:

1. **Maximum deposit amount.** Caps differ — e.g. some states
   cap at one month's rent, others at two, others have no cap.
2. **Trust account / segregation requirement.** Some states
   (NJ, MA, NY for rentals over a threshold, CT for buildings
   ≥10 units, etc.) require the deposit be held in a
   segregated bank account, sometimes interest-bearing.
3. **Interest payable to tenant.** Some states require the
   landlord to pay interest on held deposits (annual rate set
   by state agency).
4. **Time limit for return.** Most states give 14-60 days from
   move-out to return or itemize forfeitures.
5. **Itemized statement requirements.** When forfeiture is
   claimed, an itemized statement of charges must be provided.

The implementation must:

- Track the lease's governing state (`pm.properties.state`
  drives this).
- Refuse to allow a deposit collection that exceeds the state
  cap (gated by §SD4 and the future
  `core.bank_accounts.is_trust_account` flag).
- Schedule interest accruals where required.
- Surface a "return-by date" alert at move-out per state rules.
- Generate an itemized forfeiture statement (PDF or email
  template) when §SD3 fires.

**Legal / CPA review requirement.** A real estate attorney
licensed in each state of operation must approve the per-state
ruleset before that state's data goes through this code path.

**Compliance scope today.** Crestview Holdings operates
primarily in Florida (verify with Tony). The Florida-specific
deposit rules:

- No statutory cap on amount.
- Within 30 days of move-out: either return the deposit OR
  send a notice of intent to claim, by certified mail. Tenant
  has 15 days to dispute.
- If the property has 5+ units, the deposit must be held in a
  separate non-interest-bearing account, OR a separate
  interest-bearing account (operator chooses), OR a surety
  bond.
- See: Florida Statutes §83.49

## §CN-LATE. Late fees — lease and law constraints

Late fees have THREE constraints that must all be satisfied
before assessment:

1. **Lease authorization.** The lease must explicitly authorize
   the fee and state amount + grace period. Driven by
   `pm.leases.late_fee_amount` and `pm.leases.grace_period_days`
   (per §LF4).
2. **State / city law.** Some jurisdictions cap late fees as a
   percentage of monthly rent (e.g. some California cities cap
   at 5%). Others require the fee be "reasonable" — case law
   has invalidated late fees deemed punitive.
3. **Operator policy.** The operator may have a stricter
   internal cap than law/lease allows.

The implementation must:

- Check all three before assessment. Reject if any fails.
- Log the rationale (which check was applied) in the late-fee
  line item's `notes` field for future audit / dispute defense.
- Provide a per-property override flag for operators who want
  to suppress late-fee assessment (e.g. during a relief
  period or pandemic-era moratorium).

**Legal review requirement.** State-by-state late-fee rules
must be approved by counsel for each state before code goes
live.

## §CN-TENANT-COMM. Tenant communications

Any automated email, SMS, or paper letter to a tenant from
this system that mentions money is **regulated content**.
Examples: rent reminders, late notices, payment receipts,
collection letters, deposit-itemization statements, balance
statements, legal notices.

Pre-production review requirements:

- **Counsel review.** A real estate / consumer-finance attorney
  must review every templated tenant communication BEFORE it
  ships to a real tenant.
- **State-specific debt collection law.** Late notices and
  pre-eviction communications can trigger Fair Debt Collection
  Practices Act (FDCPA) requirements if the operator is
  treated as a debt collector — varies by state and by whether
  the operator is the original creditor.
- **Consumer privacy.** Communications mentioning balances or
  deposits must respect state privacy law (e.g. CA CCPA, NY
  SHIELD).
- **Right-to-cure language.** Many states require eviction
  notices include specific language about how the tenant can
  cure the default.

**Operational rule.** Until counsel review is documented, no
automated email is sent to a real tenant address. This is the
B-04 blocker (Resend domain not yet verified) acting as a
backstop — but `ENABLE_*` flags and the §SB3 rule apply
independently.

## §CN-TAX-1099. Vendor 1099-NEC reporting

**Status.** US operators must file Form 1099-NEC for every
vendor paid more than $600 in a calendar year (other than
incorporated entities and certain exemptions). Filing deadline
is January 31 of the following year.

The implementation already tracks `core.contacts.is_1099_eligible`
and `core.contacts.w9_received_date`. The Tax Center
(`app/(app)/tax-center/`) generates the per-vendor amount
totals. What's NOT yet covered:

- Automatic 1099-NEC generation (PDF + e-file via IRS FIRE
  system or a third-party service).
- W-9 chasing automation for vendors approaching the $600
  threshold without a W-9 on file.
- Per-state 1099 reporting requirements that diverge from
  federal.

These belong in their own future issue (`[FIN-NN] 1099-NEC
filing`).

## §CN-TAX-1098. Mortgage interest reporting (Form 1098)

**Status.** Lenders issue Form 1098 to borrowers reporting
mortgage interest paid. The operator does NOT issue 1098 to
itself — they receive it from the lender. The implementation
must:

- Record loan interest paid per loan per tax year (already
  covered by the existing `acc.loan_payments.interest_amount`
  column).
- Reconcile against the lender-issued 1098 each January.
- Surface discrepancies (lender says we paid X, our books say
  Y) on the Tax Center page.

## §CN-DEPRECIATION-MACRS. Tax depreciation method

**Status.** US tax depreciation for real estate uses MACRS
(Modified Accelerated Cost Recovery System):

- Residential rental property: 27.5-year straight-line
- Commercial real property: 39-year straight-line
- Personal property in rental units (appliances, etc.): 5-7
  years, often 200% declining balance switching to
  straight-line

**Book vs tax depreciation often diverge.** GAAP (book)
depreciation may use a different method or useful life than
MACRS (tax). The implementation must track BOTH and reconcile
on the per-fiscal-year tax filing.

See §19 of `FINANCIAL_LOGIC_RULES.md` for the book-side rules.
Tax-side rules + reconciliation belong in a future
`[FIN-NN] MACRS depreciation + book/tax reconciliation`
issue.

## §CN-OPERATOR-LICENSE. Property management licensing

Many states require a property management company to hold a
real estate broker's license (or equivalent). Some states have
specific PM-only licenses. The implementation does NOT enforce
this — it's an operator-side compliance issue — but tenant
communications that imply license requirements (e.g. trust
account compliance language) should be reviewed by the operator's
counsel before going live.

## §CN-LEGAL. Disclaimer

This document is informational. It is **not legal advice and
not tax advice.** State landlord-tenant law, IRS rulings, FASB
updates, and case law change frequently. The dates, rates, and
statute numbers above reflect Claude's best research at the
time of authoring (May 2026) and may be outdated by the time
implementation lands.

Before any code that touches a regulated area (Florida sales
tax, security deposit handling per state, late fees, tenant
communications, 1099 filing, depreciation methods) goes to
production:

1. A licensed CPA must review the accounting treatment.
2. A licensed real estate attorney for the relevant state must
   review the customer-facing implications.
3. Tony approves the review documentation.

The role of THIS document is to be the checklist that triggers
those reviews — not to substitute for them.

## How to extend

Same process as `FINANCIAL_LOGIC_RULES.md`:

1. Open a `[FIN-NN]` issue describing the compliance gap.
2. Cite the authoritative source (state statute, IRS pub, FASB
   update).
3. Propose the rule wording for this file.
4. Tony reviews + approves; this doc gets a new section.


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- FILE: docs/FINANCIAL_EXAMPLES.md -->
<!-- ─────────────────────────────────────────────────────────────── -->

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


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- FILE: docs/FINANCIAL_GL_ACCOUNTS.md -->
<!-- ─────────────────────────────────────────────────────────────── -->

# GL account codes — inventory and mapping guidance

Authoritative inventory of every GL account code referenced in the
financial guardrails docs. Implementation must use the codes as
they exist in the seeded `acc.chart_of_accounts` table — these
human-readable names are placeholders.

This file exists because `FINANCIAL_EXAMPLES.md` uses readable
strings like `asset:cash_security_deposits` for clarity, but the
runtime codes (e.g. `1110`, `2210`) live in
`acc.chart_of_accounts` (seeded by migration 0008).

## How to use this file

When implementing a financial mutation:

1. Look up the placeholder string from `FINANCIAL_EXAMPLES.md`.
2. Find its row in the table below.
3. Use the **`acc.chart_of_accounts.code`** value (looked up
   programmatically) — never the placeholder string and never the
   human-readable name in code.
4. If the row says **MISSING** in the seed-status column, that
   account doesn't exist yet. Add it to the seed (separate
   migration, separate PR) BEFORE the financial code that
   references it lands. Don't auto-create at runtime — §J5 of
   `FINANCIAL_LOGIC_RULES.md` forbids that.

## Account categories

GAAP-style five-category classification. The first digit of the
proposed code maps to the category:

| First digit | Category         | Normal balance |
| ----------- | ---------------- | -------------- |
| `1xxx`      | Asset            | Debit          |
| `2xxx`      | Liability        | Credit         |
| `3xxx`      | Equity           | Credit         |
| `4xxx`      | Revenue / Income | Credit         |
| `5xxx`      | Expense          | Debit          |

Sub-ranges are convention, not enforced by the schema:

- `11xx` — Cash + cash equivalents
- `12xx` — Receivables
- `13xx` — Prepaids + other current assets
- `14xx` — Property, plant & equipment (PP&E) + accumulated depreciation
- `21xx` — Accounts payable + accrued
- `22xx` — Tenant-related liabilities (deposits, unearned rent, customer credits)
- `23xx` — Loan principal + interest payable
- `24xx` — Tax payable (sales tax, payroll tax)
- `41xx` — Rental revenue
- `42xx` — Other revenue (late fees, forfeited deposits, etc.)
- `51xx` — Operating expense
- `52xx` — Interest + finance expense
- `53xx` — Depreciation + amortization
- `54xx` — Tax expense

## Inventory of placeholder codes used in `FINANCIAL_EXAMPLES.md`

The "Seed status" column reflects what's expected to exist after
migration 0008 (the chart-of-accounts seed). Verify against the
actual seed file before relying on this — Claude has not opened
the migration file in this PR.

### Asset accounts

| Placeholder string in docs       | Proposed code | Description                                                    | Seed status                       |
| -------------------------------- | ------------- | -------------------------------------------------------------- | --------------------------------- |
| `asset:cash_operating`           | `1110`        | Operating bank account cash                                    | expected in seed                  |
| `asset:cash_security_deposits`   | `1120`        | Segregated security-deposit cash (trust where required)        | expected in seed                  |
| `asset:accounts_receivable`      | `1210`        | Tenant receivables                                             | expected in seed                  |
| `asset:deferred_rent_receivable` | `1220`        | ASC 842 straight-line excess (commercial)                      | **VERIFY in seed** — added for v2 |
| `asset:property_book_value`      | `1410`        | PP&E gross (per property)                                      | **VERIFY in seed**                |
| `asset:accumulated_depreciation` | `1419`        | Contra-asset, normal credit balance — note this is an asset CR | **VERIFY in seed**                |

### Liability accounts

| Placeholder string in docs                      | Proposed code | Description                                                                          | Seed status                                                |
| ----------------------------------------------- | ------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `liability:accounts_payable`                    | `2110`        | Vendor payables                                                                      | expected in seed                                           |
| `liability:security_deposits_held`              | `2210`        | Tenant deposits held — liability until forfeited or applied                          | expected in seed                                           |
| `liability:unearned_rent`                       | `2220`        | Rent received for future periods (accrual basis)                                     | expected in seed                                           |
| `liability:unapplied_customer_credit`           | `2230`        | Overpayments / credit balances awaiting application                                  | expected in seed                                           |
| `liability:deferred_rent_credit`                | `2240`        | ASC 842 straight-line excess (commercial — opposite side of `1220`)                  | **VERIFY in seed**                                         |
| `liability:loan_principal`                      | `2310`        | Mortgage / loan principal balance                                                    | expected in seed                                           |
| `liability:loan_interest_payable`               | `2320`        | Accrued interest not yet paid                                                        | **VERIFY in seed**                                         |
| `liability:loan_escrow_held`                    | `2330`        | Lender-held escrow (taxes / insurance)                                               | **VERIFY in seed**                                         |
| `liability:florida_commercial_rent_tax_payable` | `2410`        | FL sales tax on commercial rent (period-aware — see `FINANCIAL_COMPLIANCE_NOTES.md`) | **MISSING — add for v2 if any FL commercial leases exist** |

### Equity accounts

| Placeholder string in docs                 | Proposed code          | Description                                                              | Seed status                                         |
| ------------------------------------------ | ---------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| `equity:owner_contributions`               | `3110`                 | Per-entity owner-contributed capital                                     | expected in seed                                    |
| `equity:owner_distributions`               | `3120`                 | Per-entity distributions to owners (contra-equity, debit normal)         | expected in seed                                    |
| `equity:retained_earnings`                 | `3210`                 | Cumulative retained earnings                                             | expected in seed                                    |
| `equity:current_year_earnings`             | `3220`                 | Year-to-date net income (closes to retained earnings at fiscal year-end) | expected in seed                                    |
| `equity:intercompany_due_from_<entity_id>` | `3310-3399` (per pair) | Intercompany receivable from another entity in the same org              | **VERIFY in seed** — may need per-pair sub-accounts |
| `equity:intercompany_due_to_<entity_id>`   | `3410-3499` (per pair) | Intercompany payable to another entity                                   | **VERIFY in seed**                                  |

### Revenue accounts

| Placeholder string in docs      | Proposed code | Description                                                   | Seed status        |
| ------------------------------- | ------------- | ------------------------------------------------------------- | ------------------ |
| `income:rental_revenue`         | `4110`        | Recognized rental income                                      | expected in seed   |
| `income:late_fee_revenue`       | `4210`        | Late fees billed (separate from rental for tax/audit clarity) | expected in seed   |
| `income:forfeited_deposits`     | `4220`        | Forfeited security deposits — income event per §SD3           | expected in seed   |
| `income:nsf_fee_revenue`        | `4230`        | Bounced check / NSF fees passed to tenant                     | **VERIFY in seed** |
| `income:other_property_revenue` | `4290`        | Misc property income (laundry, parking, signage)              | optional           |
| `income:gain_on_disposal`       | `4310`        | Book gain on asset disposal (see §19)                         | **VERIFY in seed** |

### Expense accounts

| Placeholder string in docs             | Proposed code | Description                                    | Seed status        |
| -------------------------------------- | ------------- | ---------------------------------------------- | ------------------ |
| `expense:repairs_maintenance`          | `5110`        | Property maintenance                           | expected in seed   |
| `expense:property_management_fee`      | `5120`        | Mgmt-fee expense on a per-property basis       | expected in seed   |
| `expense:insurance`                    | `5130`        | Property insurance premium expense             | expected in seed   |
| `expense:property_tax`                 | `5140`        | Real estate tax expense                        | expected in seed   |
| `expense:utilities`                    | `5150`        | Owner-paid utilities                           | expected in seed   |
| `expense:lease_incentive_amortization` | `5160`        | Concessions classified as operating per §CN1   | **VERIFY in seed** |
| `expense:bad_debt_writeoff`            | `5170`        | Uncollectible AR write-offs                    | **VERIFY in seed** |
| `expense:processor_fees`               | `5180`        | Stripe / ACH / wire fees                       | **VERIFY in seed** |
| `expense:interest_expense`             | `5210`        | Loan interest expense                          | expected in seed   |
| `expense:finance_charges`              | `5220`        | Late charges paid TO lenders                   | optional           |
| `expense:depreciation`                 | `5310`        | Periodic depreciation expense                  | **VERIFY in seed** |
| `expense:amortization`                 | `5320`        | Amortization of intangibles / lease incentives | optional           |
| `expense:loss_on_disposal`             | `5410`        | Book loss on asset disposal (see §19)          | **VERIFY in seed** |

## Lookup convention in code

Don't hardcode either the code (`1110`) or the readable name
(`asset:cash_operating`) at call sites. Define a typed helper:

```ts
// lib/accounting/gl-accounts.ts (proposed; not yet implemented)
import { db } from "@/lib/db";
import { chartOfAccounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export type GlAccountSlug =
  | "cash_operating"
  | "cash_security_deposits"
  | "accounts_receivable"
  | "security_deposits_held"
  | "unearned_rent"
  | "unapplied_customer_credit"
  | "rental_revenue"
  | "late_fee_revenue"
  | "forfeited_deposits"
  | "loan_principal"
  | "interest_expense";
// ... etc

export async function resolveGlAccountId(
  orgId: string,
  slug: GlAccountSlug,
): Promise<string> {
  const row = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(
      and(eq(chartOfAccounts.orgId, orgId), eq(chartOfAccounts.slug, slug)),
    )
    .limit(1);
  if (!row[0]) {
    throw new Error(
      `GL account slug "${slug}" not found for org ${orgId} — see docs/FINANCIAL_GL_ACCOUNTS.md`,
    );
  }
  return row[0].id;
}
```

This keeps the docs (slug strings) as the integration contract,
and the seed (code numbers) as the deployable artifact.

## Adding a new GL account

When a financial implementation needs a code that's MISSING above
or has **VERIFY** status that turns out to be unset:

1. Add the row to the chart-of-accounts seed (new migration).
2. Update the table in this file with the assigned code +
   `confirmed-in-seed-NNNN` status.
3. Reference the slug (not the code) in your application code.
4. The `resolveGlAccountId` helper will fail loudly if the seed
   isn't deployed yet — that's the right failure mode (§J5).

## Cross-org scoping

Every account in `acc.chart_of_accounts` is org-scoped by default
(per the existing schema). Codes can be reused across orgs (every
org has its own `1110`). Don't assume a single global chart.

## Open question for CPA review

- **Intercompany accounts.** §18 needs accounts paired by
  `(from_entity, to_entity)`. The proposed `3310-3399` /
  `3410-3499` ranges are wide enough for ~90 entity pairs.
  Real implementations sometimes use a single
  `intercompany_clearing` account with the entity recorded as a
  per-line dimension. CPA call.
- **Florida sales tax payable.** Period-aware; see
  `FINANCIAL_COMPLIANCE_NOTES.md`. The `2410` proposed code is
  reserved but the account only needs to exist in orgs that have
  taxable FL commercial leases.
- **Per-property sub-accounts vs single GL with property
  dimension.** Most modern PM systems track per-property data
  via a dimension column rather than a per-property GL account.
  Stick with the dimension (`acc.journal_entry_lines.property_id`)
  and keep one GL per category. CPA review.


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- FILE: docs/FINANCIAL_TEST_PLAN.md -->
<!-- ─────────────────────────────────────────────────────────────── -->

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


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- FILE: docs/FINANCIAL_TEST_MATRIX.md -->
<!-- ─────────────────────────────────────────────────────────────── -->

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


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- FILE: docs/FINANCIAL_INTEGRITY_TEST_SUITE.md -->
<!-- ─────────────────────────────────────────────────────────────── -->

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


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- FILE: docs/FINANCIAL_RECONCILIATION_TESTS.md -->
<!-- ─────────────────────────────────────────────────────────────── -->

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


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- FILE: docs/FINANCIAL_BLOCKING_GATES.md -->
<!-- ─────────────────────────────────────────────────────────────── -->

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


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- FILE: docs/FINANCIAL_MODULE_SYNC_RULES.md -->
<!-- ─────────────────────────────────────────────────────────────── -->

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


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- FILE: docs/FINANCIAL_REVIEW_CHECKLIST.md -->
<!-- ─────────────────────────────────────────────────────────────── -->

# Financial PR review checklist

The pre-merge gate for any PR classified as **financial** per §15
of `FINANCIAL_LOGIC_RULES.md`. Reviewers (Tony, or any second
agent) work top to bottom. A `[ ]` left unchecked or unaddressed
blocks merge.

This is also the **handoff comment template** the implementing
agent must post on the GitHub Issue when moving it to `Review`.

---

## Authoring side: 9 pre-implementation answers

These must appear in the issue body (template
`.github/ISSUE_TEMPLATE/financial-task.md`) BEFORE implementation
starts. If the issue is missing any of these, stop and ask Tony to
fill them in — don't implement against an under-specified financial
spec.

### 1. Business logic summary

A 3-5 sentence plain-English description of what the operator wants
this code path to do. Include the trigger, the actor, and the
expected human-visible outcome.

### 2. Entities affected

Which DB tables are read AND which are written. Mark each with
`R` / `W` / `RW`.

### 3. GL impact

Which GL accounts get debited / credited. Reference codes from
`acc.chart_of_accounts`. If the path is purely operational (no
journal entry), say so explicitly.

### 4. Debit/credit example

A concrete example like the ones in `FINANCIAL_EXAMPLES.md` —
with real-looking numbers — showing one full journal entry that
the new code will produce. Reviewers compare this against §J of
`FINANCIAL_LOGIC_RULES.md`.

### 5. Edge cases

Which scenarios from §E of `FINANCIAL_TEST_PLAN.md` apply. For
each: covered (with test ref) or affirmatively N/A (with reason).

### 6. Data model impact

New columns? New tables? Migration number? Any RLS policy delta?
Any new INDEX needed? If "no schema changes" — say it.

### 7. Test plan

Which §A / §B / §C / §D / §E / §F / §G / §H tests will land in
the same PR. Skipping a category requires a written carve-out.

### 8. Rollback plan

If this lands and turns out wrong:

- Pure code revert (`git revert`)? OK to say so.
- Schema revert (down migration)?
- Data fix (reversing entries for posted records)?
- Feature flag flip-off?

### 9. Feature flag plan

Which flag from §12 of `FINANCIAL_LOGIC_RULES.md` gates this. If a
new flag is introduced, name it (`ENABLE_*`) and document the
default (must be `false`) plus the per-org enablement steps.

---

## Implementer side: 6 post-implementation proofs

After implementation, the handoff comment must demonstrate:

### 1. Debit = credit

For each new journal-entry posting path:

- ☐ Test reference proving balance assertion (§B of test plan)
- ☐ DB trigger assertion is NOT the only guard (application
  layer also asserts pre-insert)

### 2. Money math is decimal-safe

- ☐ All arithmetic on currency values goes through `Money`
- ☐ No `Number(...)` / `+` / `-` on currency strings or columns
- ☐ Test reference proving precision (§A of test plan)

### 3. No financial records deleted

- ☐ No `db.delete(...)` against `acc.*` tables in the PR
- ☐ No `DELETE FROM acc.*` in any new SQL
- ☐ Void / soft-delete / reversing-entry path used instead

### 4. Closed periods not mutated

- ☐ Mutations check `acc.accounting_periods.is_locked` before
  posting
- ☐ Effective-date inside locked period → mutation rejected
  with clear error
- ☐ Test reference (§C of test plan)

### 5. Duplicate prevention

- ☐ Mutation has a dedupe key (Stripe event ID, period+lease,
  invoice_id, etc.)
- ☐ Re-running the same mutation produces no duplicate
  operational record AND no duplicate journal entry
- ☐ Test reference (§D of test plan)

### 6. Test coverage of edge cases

- ☐ Partial payment (E1)
- ☐ Overpayment (E2)
- ☐ Duplicate payment (E3)
- ☐ Voided invoice (E4)
- ☐ Backdated transaction (E5)
- ☐ Security deposit lifecycle (E6)
- ☐ Late fee duplication (E7)
- ☐ Closed period correction (E8)
- ☐ Concession application (E9)
- ☐ Concurrent allocation (E10)
- ☐ Loan payment 4-component split (E11)
- ☐ Duplicate bank import (E12)
- ☐ Owner contribution / distribution (E13)
- ☐ Fixed asset disposal (E14)
- ☐ Concurrent generation umbrella (E15)

For each line: covered (with test ref) OR affirmatively N/A
(with reason). "Not applicable" without a reason is rejected.

---

## v2 impact disclosures (mandatory in handoff comment)

In addition to the 6 proofs above, the handoff comment must
disclose impact on v2-specific surfaces. For each: "Yes —

<details>" or "No":

### F. v2 section impact

- ☐ §16 (Loans / Debt) touched?
- ☐ §17 (Bank reconciliation) touched?
- ☐ §18 (Owner distributions / intercompany) touched?
- ☐ §19 (Fixed assets / depreciation) touched?

### G. Compliance impact

- ☐ Florida commercial rent tax (§CN-FL) impact?
- ☐ Other jurisdiction-specific rules in
  `FINANCIAL_COMPLIANCE_NOTES.md` impacted?

### H. Migration / historical data

- ☐ Migration / historical data per
  `FINANCIAL_MIGRATION_GUIDE.md` touched?
- ☐ Opening balance / closed-period considerations
  applicable?

### I. Concurrency / idempotency

- ☐ Concurrency / idempotency risk introduced?
- ☐ §PC1-§PC8 rules applied?
- ☐ Idempotency key documented + tested?

### J. Source hierarchy + reviews

- ☐ Source hierarchy category cited (which doc was
  authoritative for this change)?
- ☐ CPA / legal review required AND scheduled / completed?
- ☐ Escalation triggered during implementation? If yes, link
  the escalation comment.

---

## Reviewer side: 12 sweep checks

The reviewer (human or second agent) confirms:

### A. Scope sanity

- ☐ The change is limited to the issue's stated entities (no
  scope creep into unrelated tables / actions)
- ☐ The change does NOT touch payments, invoices, tenants, auth,
  database schema, API integrations, `.env.local`, or
  production secrets unless the issue explicitly authorizes it

### B. Restriction sanity

- ☐ No live API keys constructed in code
- ☐ No real customer email addresses hardcoded
- ☐ No production secrets committed
- ☐ Service-role Supabase client is NOT used in user-facing code
  paths (only allowed in cron handlers / webhook handlers / one-
  off scripts)

### C. Audit / observability

- ☐ Mutations leave `core.audit_log` rows (verified via the
  audit-log smoke test or new specific test)
- ☐ Errors are logged in a way Sentry will capture (rejected
  mutations are not silently swallowed)

### D. Feature flag

- ☐ The new path is gated by a flag from §12
- ☐ Default is OFF
- ☐ Flag check is at the entry point, not deep in the code
- ☐ Documentation states how Tony enables it for an org

### E. Tests passing

- ☐ All four health checks green (`pnpm lint` /
  `pnpm typecheck` / `pnpm test` / `pnpm build`)
- ☐ Smoke E2E green
- ☐ Newly-required integration tests included AND green
- ☐ Coverage of edge cases per the implementer's "6 post-
  implementation proofs" claim is real (reviewer reads the test
  files, not just the claim)

---

## Carve-out etiquette

If a check legitimately doesn't apply, name it explicitly:

> "Edge case E10 (Concurrent allocation) — N/A because this PR
> only adds a read path on `acc.payments`, no allocation writes."

If a check applies but you can't satisfy it in this PR, escalate:

> "Edge case E5 (Backdated transaction) — implementation
> postponed to a follow-up. Tracked in #NN. This PR does not
> introduce any new mutation that could backdate, so the gap
> doesn't widen."

Don't invent passes. The cost of a missed financial bug is
materially higher than the cost of a delayed PR.

---

## When to call this checklist DONE

The implementer's handoff comment (move to `Review`) includes:

- All 9 pre-impl answers (re-stated for the reviewer's
  convenience)
- All 6 post-impl proofs with test refs OR carve-outs
- Sweep checks A–E pre-completed by the implementer

Reviewer's job is then to verify, not to fill in.

The PR can move from `Review` → merged once Tony approves. The
issue moves from `Review` → `Done` only by Tony.


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- FILE: docs/FINANCIAL_MIGRATION_GUIDE.md -->
<!-- ─────────────────────────────────────────────────────────────── -->

# Financial migration guide

Rules for importing historical financial data from a prior system
(spreadsheets, QuickBooks, AppFolio, Buildium, Yardi, etc.) into
Kiwi Rentals. Companion to `FINANCIAL_LOGIC_RULES.md` — the rules
say how new transactions must behave; this guide says how legacy
transactions get loaded WITHOUT breaking those rules.

Every rule below is a hard requirement for any import that lands in
production data. Violating one of these in a one-off script ruins
the audit trail forever — there is no clean rollback once mixed
with new live data.

---

## §M1. No destructive imports

**Rule.** Imports never `TRUNCATE`, `DROP`, or hard-`DELETE`
financial tables. If a re-import is needed, void or soft-delete
the prior import batch and run a fresh batch with a new
`import_batch_id` — see §M9.

> _Why._ §D1 of `FINANCIAL_LOGIC_RULES.md` forbids hard-delete on
> financial records. That rule applies to imports too — historical
> data is just as load-bearing as live data.

## §M2. Preserve source dates AND import dates

**Rule.** Every imported row carries TWO timestamps:

- `effective_date` (or domain-specific equivalent like
  `issue_date`, `payment_date`, `transaction_date`) — the date
  the event happened in the source system. Used for reporting,
  period assignment, and accounting basis.
- `imported_at` — wall-clock time the row was inserted into
  Kiwi Rentals. Used for audit and dedup.

Never collapse these into one. Reports needs `effective_date`;
audits need `imported_at`.

## §M3. Explicit opening balances

**Rule.** The first imported batch must include opening-balance
journal entries that bring the chart of accounts to the trial-
balance state at a chosen `as_of_date`. After that batch, every
subsequent transaction is normal accrual / cash posting.

The opening-balance entry pattern:

```
DR  asset:cash_operating              <opening cash>
DR  asset:accounts_receivable         <opening AR>
DR  asset:property_book_value         <opening PP&E>
... (all asset accounts)
CR  liability:loan_principal          <opening loan principal>
CR  liability:security_deposits_held  <opening deposits held>
... (all liability accounts)
CR  equity:retained_earnings          <opening RE>
... (all equity accounts)
```

Source: `acc.journal_entries` with
`source_type = 'opening_balance_import'` and `source_id = <batch_id>`.

The entry must balance per §J1.

## §M4. Reconcile beginning AR/AP to source reports

**Rule.** Before accepting an opening-balance batch:

1. Run an AR aging report from the source system as of
   `as_of_date`.
2. Sum its outstanding by tenant.
3. Insert opening AR invoices in Kiwi Rentals (see §M6).
4. Run Kiwi Rentals' AR aging report as of the same date.
5. Sums must match to the cent.
6. Same exercise for AP if the source carries vendor invoices.

If the totals don't match, **stop the import**. Don't paper over
with an "adjustment" entry — find and fix the discrepancy in the
import data first.

## §M5. Idempotent invoice / payment imports

**Rule.** Every import script uses `(import_batch_id, legacy_id)`
as a UNIQUE dedupe key. Re-running the same import with the same
batch ID is a no-op (no duplicate inserts, no errors).

Concretely on Drizzle: add a partial unique index OR a check
constraint on `(import_batch_id, legacy_id)` in the
`imported_invoices` / `imported_payments` mapping tables, OR
include `(import_batch_id, legacy_id)` as a filter in the upsert
target.

Spec stays high-level here; implementation in the migration PR.

## §M6. Preserve legacy IDs

**Rule.** Each imported row stores its source-system identifier in
a dedicated column (`legacy_id`, `source_invoice_number`, etc.).
Don't try to remap to Kiwi Rentals invoice numbering — preserve
both:

- `acc.invoices.invoice_number` — Kiwi Rentals' atomic
  `nextNumber()` value (never reused, per §IN3)
- `acc.invoices.legacy_invoice_number` — what the tenant has on
  paper from the prior system

Reports default to showing both during a transition period.

## §M7. Bank transaction dedupe

**Rule.** Bank transactions have a natural unique key:
`(bank_account_id, posted_date, amount, source_provider_id)`.
Imports must respect it. Re-importing the same transaction
file produces no duplicates and no errors.

For sources without a stable provider ID (CSV from a paper
statement), fall back to a content hash of normalized fields
(date + amount + description) and dedupe on that. Document the
fallback in the import script's header comment.

## §M8. Trial balance must balance before acceptance

**Rule.** After an opening-balance batch lands:

1. Sum all DR amounts across all accounts.
2. Sum all CR amounts.
3. They must be equal to the cent.
4. The accounting equation must hold: Assets = Liabilities +
   Equity.

If either fails, void the batch (§M9) and re-import after fixing
the source data.

A pre-import dry-run mode that runs the trial-balance check WITHOUT
inserting anything is a hard requirement of any new importer.

## §M9. Close / lock prior periods after import

**Rule.** Once an opening-balance batch is verified per §M8, the
operator must:

1. Close every accounting period prior to `as_of_date` by
   setting `acc.accounting_periods.is_locked = true` for those
   periods.
2. After lock, those periods become immutable per §C1.
3. Document in the import batch log: which periods were locked,
   when, by whom.

This prevents future "edit a 2022 invoice" bugs from corrupting
pre-Kiwi-Rentals history.

## §M10. Import batch logs

**Rule.** Every import run creates a row in `core.import_batches`
(table to be added in the migration PR — not in scope of FIN-01)
with:

- `batch_id` (UUID)
- `source_system` (e.g. `'appfolio'`, `'csv'`, `'quickbooks'`)
- `as_of_date`
- `imported_at` (UTC)
- `imported_by_user_id`
- `entity_count` (per imported entity type — invoices: N,
  payments: M, etc.)
- `trial_balance_check_result` (`'pass'` / `'fail'` / `'skipped'`)
- `dry_run` (boolean — was this a dry run?)
- `notes` (free text)
- `source_files` (JSONB of file checksums + names if loaded
  from CSVs)

The log is queryable forever and feeds the rollback path in §M11.

## §M11. Rollback by batch, not by deleting financial records

**Rule.** When an import batch needs to be reverted (bad source
file, wrong as-of-date, schema mismatch caught after the fact):

1. Insert reversing journal entries that cancel every entry
   tagged with `source_id = <batch_id>`.
2. Soft-delete the operational records imported in the batch (set
   `deleted_at` — do NOT hard-DELETE per §M1 / §D1).
3. Mark `core.import_batches.reversed_at` and
   `reversed_by_user_id`.
4. Update `core.audit_log` with a single entry summarizing the
   reversal.
5. Document the reason for reversal in the batch log notes.

After reversal, a fresh import with a new batch ID can run.

## §M12. Concurrency during import

**Rule.** Imports lock the org against new financial mutations
for the duration:

1. Set a transient flag in `core.app_settings` like
   `import_in_progress.{orgId} = batch_id`.
2. Mutation server actions check the flag at the entry point
   (§FF2) and return a clear "import in progress, try again in N
   minutes" error.
3. Clear the flag in a `finally` block — never leave it set if
   the import crashes (the importer's start-of-batch cleanup
   should also force-clear stale flags older than 24h).

This prevents racy double-counts (operator manually creates an
invoice while the importer is mid-load).

## §M13. CPA review for opening balances

**Rule.** The first import for any org must have a CPA review the
opening balance entries before §M9 lock. Specifically:

- Trial balance ties to source-system trial balance
- Account categorization matches the chart-of-accounts seed
  (no expense booked to revenue, no liability booked to equity)
- Cash basis vs accrual basis is correctly stated per
  `core.legal_entities.accounting_basis`
- Tax-period boundaries are correct (e.g. fiscal year vs
  calendar year)

If the operator has no CPA, escalate to Tony — he'll either
arrange one or accept written sign-off. The import doesn't
land in production without one of those.

## §M14. Multi-source migrations

**Rule.** When migrating from N sources (e.g. spreadsheet for
older history + AppFolio for recent), each source gets its own
batch, in chronological order, with each batch's `as_of_date`
matching the prior batch's end of coverage.

Don't interleave sources within a single batch — debugging
becomes impossible.

## §M15. Source-data archival

**Rule.** The raw source files (CSVs, QBO exports, JSON dumps)
are archived to `core.documents` with `kind = 'import_source'`
and the import batch ID. Never thrown away after the import. Audit
might need them years later.

Storage path follows the standard sha256-content-addressed scheme
(`<orgId>/<sha256>.<ext>`).

## §M16. Tenant security deposit re-classification

**Rule.** A common opening-balance gotcha: prior systems often
booked all tenant deposits to a single liability account, OR
sometimes (incorrectly) to revenue. The importer must:

1. Read the source's deposit ledger.
2. Map each deposit to the correct Kiwi Rentals classification
   (refundable security deposit per §SD1, last-month-rent
   prepayment per §AR4, damage retention etc. per
   `FINANCIAL_LOGIC_RULES.md`).
3. Post per-tenant entries to the right liability account.
4. NEVER auto-classify legacy "deposits" as forfeited income
   without explicit operator confirmation per deposit.

If the source booked deposits to revenue: the import posts a
correcting entry that moves them out of revenue and into
liability, with `source_type = 'deposit_reclassification_import'`
for audit clarity.

## What this guide does NOT cover

- The actual schema for `core.import_batches`, `imported_invoices`,
  `imported_payments` tables — those are migration-PR territory.
- The CSV column-mapping logic per source system — per-importer
  spec.
- Customer-specific data scrubbing rules (PII, archived tenants,
  etc.) — privacy review territory.
- Post-import reconciliation reports — deserves its own design
  doc when the importer lands.

## Cross-references

- §C1, §C2, §C3 of `FINANCIAL_LOGIC_RULES.md` (closed-period
  immutability — applies to imported periods after §M9 lock)
- §D1 of `FINANCIAL_LOGIC_RULES.md` (no DELETE on financial
  records — applies to imports)
- §J1, §J2 of `FINANCIAL_LOGIC_RULES.md` (debit=credit, source
  linkage — applies to opening-balance entries)
- `FINANCIAL_COMPLIANCE_NOTES.md` (Florida commercial rent tax,
  trust-account rules — must be respected during import)


<!-- ─────────────────────────────────────────────────────────────── -->
<!-- Drizzle schema — accounting tables (db/schema/acc/*.ts) -->
<!-- ─────────────────────────────────────────────────────────────── -->

## Drizzle schema — accounting tables

Source: `db/schema/acc/*.ts`. These are the canonical table definitions for the accounting schema. All financial rules above reference these tables.


### `db/schema/acc/accounting_periods.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { legalEntities, organizations, users } from "../core";

export const PERIOD_TYPES = ["monthly", "quarterly", "annual"] as const;
export const PERIOD_STATUSES = ["open", "closed", "locked"] as const;

export const accountingPeriods = accSchema.table(
  "accounting_periods",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id").references(() => legalEntities.id, {
      onDelete: "cascade",
    }),
    periodType: text("period_type").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    status: text("status").notNull().default("open"),
    closedBy: uuid("closed_by").references(() => users.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedNotes: text("closed_notes"),
    lockedBy: uuid("locked_by").references(() => users.id),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockApprovalRequestId: uuid("lock_approval_request_id"),
    unlockCount: integer("unlock_count").notNull().default(0),
    linkedXeroPeriodId: text("linked_xero_period_id"),
    xeroSyncedAt: timestamp("xero_synced_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("periods_unique").on(
      t.orgId,
      t.entityId,
      t.periodStart,
      t.periodEnd,
      t.periodType,
    ),
    index("periods_org_status_idx").on(t.orgId, t.status),
    index("periods_end_idx").on(t.periodEnd),
    check(
      "periods_type_chk",
      sql`${t.periodType} IN ('monthly','quarterly','annual')`,
    ),
    check("periods_status_chk", sql`${t.status} IN ('open','closed','locked')`),
    check("periods_dates_chk", sql`${t.periodEnd} > ${t.periodStart}`),
    check(
      "periods_state_consistency_chk",
      sql`(${t.status} = 'open' AND ${t.closedAt} IS NULL AND ${t.lockedAt} IS NULL)
          OR (${t.status} = 'closed' AND ${t.closedAt} IS NOT NULL AND ${t.lockedAt} IS NULL)
          OR (${t.status} = 'locked' AND ${t.lockedAt} IS NOT NULL)`,
    ),
  ],
);

export type AccountingPeriod = typeof accountingPeriods.$inferSelect;
export type NewAccountingPeriod = typeof accountingPeriods.$inferInsert;
```


### `db/schema/acc/bank_accounts.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { legalEntities, organizations } from "../core";
import { chartOfAccounts } from "./chart_of_accounts";

export const BANK_ACCOUNT_TYPES = [
  "checking",
  "savings",
  "credit",
  "line_of_credit",
  "escrow",
  "money_market",
] as const;

export const BANK_ACCOUNT_PURPOSES = [
  "operating",
  "rental_collection",
  "security_deposit_escrow",
  "tax_escrow",
  "reserve",
  "distribution",
  "payroll",
  "other",
] as const;

export const BANK_SYNC_STATUSES = [
  "manual",
  "active",
  "disconnected",
  "needs_reauth",
  "error",
  "syncing",
] as const;

export const bankAccounts = accSchema.table(
  "bank_accounts",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerEntityId: uuid("owner_entity_id")
      .notNull()
      .references(() => legalEntities.id),
    accountName: text("account_name").notNull(),
    bankName: text("bank_name").notNull(),
    accountType: text("account_type").notNull(),
    mask: text("mask"),
    routingNumberEncrypted: text("routing_number_encrypted"),
    accountNumberEncrypted: text("account_number_encrypted"),
    purpose: text("purpose"),
    currentBalance: numeric("current_balance", { precision: 15, scale: 2 }),
    availableBalance: numeric("available_balance", {
      precision: 15,
      scale: 2,
    }),
    currency: text("currency").notNull().default("USD"),
    glAccountId: uuid("gl_account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    stripeFinancialConnectionId: text("stripe_financial_connection_id"),
    externalAccountId: text("external_account_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    syncStatus: text("sync_status").notNull().default("manual"),
    syncError: text("sync_error"),
    isArchived: boolean("is_archived").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (t) => [
    index("bank_accounts_owner_idx").on(t.orgId, t.ownerEntityId),
    index("bank_accounts_sync_idx").on(t.orgId, t.syncStatus),
    uniqueIndex("bank_accounts_stripe_fc_uniq")
      .on(t.stripeFinancialConnectionId)
      .where(sql`${t.stripeFinancialConnectionId} IS NOT NULL`),
    index("bank_accounts_gl_idx").on(t.glAccountId),
    check(
      "bank_accounts_type_chk",
      sql`${t.accountType} IN ('checking','savings','credit','line_of_credit','escrow','money_market')`,
    ),
    check(
      "bank_accounts_purpose_chk",
      sql`${t.purpose} IS NULL OR ${t.purpose} IN ('operating','rental_collection','security_deposit_escrow','tax_escrow','reserve','distribution','payroll','other')`,
    ),
    check(
      "bank_accounts_sync_chk",
      sql`${t.syncStatus} IN ('manual','active','disconnected','needs_reauth','error','syncing')`,
    ),
  ],
);

export type BankAccount = typeof bankAccounts.$inferSelect;
export type NewBankAccount = typeof bankAccounts.$inferInsert;
```


### `db/schema/acc/bank_reconciliation_items.ts`

```typescript
import { sql } from "drizzle-orm";
import { check, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { idCol } from "../_shared";
import { bankReconciliationSessions } from "./bank_reconciliation_sessions";
import { bankTransactions } from "./bank_transactions";
import { payments } from "./payments";

export const RECONCILIATION_ADJUSTMENT_TYPES = [
  "matched",
  "outstanding",
  "book_only",
  "adjustment",
  "ignored",
] as const;

export const bankReconciliationItems = accSchema.table(
  "bank_reconciliation_items",
  {
    id: idCol(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => bankReconciliationSessions.id, {
        onDelete: "cascade",
      }),
    bankTransactionId: uuid("bank_transaction_id")
      .notNull()
      .references(() => bankTransactions.id),
    matchedPaymentId: uuid("matched_payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),
    adjustmentType: text("adjustment_type").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    uniqueIndex("recon_items_unique").on(t.sessionId, t.bankTransactionId),
    check(
      "recon_items_type_chk",
      sql`${t.adjustmentType} IN ('matched','outstanding','book_only','adjustment','ignored')`,
    ),
  ],
);

export type BankReconciliationItem =
  typeof bankReconciliationItems.$inferSelect;
export type NewBankReconciliationItem =
  typeof bankReconciliationItems.$inferInsert;
```


### `db/schema/acc/bank_reconciliation_sessions.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { documents, legalEntities, organizations, users } from "../core";
import { bankAccounts } from "./bank_accounts";

export const RECONCILIATION_STATUSES = [
  "open",
  "in_progress",
  "completed",
  "locked",
] as const;

export const bankReconciliationSessions = accSchema.table(
  "bank_reconciliation_sessions",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => legalEntities.id),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    openingBalance: numeric("opening_balance", {
      precision: 15,
      scale: 2,
    }).notNull(),
    closingBalancePerBank: numeric("closing_balance_per_bank", {
      precision: 15,
      scale: 2,
    }).notNull(),
    closingBalancePerBooks: numeric("closing_balance_per_books", {
      precision: 15,
      scale: 2,
    }),
    variance: numeric("variance", {
      precision: 15,
      scale: 2,
    }).generatedAlwaysAs(
      sql`closing_balance_per_bank - closing_balance_per_books`,
    ),
    status: text("status").notNull().default("open"),
    reconciledBy: uuid("reconciled_by").references(() => users.id),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    lockedBy: uuid("locked_by").references(() => users.id),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockApprovalRequestId: uuid("lock_approval_request_id"),
    statementDocumentId: uuid("statement_document_id").references(
      () => documents.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
  },
  (t) => [
    index("recon_sessions_account_idx").on(
      t.orgId,
      t.bankAccountId,
      t.periodEnd,
    ),
    uniqueIndex("recon_sessions_period_uniq").on(
      t.bankAccountId,
      t.periodStart,
      t.periodEnd,
    ),
    check(
      "recon_sessions_status_chk",
      sql`${t.status} IN ('open','in_progress','completed','locked')`,
    ),
  ],
);

export type BankReconciliationSession =
  typeof bankReconciliationSessions.$inferSelect;
export type NewBankReconciliationSession =
  typeof bankReconciliationSessions.$inferInsert;
```


### `db/schema/acc/bank_transactions.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  numeric,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { organizations } from "../core";
import { bankAccounts } from "./bank_accounts";

export const MATCH_STATUSES = [
  "unmatched",
  "auto_matched",
  "manually_matched",
  "ignored",
  "split",
] as const;

export const bankTransactions = accSchema.table(
  "bank_transactions",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    transactionDate: date("transaction_date").notNull(),
    postedDate: date("posted_date"),
    description: text("description").notNull(),
    merchantName: text("merchant_name"),
    category: text("category"),
    pending: boolean("pending").notNull().default(false),
    matchStatus: text("match_status").notNull().default("unmatched"),
    matchConfidence: numeric("match_confidence", { precision: 3, scale: 2 }),
    matchedPaymentId: uuid("matched_payment_id"),
    matchedExpenseId: uuid("matched_expense_id"),
    matchedLoanPaymentId: uuid("matched_loan_payment_id"),
    matchRuleId: uuid("match_rule_id"),
    reconciliationSessionId: uuid("reconciliation_session_id"),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("bank_tx_external_uniq").on(t.bankAccountId, t.externalId),
    index("bank_tx_account_date_idx").on(t.bankAccountId, t.transactionDate),
    index("bank_tx_org_match_idx").on(t.orgId, t.matchStatus),
    index("bank_tx_payment_idx")
      .on(t.matchedPaymentId)
      .where(sql`${t.matchedPaymentId} IS NOT NULL`),
    check(
      "bank_tx_match_chk",
      sql`${t.matchStatus} IN ('unmatched','auto_matched','manually_matched','ignored','split')`,
    ),
  ],
);

export type BankTransaction = typeof bankTransactions.$inferSelect;
export type NewBankTransaction = typeof bankTransactions.$inferInsert;
```


### `db/schema/acc/chart_of_accounts.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { legalEntities, organizations } from "../core";

export const ACCOUNT_TYPES = [
  "Asset",
  "Liability",
  "Equity",
  "Revenue",
  "Expense",
  "OtherIncome",
  "OtherExpense",
  "ContraRevenue",
  "ContraExpense",
  "ContraAsset",
] as const;

export const ACCOUNT_SUBTYPES = [
  "Bank",
  "AR",
  "OtherCurrentAsset",
  "FixedAsset",
  "OtherAsset",
  "AccumulatedDepreciation",
  "AP",
  "CreditCard",
  "OtherCurrentLiability",
  "LongTermLiability",
  "Equity",
  "Income",
  "OtherIncome",
  "COGS",
  "OperatingExpense",
  "OtherExpense",
  "Depreciation",
  "Concession",
  "BadDebt",
] as const;

export const NORMAL_BALANCES = ["debit", "credit"] as const;

export const chartOfAccounts = accSchema.table(
  "chart_of_accounts",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id").references(() => legalEntities.id, {
      onDelete: "cascade",
    }),
    accountNumber: text("account_number").notNull(),
    name: text("name").notNull(),
    fullPath: text("full_path").notNull(),
    accountType: text("account_type").notNull(),
    accountSubtype: text("account_subtype").notNull(),
    normalBalance: text("normal_balance").notNull(),
    parentAccountId: uuid("parent_account_id").references(
      (): AnyPgColumn => chartOfAccounts.id,
      { onDelete: "set null" },
    ),
    xeroAccountId: text("xero_account_id"),
    xeroAccountCode: text("xero_account_code"),
    isActive: boolean("is_active").notNull().default(true),
    isSystem: boolean("is_system").notNull().default(false),
    isBank: boolean("is_bank").notNull().default(false),
    description: text("description"),
    currency: text("currency").notNull().default("USD"),
  },
  (t) => [
    uniqueIndex("coa_org_entity_number_uniq").on(
      t.orgId,
      t.entityId,
      t.accountNumber,
    ),
    index("coa_org_type_idx").on(t.orgId, t.accountType),
    index("coa_parent_idx")
      .on(t.parentAccountId)
      .where(sql`${t.parentAccountId} IS NOT NULL`),
    index("coa_xero_idx")
      .on(t.xeroAccountId)
      .where(sql`${t.xeroAccountId} IS NOT NULL`),
    index("coa_active_type_idx").on(t.isActive, t.accountType),
    check(
      "coa_type_chk",
      sql`${t.accountType} IN ('Asset','Liability','Equity','Revenue','Expense','OtherIncome','OtherExpense','ContraRevenue','ContraExpense','ContraAsset')`,
    ),
    check(
      "coa_subtype_chk",
      sql`${t.accountSubtype} IN ('Bank','AR','OtherCurrentAsset','FixedAsset','OtherAsset','AccumulatedDepreciation','AP','CreditCard','OtherCurrentLiability','LongTermLiability','Equity','Income','OtherIncome','COGS','OperatingExpense','OtherExpense','Depreciation','Concession','BadDebt')`,
    ),
    check("coa_balance_chk", sql`${t.normalBalance} IN ('debit','credit')`),
  ],
);

export type ChartOfAccount = typeof chartOfAccounts.$inferSelect;
export type NewChartOfAccount = typeof chartOfAccounts.$inferInsert;
```


### `db/schema/acc/credit_memo_applications.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { idCol } from "../_shared";
import { users } from "../core";
import { creditMemos } from "./credit_memos";
import { invoiceLineItems } from "./invoice_line_items";
import { invoices } from "./invoices";
import { journalEntries } from "./journal_entries";

export const creditMemoApplications = accSchema.table(
  "credit_memo_applications",
  {
    id: idCol(),
    creditMemoId: uuid("credit_memo_id")
      .notNull()
      .references(() => creditMemos.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    invoiceLineItemId: uuid("invoice_line_item_id").references(
      () => invoiceLineItems.id,
      { onDelete: "set null" },
    ),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    applicationDate: date("application_date").notNull(),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    appliedBy: uuid("applied_by")
      .notNull()
      .references(() => users.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    index("cm_apps_credit_idx").on(t.creditMemoId),
    index("cm_apps_invoice_idx").on(t.invoiceId),
    uniqueIndex("cm_apps_unique").on(
      t.creditMemoId,
      t.invoiceId,
      t.invoiceLineItemId,
    ),
    check("cm_apps_amount_chk", sql`${t.amount} > 0`),
  ],
);

export type CreditMemoApplication = typeof creditMemoApplications.$inferSelect;
export type NewCreditMemoApplication =
  typeof creditMemoApplications.$inferInsert;
```


### `db/schema/acc/credit_memo_line_items.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { idCol } from "../_shared";
import { chartOfAccounts } from "./chart_of_accounts";
import { creditMemos } from "./credit_memos";
import { invoiceLineItems } from "./invoice_line_items";

export const creditMemoLineItems = accSchema.table(
  "credit_memo_line_items",
  {
    id: idCol(),
    creditMemoId: uuid("credit_memo_id")
      .notNull()
      .references(() => creditMemos.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 10, scale: 2 })
      .notNull()
      .default("1"),
    unitPrice: numeric("unit_price", { precision: 15, scale: 2 }).notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).generatedAlwaysAs(
      sql`quantity * unit_price`,
    ),
    accountId: uuid("account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    classId: uuid("class_id"),
    originalInvoiceLineItemId: uuid("original_invoice_line_item_id").references(
      () => invoiceLineItems.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    uniqueIndex("cm_lines_uniq").on(t.creditMemoId, t.lineNumber),
    index("cm_lines_orig_idx")
      .on(t.originalInvoiceLineItemId)
      .where(sql`${t.originalInvoiceLineItemId} IS NOT NULL`),
  ],
);

export type CreditMemoLineItem = typeof creditMemoLineItems.$inferSelect;
export type NewCreditMemoLineItem = typeof creditMemoLineItems.$inferInsert;
```


### `db/schema/acc/credit_memos.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import {
  contacts,
  documents,
  legalEntities,
  organizations,
  users,
} from "../core";
import { leases } from "../pm";
import { invoices } from "./invoices";
import { journalEntries } from "./journal_entries";

export const CREDIT_MEMO_REASONS = [
  "overpayment",
  "service_credit",
  "goodwill",
  "dispute_resolution",
  "correction",
  "double_payment",
  "prepayment_refund",
  "rent_concession_credit",
  "damage_credit",
  "other",
] as const;

export const CREDIT_MEMO_STATUSES = [
  "draft",
  "issued",
  "partially_applied",
  "fully_applied",
  "refunded",
  "void",
] as const;

export const creditMemos = accSchema.table(
  "credit_memos",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    creditMemoNumber: text("credit_memo_number").notNull(),
    issuingEntityId: uuid("issuing_entity_id")
      .notNull()
      .references(() => legalEntities.id),
    counterpartyContactId: uuid("counterparty_contact_id")
      .notNull()
      .references(() => contacts.id),
    leaseId: uuid("lease_id").references(() => leases.id, {
      onDelete: "set null",
    }),
    originalInvoiceId: uuid("original_invoice_id").references(
      () => invoices.id,
      {
        onDelete: "set null",
      },
    ),
    issueDate: date("issue_date").notNull(),
    totalAmount: numeric("total_amount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    amountApplied: numeric("amount_applied", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    amountRefunded: numeric("amount_refunded", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    amountRemaining: numeric("amount_remaining", {
      precision: 15,
      scale: 2,
    }).generatedAlwaysAs(sql`total_amount - amount_applied - amount_refunded`),
    reason: text("reason").notNull(),
    reasonDetail: text("reason_detail"),
    status: text("status").notNull().default("draft"),
    internalNotes: text("internal_notes"),
    customerVisibleMemo: text("customer_visible_memo"),
    pdfDocumentId: uuid("pdf_document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    xeroCreditNoteId: text("xero_credit_note_id"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    approvalRequestId: uuid("approval_request_id"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    voidedBy: uuid("voided_by").references(() => users.id),
  },
  (t) => [
    uniqueIndex("credit_memos_number_uniq").on(t.orgId, t.creditMemoNumber),
    index("credit_memos_counterparty_idx").on(
      t.counterpartyContactId,
      t.status,
    ),
    index("credit_memos_invoice_idx")
      .on(t.originalInvoiceId)
      .where(sql`${t.originalInvoiceId} IS NOT NULL`),
    index("credit_memos_status_idx").on(t.status, t.issueDate),
    index("credit_memos_remaining_idx")
      .on(t.amountRemaining)
      .where(sql`${t.amountRemaining} > 0`),
    uniqueIndex("credit_memos_xero_uniq")
      .on(t.xeroCreditNoteId)
      .where(sql`${t.xeroCreditNoteId} IS NOT NULL`),
    check(
      "credit_memos_amount_chk",
      sql`${t.totalAmount} > 0 AND ${t.totalAmount} >= ${t.amountApplied} + ${t.amountRefunded}`,
    ),
    check(
      "credit_memos_reason_chk",
      sql`${t.reason} IN ('overpayment','service_credit','goodwill','dispute_resolution','correction','double_payment','prepayment_refund','rent_concession_credit','damage_credit','other')`,
    ),
    check(
      "credit_memos_status_chk",
      sql`${t.status} IN ('draft','issued','partially_applied','fully_applied','refunded','void')`,
    ),
  ],
);

export type CreditMemo = typeof creditMemos.$inferSelect;
export type NewCreditMemo = typeof creditMemos.$inferInsert;
```


### `db/schema/acc/expenses.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import {
  contacts,
  documents,
  legalEntities,
  organizations,
  users,
} from "../core";
import { properties } from "../pm";
import { bankTransactions } from "./bank_transactions";
import { chartOfAccounts } from "./chart_of_accounts";
import { invoices } from "./invoices";
import { journalEntries } from "./journal_entries";
import { payments } from "./payments";

export const EXPENSE_PAYMENT_METHODS = [
  "check",
  "ach",
  "wire",
  "card",
  "cash",
  "transfer",
  "reimbursement",
] as const;

export const expenses = accSchema.table(
  "expenses",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    expenseNumber: text("expense_number").notNull(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => legalEntities.id),
    propertyId: uuid("property_id").references(() => properties.id, {
      onDelete: "set null",
    }),
    vendorContactId: uuid("vendor_contact_id").references(() => contacts.id),
    expenseDate: date("expense_date").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    taxAmount: numeric("tax_amount", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    category: text("category"),
    accountId: uuid("account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    classId: uuid("class_id"),
    description: text("description").notNull(),
    paymentMethod: text("payment_method"),
    paymentId: uuid("payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),
    bankTransactionId: uuid("bank_transaction_id").references(
      () => bankTransactions.id,
      { onDelete: "set null" },
    ),
    receiptDocumentId: uuid("receipt_document_id").references(
      () => documents.id,
      { onDelete: "set null" },
    ),
    isBillableToTenant: boolean("is_billable_to_tenant")
      .notNull()
      .default(false),
    billedToTenantInvoiceId: uuid("billed_to_tenant_invoice_id").references(
      () => invoices.id,
      { onDelete: "set null" },
    ),
    billedAt: timestamp("billed_at", { withTimezone: true }),
    isCapitalizable: boolean("is_capitalizable").notNull().default(false),
    linkedFixedAssetId: uuid("linked_fixed_asset_id"),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    taxDeductible: boolean("tax_deductible").notNull().default(true),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    approvalRequestId: uuid("approval_request_id"),
    notes: text("notes"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    uniqueIndex("expenses_number_uniq").on(t.orgId, t.expenseNumber),
    index("expenses_org_date_idx").on(t.orgId, t.expenseDate),
    index("expenses_property_idx")
      .on(t.propertyId, t.expenseDate)
      .where(sql`${t.propertyId} IS NOT NULL`),
    index("expenses_vendor_idx").on(t.vendorContactId, t.expenseDate),
    index("expenses_account_idx").on(t.accountId, t.expenseDate),
    index("expenses_payment_idx")
      .on(t.paymentId)
      .where(sql`${t.paymentId} IS NOT NULL`),
    index("expenses_billable_idx")
      .on(t.isBillableToTenant, t.billedAt)
      .where(sql`${t.isBillableToTenant} = true AND ${t.billedAt} IS NULL`),
    check("expenses_amount_chk", sql`${t.amount} > 0`),
    check(
      "expenses_method_chk",
      sql`${t.paymentMethod} IS NULL OR ${t.paymentMethod} IN ('check','ach','wire','card','cash','transfer','reimbursement')`,
    ),
  ],
);

export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
```


### `db/schema/acc/intercompany_transfers.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  text,
  timestamp,
  numeric,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { legalEntities, organizations, users } from "../core";
import { chartOfAccounts } from "./chart_of_accounts";
import { journalEntries } from "./journal_entries";
import { payments } from "./payments";

export const INTERCOMPANY_TRANSFER_TYPES = [
  "distribution",
  "contribution",
  "management_fee",
  "reimbursement",
  "intercompany_loan",
  "loan_repayment",
  "expense_passthrough",
  "rent_passthrough",
  "property_transfer",
] as const;

export const INTERCOMPANY_STATUSES = [
  "pending",
  "approved",
  "completed",
  "reversed",
] as const;

export const intercompanyTransfers = accSchema.table(
  "intercompany_transfers",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fromEntityId: uuid("from_entity_id")
      .notNull()
      .references(() => legalEntities.id),
    toEntityId: uuid("to_entity_id")
      .notNull()
      .references(() => legalEntities.id),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    transferDate: date("transfer_date").notNull(),
    valueDate: date("value_date"),
    transferType: text("transfer_type").notNull(),
    linkedPaymentIds: uuid("linked_payment_ids").array(),
    linkedPeriod: text("linked_period"),
    fromPaymentId: uuid("from_payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),
    toPaymentId: uuid("to_payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),
    fromJournalEntryId: uuid("from_journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    toJournalEntryId: uuid("to_journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    fromAccountId: uuid("from_account_id").references(() => chartOfAccounts.id),
    toAccountId: uuid("to_account_id").references(() => chartOfAccounts.id),
    status: text("status").notNull().default("pending"),
    approvalRequestId: uuid("approval_request_id"),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    memo: text("memo"),
    notes: text("notes"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by").references(() => users.id),
    reversalReason: text("reversal_reason"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    index("intercompany_org_status_idx").on(t.orgId, t.status),
    index("intercompany_from_idx").on(t.fromEntityId, t.transferDate),
    index("intercompany_to_idx").on(t.toEntityId, t.transferDate),
    index("intercompany_period_idx")
      .on(t.linkedPeriod)
      .where(sql`${t.linkedPeriod} IS NOT NULL`),
    index("intercompany_payments_idx").using("gin", t.linkedPaymentIds),
    check("intercompany_amount_chk", sql`${t.amount} > 0`),
    check(
      "intercompany_distinct_chk",
      sql`${t.fromEntityId} != ${t.toEntityId}`,
    ),
    check(
      "intercompany_type_chk",
      sql`${t.transferType} IN ('distribution','contribution','management_fee','reimbursement','intercompany_loan','loan_repayment','expense_passthrough','rent_passthrough','property_transfer')`,
    ),
    check(
      "intercompany_status_chk",
      sql`${t.status} IN ('pending','approved','completed','reversed')`,
    ),
  ],
);

export type IntercompanyTransfer = typeof intercompanyTransfers.$inferSelect;
export type NewIntercompanyTransfer = typeof intercompanyTransfers.$inferInsert;
```


### `db/schema/acc/invoice_line_items.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { idCol } from "../_shared";
import { legalEntities } from "../core";
import { properties, recurringCharges, rentConcessions } from "../pm";
import { chartOfAccounts } from "./chart_of_accounts";
import { invoices } from "./invoices";

export const INVOICE_LINE_CATEGORIES = [
  "rent",
  "late_fee",
  "utility",
  "deposit",
  "repair",
  "admin_fee",
  "cam",
  "tax_recovery",
  "insurance_recovery",
  "concession",
  "adjustment",
  "other",
] as const;

export const invoiceLineItems = accSchema.table(
  "invoice_line_items",
  {
    id: idCol(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 10, scale: 2 })
      .notNull()
      .default("1"),
    unitPrice: numeric("unit_price", { precision: 15, scale: 2 }).notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).generatedAlwaysAs(
      sql`quantity * unit_price`,
    ),
    taxRatePct: numeric("tax_rate_pct", { precision: 5, scale: 3 }),
    taxAmount: numeric("tax_amount", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    category: text("category"),
    accountId: uuid("account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    classId: uuid("class_id"),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => legalEntities.id),
    propertyId: uuid("property_id").references(() => properties.id),
    recurringChargeId: uuid("recurring_charge_id").references(
      () => recurringCharges.id,
      { onDelete: "set null" },
    ),
    concessionId: uuid("concession_id").references(() => rentConcessions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    uniqueIndex("invoice_lines_uniq").on(t.invoiceId, t.lineNumber),
    index("invoice_lines_account_idx").on(t.accountId),
    index("invoice_lines_class_idx")
      .on(t.classId)
      .where(sql`${t.classId} IS NOT NULL`),
    index("invoice_lines_concession_idx")
      .on(t.concessionId)
      .where(sql`${t.concessionId} IS NOT NULL`),
    index("invoice_lines_recurring_idx")
      .on(t.recurringChargeId)
      .where(sql`${t.recurringChargeId} IS NOT NULL`),
    check(
      "invoice_lines_category_chk",
      sql`${t.category} IS NULL OR ${t.category} IN ('rent','late_fee','utility','deposit','repair','admin_fee','cam','tax_recovery','insurance_recovery','concession','adjustment','other')`,
    ),
  ],
);

export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type NewInvoiceLineItem = typeof invoiceLineItems.$inferInsert;
```


### `db/schema/acc/invoices.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import {
  contacts,
  documents,
  legalEntities,
  organizations,
  users,
} from "../core";
import { leases, recurringCharges } from "../pm";
import { journalEntries } from "./journal_entries";

export const INVOICE_TYPES = [
  "invoice",
  "proforma",
  "credit_memo",
  "recurring_template",
] as const;

export const INVOICE_COUNTERPARTY_TYPES = [
  "tenant",
  "vendor",
  "other",
] as const;

export const INVOICE_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "partial",
  "paid",
  "overdue",
  "void",
  "written_off",
] as const;

export const invoices = accSchema.table(
  "invoices",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    invoiceNumber: text("invoice_number").notNull(),
    invoiceType: text("invoice_type").notNull().default("invoice"),
    issuingEntityId: uuid("issuing_entity_id")
      .notNull()
      .references(() => legalEntities.id),
    beneficiaryEntityId: uuid("beneficiary_entity_id").references(
      () => legalEntities.id,
    ),
    counterpartyType: text("counterparty_type").notNull(),
    counterpartyContactId: uuid("counterparty_contact_id")
      .notNull()
      .references(() => contacts.id),
    leaseId: uuid("lease_id").references(() => leases.id, {
      onDelete: "set null",
    }),
    recurringChargeId: uuid("recurring_charge_id").references(
      () => recurringCharges.id,
      { onDelete: "set null" },
    ),
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date").notNull(),
    servicePeriodStart: date("service_period_start"),
    servicePeriodEnd: date("service_period_end"),
    subtotal: numeric("subtotal", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    taxAmount: numeric("tax_amount", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    totalAmount: numeric("total_amount", {
      precision: 15,
      scale: 2,
    }).generatedAlwaysAs(sql`subtotal + tax_amount`),
    amountPaid: numeric("amount_paid", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    amountCredited: numeric("amount_credited", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    amountWrittenOff: numeric("amount_written_off", {
      precision: 15,
      scale: 2,
    })
      .notNull()
      .default("0"),
    balanceDue: numeric("balance_due", {
      precision: 15,
      scale: 2,
    }).generatedAlwaysAs(
      sql`subtotal + tax_amount - amount_paid - amount_credited - amount_written_off`,
    ),
    status: text("status").notNull().default("draft"),
    terms: text("terms"),
    memo: text("memo"),
    internalNotes: text("internal_notes"),
    currency: text("currency").notNull().default("USD"),
    stripeInvoiceId: text("stripe_invoice_id"),
    xeroInvoiceId: text("xero_invoice_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    pdfDocumentId: uuid("pdf_document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    lastReminderSentAt: timestamp("last_reminder_sent_at", {
      withTimezone: true,
    }),
    reminderCount: integer("reminder_count").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id),
    voidedBy: uuid("voided_by").references(() => users.id),
    payLinkToken: text("pay_link_token"),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
  },
  (t) => [
    uniqueIndex("invoices_number_uniq").on(t.orgId, t.invoiceNumber),
    index("invoices_status_due_idx").on(t.orgId, t.status, t.dueDate),
    uniqueIndex("invoices_pay_link_token_uniq")
      .on(t.payLinkToken)
      .where(sql`${t.payLinkToken} IS NOT NULL`),
    uniqueIndex("invoices_stripe_pi_uniq")
      .on(t.stripePaymentIntentId)
      .where(sql`${t.stripePaymentIntentId} IS NOT NULL`),
    index("invoices_counterparty_idx").on(t.counterpartyContactId, t.status),
    index("invoices_lease_idx")
      .on(t.leaseId)
      .where(sql`${t.leaseId} IS NOT NULL`),
    index("invoices_recurring_idx")
      .on(t.recurringChargeId)
      .where(sql`${t.recurringChargeId} IS NOT NULL`),
    index("invoices_entity_idx").on(t.issuingEntityId, t.status, t.issueDate),
    uniqueIndex("invoices_stripe_uniq")
      .on(t.stripeInvoiceId)
      .where(sql`${t.stripeInvoiceId} IS NOT NULL`),
    uniqueIndex("invoices_xero_uniq")
      .on(t.xeroInvoiceId)
      .where(sql`${t.xeroInvoiceId} IS NOT NULL`),
    check(
      "invoices_type_chk",
      sql`${t.invoiceType} IN ('invoice','proforma','credit_memo','recurring_template')`,
    ),
    check(
      "invoices_counterparty_type_chk",
      sql`${t.counterpartyType} IN ('tenant','vendor','other')`,
    ),
    check(
      "invoices_status_chk",
      sql`${t.status} IN ('draft','sent','viewed','partial','paid','overdue','void','written_off')`,
    ),
  ],
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
```


### `db/schema/acc/journal_entries.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { legalEntities, organizations, users } from "../core";
import { accountingPeriods } from "./accounting_periods";

export const JOURNAL_SOURCE_TYPES = [
  "invoice",
  "payment",
  "payment_allocation",
  "expense",
  "loan_payment",
  "intercompany_transfer",
  "owner_contribution",
  "owner_distribution",
  "deposit_movement",
  "reconciliation_adjustment",
  "depreciation",
  "manual",
  "reversing",
  "credit_memo",
  "credit_memo_application",
  "writeoff",
  "writeoff_recovery",
  "concession_application",
  "currency_revaluation",
  "accrual",
  "prepaid_amortization",
  "closing_entry",
] as const;

export const JOURNAL_STATUSES = ["draft", "posted", "void"] as const;

export const journalEntries = accSchema.table(
  "journal_entries",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => legalEntities.id),
    accountingPeriodId: uuid("accounting_period_id")
      .notNull()
      .references(() => accountingPeriods.id),
    entryNumber: text("entry_number").notNull(),
    entryDate: date("entry_date").notNull(),
    postedDate: timestamp("posted_date", { withTimezone: true }),
    memo: text("memo").notNull(),
    referenceNumber: text("reference_number"),
    sourceSchema: text("source_schema").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id"),
    status: text("status").notNull().default("draft"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidedByEntryId: uuid("voided_by_entry_id").references(
      (): AnyPgColumn => journalEntries.id,
      { onDelete: "set null" },
    ),
    isReversingEntry: boolean("is_reversing_entry").notNull().default(false),
    reversesEntryId: uuid("reverses_entry_id").references(
      (): AnyPgColumn => journalEntries.id,
      { onDelete: "set null" },
    ),
    xeroJournalId: text("xero_journal_id"),
    xeroSyncedAt: timestamp("xero_synced_at", { withTimezone: true }),
    xeroSyncError: text("xero_sync_error"),
    totalDebit: numeric("total_debit", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    totalCredit: numeric("total_credit", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    createdBy: uuid("created_by").references(() => users.id),
    postedBy: uuid("posted_by").references(() => users.id),
  },
  (t) => [
    uniqueIndex("je_number_uniq").on(t.orgId, t.entryNumber),
    index("je_entity_date_idx").on(t.entityId, t.entryDate),
    index("je_period_idx").on(t.accountingPeriodId),
    index("je_source_idx").on(t.sourceSchema, t.sourceType, t.sourceId),
    index("je_status_sync_idx")
      .on(t.status, t.xeroSyncedAt)
      .where(sql`${t.status} = 'posted'`),
    uniqueIndex("je_xero_uniq")
      .on(t.xeroJournalId)
      .where(sql`${t.xeroJournalId} IS NOT NULL`),
    check("je_status_chk", sql`${t.status} IN ('draft','posted','void')`),
    check(
      "je_source_schema_chk",
      sql`${t.sourceSchema} IN ('pm','acc','core')`,
    ),
    check(
      "je_balanced_chk",
      sql`${t.status} != 'posted' OR ${t.totalDebit} = ${t.totalCredit}`,
    ),
  ],
);

export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;
```


### `db/schema/acc/journal_entry_lines.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { idCol } from "../_shared";
import { contacts, legalEntities } from "../core";
import { chartOfAccounts } from "./chart_of_accounts";
import { journalEntries } from "./journal_entries";

export const journalEntryLines = accSchema.table(
  "journal_entry_lines",
  {
    id: idCol(),
    journalEntryId: uuid("journal_entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    debit: numeric("debit", { precision: 15, scale: 2 }).notNull().default("0"),
    credit: numeric("credit", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    classId: uuid("class_id"),
    contactId: uuid("contact_id").references(() => contacts.id),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => legalEntities.id),
    memo: text("memo"),
    taxAmount: numeric("tax_amount", { precision: 15, scale: 2 }),
    taxRatePct: numeric("tax_rate_pct", { precision: 5, scale: 3 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    uniqueIndex("jel_journal_line_uniq").on(t.journalEntryId, t.lineNumber),
    index("jel_account_entity_idx").on(t.accountId, t.entityId),
    index("jel_class_idx")
      .on(t.classId)
      .where(sql`${t.classId} IS NOT NULL`),
    index("jel_contact_idx")
      .on(t.contactId)
      .where(sql`${t.contactId} IS NOT NULL`),
    check(
      "jel_dr_xor_cr_chk",
      sql`(${t.debit} > 0 AND ${t.credit} = 0) OR (${t.debit} = 0 AND ${t.credit} > 0)`,
    ),
    check("jel_non_negative_chk", sql`${t.debit} >= 0 AND ${t.credit} >= 0`),
  ],
);

export type JournalEntryLine = typeof journalEntryLines.$inferSelect;
export type NewJournalEntryLine = typeof journalEntryLines.$inferInsert;
```


### `db/schema/acc/loan_amortization_schedule.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { idCol } from "../_shared";
import { loans } from "./loans";

export const loanAmortizationSchedule = accSchema.table(
  "loan_amortization_schedule",
  {
    id: idCol(),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id, { onDelete: "cascade" }),
    paymentNumber: integer("payment_number").notNull(),
    dueDate: date("due_date").notNull(),
    beginningBalance: numeric("beginning_balance", {
      precision: 15,
      scale: 2,
    }).notNull(),
    principalDue: numeric("principal_due", {
      precision: 15,
      scale: 2,
    }).notNull(),
    interestDue: numeric("interest_due", {
      precision: 15,
      scale: 2,
    }).notNull(),
    escrowDue: numeric("escrow_due", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    totalDue: numeric("total_due", {
      precision: 15,
      scale: 2,
    }).generatedAlwaysAs(sql`principal_due + interest_due + escrow_due`),
    endingBalance: numeric("ending_balance", {
      precision: 15,
      scale: 2,
    }).notNull(),
    isObsolete: boolean("is_obsolete").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    uniqueIndex("loan_sched_active_uniq")
      .on(t.loanId, t.paymentNumber)
      .where(sql`${t.isObsolete} = false`),
    uniqueIndex("loan_sched_due_idx").on(t.loanId, t.dueDate),
  ],
);

export type LoanAmortizationEntry =
  typeof loanAmortizationSchedule.$inferSelect;
export type NewLoanAmortizationEntry =
  typeof loanAmortizationSchedule.$inferInsert;
```


### `db/schema/acc/loan_payments.ts`

```typescript
import { sql } from "drizzle-orm";
import { check, date, index, numeric, text, uuid } from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { organizations } from "../core";
import { journalEntries } from "./journal_entries";
import { loanAmortizationSchedule } from "./loan_amortization_schedule";
import { loans } from "./loans";
import { payments } from "./payments";

export const LOAN_PAYMENT_STATUSES = [
  "scheduled",
  "paid",
  "late",
  "partial",
  "missed",
  "reversed",
] as const;

export const loanPayments = accSchema.table(
  "loan_payments",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id, { onDelete: "cascade" }),
    scheduleEntryId: uuid("schedule_entry_id").references(
      () => loanAmortizationSchedule.id,
      { onDelete: "set null" },
    ),
    dueDate: date("due_date").notNull(),
    scheduledAmount: numeric("scheduled_amount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    principalPaid: numeric("principal_paid", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    interestPaid: numeric("interest_paid", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    escrowPaid: numeric("escrow_paid", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    lateFeePaid: numeric("late_fee_paid", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    principalExtra: numeric("principal_extra", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    totalPaid: numeric("total_paid", {
      precision: 15,
      scale: 2,
    }).generatedAlwaysAs(
      sql`principal_paid + interest_paid + escrow_paid + late_fee_paid + principal_extra`,
    ),
    paidDate: date("paid_date"),
    paymentId: uuid("payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("scheduled"),
    notes: text("notes"),
  },
  (t) => [
    index("loan_pmts_loan_due_idx").on(t.loanId, t.dueDate),
    index("loan_pmts_org_status_idx").on(t.orgId, t.status),
    index("loan_pmts_payment_idx")
      .on(t.paymentId)
      .where(sql`${t.paymentId} IS NOT NULL`),
    check(
      "loan_pmts_status_chk",
      sql`${t.status} IN ('scheduled','paid','late','partial','missed','reversed')`,
    ),
  ],
);

export type LoanPayment = typeof loanPayments.$inferSelect;
export type NewLoanPayment = typeof loanPayments.$inferInsert;
```


### `db/schema/acc/loans.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { contacts, legalEntities, organizations } from "../core";
import { properties } from "../pm";
import { chartOfAccounts } from "./chart_of_accounts";

export const LOAN_TYPES = [
  "conventional",
  "fha",
  "va",
  "jumbo",
  "hard_money",
  "construction",
  "heloc",
  "line_of_credit",
  "seller_financing",
  "private",
  "government",
] as const;

export const RATE_TYPES = ["fixed", "arm", "interest_only", "balloon"] as const;

export const LOAN_STATUSES = [
  "active",
  "paid_off",
  "in_default",
  "refinanced",
  "foreclosed",
  "assumed",
  "modified",
  "rescinded",
] as const;

export const loans = accSchema.table(
  "loans",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    borrowerEntityId: uuid("borrower_entity_id")
      .notNull()
      .references(() => legalEntities.id),
    propertyId: uuid("property_id").references(() => properties.id, {
      onDelete: "set null",
    }),
    lenderContactId: uuid("lender_contact_id")
      .notNull()
      .references(() => contacts.id),
    loanNumber: text("loan_number"),
    loanType: text("loan_type").notNull(),
    lienPosition: integer("lien_position"),
    principalAmount: numeric("principal_amount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    currentBalance: numeric("current_balance", {
      precision: 15,
      scale: 2,
    }).notNull(),
    interestRate: numeric("interest_rate", {
      precision: 7,
      scale: 4,
    }).notNull(),
    rateType: text("rate_type").notNull(),
    armDetails: jsonb("arm_details"),
    termMonths: integer("term_months").notNull(),
    amortizationMonths: integer("amortization_months"),
    originationDate: date("origination_date").notNull(),
    firstPaymentDate: date("first_payment_date").notNull(),
    maturityDate: date("maturity_date").notNull(),
    monthlyPayment: numeric("monthly_payment", {
      precision: 15,
      scale: 2,
    }).notNull(),
    escrowTaxes: numeric("escrow_taxes", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    escrowInsurance: numeric("escrow_insurance", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    escrowOther: numeric("escrow_other", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    totalMonthlyPayment: numeric("total_monthly_payment", {
      precision: 15,
      scale: 2,
    }).generatedAlwaysAs(
      sql`monthly_payment + escrow_taxes + escrow_insurance + escrow_other`,
    ),
    paymentDueDay: integer("payment_due_day").notNull().default(1),
    lateFeeAmount: numeric("late_fee_amount", { precision: 15, scale: 2 }),
    lateFeeGraceDays: integer("late_fee_grace_days"),
    prepaymentPenalty: jsonb("prepayment_penalty"),
    liabilityAccountId: uuid("liability_account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    interestExpenseAccountId: uuid("interest_expense_account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    escrowAccountId: uuid("escrow_account_id").references(
      () => chartOfAccounts.id,
    ),
    closingCosts: numeric("closing_costs", { precision: 15, scale: 2 }),
    pointsPaid: numeric("points_paid", { precision: 15, scale: 2 }),
    status: text("status").notNull().default("active"),
    payoffDate: date("payoff_date"),
    payoffAmount: numeric("payoff_amount", { precision: 15, scale: 2 }),
    notes: text("notes"),
  },
  (t) => [
    index("loans_org_status_idx").on(t.orgId, t.status),
    index("loans_property_idx")
      .on(t.propertyId)
      .where(sql`${t.propertyId} IS NOT NULL`),
    index("loans_borrower_idx").on(t.borrowerEntityId, t.status),
    index("loans_maturity_idx").on(t.maturityDate),
    index("loans_lender_idx").on(t.lenderContactId),
    check(
      "loans_type_chk",
      sql`${t.loanType} IN ('conventional','fha','va','jumbo','hard_money','construction','heloc','line_of_credit','seller_financing','private','government')`,
    ),
    check(
      "loans_rate_type_chk",
      sql`${t.rateType} IN ('fixed','arm','interest_only','balloon')`,
    ),
    check(
      "loans_status_chk",
      sql`${t.status} IN ('active','paid_off','in_default','refinanced','foreclosed','assumed','modified','rescinded')`,
    ),
  ],
);

export type Loan = typeof loans.$inferSelect;
export type NewLoan = typeof loans.$inferInsert;
```


### `db/schema/acc/owner_contributions.ts`

```typescript
import { sql } from "drizzle-orm";
import { check, date, index, numeric, text, uuid } from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import {
  contacts,
  documents,
  legalEntities,
  organizations,
  users,
} from "../core";
import { properties } from "../pm";
import { chartOfAccounts } from "./chart_of_accounts";
import { journalEntries } from "./journal_entries";
import { payments } from "./payments";

export const CONTRIBUTION_TYPES = [
  "cash",
  "property",
  "services",
  "assumption_of_debt",
  "equipment",
] as const;

export const ownerContributions = accSchema.table(
  "owner_contributions",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => legalEntities.id),
    contributorContactId: uuid("contributor_contact_id")
      .notNull()
      .references(() => contacts.id),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    contributionDate: date("contribution_date").notNull(),
    contributionType: text("contribution_type").notNull(),
    linkedPaymentId: uuid("linked_payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),
    linkedPropertyId: uuid("linked_property_id").references(
      () => properties.id,
      { onDelete: "set null" },
    ),
    equityAccountId: uuid("equity_account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    documentationDocumentId: uuid("documentation_document_id").references(
      () => documents.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    index("contributions_entity_date_idx").on(t.entityId, t.contributionDate),
    index("contributions_contributor_idx").on(t.contributorContactId),
    check("contributions_amount_chk", sql`${t.amount} > 0`),
    check(
      "contributions_type_chk",
      sql`${t.contributionType} IN ('cash','property','services','assumption_of_debt','equipment')`,
    ),
  ],
);

export type OwnerContribution = typeof ownerContributions.$inferSelect;
export type NewOwnerContribution = typeof ownerContributions.$inferInsert;
```


### `db/schema/acc/owner_distributions.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { contacts, legalEntities, organizations, users } from "../core";
import { chartOfAccounts } from "./chart_of_accounts";
import { journalEntries } from "./journal_entries";
import { payments } from "./payments";

export const DISTRIBUTION_TYPES = [
  "cash",
  "property",
  "guaranteed_payment",
  "tax_distribution",
  "liquidating",
] as const;

export const ownerDistributions = accSchema.table(
  "owner_distributions",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => legalEntities.id),
    recipientContactId: uuid("recipient_contact_id")
      .notNull()
      .references(() => contacts.id),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    distributionDate: date("distribution_date").notNull(),
    distributionType: text("distribution_type").notNull(),
    linkedPaymentId: uuid("linked_payment_id").references(() => payments.id, {
      onDelete: "set null",
    }),
    linkedPeriod: text("linked_period"),
    equityAccountId: uuid("equity_account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    approvalRequestId: uuid("approval_request_id").notNull(),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    taxYear: integer("tax_year"),
    isTaxDistribution: boolean("is_tax_distribution").notNull().default(false),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    index("distributions_entity_date_idx").on(t.entityId, t.distributionDate),
    index("distributions_recipient_idx").on(
      t.recipientContactId,
      t.distributionDate,
    ),
    index("distributions_approval_idx").on(t.approvalRequestId),
    index("distributions_period_idx")
      .on(t.linkedPeriod)
      .where(sql`${t.linkedPeriod} IS NOT NULL`),
    check("distributions_amount_chk", sql`${t.amount} > 0`),
    check(
      "distributions_type_chk",
      sql`${t.distributionType} IN ('cash','property','guaranteed_payment','tax_distribution','liquidating')`,
    ),
  ],
);

export type OwnerDistribution = typeof ownerDistributions.$inferSelect;
export type NewOwnerDistribution = typeof ownerDistributions.$inferInsert;
```


### `db/schema/acc/payment_allocations.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  numeric,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { idCol } from "../_shared";
import { legalEntities, users } from "../core";
import { chartOfAccounts } from "./chart_of_accounts";
import { creditMemos } from "./credit_memos";
import { invoices } from "./invoices";
import { journalEntries } from "./journal_entries";
import { payments } from "./payments";

export const ALLOCATION_TARGET_TYPES = [
  "invoice_line_item",
  "loan_payment",
  "security_deposit",
  "customer_credit",
  "prepayment",
  "writeoff",
  "credit_memo",
  "intercompany",
  "other",
] as const;

export const paymentAllocations = accSchema.table(
  "payment_allocations",
  {
    id: idCol(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "cascade" }),
    allocatedToType: text("allocated_to_type").notNull(),
    allocatedToId: uuid("allocated_to_id"),
    invoiceId: uuid("invoice_id").references(() => invoices.id, {
      onDelete: "set null",
    }),
    creditMemoId: uuid("credit_memo_id").references(() => creditMemos.id, {
      onDelete: "set null",
    }),
    loanPaymentId: uuid("loan_payment_id"),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    allocationDate: date("allocation_date").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    classId: uuid("class_id"),
    entityId: uuid("entity_id").references(() => legalEntities.id),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => [
    index("pmt_alloc_payment_idx").on(t.paymentId),
    index("pmt_alloc_invoice_idx")
      .on(t.invoiceId)
      .where(sql`${t.invoiceId} IS NOT NULL`),
    index("pmt_alloc_target_idx").on(t.allocatedToType, t.allocatedToId),
    index("pmt_alloc_credit_idx")
      .on(t.creditMemoId)
      .where(sql`${t.creditMemoId} IS NOT NULL`),
    index("pmt_alloc_loan_pmt_idx")
      .on(t.loanPaymentId)
      .where(sql`${t.loanPaymentId} IS NOT NULL`),
    check("pmt_alloc_amount_chk", sql`${t.amount} > 0`),
    check(
      "pmt_alloc_target_type_chk",
      sql`${t.allocatedToType} IN ('invoice_line_item','loan_payment','security_deposit','customer_credit','prepayment','writeoff','credit_memo','intercompany','other')`,
    ),
  ],
);

export type PaymentAllocation = typeof paymentAllocations.$inferSelect;
export type NewPaymentAllocation = typeof paymentAllocations.$inferInsert;
```


### `db/schema/acc/payments.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { contacts, legalEntities, organizations, users } from "../core";
import { bankAccounts } from "./bank_accounts";
import { bankTransactions } from "./bank_transactions";
import { journalEntries } from "./journal_entries";

export const PAYMENT_DIRECTIONS = ["in", "out"] as const;
export const PAYMENT_METHODS = [
  "stripe_card",
  "stripe_ach",
  "wire",
  "check",
  "cash",
  "zelle",
  "venmo",
  "intercompany",
  "adjustment",
  "credit_memo_application",
  "other",
] as const;
export const PAYMENT_STATUSES = [
  "pending",
  "cleared",
  "failed",
  "refunded",
  "partially_refunded",
  "disputed",
  "void",
] as const;

export const payments = accSchema.table(
  "payments",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    paymentNumber: text("payment_number").notNull(),
    direction: text("direction").notNull(),
    receivedByEntityId: uuid("received_by_entity_id")
      .notNull()
      .references(() => legalEntities.id),
    forEntityId: uuid("for_entity_id").references(() => legalEntities.id),
    counterpartyContactId: uuid("counterparty_contact_id").references(
      () => contacts.id,
    ),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    paymentDate: date("payment_date").notNull(),
    valueDate: date("value_date"),
    method: text("method").notNull(),
    bankAccountId: uuid("bank_account_id").references(() => bankAccounts.id),
    bankTransactionId: uuid("bank_transaction_id").references(
      () => bankTransactions.id,
      { onDelete: "set null" },
    ),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeChargeId: text("stripe_charge_id"),
    stripePayoutId: text("stripe_payout_id"),
    checkNumber: text("check_number"),
    referenceNumber: text("reference_number"),
    status: text("status").notNull().default("pending"),
    unallocatedAmount: numeric("unallocated_amount", {
      precision: 15,
      scale: 2,
    })
      .notNull()
      .default("0"),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    approvalRequestId: uuid("approval_request_id"),
    memo: text("memo"),
    notes: text("notes"),
    failureReason: text("failure_reason"),
    refundAmount: numeric("refund_amount", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
  },
  (t) => [
    uniqueIndex("payments_number_uniq").on(t.orgId, t.paymentNumber),
    index("payments_status_date_idx").on(t.orgId, t.status, t.paymentDate),
    index("payments_counterparty_idx").on(
      t.counterpartyContactId,
      t.paymentDate,
    ),
    index("payments_bank_tx_idx")
      .on(t.bankTransactionId)
      .where(sql`${t.bankTransactionId} IS NOT NULL`),
    uniqueIndex("payments_stripe_pi_uniq")
      .on(t.stripePaymentIntentId)
      .where(sql`${t.stripePaymentIntentId} IS NOT NULL`),
    index("payments_entity_idx").on(t.receivedByEntityId, t.paymentDate),
    index("payments_unallocated_idx")
      .on(t.unallocatedAmount)
      .where(sql`${t.unallocatedAmount} > 0`),
    check("payments_amount_chk", sql`${t.amount} > 0`),
    check("payments_unallocated_chk", sql`${t.unallocatedAmount} >= 0`),
    check("payments_direction_chk", sql`${t.direction} IN ('in','out')`),
    check(
      "payments_method_chk",
      sql`${t.method} IN ('stripe_card','stripe_ach','wire','check','cash','zelle','venmo','intercompany','adjustment','credit_memo_application','other')`,
    ),
    check(
      "payments_status_chk",
      sql`${t.status} IN ('pending','cleared','failed','refunded','partially_refunded','disputed','void')`,
    ),
  ],
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
```


### `db/schema/acc/transaction_match_rules.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { organizations } from "../core";

export const transactionMatchRules = accSchema.table(
  "transaction_match_rules",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(100),
    enabled: boolean("enabled").notNull().default(true),
    conditions: jsonb("conditions").notNull(),
    actions: jsonb("actions").notNull(),
    matchCount: integer("match_count").notNull().default(0),
    lastMatchedAt: timestamp("last_matched_at", { withTimezone: true }),
  },
  (t) => [index("match_rules_lookup_idx").on(t.orgId, t.enabled, t.priority)],
);

export type TransactionMatchRule = typeof transactionMatchRules.$inferSelect;
export type NewTransactionMatchRule = typeof transactionMatchRules.$inferInsert;
```


### `db/schema/acc/write_offs.ts`

```typescript
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accSchema } from "../schemas";
import { standardCols } from "../_shared";
import { contacts, legalEntities, organizations, users } from "../core";
import { leases } from "../pm";
import { chartOfAccounts } from "./chart_of_accounts";
import { invoices } from "./invoices";
import { journalEntries } from "./journal_entries";
import { payments } from "./payments";

export const WRITEOFF_TYPES = [
  "bad_debt",
  "tenant_skipped",
  "dispute_loss",
  "statute_of_limitations",
  "collection_agency_failure",
  "small_balance",
  "administrative",
  "tenant_deceased",
  "other",
] as const;

export const WRITEOFF_STATUSES = [
  "pending",
  "approved",
  "posted",
  "recovered",
  "reversed",
] as const;

export const writeOffs = accSchema.table(
  "write_offs",
  {
    ...standardCols(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    writeoffNumber: text("writeoff_number").notNull(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => legalEntities.id),
    counterpartyContactId: uuid("counterparty_contact_id")
      .notNull()
      .references(() => contacts.id),
    invoiceId: uuid("invoice_id").references(() => invoices.id, {
      onDelete: "set null",
    }),
    leaseId: uuid("lease_id").references(() => leases.id, {
      onDelete: "set null",
    }),
    writeoffDate: date("writeoff_date").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    writeoffType: text("writeoff_type").notNull(),
    reason: text("reason"),
    badDebtAccountId: uuid("bad_debt_account_id")
      .notNull()
      .references(() => chartOfAccounts.id),
    recoveredAmount: numeric("recovered_amount", { precision: 15, scale: 2 })
      .notNull()
      .default("0"),
    recoveredPaymentId: uuid("recovered_payment_id").references(
      () => payments.id,
      { onDelete: "set null" },
    ),
    recoveredDate: date("recovered_date"),
    recoveryJournalEntryId: uuid("recovery_journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("pending"),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    approvalRequestId: uuid("approval_request_id"),
    journalEntryId: uuid("journal_entry_id").references(
      () => journalEntries.id,
      { onDelete: "set null" },
    ),
    evidenceDocumentIds: uuid("evidence_document_ids").array(),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    postedBy: uuid("posted_by").references(() => users.id),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by").references(() => users.id),
  },
  (t) => [
    uniqueIndex("writeoffs_number_uniq").on(t.orgId, t.writeoffNumber),
    index("writeoffs_invoice_idx")
      .on(t.invoiceId)
      .where(sql`${t.invoiceId} IS NOT NULL`),
    index("writeoffs_counterparty_idx").on(t.counterpartyContactId),
    index("writeoffs_status_date_idx").on(t.status, t.writeoffDate),
    index("writeoffs_entity_date_idx").on(t.entityId, t.writeoffDate),
    check("writeoffs_amount_chk", sql`${t.amount} > 0`),
    check(
      "writeoffs_type_chk",
      sql`${t.writeoffType} IN ('bad_debt','tenant_skipped','dispute_loss','statute_of_limitations','collection_agency_failure','small_balance','administrative','tenant_deceased','other')`,
    ),
    check(
      "writeoffs_status_chk",
      sql`${t.status} IN ('pending','approved','posted','recovered','reversed')`,
    ),
  ],
);

export type WriteOff = typeof writeOffs.$inferSelect;
export type NewWriteOff = typeof writeOffs.$inferInsert;
```

