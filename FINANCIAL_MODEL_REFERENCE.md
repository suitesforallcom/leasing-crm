# FINANCIAL_MODEL_REFERENCE.md

> **Canonical source for all financial logic in SuitesForAll, set 2026-05-11 evening.**
>
> Source: Tony's Kiwi Rentals financial-rules bundle, loaded into `financial-model/` as 14 markdown docs + 9 TypeScript schema files (12,739 + 829 lines). The Kiwi bundle was authored against a different tech stack (Next.js + Drizzle + PostgreSQL + multi-LLC `acc.*` schema). SuitesForAll is single-file vanilla JS + Firestore single-doc state.
>
> This file is the **applicability map** — it documents which Kiwi rules apply to SuitesForAll AS-IS, which require architectural prerequisites, and which are N/A for the current architecture. Every financial code change in SuitesForAll must be checked against this file FIRST.

---

## 0. Pre-deploy gate (mandatory)

Before ANY commit that touches financial code paths in SuitesForAll, Claude MUST:

1. Re-read this file in full
2. Identify which Kiwi rules apply (from § 2 mapping below)
3. Verify the proposed change aligns with those rules — OR explicitly note the divergence + reason in the commit message
4. If the change introduces a NEW financial behavior not covered by current SuitesForAll formulas, propose a "SuitesForAll equivalent rule" and ask Tony to approve before committing
5. Pass the relevant subset of the [Kiwi PR Review Checklist](financial-model/FINANCIAL_REVIEW_CHECKLIST.md) — adapted to SuitesForAll's simpler architecture

If discrepancies between Kiwi rules + current SuitesForAll behavior are found, **STOP** and report to Tony — don't silently fix or silently leave.

Auto-deploy mode (re-enabled 2026-05-11) does NOT skip this gate. The auto-pipeline is: parse → commit → stamp → deploy → push. The financial-gate slots BEFORE commit, as part of the per-edit checklist.

---

## 1. What "financial code paths" means in SuitesForAll

Touching ANY of these = financial:

- `floor-map-editor.html`:
  - `submitManualPayment()` and helpers
  - `_compute30DayActivity()`, `_unitProrationCredit()`
  - `_isFinanceShadow()`, `_isInactiveSubRoom()`, `_unitContributesToMRR()`
  - `_isDepositPaid()`, `_unitTenantSignedAt()`
  - `effectiveMonthly` calc, `STATUS_FILL` for vacant/occupied
  - `renderHomeForecast()`, `renderHomeInvest()`, `_investBuilding*()`, `investComputeAll()`
  - Late-fee bulk-send, A/R Aging buckets, Stripe modal (`_mpmCtx`, `_mpm*` helpers)
  - Recovery cases (`state.recoveryCases[]`)
  - Auto-billing Cron triggers visible in UI (`buildAutoBillingRows`, `applyAutoBillingFilters`)
- `functions/index.js` (Cloud Functions) — entire file, especially:
  - Stripe webhooks (`invoice.payment_succeeded`, `payment_failed`, `charge.refunded`, etc.)
  - Auto-billing scheduled cron
  - Late-fee assessment logic
  - Receipt upload helpers (less sensitive)
- `firestore.rules` — finance-related allow/deny rules
- Any helper that reads/writes `u.payments`, `u.contractRent`, `u.rent`, `u.lateFee`, `u.stripe.*`

---

## 2. Kiwi rule applicability matrix

Each Kiwi `FINANCIAL_LOGIC_RULES.md` rule mapped to SuitesForAll status:

