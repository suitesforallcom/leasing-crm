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
