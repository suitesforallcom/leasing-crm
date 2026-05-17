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