| Kiwi Rule | Topic | SuitesForAll Status | Notes |
|---|---|---|---|
| **§1 Money type (M1-M4)** | Decimal-safe types, no float math | 🟡 PARTIAL | SuitesForAll uses raw JS `number` (`+u.contractRent`). Acceptable for current single-currency simple-math case, but risks accumulation errors. **Don't introduce any new currency-string `+` operations.** Document any new financial math with explicit `Math.round(value * 100) / 100` pattern. |
| **§2 Journal entries (J1-J5)** | Double-entry GL, debit=credit | ❌ N/A by architecture | SuitesForAll has NO general ledger. Payments are flat records on `u.payments[ym]`. Migrating to GL = enormous schema change requiring Tony approval + multi-week work. |
| **§3 Closed periods (C1-C3)** | Period close immutability | ❌ N/A | No accounting periods in current schema. |
| **§4 Soft delete (D1-D3)** | No DELETE on financial records | 🟢 APPLIES | SuitesForAll uses `archivedAt` for buildings/units. Payments not currently deletable from UI. **Don't add hard-delete UI for payments / units / leases.** |
| **§5 Security deposits (SD1-SD5)** | Held = liability, 5 categories | 🟡 PARTIAL | SuitesForAll tracks `u.payments.deposit` as one record. The 5-category distinction (refundable / final-month-rent / forfeited / damage-retention / refund) is NOT enforced. Treating deposit as flat = audit risk. **Tony decision needed**: enforce the 5-category model? Would be a schema change. |
| **§6 Advance rent (AR1-AR5)** | Accrual book / IRS tax separation, ASC 842 | ❌ N/A | SuitesForAll doesn't distinguish book-vs-tax and doesn't apply ASC 842. Cash-basis-style recording only. |
| **§7 Late fees (LF1-LF5)** | Line items on existing invoice, dedup per cycle, separate revenue account | 🟡 PARTIAL | SuitesForAll late fees fire as separate Stripe invoices with line items, `u.lateFee.sentList` provides per-month dedup, but there's no separate revenue account (no GL). **Dedup is honored**; **separate-account is N/A**. |
| **§8 Concessions (CN1-CN4)** | Revenue vs operating, immutable classification, ASC 842 straight-line | 🟡 PARTIAL | SuitesForAll tracks waivers (`status='free'`, `waiverReason`) and supports referral credit (100% / 50% / 0% depending on lease term). Concessions are NOT classified revenue-vs-operating; ASC 842 straight-line N/A. |
| **§9 Overpayments (OP1-OP3)** | Overpayments are unapplied cash, never income | ⚠️ NOT ENFORCED | SuitesForAll has 5× over-record guard in `submitManualPayment` but doesn't have an `unapplied_amount` concept. Currently the operator manages overpayments via memo. **Risk**: overpayments could be silently treated as paid. |
| **§10 Partial payments (PP1-PP4)** | Allocations sum, atomic status updates | 🟡 PARTIAL | SuitesForAll has `status: 'partial'` but no allocation table. Status updates are atomic with the payment write (single doc). Partial payments are operator-driven, not formula-driven. |
| **§11 Invoice numbering (IN1-IN4)** | Atomic via `nextNumber()`, immutable | 🟡 STRIPE-DELEGATED | SuitesForAll lets Stripe assign invoice numbers (`in_*`). `INV-YYYY-NNNNN` format N/A. `u.lateFee.sentList[].invoiceId` stores the assigned ID. **Stripe handles atomicity.** |
| **§12 Feature flags (FF1-FF3)** | All financial automation defaults OFF | 🟡 PARTIAL | SuitesForAll has `state.settings.lateFee.autoSendLive` (workspace-level dry-run flag) AND per-unit `u.lateFee.autoSend` AND per-building `b.billingRulesOverride.paused`. Three layers of opt-in, BUT defaults vary (some are ON in fresh installs). **Tony decision**: enforce default-OFF? |
| **§13 Sandbox-only restriction (SB1-SB3)** | Test mode for all 3rd-party until Tony approves | 🟢 APPLIES | `STRIPE_MODE` env var; never construct live key in code; no real emails to customers without verified domain. |
| **§14 Financial PR handoff (HF1-HF2)** | Required Financial Handoff comment | ❌ N/A | SuitesForAll doesn't use PR workflow. Replaced by SuitesForAll's commit-message + final-report convention (see CLAUDE.md "Final Response Format"). |
| **§15 Loan payments split (NEW v2)** | Principal/interest/escrow/fees per amortization | ❌ N/A | SuitesForAll doesn't track loan payments. `state.investments[bId].refiAmount / refiRatePct / refiTermYears` are inputs to NPV/IRR analysis only — no actual payments tracked. |
| **§16 Bank reconciliation (NEW v2)** | State machine matched/unmatched/disputed | ❌ N/A | SuitesForAll has no bank-feed connection. Manual payment recording only. |
| **§17 Owner equity (NEW v2)** | Contributions/distributions are equity, not income | ❌ N/A | SuitesForAll doesn't track owner activity. |
| **§18 Fixed asset disposals (NEW v2)** | Book gain/loss vs tax treatment | ❌ N/A | SuitesForAll doesn't track fixed assets. |

