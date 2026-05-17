# ARCHITECTURE.md

## Overview

SuitesForAll is a **single-file vanilla-JS web application** with a Firebase backend (Firestore + Auth + Storage + Functions) and Stripe payments. The main app is one ~130k-line HTML file (`floor-map-editor.html`) — no build step, no module bundler, no framework. State lives in localStorage (Phase 1 fallback) AND Firestore (Phase 2 source of truth). Realtime sync via `onSnapshot`. Cloud Functions handle Stripe webhooks + scheduled auto-billing.

## Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| **Language** | Vanilla JavaScript (ES2020+) | No TypeScript at root |
| **Framework** | None (DOM + SVG event handlers) | Intentional — single-file architecture |
| **Frontend** | HTML5 + CSS (inline `<style>`) + SVG | All in `floor-map-editor.html` |
| **Backend** | Firebase Cloud Functions (Node 20) | `functions/index.js` ~260k lines |
| **Database** | Firestore | Plus `localStorage` fallback for offline |
| **Auth** | Firebase Authentication | Google sign-in primary; role lookup via custom claims / state field |
| **Storage** | Firebase Storage | Receipts, blueprints, lease PDFs, photos |
| **Realtime sync** | Firestore `onSnapshot` | Optimistic locking via `_rev` field |
| **Payments** | Stripe (via `stripe@^17` in functions) | Invoice generation + webhook reconciliation |
| **E-sign** | DocuSign | Lease envelopes |
| **Camera / IoT** | UniFi Protect / Access | Phase 4 stubs (`functions/unifi.js`) |
| **PDF parsing** | `pdf.js@3.11.174` | CDN, lazy-loaded with multi-CDN fallback |
| **DXF parsing** | `dxf-parser` | CDN, lazy-loaded |
| **Package manager** | `npm` | Only inside `functions/` and `tests/` — no root `package.json` |
| **Build tool** | None for main app; `tsc` not used | Cloud Functions deploy via `firebase deploy --only functions` |
| **Testing** | Playwright (`@playwright/test@^1.59`) | 3 smoke specs in `tests/specs/` |
| **Styling** | Inline CSS in `<style>` blocks | No Tailwind, no CSS modules, no preprocessor |
| **External services (production)** | Firebase Hosting + Firestore + Auth + Storage + Functions, Stripe, DocuSign, UniFi | All require env vars / API keys (see SECURITY_AND_SECRETS.md) |
| **Deployment (legacy)** | `firebase deploy --only hosting` | **SUSPENDED in current mode** |
| **Error monitoring** | Sentry (`<meta name="sfa-release">` tag for release tagging) | Catches `window.onerror`; does NOT catch silent SVG `DOMException` (see DECISIONS.md § 6) |

## Folder Structure

