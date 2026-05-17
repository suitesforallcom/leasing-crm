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
