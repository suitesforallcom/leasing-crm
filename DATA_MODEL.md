# DATA_MODEL.md

> Top-level shapes of `state` (in-memory + Firestore mirror) and key sub-shapes. Read alongside ARCHITECTURE.md "State shape (top-level)".

## Storage layers

| Layer | What | When written | Authoritative? |
|---|---|---|---|
| **In-memory `state`** | Single global `state` object in `floor-map-editor.html` | Every UI mutation | Working copy |
| **`localStorage`** | JSON dump of `state` | Debounced after `state` mutates | Offline fallback |
| **Firestore** | `workspaces/<WORKSPACE_ID>/data/state` document, optimistic-locked via `_rev` | Debounced (250-1000ms) via `fbPushNow` after `state` mutates | **Source of truth** when online |
| **Firebase Storage** | Receipts, blueprints, lease PDFs, photos | On manual upload | Source of truth for binary assets |

Sync direction:
- Local → Cloud: optimistic-locked `runTransaction` on `_rev`
- Cloud → Local: `onSnapshot` listener calls `fbApplyRemote()` to rebase

## Top-level `state` shape

```js
state = {
  buildings: Array<Building>,
  tenants: [],                          // legacy, mostly empty
  leases: [],                           // legacy, mostly empty
  settings: WorkspaceSettings,
  ui: UIState,
  investments: { [buildingId]: InvestmentRecord },
  recoveryCases: Array<RecoveryCase>,
  _rev: number                          // optimistic-lock version (Firestore timestamp-derived)
}
```

## `Building`

```js
{
  id: string,                           // uuid-like, stable
  name: string,                         // primary display label (per 2026-05-10 commit 697d26b)
  address: string,
  photo: string | { url, storagePath, addedAt, addedBy },
  icon: 'tower' | 'house' | etc.,
  floors: Array<Floor>,
  fileMeta: { [filePath]: { folder, addedAt, addedBy } },  // file folder org (Files tab)
  fileFolders: Array<string>,           // explicit empty folders
  billingRulesOverride: {
    paused: boolean,                    // per-building pause for auto-billing
    gracePct: number,
    lateFeePct: number,
    lateFeeMinUsd: number,
  },
  assignedManagerUid: string | null,    // for commission attribution
  notes: string,
  createdAt: ISO8601,
  archivedAt: ISO8601 | null,
}
```

## `Floor`

```js
{
  id: string,
  name: string,                         // "1st Floor", "2nd Floor", etc
  number: number,                       // sort key
  grossSqft: number,                    // operator-set, optional
  rentableSqft: number,                 // operator-set, optional
  bg: {                                 // background blueprint
    src: string,                        // dataURL or Storage URL
    storagePath: string | null,         // Storage path (for cleanup)
    opacity: number,                    // 0..1
    scale: number,                      // image scale
    x: number,                          // pan offset X (in scene-units)
    y: number,                          // pan offset Y
  } | null,
  outline: {                            // operator-traced building perimeter polygon
    points: Array<[x, y]>,              // absolute scene-units
  } | null,
  scale: {                              // calibration result
    pxPerFt: number,
    source: 'line' | 'area' | 'dxf',
    calibratedAt: ISO8601,
    sourceUnit: 'in' | 'ft' | 'mm' | 'm',  // for DXF
    dxfWidthFt: number,                 // for DXF only
    dxfHeightFt: number,                // for DXF only
  },
  units: Array<Unit>,
  walls: Array<Wall>,
  doors: Array<Door>,
}
```

## `Unit` (the core entity)