```text
/ (project root)
├── floor-map-editor.html        ← THE app (~130k lines, single-file)
├── home.html                    ← legacy home page (rarely touched)
├── billing.html                 ← legacy billing page
├── design-system.html           ← design system reference
├── blueprint-demo.html          ← demo / test page
├── pinellas-park-4th-floor.html ← demo floor
├── investment-questionnaire.html
├── privacy.html                 ← privacy policy page
├── index.html                   ← landing redirect (mostly to floor-map-editor)
│
├── firebase.json                ← Hosting config (rewrites all → floor-map-editor.html)
├── firestore.rules              ← Firestore security rules (mirror of role matrix)
├── firestore.indexes.json       ← Firestore composite indexes
├── manifest.webmanifest         ← PWA manifest
├── favicon.svg                  ← app icon
├── logo.svg                     ← brand logo
├── cors.json                    ← CORS config for Firebase Storage
│
├── CLAUDE.md                    ← THIS PROJECT — operating mode + non-negotiables
├── PROJECT_CONTEXT.md           ← what the program does
├── ARCHITECTURE.md              ← (this file) tech stack + folder structure
├── DECISIONS.md                 ← terminology, formulas, UX conventions
├── SESSION_LOG.md               ← chronological "what we shipped"
├── PRINCIPLES.md                ← engineering principles (mirror of CLAUDE.md legacy)
├── HANDOFF.md                   ← onboarding text for new chat sessions
├── PLAN.md                      ← backlog + workflow rules
├── KNOWN_ISSUES.md              ← current open problems
├── MAINTENANCE_TASKS.md         ← recurring maintenance
├── CHANGELOG.md                 ← high-level milestones
├── DECISION_LOG.md              ← cross-ref to DECISIONS.md
├── RISK_MATRIX.md               ← top risks
├── AUTOMATION_BOUNDARIES.md     ← what auto-runs vs ask-first
├── PM_OPERATING_MODE.md         ← how Claude PM-coordinates
├── PAYMENTS_AND_FINANCE_RULES.md
├── AUTH_AND_PERMISSIONS_RULES.md
├── DATABASE_RULES.md
├── LOCAL_SETUP.md               ← how to run locally
├── DEVELOPMENT_WORKFLOW.md      ← local dev cycle
├── QA_CHECKLIST.md              ← pre-/post-change checks
├── SECURITY_AND_SECRETS.md      ← where secrets live, what NOT to do
├── ENVIRONMENT_VARIABLES.md     ← env var inventory (no real values)
├── USER_FLOWS.md                ← main user flows
├── DATA_MODEL.md                ← state + Firestore shapes
│
├── CORS_SETUP.md                ← legacy: Firebase Storage CORS setup notes
├── STRIPE_SETUP.md              ← legacy: Stripe configuration notes
├── STRIPE_ПРОСТАЯ_ИНСТРУКЦИЯ.md ← Russian-language Stripe quickstart
├── Kiwi-Rentals-DocuSign-Setup-Guide.md
│
├── Kiwi-Rentals-Lease-TEMPLATE.html
├── Kiwi-Rentals-Post-Termination-Notice-TEMPLATE.html
├── lease-preview.pdf            ← sample lease PDF for testing
├── page-01.jpg ... page-10.jpg  ← sample blueprint pages
│
├── functions/                   ← Firebase Cloud Functions (Node 20)
│   ├── index.js                 ← all functions (~260k lines): Stripe webhooks, auto-billing cron, etc.
│   ├── unifi.js                 ← UniFi Protect/Access integration stubs (Phase 4)
│   ├── package.json             ← deps: firebase-admin, firebase-functions, stripe
│   ├── package-lock.json
│   ├── .env                     ← ⚠️ HAS REAL SECRETS — do not commit, do not read
│   └── .gitignore               ← ignores .env, node_modules
│
├── tests/                       ← Playwright smoke tests
│   ├── playwright.config.ts     ← config (default base = production)
│   ├── package.json             ← devDep: @playwright/test
│   ├── package-lock.json
│   ├── specs/
│   │   ├── app-loads.spec.ts    ← page renders, Sentry inits, no console errors, release tag valid
│   │   └── auth-gate.spec.ts    ← unauth visitors see login screen
│   └── test-results/            ← gitignored output
│
├── scripts/                     ← local helper scripts
│   ├── stamp-release.sh         ← bakes commit hash into <meta name="sfa-release">
│   └── test-table-sort.mjs      ← unit-test for table sort helper
│
├── redesign/                    ← redesign workspace (mostly reference)
│   ├── index.html
│   └── src/
│
└── .claude/                     ← Claude config (gitignored)
    └── worktrees/
        └── angry-tu-472a94/     ← active worktree (this folder when working)
```

### What's a "worktree"?

When Tony works in this project via Claude, an isolated git worktree may be created to keep parallel sessions from clobbering each other. The worktree is a full clone of the working tree at a specific commit. All paths above are inside the worktree.

## Single-file philosophy

`floor-map-editor.html` is intentionally one file because:
- Zero build step → operator can debug directly in browser DevTools with original line numbers.
- No module bundler complexity → no webpack / vite / esbuild cognitive overhead.
- Editing is local-only (file-system) — no server-side rendering, no SSR, no hydration.
- Single-source-of-truth — entire app state shape, all helpers, all rendering, all event handlers in one searchable file.

Cost: file is huge (~130k lines / ~2.7 MB) and IDE / Claude sometimes hits performance limits. Mitigated by:
- `grep -n` to locate functions before reading slices
- Read tool with `offset` + `limit` for partial loads
- Logical sectioning via `// ===== Section =====` comment banners

## Cloud Functions structure

`functions/index.js` is also a single-file design (~260k lines) — same reasoning. Main capabilities:

- **Stripe webhooks**: invoice.paid, invoice.payment_failed, charge.refunded, etc → updates `state.buildings[].floors[].units[].payments[]` via Firestore admin write
- **Auto-billing cron**: scheduled function runs daily, checks units with `lateFee.autoSend = true` past grace period → creates Stripe invoice
- **Lease envelope sync**: DocuSign webhook handler updates `u.leaseEnvelopes[]` status
- **Receipt upload helpers**: pre-signed URL generation for Storage (when client uploads check photos)
- **Backup snapshots**: scheduled snapshots of Firestore state to Storage

## Build / deploy pipeline (LEGACY — currently SUSPENDED)

Prior to 2026-05-11 the operator ran auto-deploy after every commit:

