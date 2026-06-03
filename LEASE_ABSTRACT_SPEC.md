# LEASE_ABSTRACT_SPEC.md

> **Goal (Tony 2026-06-03):** extract EVERYTHING from a commercial office lease the
> first time, so the system can auto-bill every month and run every operation
> **without ever re-reading or re-analyzing the lease**. This is the professional
> CRE lease-abstraction field set, organized by the automation each field enables.

> Storage target: a structured **`u.leaseAbstract`** object on the suite (the head
> suite for grouped leases), populated by the AI lease importer. Today we extract a
> subset (tenant, rent, deposit, dates, term, size, `rentSchedule`, `leaseAnalysis`).
> This spec is the full target.

> ⚠️ **Financial gate.** Extracting + storing these is reference data (safe). WIRING
> any of them into actual invoicing (pass-throughs, sales tax, reconciliation, late
> fees) is a financial-computation change → staged, DORMANT behind flags, validated
> against `FINANCIAL_MODEL_REFERENCE.md`, client-first then `functions/index.js` cron
> with explicit approval. Never bill a derived amount before a reconcile preview.

---

## TIER 1 — Recurring monthly invoice (compute the exact bill every month)

Everything needed so `invoice(month) = base rent + additional rent + parking + other + tax`,
with $0 months skipped — no human lookup.

| Field | Why / what it drives |
|---|---|
| **Base rent schedule** `[{start,end,$psf,monthly,periodTotal}]` | Correct base rent per period (escalations). ✅ have (`rentSchedule`) |
| **Free rent / abatement periods** | Months billed $0 (already $0 rows in schedule). ✅ have |
| **Rent due day** (e.g. 1st) | Invoice/issue date + late-fee anchor |
| **Proration method** (partial first/last month) | Partial-month base rent |
| **Lease structure**: NNN / Modified Gross / Full-Service Gross / Industrial Gross | Decides whether pass-throughs are billed monthly at all |
| **Estimated monthly additional rent** (CAM/OpEx + RE Taxes + Insurance) | The recoverable estimate billed WITH base rent each month (big for NNN; $0 for FSG until true-up) |
| **Parking** (spaces, rate, reserved vs unreserved) | Recurring add-on line |
| **Other fixed recurring charges** (storage, signage, fixed after-hours HVAC, etc.) | Extra recurring lines |
| **Sales tax on rent** | **FL commercial rent is taxable** (state rate + county surtax; Hillsborough/Tampa). Tax base = rent (often + CAM). Must be its own line for FL leases |
| **Payment method / portal** (PayLink, ACH, lockbox) | Remittance instructions on the invoice |

## TIER 2 — Late fees · deposits · annual reconciliation (true-up)

| Field | Why / what it drives |
|---|---|
| **Late fee terms**: grace days, % or flat, cap, **default interest rate** | Auto late fees (app already has a late-fee config — map lease → config) |
| **Security deposit**: amount, form (cash/LOC), **burn-down schedule**, last-month-rent prepaid | Deposit tracking + move-out | (amount ✅) |
| **Pro-rata share %** (tenant RSF ÷ building RSF) | Tenant's share for CAM/Tax/Insurance reconciliation |
| **Base year** (Modified Gross) / **expense stop** | Reconciliation baseline (tenant pays increases over base) |
| **Expense caps**: controllable cap %, cumulative vs annual compounding, what's excluded | Caps the recoverable increase at true-up |
| **Admin / management fee %** on pass-throughs | Adds to recoverable amount |
| **Reconciliation timing** (annual true-up date, estimate-reset date) | When to issue the true-up invoice/credit |

## TIER 3 — Critical dates · options · ops (no re-reading for deadlines)

Each becomes an auto-generated **critical-date alert** + a stored term.

| Field | Why / what it drives |
|---|---|
| **Renewal / extension options**: count, length, **rate basis** (FMV/fixed/%), **notice window** | Exercise-by-date alert; renewal rent |
| **Early termination / kick-out**: eligible date, fee, notice | Termination-window alert |
| **Expansion / ROFO / ROFR / contraction rights** | Opportunity + obligation alerts |
| **Holdover rent** (% of then-current base) | Holdover billing. ✅ in key points |
| **Permitted use · exclusive use · co-tenancy** | Compliance / leasing constraints |
| **Assignment & subletting**: consent, recapture, profit-share, admin fee | Approval workflow. ✅ in key points |
| **TI allowance** + landlord work + other concessions | Build-out tracking / amortization |
| **Insurance requirements** (CGL limits, waiver of subrogation) + **COI renewal date** | Compliance alert |
| **Guaranty**: guarantor name, type (personal/corporate), cap, burn-off | Risk + collections |
| **Default & cure** periods; **estoppel / SNDA** obligations | Legal workflow |

## Parties & premises (identity — needed everywhere)

Tenant legal entity + DBA · tenant notice address + billing contact (name/email/phone) ·
guarantor · **landlord legal entity + notice address + property manager** · signatory name/title ·
building name + address · **suite(s)** · **RSF + USF** · permitted use.

## Derived auto-calendar (generated from the above — the "never re-read" payoff)

rent commencement · expiration · every escalation date · renewal-notice deadline ·
termination-notice deadline · annual reconciliation date · COI renewal · deposit burn-down dates.

---

## Implementation plan (staged)

1. **Extract + store** the full `u.leaseAbstract` (extend the AI prompt into the sections
   above; render grouped in the modal + Lease tab). Safe — reference data only.
2. **Tier 1 → monthly invoice builder** (DORMANT flag): `monthlyInvoice(u, ym)` =
   escalated base (✅) + estimated additional rent + parking + other + FL sales tax,
   skipping $0 months. Client-first (owed/A-R), then cron with approval. Reconcile preview.
3. **Tier 2 → reconciliation + late fees + deposit** (separate flag; needs actual OpEx
   actuals input — a new annual true-up flow).
4. **Tier 3 → critical-dates engine** (feeds the existing Lease-tab critical dates +
   alerts; mostly non-financial → lower gate).

Build order recommendation: **(1) full extraction first** (so all data is captured),
then **(2) Tier-1 monthly invoice** (the core of "auto-bill without re-reading"),
then 3 & 4.
