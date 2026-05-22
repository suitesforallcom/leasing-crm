# FINANCIAL_INVARIANTS.md

> **Single source of truth for financial-correctness rules in SuitesForAll.**
> Born from the phantom-transaction incident on 2026-05-21 (Tony's NUHS
> Suite 101 / $13,318.33 dup from disconnected Stripe FC account).
>
> Read this BEFORE touching any code path that ingests, displays,
> matches, or mutates `state.u.payments`, `bankTransactions`,
> `stripeInvoices`, or financial fields on units/leases.

---

## 0. Why this document exists

Tony's words on 2026-05-21:

> «Это финансы здесь совершенно не может быть никаких ошибок. Сделать
> так чтобы в финансах вообще никогда не было никаких ошибок это
> критично. Посмотри как лучших финансовых программах написан код и
> напиши также чтобы таких ошибок не повторялось мне нужно предугадать
> последующие ошибки чтобы их тоже не возникало.»

In English: **financial errors are intolerable**. The patterns below
mirror what industry-standard accounting/PMS software (Yardi, AppFolio,
QuickBooks, Stripe, Plaid) enforce internally.

If you propose a change that violates an invariant below, **stop and
ask Tony**. No exceptions.

---

## I. Append-only ledger

**Never mutate or delete historical financial records in-place.**
Corrections are reversal entries (a new row with negated amount), not
overwrites.

### Concretely
- `u.payments[ym]` records ARE mutable today (status, amount,
  paidVia, reference fields) but the audit log MUST record before/after.
- Once an invoice is paid, the underlying payment row should not be
  rewritten — instead, attach a reversal/correction row.
- Deletions of `bankTransactions` MUST go through `cleanupOrphanBankTransactions`
  (functions/index.js) which writes a full snapshot to
  `workspaces/{ws}/audit` before deleting.

### Why
Auditors, tax filings, dispute investigations need to see WHAT was
there yesterday. Silent overwrites destroy the paper trail.

---

## II. Idempotent ingestion (deterministic fingerprint)

**Every external transaction has a stable canonical fingerprint. Two
writes with the same fingerprint MUST collapse to one row.**

### Current state (incomplete)
- Stripe FC: doc-id = `t.id` (Stripe transaction ID). Fails when Stripe
  issues a new ID for the same logical deposit (pending→posted, reconnect).
- CSV import: doc-id = `imp_<sha1(date|amount|description)>`. Reasonable
  but description sensitivity makes it fragile.
- **No cross-source dedupe between Stripe FC and CSV imports.**

### Target state (Tier 2 — pending Tony approval)
- Composite fingerprint doc-id:
  `fp_<sha1(accountFamily|amountCents|dayBucketNY|descriptionNormalized).slice(0,24)>`
- `dayBucketNY` = day-of-year in **America/New_York** TZ, NOT UTC.
- `descriptionNormalized` = lowercase, alphanum only, trimmed.
- `accountFamily` = first 8 chars of accountId (covers reconnect cases
  where new fc_account_id shares the same bank).
- Raw `t.id` preserved in field `stripeFcTransactionId` for traceability.

### Why
A reconnect, a Stripe ID format change, a description typo by the bank
— none of these are valid reasons to create a duplicate financial row.

---

## III. Source-of-truth pointer

**Every internal financial record links back to its external origin.**

### Fields required on every `bankTransactions` doc
- `accountId` — Stripe FC `fca_*` OR `import:csv:*` OR `import:ofx:*`
- `source` — `'stripe-fc' | 'csv' | 'ofx' | 'manual'`
- `sourceExternalId` — Stripe FC `t.id`, OFX `FITID`, CSV row hash
- `seenAt` — server timestamp when first ingested
- `lastUpdatedAt` — server timestamp on any merge

### Fields required on every `u.payments[ym]` record
- `bankTxnId` (when applicable) — points back to bankTransactions doc
- `stripeInvoiceId` (when applicable) — points to Stripe invoice
- `paidVia` — `'stripe' | 'check' | 'ach' | 'wire' | 'cash' | 'other'`
- `recordedBy` — operator email
- `recordedAt` — ISO timestamp

### Why
Reconciliation is impossible without bi-directional links. If a row
exists internally but not in the bank statement, we need to find it
in seconds, not hours.

---

## IV. Audit trail on every write

**Every financial mutation writes to `workspaces/{ws}/audit`.**

### What gets logged
- `payment.mark-paid` — manual payment recorded
- `payment.unmark` — payment reversed
- `payment.variance-as-is` — bank amount differs from rent, applied as-is
- `rent.change` — head.contractRent updated
- `credit.overpayment` — overpayment credited
- `payment.one-time-fee` — extra charge recorded
- `payment.refund-pending` — refund flagged
- `bank.txn.dup_suspected` — UI detected potential duplicate
- `bank.txn.dup_review` — operator opened drill-down popover
- `bank.txn.orphan-cleanup` — CF deleted orphan doc