1. Edit `floor-map-editor.html`
2. Parse-check via `node -e "..."` (validates every `<script>` block)
3. `git add` + `git commit`
4. `scripts/stamp-release.sh` bakes `<meta name="sfa-release" content="<commit-hash>">` so Sentry can tag events
5. Second commit: `chore(release): stamp <feature-name>`
6. `firebase deploy --only hosting` — uploads everything in `.` per `firebase.json`'s `public` field, with `ignore` rules
7. `git push origin <branch>` — mirror to GitHub

**In current local-only mode**: stop after step 3 (commit). Do not stamp release, deploy, or push without Tony's explicit approval.

## Data flow

```
                    ┌────────────────────┐
                    │   Browser (single   │
                    │   floor-map-editor) │
                    └─────┬──────────┬────┘
                          │          │
                          │          │ optimistic write
                          │          ▼
                          │  ┌──────────────────┐
                          │  │ Firestore        │
                          │  │ workspaces/{ws}/ │
                          │  │   data/state     │  ← single document, _rev field
                          │  └─────┬────────────┘
                          │        │ onSnapshot
                          │        ▼
                          │  fbApplyRemote (rebases local state)
                          │
                 onSnapshot listener
                          │
                          ▼
                ┌──────────────────────┐
                │ Cloud Functions      │
                │ (functions/index.js) │
                └──────┬───────────────┘
                       │
                       ▼
                  ┌─────────────┐
                  │   Stripe    │  ← webhooks bidirectional
                  │  DocuSign   │
                  │  UniFi      │
                  │  Sentry     │
                  └─────────────┘
```

## State shape (top-level)

```js
state = {
  buildings: [
    {
      id, name, address, photo,
      floors: [
        {
          id, name, number, grossSqft, rentableSqft,
          bg: { src, scale, opacity, x, y, storagePath },
          outline: { points: [[x,y], ...] },
          scale: { pxPerFt, ... },
          units: [
            {
              id, x, y, w, h, points,           // geometry (polygon = points)
              type, rentable, status,            // 'office' / 'mechanical' / etc; 'occupied'/'vacant'/'reserved'
              tenant, company, email, phone,    // tenant identity
              rent, contractRent, sqft, cap,    // financials
              leaseStart, leaseEnd,
              groupId, groupRole,                // multi-suite lease
              parentId,                          // sub-room link
              labelDX, labelDY, labelPosition,   // label positioning
              window, sink,                      // amenities
              payments: { [ym]: { status, amount, date, method, waiverStart, waiverEnd, ... }, deposit: { ... } },
              stripe: { customerId, depositInvoice: { status, paidAt }, lastAutoInvoiceError },
              prospects: [...],
              leaseEnvelopes: [...],
              tenantHistory: [...]
            }
          ],
          walls: [{ points: [x1,y1,x2,y2] }, ...],
          doors: [...]
        }
      ],
      billingRulesOverride: { paused, gracePct, lateFee, ... },
      assignedManagerUid
    }
  ],
  settings: { editMode, showRent, showSqft, showTenant, showSink, lateFee: {...}, ... },
  ui: { currentBuildingId, currentFloorId, selectedUnitId, activeView, ... },
  investments: { [buildingId]: { capRatePct, vacancyPct, opexPct, refiAmount, ... } },
  recoveryCases: [{ buildingId, unitId, tenant, balanceOwed, agency, status, events, ... }],
  tenants: [],
  leases: [],
  _rev: <number>             // optimistic-lock version
}
```

Detailed shape per surface in **`DATA_MODEL.md`**.

## Render passes (in `renderUnits()`)

| Pass | Purpose |
|---|---|
| **PASS 1** | Per-unit fills + labels (rect or polygon), badges, status icons, plumbing markers |
| **PASS 2** | Wall edges — deduped, classified perimeter/internal (uniform style as of 2026-05-10 commit `be051f3`) |
| **PASS 2.5** | Window stripes (drawn after walls so they appear on top) |
| **PASS 2.6** | Tenant-group highlight overlay (purple ring around multi-suite-lease members) |
| **PASS 3** | Drag handles (resize corners, rotate handle, window-stripe handle) |
| **PASS 4** | Selection halo (around selected unit(s)) |

## Performance considerations

- `renderUnits()` is the hot path — runs on every state change. Optimizations:
  - Edge dedup in PASS 2 to avoid double-drawing shared walls
  - Two-bucket label sizing (normal + 65% small) instead of continuous interpolation
  - `vector-effect: non-scaling-stroke` so SVG strokes are zoom-invariant
  - Zoom-aware `_zr` / `_zsw` / `_zfs` helpers for screen-px constancy
- `_labelFontFor(u, targetScreenPx)` MUST guard against zoom denom = 0 (see DECISIONS.md § 6) — past bug aborted whole render mid-loop