---

## 3. SuitesForAll-specific equivalent rules (where Kiwi rules don't directly apply)

Where SuitesForAll has its own simpler approach, document the equivalent here:

### EQ-1. Effective rent (SuitesForAll)
```
effectiveMonthly = (u.status === 'occupied')
                   ? (+u.contractRent || +u.rent || 0)   // legacy fallback
                   : (+u.rent || 0)
```
Used by Rent Roll, Stacking, Avg Rent cards, A/R Aging. Documented in DECISIONS.md § 3.
**Equivalent of Kiwi**: §1 (Money type — partial), §6 (Advance rent — N/A here as we're cash-recording-style).

### EQ-2. Multi-suite lease (`groupId`)
One tenant + one contract + one set of invoices. Members hold `contractRent = 0`; primary holds combined. `_isFinanceShadow(u)` skips members in finance loops.
**Equivalent of Kiwi**: §10 (Partial payments — adapted for multi-suite split).

### EQ-3. Sub-room (`parentId`)
Children of whole-rented or grouped parents are inactive in MRR / aging / vacancy.
**Equivalent of Kiwi**: no direct Kiwi rule.

### EQ-4. Building valuation defaults
- Forecast hero «Potential Value»: `(GPR × 65%) / 9%` → 9% cap, 0% vacancy (proforma 100% leased), 35% expenses
- Investment Analysis quick-estimate / seed: `(GPR × 95% × 65%) / 7%` → 7% cap, 5% vacancy, 35% opex
- Investment Analysis full record: per-building configurable

**Equivalent of Kiwi**: no direct Kiwi rule (Kiwi focuses on transaction accounting, not asset valuation).

### EQ-5. Waiver pro-rate
`_unitProrationCredit(u, ym)` returns fraction (0..1) of rent to credit for a given ym, walking all `u.payments[*]` with `status='free'` and `waiverStart/End`.
**Status**: helper exists; **NOT yet wired** into invoice generation. KNOWN_ISSUES.md #1.
**Equivalent of Kiwi**: §8 CN1 (concession classification — partial).

### EQ-6. Late fee (SuitesForAll)
Per-unit `u.lateFee.autoSend` opt-in. Per-building pause. Workspace dry-run flag. `u.lateFee.sentList[]` for per-month dedup.
**Equivalent of Kiwi**: §7 (Late fees — partial; no separate revenue account because no GL).

### EQ-7. Activity pill
Window: month-to-date. Inclusion criterion: `leaseStart`. Scope: active building.
**Equivalent of Kiwi**: no direct rule (Kiwi doesn't define dashboard pills).

---

## 4. Architectural gap (read this before proposing big changes)

SuitesForAll's payment record:
```js
u.payments[ym] = { status, amount, date, method, ref, memo, ... }
```

Kiwi's expected payment record:
```ts
acc.payments {
  id, orgId, paymentNumber, paymentDate, amount, paymentMethod,
  status, ...,
  allocations: acc.payment_allocations[]  // can split across N invoices
}
acc.payment_allocations { paymentId, invoiceId, amount }
acc.invoices { ... }
acc.invoice_line_items { ... }
acc.journal_entries { totalDebits, totalCredits, sourceType, sourceId, ... }
acc.journal_entry_lines { journalId, accountCode, debit, credit, ... }
acc.chart_of_accounts { code, name, type, ... }
acc.accounting_periods { startDate, endDate, isLocked }
```

Migrating SuitesForAll → Kiwi schema requires:
1. **Migrating from Firestore single-doc → relational** (Postgres or Firestore sub-collections with manual JOIN logic)
2. Adding double-entry GL: every operational mutation triggers journal posting
3. Building period-close UI + lock semantics
4. Building bank reconciliation state machine
5. Adding chart-of-accounts UI + seed
6. Migrating historical `u.payments[*]` to journal entries (needs accounting basis decision per legal entity)

**Estimate**: weeks-to-months of architecture work. **Not a Claude-decides task.** Tony decides if/when to undertake this migration.

In the meantime: SuitesForAll operates on the simpler record-keeping model. Document each new financial change against this file's § 2 + § 3.

---

## 5. Kiwi source files (DO NOT EDIT — reference only)

These files in `financial-model/` are the canonical Kiwi rules. Do not edit them — they're the source of truth from another project. Updates come from re-importing a fresh bundle.

| File | Purpose |
|---|---|
| `financial-model/kiwi-financial-rules-bundle.md` | Single-file export of everything (7,623 lines) |
| `financial-model/finance-guardian.md` | Working-memory cheat sheet + 14 hard rules (compressed) + escalation protocol |
| `financial-model/FINANCIAL_LOGIC_RULES.md` | Full §1-§19 rules (1,055 lines) — primary citation source |
| `financial-model/FINANCIAL_GL_ACCOUNTS.md` | Chart of accounts inventory + mapping |
| `financial-model/FINANCIAL_BLOCKING_GATES.md` | What blocks merge per-PR-category |
| `financial-model/FINANCIAL_MODULE_SYNC_RULES.md` | Cross-module sync (6 flows A-F) |
| `financial-model/FINANCIAL_TEST_PLAN.md` | Test surface coverage |
| `financial-model/FINANCIAL_TEST_MATRIX.md` | Gate × module grid |
| `financial-model/FINANCIAL_INTEGRITY_TEST_SUITE.md` | File/folder layout for tests |
| `financial-model/FINANCIAL_RECONCILIATION_TESTS.md` | Reconciliation specs |
| `financial-model/FINANCIAL_REVIEW_CHECKLIST.md` | PR review template (9 questions, 6 invariants) |
| `financial-model/FINANCIAL_COMPLIANCE_NOTES.md` | Jurisdiction overlays (NJ/MA/NY trust accounts, etc.) |
| `financial-model/FINANCIAL_EXAMPLES.md` | Worked examples — debit/credit reference |
| `financial-model/FINANCIAL_MIGRATION_GUIDE.md` | Historical import paths |
| `financial-model/db-schema-acc/*.ts` | 9 Drizzle schema files (invoices, payments, allocations, etc.) |

---

## 6. Pre-commit checklist for any financial change in SuitesForAll

Before committing any change to a "financial code path" (per § 1):

- [ ] Re-read § 2 mapping table — identify which Kiwi rules apply
- [ ] Re-read § 3 SuitesForAll equivalents — does the change conflict with one?
- [ ] If touching effective-rent / cap-rate / late-fee / pro-rate logic → cross-check the formula in `financial-model/FINANCIAL_LOGIC_RULES.md` § 5-§ 11
- [ ] If touching concession / waiver logic → cross-check § 8 (CN1-CN4) — at minimum, verify the change preserves the "classification immutable after first posting" semantics (EQ-5 above)
- [ ] If touching late-fee logic → preserve dedup (LF2 → SuitesForAll's `sentList` already does this — don't break)
- [ ] If touching deposit logic → cross-check § 5 (SD1-SD5) — at minimum, don't treat refundable deposit as income
- [ ] If touching multi-suite or sub-room aggregation → preserve `_isFinanceShadow` / `_isInactiveSubRoom` skips (EQ-2, EQ-3)
- [ ] If introducing a NEW financial behavior → propose a "SuitesForAll equivalent rule" and ask Tony BEFORE committing
- [ ] Verify the change doesn't introduce float math on currency (Rule M1 spirit)
- [ ] Update DECISIONS.md § 3 if a formula or default changed
- [ ] Update this file (§ 2 or § 3) if the SuitesForAll-vs-Kiwi mapping changed

---

## 7. Discrepancies log

Any time a Claude session finds a discrepancy between SuitesForAll behavior and Kiwi rules, log it here:

### D-2026-05-11-FM1 · Effective rent uses raw JS number (Kiwi §1 violation, accepted)
- **Where**: `floor-map-editor.html` — `+u.contractRent || +u.rent`
- **Kiwi rule**: M1 — Decimal-safe types only (no float math)
- **Status**: ACCEPTED with caveat. Single-currency, single-multiplier (× 12 for annual, × 0.65 for opex), values bounded to ~$10k/mo. Float error within 0.01 cent for typical values. **Don't introduce additional float operations** without revisiting.
- **Action**: documented; not a fix priority.

### D-2026-05-11-FM2 · Overpayments not tracked as unapplied cash (Kiwi §9 violation, open risk)
- **Where**: `submitManualPayment` accepts arbitrary amount; no `unapplied_amount` concept
- **Kiwi rule**: OP1 — overpayments are unapplied cash, never income
- **Status**: NOT ENFORCED. 5× over-record guard catches typos; over-payments still recorded as `paid` with full amount.
- **Action**: KNOWN_ISSUES.md follow-up needed if overpayment scenarios become operational.

### D-2026-05-11-FM3 · Pro-rate helper not wired into invoice generation (Kiwi §8 spirit, KNOWN_ISSUES #1)
- **Where**: `_unitProrationCredit(u, ym)` exists but invoice paths still bill full rent
- **Kiwi rule**: CN1 — concessions classified upfront, immutable after first posting
- **Status**: helper exists, wiring deferred. Operator manually adjusts spillover-month invoices.
- **Action**: KNOWN_ISSUES.md #1; needs Tony's call on auto-wire vs operator-controlled.

### D-2026-05-11-FM4 · Building valuation defaults differ between Forecast hero (9%) and Investment Analysis (7%)
- **Where**: `floor-map-editor.html` — `renderHomeForecast()` uses 9% / 35% / 0% vacancy; `renderHomeInvest()` uses 7% / 35% / 5%
- **Kiwi rule**: no direct rule (Kiwi doesn't cover valuation)
- **Status**: ACCEPTED — operator-chosen tradeoff documented in DECISIONS.md § 3 (DECISION_LOG.md D-2026-05-11 «Building Valuation defaults»).
- **Action**: none.

---

## 8. Process: when Tony loads a NEW model bundle

1. Tony unzips into `.financial-model-input/`
2. Claude reads + maps each rule against current SuitesForAll behavior
3. Claude updates this file's § 2 + § 3 + § 7 (discrepancy log)
4. Claude moves files from `.financial-model-input/` → `financial-model/` (or replace existing if a refresh)
5. Claude commits + auto-deploys (docs only — no runtime impact, just stamp bump)
6. Tony reviews the updated map; flags new discrepancies as issues

---

## 9. Quick reference — formulas Kiwi expects vs SuitesForAll uses

| Concept | Kiwi pattern | SuitesForAll pattern |
|---|---|---|
| Money math | `Money` class from `@/lib/money` | Raw JS `number` with explicit rounding where critical |
| Invoice creation | `acc.invoices` row + journal entry posted in same DB tx | Stripe API call; `u.stripe.lastSentInvoice` + `u.payments[ym]` updated on webhook |
| Late fee | Line item on existing `acc.invoices` | Separate Stripe invoice with line items + `u.lateFee.sentList[]` |
| Payment | `acc.payments` row + `acc.payment_allocations[]` + journal entry | `u.payments[ym] = {...}` flat record |
| Deposit | `pm.security_deposits` (5 categories) + `acc.security_deposit_applications/forfeitures` | `u.payments.deposit = { status, amount, date }` flat record |
| Overpayment | `acc.payments.unapplied_amount` + `liability:unapplied_customer_credit` | Currently silent |
| Period close | `acc.accounting_periods.is_locked` enforced at DB | None |
| Bank rec | State machine: matched / unmatched / disputed / written-off | None |

The right column is the current SuitesForAll behavior. The left column is what to migrate toward IF Tony approves the architectural overhaul.

---

## 10. Cross-references

- **CLAUDE.md** § "Approval STILL required" → "Financial-model gate" — points here
- **DECISIONS.md** § 3 — formulas (now also reference this file)
- **KNOWN_ISSUES.md** #1, #2 — open financial issues
- **PAYMENTS_AND_FINANCE_RULES.md** — SuitesForAll-specific rules (now layered over this file's mapping)
- **DEVELOPMENT_WORKFLOW.md** — pre-commit checklist (will be updated to call this gate)
- **QA_CHECKLIST.md** — financial-area sub-section (will reference this file)
