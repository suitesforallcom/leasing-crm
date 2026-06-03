# LEASE_EXTRACTION_SPEC_REVIEW.md

> Expert review of Tony's "Universal AI Lease Extraction" spec (2026-06-03).
> Companion to `LEASE_ABSTRACT_SPEC.md`. Verdict: **strong, industry-grade** —
> matches how Yardi / VTS / Leverton / LeaseAccelerator model lease administration.
> Below: high-impact additions + how to fit it to THIS repo's hard constraints.
> Status today: extraction (core + full `lease_abstract`) + escalation→client
> billing (DORMANT) + source highlight + key-points are shipped. That's ≈ Stage 1
> of this spec.

---

## A. Field-status model — split 3 orthogonal axes (don't flatten into one enum)

The spec's status list mixes three independent dimensions. A field can be
"Conflicting" AND have a value AND be human-reviewed — one flat enum can't say that.
Model each field as:

```
{ value, normalizedValue,
  extraction: Found | NotFound | NotApplicable | Inferred | Ambiguous | Conflicting,
  confidence: 0..1,                  // advisory only (see C)
  sourceType: text|table|checkbox|ocr|inferred|manual,
  review:  Unreviewed | Reviewed | ManuallyAdded,
  approvals: { tenantCreation: bool, billing: bool, automation: bool },
  valueHistory: [ {value, doc, docDate, supersededBy} ]   // see B
}
```
"Approved for X" is an **approval flag**, not a status — so a Conflicting field can never silently be billing-approved.

## B. Conflict/priority — resolve PER FIELD on an effective-date timeline (not per document)

The biggest real-world gap. An amendment may change the expiration and rent but
not the premises — the controlling value is field-by-field. Add:
- **Per-field value history** (lineage): original → amendment 1 → amendment 2, with
  the winner + every superseded value + which doc/date produced it. Spec says
  "store superseded" — make it first-class.