```js
{
  // === IDENTITY ===
  id: string,                           // suite ID, operator-renames; default "new-N"
  type: 'office' | 'mechanical' | 'restroom' | 'storage' | 'kitchen' | 'conference' | 'stairs' | 'elevator' | 'atrium' | 'hallway' | 'lobby' | 'electrical' | 'server' | 'security',
  rentable: boolean,                    // false = not leasable (shared spaces)
  status: 'occupied' | 'vacant' | 'reserved',
  archivedAt: ISO8601 | null,           // soft-delete

  // === GEOMETRY ===
  x: number, y: number,                 // bbox top-left (scene-units)
  w: number, h: number,                 // bbox dimensions
  points: Array<[x, y]> | undefined,    // polygon vertices (absolute scene-units); undefined = rect
  rotation: number,                     // degrees, default 0
  parentId: string | null,              // sub-room link

  // === LABELING ===
  labelPosition: 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right',
  labelDX: number | undefined,          // custom drag offset (top-left of label block in unit-local coords)
  labelDY: number | undefined,

  // === AMENITIES ===
  window: boolean,
  windowSide: 'top' | 'right' | 'bottom' | 'left',
  windowOffset: number,                 // 0..1 along the side
  sink: boolean,

  // === FINANCIAL ===
  rent: number,                         // proforma asking $/mo (market rate)
  contractRent: number,                 // what THIS tenant actually pays $/mo (set on lease signing)
  sqft: number,                         // square feet (auto from polygon area × pxPerFt² OR operator-set)
  sqftAuto: boolean,                    // false = operator overrode; don't recompute
  cap: number,                          // person capacity (auto = sqft / 30 OSHA OR operator-set)
  capAuto: boolean,
  rate: number,                         // legacy $/ft²/yr (mostly unused now)

  // === TENANT ===
  tenant: string,                       // person name
  company: string,
  email: string,
  phone: string,
  leaseStart: 'YYYY-MM-DD',
  leaseEnd: 'YYYY-MM-DD' | '',          // empty = M-T-M
  _tenantAddedAt: ISO8601,              // when tenant row was created (fallback for new-lease detection)

  // === MULTI-SUITE LEASE GROUP ===
  groupId: string | null,
  groupRole: 'primary' | 'member' | null,

  // === PAYMENTS ===
  payments: {
    [ym: 'YYYY-MM']: {
      status: 'paid' | 'past_due' | 'free' | 'partial' | 'pending',
      amount: number,
      date: 'YYYY-MM-DD',
      paidVia: 'stripe' | 'check' | 'ach' | 'wire' | 'cash' | 'other' | 'waived',
      paidMethod: string,
      ref: string,                      // check #, ACH conf
      memo: string,
      receiptUrl: string,               // Storage URL (if uploaded)
      receiptPath: string,
      paidBy: string,                   // operator email
      recordedAt: ISO8601,
      // Waiver-only (when status='free'):
      waiverReason: 'referral' | 'promotion' | 'goodwill' | 'comp' | 'other',
      referredSuite: string | null,
      waiverStart: 'YYYY-MM-DD',        // added 2026-05-11
      waiverEnd: 'YYYY-MM-DD',          // added 2026-05-11
    },
    deposit: {
      status: 'paid' | 'pending' | 'refunded',
      amount: number,
      date: 'YYYY-MM-DD',
      // … (similar fields)
    }
  },

  // === STRIPE ===
  stripe: {
    customerId: string,                 // cus_*
    depositInvoice: { id, status, amount, paidAt, hostedUrl },
    lastSentInvoice: { id, ym, amount, sentAt, hostedUrl },
    lastAutoInvoiceError: { ym, ts, message },
  },

  // === LEASE ENVELOPES (DocuSign) ===
  leaseEnvelopes: Array<{
    envelopeId: string,
    status: 'created' | 'sent' | 'delivered' | 'completed' | 'declined' | 'voided' | 'expired',
    sentAt: ISO8601,
    completedAt: ISO8601,
    recipientEmail: string,
    pdfUrl: string,
    pdfStoragePath: string,
  }>,

  // === PROSPECTS (pipeline) ===
  prospects: Array<{
    id: string,
    name: string,
    email: string,
    company: string,
    stage: 'inquiry' | 'toured' | 'loi' | 'lease_sent' | 'signed' | 'lost',
    lastUpdate: ISO8601,
    notes: string,
  }>,

  // === HISTORY ===
  tenantHistory: Array<{                // appended on move-out
    tenant: string,
    company: string,
    email: string,
    phone: string,
    leaseStart: 'YYYY-MM-DD',
    leaseEnd: 'YYYY-MM-DD',
    contractRent: number,
    sqft: number,
    movedOut: 'YYYY-MM-DD',
    reason: string,
  }>,

  // === BILLING RULES (per-unit override) ===
  autoSendInvoice: boolean,             // monthly Stripe auto-create
  lateFee: {
    autoSend: boolean,                  // late-fee auto-create
    pct: number,
    minUsd: number,
    graceDays: number,
    sentList: Array<{ ym, sentAt, invoiceId }>,
  },
}
```

