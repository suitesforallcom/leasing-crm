# SuitesForAll — Active Error Rules

Short list of prevention rules distilled from past incidents. The full
history lives in [`ERROR_MEMORY.md`](./ERROR_MEMORY.md). This file is
auto-loaded at session start and is intentionally kept under one screen.

When a rule says "see `<commit>`", grep the commit message in
`ERROR_MEMORY.md` for the underlying incident.

## Computation & state

1. **Single source of truth.** The same money/overdue/grace formula is
   currently copy-pasted across `_computeUnitMoney`, the rent-grid
   heatmap, the alerts banner, and the dashboard queue. When you change
   one, change ALL of them in the same commit — drift is the #1 root
   cause of "the badge says X but the modal says Y" bugs.
   Refs: `fd9a42a`, `237dc8b`.

2. **Grace anchoring.** For the lease-start month, the overdue cutoff is
   `leaseStart + graceDays`, NOT `monthStart + graceDays`. A tenant
   whose lease starts on the 12th and grace is 5 days is not overdue
   on the 12th. All four code paths (see rule 1) must agree.
   Refs: `fd9a42a`, `237dc8b`.

3. **Prorate the first month.** Rent for the lease-start month is
   `_computeProrate(rent, startIso).prorated`, not the full contract
   rent. Anywhere you compare a paid amount to "expected rent" for the
   lease-start month, use the prorated value.
   Refs: `fd9a42a`.

## Stripe / payments mirroring

4. **Mirror manual links into the truth source.** When attaching an
   invoice as deposit / move-in rent / monthly rent, write to BOTH the
   `u.stripe.*Invoice` stamp AND `u.payments.*` (with `manualLink: true`).
   The truth source must survive any future heal pass that touches the
   stamp side.
   Refs: `6496f71`, `1025ee2`.

5. **`manualLink: true` is sacred.** `_healStaleStripeStamps` and any
   future auto-clean heuristics MUST skip stamps tagged with
   `manualLink: true`. Operator's explicit click outranks heuristics.
   Refs: `1025ee2`.

6. **Self-heal stale failure stamps before rendering banners.** Before
   showing `lastChargeFailure` / `lastAutoInvoiceError` banners, check
   the truth source: is the invoice now `paid` / `void` /
   `uncollectible` in `_invoicesCache`? Is `u.payments[ym].status`
   already `paid`? If so, delete the stamp + `saveState()` + `fbPushNow()`
   and skip the banner.
   Refs: `54ea663`.

7. **Status auto-flip.** When operator-edited fields imply a state
   change (e.g. tenant becomes non-empty → suite must be `occupied`),
   write the implied status in the same save. Hidden status gates the
   kebab menu and the map renderer.
   Refs: `e0daadf`.

## Service worker / deploys

8. **Bump `CACHE_NAME` whenever `sw.js` changes.** Date-based names
   (`sfa-shell-vN`) trigger the `activate` cache wipe. Stale SW serving
   pre-fix JS while the new HTML loads is a known root cause — old JS
   can push gutted state to Firestore before the new code lands.
   Refs: `6496f71`.

9. **HTML is network-first, not stale-while-revalidate.** Operator must
   see a deploy the moment it lands. Cache is fallback for offline only.
   Refs: `6496f71`.

10. **Parse-check before every commit.** Run `new Function(scriptText)`
    over every inline `<script>` block in `floor-map-editor.html`. A
    TDZ ReferenceError reaches production otherwise (see `7688246`).

## Persistence

11. **Don't write to ephemeral state when persistence is required.**
    `state.ui.*` survives a session; in-memory variables don't. If an
    operator action needs to survive a refresh (delete, hide,
    acknowledge), write it to `state.ui.*` and `saveState()`.
    Refs: `564e63e`.

## Workflow

12. **≤ 3–5 files per pass without explicit approval.** Broader
    refactors get a propose-first round.

13. **Russian code comments, English UI, Russian chat replies.**
    Identifiers stay English. UI strings (labels, tooltips, toasts,
    buttons) are English-only — no operator should ever see Russian
    text in the product.

14. **Verify before reporting done.** "Tests pass" is not the same as
    "feature works." For UI changes, open the affected page in a
    browser and reproduce the original scenario before claiming success.
