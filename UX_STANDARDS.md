# UX_STANDARDS.md

> Single source of truth for SuitesForAll UI/UX standards. Extracted from CLAUDE.md
> (2026-06-06) to keep the operating manual lean. These standards are **always
> authoritative** — read this file before building or changing any table, page header,
> top navigation, or collections KPI. Referenced from CLAUDE.md § "Doc map".

---

## 14. Tables UX Standard (in force — do not break)

Every data table must satisfy: column sort + drag-to-reorder + per-column tooltip + visibility gear menu. Use `mountTablePrefs` + `attachTableSort` + `applyTableSort` + `ensureColumnsButton` helpers. Sort + reorder must be PURE UI — must not change row count or totals. CSV export must follow current view.

> See also MEMORY: «All tables → full UX standard» — every table (existing + future) MUST
> have sort + width-resize + hide/reorder + per-header title tooltips via
> `mountTablePrefs` / `ensureColumnsButton` / `attachTableSort`. Apply proactively with a
> unique whitelisted `keyBase`.

---

## 14b. Page Header Standard — PageHelp on every page (Tony 2026-05-26)

Every Pulse page MUST have a `<PageHelp pageId="..."/>` button immediately after the `<h1 className="title">…</h1>` text. This renders the round «?» tooltip → click expands a styled detail panel describing what the page shows, where data comes from, how to read it, and how to use it.

**When adding a new Pulse page:**
1. Add a `PAGE_DOCS` entry in `pulse/page-docs.jsx` keyed by the page's view id (e.g. `mynewpage: { title: "…", detail: <>…</> }`). The `detail` JSX should answer: *what this is · data sources · how to read it · how to use it.*
2. In the page component, include `PageHelp` in its `/* global … */` declaration and render `<h1 className="title">My New Page <PageHelp pageId="mynewpage" /></h1>`.
3. Bump the cache-bust query on `page-docs.jsx` in `pulse.html`.

**Anti-patterns** (do NOT do):
- Adding a page with no `PAGE_DOCS` entry (the «?» button silently no-ops; operator gets confused).
- Writing the detail inline inside the page file (PAGE_DOCS is the single source of truth so future pages stay consistent and so the dictionary can be lifted into other surfaces — search, AI summaries, etc.).
- Using a custom help icon — reuse `<PageHelp>` so the styling stays consistent.

---

## 15. Top Navigation Visibility (Tony 2026-05-28 — REVERSAL of 2026-05-22)

**Main `.topbar` (app switcher / Building selector / Map / Rent Roll / Floor tabs / Search / overdue + pending pills) must ALWAYS remain visible.**

- **Implementation:** `position: sticky; top: 0; z-index: 50;` — that's it. No JS scroll handler, no `.topbar-hidden` class, no transform.
- The main topbar carries business-critical actions (building selector, overdue indicator, pending invoices, new-leases pill, quick-add) that the operator must reach at any scroll position without a scroll-back gesture.

**History:**
- 2026-05-22: Scroll-reveal-on-up pattern (Twitter / Linear / GitHub-mobile style) was adopted for `.topbar`. JS handler toggled `.topbar-hidden` → `transform: translateY(-100%)`.
- 2026-05-28: Tony reversed the rule («Самые верхние меню никуда не должно уезжать и всегда должно оставаться»). CSS rule + JS handler + transition were removed. Main topbar is now always-sticky.

**Scope:** This applies to the **main** `.topbar` only. Scroll-reveal-on-up remains an acceptable pattern for secondary nav strips (e.g. a sub-page filter bar) where vertical real estate matters more than instant access. But the very top nav must stay put.

**Anti-patterns** (do NOT reintroduce):
- Adding a JS scroll listener that hides `.topbar`.
- Re-adding a `.topbar.topbar-hidden { transform: translateY(-100%); }` CSS rule.
- Replacing `position: sticky` with `position: fixed` (causes layout-shift issues with the page content).

---

## 16. Collections Applied Algorithm (Tony 2026-05-22)

The primary «Collected · <Month>» KPI uses the **Collections Applied** algorithm — the same metric used by Yardi Voyager / AppFolio / Buildium / MRI / QuickBooks accrual mode. **DO NOT** confuse it with cash basis.

**Formula:**
```
COLLECTED FOR <month> = SUM(payments) where:
  • billing_ym == <month>
  • status == 'paid'
  • regardless of when actually received
```

- ✅ Includes prepayments (rent for May paid in April).
- ✅ Includes late payments (rent for May paid in June).
- ❌ EXCLUDES back-rent (rent for March paid in May — counts as collected for March).
- ❌ EXCLUDES deposits / fees not tied to the same period.

**Why this and not cash basis:**
- Cash basis (sum of all payments with `p.date` in the month) inflates the period when back-rent is paid late, and undercounts the period when tenants prepay.
- Operators ask «насколько собран рент за май» — they expect the collections-applied answer.
- Stripe Dashboard / bank deposits give cash basis; the PMS layer normalizes back to billing period.

**Collection rate:**
```
RATE = collectedForMonth / (collectedForMonth + outstanding)
```
This gives «% of May rent billed that's been collected so far». Outstanding excludes waived (status='free') months.

**Secondary metric (for context):**
The KPI's tooltip and subtitle show `cashReceivedInMonth` (sum of all paid where `_pnlMonthKey === month`) as a separate number. The diff between the two is explained inline:
- `cashReceived > collectedForMonth` → back-rent received this month
- `cashReceived < collectedForMonth` → this month's rent prepaid in prior period

**Anti-patterns** (do NOT use):
- Showing cash basis as the primary «Collected» KPI (operators get confused when back-rent inflates).
- Showing only invoices created in the month (misses invoices created earlier but paid for this period).
- Mixing waived months into the rate (artificially deflates).