## `Wall`

```js
{
  points: [x1, y1, x2, y2],             // standalone wall (not a unit edge)
  thickness: number,
}
```

## `Door`

```js
{
  x: number, y: number,                 // hinge position
  side: 'top' | 'right' | 'bottom' | 'left',
  width: number,                        // 3 or 6 ft typically
  swing: 'in' | 'out',
  type: 'single' | 'double',
}
```

## `WorkspaceSettings`

```js
{
  editMode: boolean,                    // global Edit/View toggle
  editModeOpacity: number,              // unit fill opacity in Edit Mode (default 0.4)
  unitOpacity: number,                  // in View Mode (default 1.0)
  showBg: boolean,                      // background blueprint visibility
  showUnits: boolean,
  showLabels: boolean,                  // master labels toggle
  showRent: boolean,                    // map: $/mo label
  showMapRate: boolean,                 // map: $/ft²/yr sub-label
  showSqft: boolean,
  showTenant: boolean,
  showSink: boolean,                    // 🚰 plumbing markers
  // showUnitPrice: boolean,            // (DEPRECATED 2026-05-10 — UI removed, key kept for back-compat)
  showRatePerSqft: boolean,
  showProformaPrice: boolean,
  showProformaRate: boolean,
  showRentIcon: boolean,
  snapGrid: boolean,
  gridSize: number,
  snapEdge: boolean,                    // magnetic snap to neighbor edges
  useCompactStatus: boolean,            // use small status dots vs 2×2 badge grid
  lateFee: {                            // workspace defaults (overridable per-building / per-unit)
    autoSendLive: boolean,              // false = dry-run mode
    pct: number,
    minUsd: number,
    graceDays: number,
  },
  capacityRule: {
    sqftPerPerson: number,              // default 30 (US OSHA min)
  },
  geometry: {
    snapTolerancePx: number,            // default 8
  },
  leaseTemplate: {                      // workspace default
    templateId: string,
  },
}
```

## `UIState`

```js
{
  currentBuildingId: string,            // top-bar pick — single source of truth for "active building"
  currentFloorId: string,
  selectedUnitId: string | null,        // single-select; multi-select via JS-level selectedIds[]
  activeView: 'home' | 'plan' | 'rentroll' | 'payments' | 'billing' | 'leases' | 'commissions' | 'people' | 'autobilling' | 'pipeline' | 'financeAnalytics',
  investActiveTab: 'overview' | 'cashflow' | 'hold' | 'sensitivity' | 'compare' | 'ai',
  // ... per-table column prefs auto-synced from localStorage
}
```

## `InvestmentRecord` (per building)

```js
state.investments[buildingId] = {
  buildingId: string,
  version: number,
  purchaseDate: 'YYYY-MM-DD',
  purchasePrice: number,                // operator must enter (don't fabricate)
  closingCostsPct: number,
  renoCost: number,                     // operator must enter
  renoMonths: number,
  renoStartDate: 'YYYY-MM-DD' | '',
  vacancyPct: number,                   // industry default 5
  opexPct: number,                      // industry default 35
  capRatePct: number,                   // industry default 7
  refiAmount: number,                   // smart-seeded as 65% × externalValuation
  refiRatePct: number,
  refiTermYears: number,
  refiBalloonYears: number,
  refiPointsPct: number,
  refiDate: 'YYYY-MM-DD' | '',
  externalValuation: number,            // smart-seeded as NOI / capRate
  notes: string,
  savedAt: ISO8601,
  // Multi-scenario (Phase B):
  scenarios: {
    [scenarioName]: { /* overrides for capRatePct, vacancyPct, etc. */ }
  },
  activeScenario: 'base' | 'bear' | 'bull',
  // Hold-period (Phase C):
  holdYears: number,
  rentGrowthPct: number,
  opexInflationPct: number,
  exitCapPct: number,                   // defaults to capRatePct
  sellingCostsPct: number,
}
```