### Audit row fields
```
{
  action: string,
  ts: serverTimestamp,
  actor: email,
  actorRole: 'admin' | 'manager' | 'mapeditor' | 'cloud-function',
  unitId?, headUnitId?, groupId?, ym?,
  before?: snapshot,
  after?: snapshot,
  reason?: free-text,
  source?: 'mpm' | 'txn-browser' | 'cron' | 'webhook' | 'admin-script',
}
```

### Why
"What happened to suite X's rent in May 2026?" must answer in under 10
seconds via the audit log, not via guessing.

---

## V. Pending vs Posted vs Reconciled — never blur

**A bank transaction has THREE distinct lifecycle states. UI must show
which state each row is in. Operators must not be able to apply a
`pending` row as if it were settled money.**

### States
- **pending** — bank may still reverse this (insufficient funds,
  chargeback). Stripe FC `status: 'pending'`.
- **posted** — money cleared. Stripe FC `status: 'posted'`.
- **reconciled** — operator has matched this txn to a specific
  `u.payments[ym]` record. Field `matchState: 'confirmed'`.

### UI rule
- Suggestions card SHOULD prefer `posted` > `pending`. `pending` rows
  get an explicit "PENDING" badge.
- Apply-pending rows write `u.payments[ym].pendingBank: true` so the
  operator can re-verify on next bank poll.

---

## VI. Reconciliation invariant

**For every active bank account, `sum(bankTransactions.amount where
matchState='confirmed' AND status='posted') == sum(u.payments[*].amount
where bankTxnId IS NOT NULL)`.**

### Daily reconciliation job (Tier 3 — pending)
A scheduled Cloud Function runs every 24h:
1. Aggregates `confirmed+posted` bank txn amounts.
2. Aggregates `bankTxnId NOT NULL` payment amounts.
3. If `diff > $0.50` → alert to Sentry + email to root admin.

### Why
Drift between the two ledgers means someone has a phantom payment OR a
phantom deposit. Either way, the operator needs to know within 24h.

---

## VII. Period locks (Tier 3 — pending)

**Closed accounting periods cannot be modified except via explicit
reversal journal entries.**

### Plan
- `state.settings.lockedPeriods: ['2026-04', '2026-03', ...]`
- Mutations targeting `u.payments[lockedYm]` reject with
  `permission-denied` unless the operator is admin AND explicitly
  passes `forceLockBypass: true` (with mandatory reason).
- Reversal entries land in the current open period, not the locked one.

### Why
Operators routinely "fix" historical months months after the books are
closed. Locked periods protect end-of-year reports from late tampering.

---

## VIII. Two-way attestation

**Money moving IN: bank must acknowledge. Money moving OUT: client
must acknowledge.**

### Concretely
- **Inbound (rent received):** the system must have a confirmed
  bankTransactions row (from Stripe FC or operator-imported CSV)
  before marking `u.payments[ym]` as paid. Marking paid without a
  bank-side anchor → warning chip "⚠ unverified".
- **Outbound (refunds, vendor payments — not implemented yet):**
  external system (Stripe transfer, ACH push) must confirm receipt
  before we mark our internal record settled.

### Why
A unilateral "paid" record is just a claim, not evidence.

---

## IX. Variance investigation queue

**Anything that doesn't reconcile lands in a queue, NOT silently swept.**

### Implementation
- `state.settings.varianceQueue: []` — array of variance events the
  operator must triage.
- Triage actions: "Apply rent change", "Mark one-time fee", "Issue
  refund", "Confirm as-is", "Dispute with bank".
- A daily reminder in Pulse shows the queue size.

### Why
Sweeping a $0.33 variance under the rug 12× in a year = $4 unexplained
ledger drift. Sweeping a $100 variance 12× = $1200. Visibility forces
investigation.

---

## X. Defensive UI

**Show duplicate/anomaly suspicions BEFORE the operator can act on them.**

### Current implementations
- `_bankDetectDuplicates` (floor-map-editor.html) — collapse same-amount
  ±2 days into one row + warning chip.
- "⚠ used" chip in txn browser when a row is already linked elsewhere.
- "+$0.33 over" / "−$318 short" chips on the Apply button for variance.

### Pattern
When in doubt, render `⚠ <reason> — verify`. Never silently coalesce
two financial records into one without flagging it.

### Why
The operator is the last human in the loop. UI must give them every
chance to catch an issue before they apply.

---

## XI. Automated reconciliation — high-trust gates

**The system may apply payments to `u.payments[ym]` automatically after a
bank-feed poll, but ONLY when the match is overwhelmingly unambiguous.**

### Auto-apply criteria (Strict mode — Tony's default 2026-05-21)
A bank transaction may be auto-applied to `u.payments[ym]` if and only if:

