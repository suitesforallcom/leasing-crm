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