## `RecoveryCase`

```js
{
  id: string,
  buildingId: string,
  unitId: string,
  unitLabel: string,
  tenant: string,
  company: string,
  email: string,
  phone: string,
  movedOut: 'YYYY-MM-DD',
  balanceOwed: number,                  // gross owed at move-out
  recoveredAmount: number,              // sum collected
  futureRent: number,                   // hypothetical lost rent (lease wasn't fulfilled)
  fullExposure: number,                 // balanceOwed + futureRent (auto-derived if not set)
  agency: string,                       // collections agency (free text)
  status: 'in_collections' | 'written_off' | 'recovered',
  events: Array<{ at: ISO8601, kind, note }>,
  createdAt: ISO8601,
  updatedAt: ISO8601,
}
```

## Firestore document path

The entire `state` object lives in **one document**:

```
workspaces/<WORKSPACE_ID>/data/state
{
  _rev: number,                         // server timestamp on write
  _updatedAt: serverTimestamp,
  _updatedBy: string,                   // uid of writer
  _size: number,                        // JSON.length, for size monitoring
  state: { /* the whole state object above */ }
}
```

Single-doc design keeps writes atomic but caps total size at **1 MB** Firestore limit. Hard guard at 950 KB in `fbPushNow` refuses to push (would silently fail server-side otherwise).

## localStorage keys

| Key | Purpose |
|---|---|
| `sfa_state_v1` | Full state JSON (offline fallback) |
| `sfa_<table>_col_sort` | Per-table sort state (Aging, Rent Roll, etc.) |
| `sfa_<table>_col_order` | Per-table column drag-reorder |
| `sfa_<table>_col_hidden` | Per-table column visibility |
| `sfa_rr_last_filters_v1` | Rent Roll filter state |
| `sfa_payments_last_filters_v1` | Payments filter state |
| `sfa_leases_last_filters_v1` | Leases filter state |
| `sfa_aging_default` | A/R Aging filter default (per-user) |
| `sfa_aging_filters` | A/R Aging current filter state |
| `sfa_unit_tab` | Last active unit-detail-panel tab (overview / tenant / lease / etc.) |
| `sfa_ai_key_<provider>` | AI provider API key (when configured) |
| `sfa_conflict_stash_v1` | Forensic log of cloud-sync conflicts (last 50) |
| `sfa_offline_flag` | Manual offline-mode flag |

`localStorage` is per-browser-per-domain. Total cap ~5 MB.

## Firestore rules summary (mirror of role matrix)

- `workspaces/{wsId}/data/state` — read: any signed-in user with workspace membership; write: `canEdit` roles only (admin/manager/mapeditor)
- `workspaces/{wsId}/members/{uid}` — read: self or admin; write: admin only
- `workspaces/{wsId}/backups/{backupId}` — read: admin/manager; write: admin only
- Storage: `receipts/`, `blueprints/`, `lease-pdfs/`, `building-photos/` — write: any signed-in member; read: any signed-in member

Detailed rules in `firestore.rules`. **Do not edit** without Tony's approval.

## Backwards compatibility

- New optional fields are OK (e.g. `u.labelDX` added without breaking old data — checked via `typeof u.labelDX === 'number'`).
- Renames are NOT OK — would break operator's saved data. Use a migration step gated behind a `state.version` field.
- Removed fields stay in old data — ignore them gracefully, don't error.

## Schema versioning

There's no formal `state.version` migration system. Each new field is added optionally with a runtime fallback:

```js
const _hasCustomLabel = (typeof u.labelDX === 'number' && typeof u.labelDY === 'number');
```

When a real schema migration is needed, Tony designs it explicitly (no auto-migration). Document the migration in DECISIONS.md and bump a `state._schemaVersion` field if introduced.