1. `txn.status === 'posted'` (never pending — bank may reverse pending)
2. `txn.amount > 0` (credits only, never debits)
3. The transaction is not already linked to another payment
4. **Exactly one** unit in the workspace has rent within ±$1.00 of
   the bank amount (composite-fingerprint identity)
5. That unit has at least one **unpaid month** within the active
   lease window
6. The unit does NOT have `autoApplyDisabled === true`
7. The global `state.settings.autoApplyEnabled` is not explicitly `false`

If ANY of these fail → fall back to operator manual review
(`matchState='suggested'` → operator clicks Apply in MPM).

### Auto-apply writes (atomic, transactional)
```
u.payments[ym] = {
  status: 'paid',
  amount: <bank.amount / 100>,
  paidVia: <_guessMethodFromDescServer(desc)>,    // 'ach' / 'check' / etc.
  paidReference: <bank.description, 80 chars>,
  paidAt: <bank.transactedAt as YYYY-MM-DD>,
  recordedBy: 'auto-match',
  recordedAt: <ISO timestamp>,
  bankTxnId: <bank.id>,
  bankPaidAt: <bank.transactedAt as YYYY-MM-DD>,
  bankAccountId: <bank.accountId>,
  autoApplied: true,                              // ← REVERSIBILITY MARKER
  autoAppliedAt: <ISO timestamp>,
  autoMatchDeltaCents: <|bank.amount - rent.cents|>,
  autoMatchRentCents: <expected rent in cents>,
}
```

### Reversibility (mandatory)
- Every auto-applied payment carries `autoApplied: true`.
- The operator MUST be able to undo via a one-click button in the MPM
  modal (`_mpmUndoAutoApplied` → `undoAutoAppliedPayment` callable CF).
- Undo writes audit `payment.auto-applied.undo` and returns the bank
  txn to `matchState='suggested'` so the operator can manually re-link.
- An auto-applied payment that the operator subsequently edits manually
  (changes amount, method, reference) MUST clear the `autoApplied` flag
  — once human-touched, it is operator-authoritative, not auto-attributed.

### Audit invariant (cannot be skipped)
Every auto-apply writes to `workspaces/{ws}/audit`:
- `action: 'payment.auto-applied'`
- `actor: 'auto-match'`
- `bankTxnId, bankAmount, bankDescription, bankAccountId`
- `unitId, buildingId, floorId, ym`
- `deltaCents, rentCents`

Every undo writes:
- `action: 'payment.auto-applied.undo'`
- `actor: <operator email>, actorRole: <role>`
- `bankTxnId, unitId, ym`

### What auto-apply NEVER does
- **Never** raise or change `u.contractRent`. Rent changes are the
  variance dialog's job (FIXES_LOG #29).
- **Never** create one-time fees, refunds, or credit-balance entries.
  Those are all explicitly operator-confirmed.
- **Never** auto-apply CSV-imported transactions (no
  `import:*` accountIds — operator already chose what to import).
- **Never** auto-apply if any of `u.payments[ym]` exists with status
  already `'paid'`, `'free'`, or has `bankTxnId === txn.id` (idempotency).
- **Never** auto-apply for an archived unit (`u.deletedAt` set).
- **Never** auto-apply for a satellite suite (`u.groupId && u.groupRole
  !== 'primary'`) — only the head of a multi-suite lease can be the
  target.

### Why we use direct candidate-finder, not the matcher
The existing `_matchTransaction` scoring system gates at 60 points. For
bank descriptions without a tenant name (e.g. `Customer Deposit`,
`Mobile Deposit`, `ACH Credit`), even an exact-amount, single-candidate
match scores ~45 points and never reaches `matchState='suggested'`. So
auto-apply has its own direct check (`_findAutoApplyCandidate`) that
relies on three facts only: posted, credit, single rent-match. The
matcher's score remains useful for the operator-facing suggestions
panel but is not authoritative for auto-apply decisions.

---

## Reference: the 2026-05-21 phantom incident

- See [FIXES_LOG.md](FIXES_LOG.md) Entry 30 for the full timeline.
- Root cause: Stripe FC reconnect → new `fc_account_id` → orphan docs
  in `bankTransactions` from disconnected account.
- Fix: Tier 1 client-side dup-detection + Tier 1 cleanup CF.
- **Tier 2 pending:** composite fingerprint doc-id (rewrite of
  `_pullTransactionsForAccount`).
- **Tier 3 pending:** daily reconciliation cron, period locks, variance
  queue.

---

## How to add a new invariant

1. Run into a financial bug in production.
2. Diagnose root cause.
3. Add a `FIXES_LOG.md` entry with full Invariant — DO NOT BREAK list.
4. If the invariant generalizes beyond the one bug, add a section here.
5. Cite this doc in `CLAUDE.md` "Approval STILL required" list.

---

> **«Лучше один раз спросить, чем один раз случайно double-credit'нуть
> рент.»** — Operator's law of finance, by Tony.
