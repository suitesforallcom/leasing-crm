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