- **Estoppel = verification, not source-of-truth.** Use it to RECONCILE computed
  state (rent paid-through, deposit held, no defaults), and flag mismatch. (Tony's
  Highwoods doc is literally an estoppel: "Rental has been paid for the period
  ending Nov. 30, 2025" — that's an A/R reconciliation signal, not a rent source.)
- **Commencement-driven schedule re-anchoring (CRITICAL, missing from spec).** Rent
  schedules are often written relative to an assumed commencement and must be
  recomputed if the Commencement Date Agreement says otherwise. The Highwoods
  schedule even footnotes it: *"Dates to be modified in the event the Commencement
  Date is not December 1, 2020."* Rule: if actual commencement ≠ schedule's assumed
  start, shift every period and mark the schedule `Needs Re-anchor` until confirmed.

## C. Confidence — gate on DETERMINISTIC checks, not the model's self-reported score

LLM self-confidence is not calibrated (models say 0.98 and are wrong). Do **not**
let `confidence ≥ threshold` alone approve billing. Real gates for a financial field:
1. source page present, 2. math cross-checks pass (§D), 3. no conflict, 4. human
approved for billing-critical. Treat model confidence as advisory/sorting only.

## D. Cross-checks to add (catch OCR/extraction errors automatically)

Beyond §7.4/7.5, verify and flag:
- `monthly × months_in_period = period_total` per row.
- **Σ(schedule periods) = stated total base rent for the term.** (Highwoods states
  "minimum base rent for the Term is $1,579,489.26" — sum the table, must match.)
- `annual_psf × RSF / 12 = monthly` (already) AND consecutive-period escalation %
  in a sane band (flag negative or >~12%/yr).
- `commencement + term = expiration` (already), and rent-commencement vs free-rent
  consistency.
Cross-checks are the *real* trust signal — surface them as a "Verification" panel.

## E. Accounting outputs the spec under-covers (lenders/owners need these)

- **Straight-line / deferred rent (ASC 842)**: average rent over term incl. free
  rent → deferred-rent asset/liability schedule. ("Effective rent after free rent"
  → extend to full straight-line + the deferred schedule.)
- **Sales tax: rate from a JURISDICTION CONFIG, not the lease.** Leases say
  "plus applicable tax" but rarely the %. Extract `taxable: yes/no` from the lease;
  get the **rate** (FL state + county surtax, with effective dates) from a config
  table. Don't trust a rate the model "found".
- **Recoverable capex amortization** schedule (mentioned — keep).

## F. Multi-document & lease-as-entity + dedup (operational must-haves)

- The abstraction unit is the **Lease**, which can span multiple suites (grouped
  suites already exist here → anchor the abstract + `documents[]` on the lease-HEAD
  suite) and many documents.
- **Dedup + match-to-existing-suite.** Tony's use case is "I bought a building with
  existing tenants" → on import, match tenant+suite+address to an existing floor-plan
  suite and OFFER to attach, rather than blindly creating a duplicate tenant.
- **Packet splitting**: one uploaded PDF often contains lease + exhibits + estoppel.
  Stage 1 should split/segment, not treat as one doc.

## G. Architecture fit — THIS repo's hard constraints (the spec is PMS-relational; we aren't)

1. **Size / Firestore.** Full abstraction (200+ fields) × source-audit-with-excerpts
   × many leases × many docs will blow the single state doc (already ~910KB / 90%
   localStorage). **Do NOT store raw doc text/images or long excerpts in `state`.**
   Store: compact abstract on the lease-head suite; the heavy source-audit + doc
   text/images in **Storage** or a per-lease Firestore subcollection (align with the
   in-progress document-per-entity scaling — SCALING_PLAN_v2). Keep source excerpts
   short (≤ ~140 chars) + a page/offset pointer.
2. **The 13 "data objects" (§12) are relational tables.** Map them onto the existing
   `state` shape (suite/payments/leases) + scaling collections — don't build a parallel
   relational layer in a single-file app.
3. **Financial gates.** Every billing-rule path is gated by `FINANCIAL_MODEL_REFERENCE.md`
   + must be DORMANT-flagged + reconcile-previewed (as we did for escalation).
   Idempotent + append-only ledger per `FINANCIAL_INVARIANTS.md`.
4. **PII.** Guaranties/estoppels carry SSN/EIN/bank instructions/signatures. Client
   sends docs to the LLM on the USER's own key (their provider agreement). Avoid
   persisting raw PII text in state; offer redaction of obvious SSNs in stored excerpts.

## H. UI refinements (on top of the spec's good "collapsed missing fields")

- The 14-tab review (§3) is heavy for the side modal. Keep the IMPORT modal focused
  (doc | fields | key-points, as now); put the FULL tabbed abstract in the unit's
  **Lease tab** (persistent) or a dedicated full-screen lease view.
- Per-field **confidence color** (green/amber/red) + a one-click **source jump**
  (already built: click→highlight) everywhere, including the tabbed view.
- A **re-extraction diff** ("what changed since last analyze") with the run's model +
  timestamp + prompt version logged to the existing Audit (`recordAuditClient`).

## I. §16 "Automatic PR Rule" — does NOT fit this project

- CLAUDE.md: **this repo does not use a PR workflow** ("Do not create PRs"); the
  gate set is **parse-check + `scripts/check-invariants.sh`**, not lint/typecheck/build
  (single-file vanilla JS, no build step). So "run typecheck/build, open a PR" can't
  run as written.
- This spec is a **multi-month program** (10+ subsystems, each touching billing/legal/
  reminders), not a single task/PR. It must be staged.
- Functions + financial changes are explicitly gated → no auto-deploy of those.
  Use the proven DORMANT-flag cadence instead of one big merge.

## J. Recommended staged roadmap (each stage = own change, gated)

1. ✅ **Extraction v1** — core + full `lease_abstract` (DONE).
2. **Status + Missing-fields UI** — field-status model (A), collapsed "Missing/Not
   Found (N)" grouped by category, manual add (value/user/ts/note/sourceType=manual),
   confidence colors, verification panel (D). *Non-financial → low gate.*
3. **Multi-doc + conflict engine** — intake/classify/segment, per-field value history
   + effective-date resolution (B), estoppel reconciliation, schedule re-anchoring,
   dedup/match-to-suite (F). *Non-financial.*
4. **Source-audit + storage** — full audit table in Storage/subcollection, not state
   (G). *Architecture.*
5. **Billing-rule generation (DORMANT)** — base ✅ → CAM/additional rent → tax (rate
   from config) → parking; client-first, reconcile preview, then functions cron with
   explicit approval. *Financial-gated, staged.*
6. **Reminders/critical-dates engine** — renewal/expiration/COI via the existing
   onSchedule cron + Lease-tab surfacing. *Mostly non-financial.*
7. **Reconciliation (CAM true-up), late-fee automation, risk scoring, NOI/cash-flow.*

## K. Smaller notes
- Add `extractionRun` metadata (model, version, ts) to every abstract for audit/diff.
- "Inferred" must always carry the inference basis; never auto-approve inferred for billing.
- Risk score should be **explainable** (each risk cites field+source) and weighted.
- Multi-currency/multi-LLC: N/A here (single currency/entity) — mark N/A, don't build.
- Reminders need concrete dates computed from notice windows (notice_days → deadline).

**Bottom line:** the spec is excellent and the right target. The four things I'd add
before building deeper: (B) per-field effective-date conflict resolution + commencement
re-anchoring, (C) gate on deterministic cross-checks not model confidence, (D) the
sum-vs-stated-total cross-check, and (G) keep heavy data out of the state doc. Then
build in the staged order above — not as one PR.
