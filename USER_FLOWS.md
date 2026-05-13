# USER_FLOWS.md

> Main workflows the operator (and tenants where applicable) take through the app.

Each flow lists: actor → trigger → steps → state mutations → risk level. Skip to the section you're working on.

## Flow inventory

| ID | Name | Actor | Risk |
|---|---|---|---|
| F1 | Add a new building | Admin / Manager | Low |
| F2 | Trace floor outline | Admin / Manager / Mapeditor | Low |
| F3 | Draw + name a unit | Admin / Manager / Mapeditor | Low |
| F4 | Add a tenant + lease | Admin / Manager | **Medium-High** (financial setup) |
| F5 | Multi-suite lease (group) | Admin / Manager | Medium |
| F6 | Record a manual payment | Admin / Manager | **Critical (money)** |
| F7 | Record a waiver / free month | Admin / Manager | **High (revenue impact)** |
| F8 | Send a Stripe invoice (manual) | Admin / Manager | **Critical (real send)** |
| F9 | Auto-billing daily run | Cloud Function (scheduled) | **Critical (autonomous money)** |
| F10 | Move out a tenant | Admin / Manager | High (legal + financial endgame) |
| F11 | Open a recovery (collections) case | Admin / Manager | High |
| F12 | Send a lease for signing (DocuSign) | Admin / Manager | High (legal) |
| F13 | View Rent Roll | Admin / Manager / Viewer | Low (read) |
| F14 | View A/R Aging | Admin / Manager | Low (read) |
| F15 | Configure Investment Analysis (BRRRR) | Admin only | Low (analysis only) |
| F16 | Switch active building | All roles | Low |
| F17 | Move label («123» tool) | Admin / Manager / Mapeditor | Low |
| F18 | Bulk-edit unit properties via shift-select | Admin / Manager / Mapeditor | Medium (multi-write) |
| F19 | Calibrate floor scale | Admin / Manager / Mapeditor | Medium (affects sqft) |
| F20 | Cloud-sync conflict recovery | Admin / Manager | High (potentially destructive) |

---

## F1. Add a new building

**Actor**: admin or manager.
**Trigger**: Top-bar building dropdown → «+ Add building».

1. Modal opens (`buildingModal`) with fields: name, address, photo, optional floors list, optional billing rules.
2. Operator fills name (required) + optional fields.
3. Click Save → `state.buildings.push({ id: <uuid>, name, address, ..., floors: [{}] })`
4. Auto-bootstrap (`feat(building): auto-bootstrap new buildings — edit mode + upload prompt` 2026-05-10):
   - Edit Mode auto-enabled if not already on
   - Switches to the new building (`state.ui.currentBuildingId = newId`)
   - Picks the auto-created floor as active
   - Fires upload prompt: "Upload floor plan?"
5. Save to Firestore via optimistic-locked tx.

**State mutated**: `state.buildings`, `state.ui.currentBuildingId`, `state.ui.currentFloorId`, `state.settings.editMode`.
**Risk**: Low — easy to delete via Settings → Workspace → Buildings → trash.

---

## F2. Trace floor outline

**Actor**: any with `canEdit`.
**Trigger**: After blueprint upload OR via «⋯ More» menu → «📐 Set / re-draw floor outline» OR Floor stats overlay → «📐 Set floor outline».

1. `setMode('floor-outline')` — cursor → crosshair, help bubble explains "click corners".
2. Operator clicks each corner of the building perimeter.
3. Cyan dots highlight existing unit corners for snapping.
4. Double-click OR click first corner → polygon closes.
5. `floor.outline.points = [[x,y], ...]` written.
6. Total / Useful / Other ft² KPIs become available.

**State mutated**: `state.buildings[b].floors[f].outline`.
**Risk**: Low — outline is a polygon, easily redrawn or removed via «🗑 Remove floor outline».

---

## F3. Draw + name a unit

**Actor**: any with `canEdit`.
**Trigger**: bottom-toolbar Rect (R) or Polygon (P) tool.

1. **Rect**: drag rectangle from corner to corner. Snap to existing edges if `snapEdge` on.
2. **Polygon**: click corners one-by-one, double-click to close. Cyan corner snap.
3. After commit, side panel opens with unit details:
   - Suite ID (auto-generated `new-N`, operator renames)
   - Type: office / mechanical / restroom / storage / kitchen / etc.
   - Sqft (auto from polygon area × floor scale, or operator-set)
   - Capacity (auto = sqft / 30 OSHA, or operator-set)
   - Window (boolean)
   - Sink (boolean)
   - Notes
4. State mutated: `floor.units.push({...})`.

**Risk**: Low — units easily moved / resized / deleted.

---

## F4. Add a tenant + lease

**Actor**: admin or manager (`canEditFinance`).
**Trigger**: click unit → side panel → «+ Add tenant».

1. Modal captures:
   - Tenant name (or company name)
   - Email + phone
   - Lease start date
   - Lease end date (optional; M-T-M if blank)
   - Contract rent ($/mo)
   - Deposit ($)
   - Move-in date (defaults to lease start)
2. Click "Save" → state mutated:
   - `u.tenant`, `u.company`, `u.email`, `u.phone`
   - `u.contractRent` ← what tenant actually pays
   - `u.leaseStart`, `u.leaseEnd`
   - `u.status = 'occupied'`
   - `u._tenantAddedAt = <now>`
3. Optionally: deposit invoice auto-created in Stripe (if Stripe configured + admin opts in).

**State mutated**: many fields on `u`. Optimistic-lock tx writes whole `state` document.
**Risk**: Medium-High — sets the financial baseline for billing. Wrong rent = wrong invoices forever.

**Validation**: rent > 0, leaseStart valid date, leaseEnd ≥ leaseStart if set.

---

## F5. Multi-suite lease (group)

**Actor**: admin or manager.
**Trigger**: shift-click 2+ vacant or same-tenant units → press `G` (or "Group as one lease" button).

1. Modal: choose primary suite (the one that holds the combined contract rent).
2. State mutated:
   - All grouped units get `u.groupId = <new-uuid>`
   - Primary unit gets `u.groupRole = 'primary'`, holds `combinedContractRent` in `u.contractRent`
   - Other members get `u.groupRole = 'member'`, `u.contractRent = 0`
3. Tenant fields copied to all members for display consistency.

**Critical rule** (from MEMORY.md): never split per-suite for invoices/overdue/payments — collapse to one set everywhere via `_isFinanceShadow` skip.

**State mutated**: `groupId`, `groupRole`, `contractRent` on all members.
**Risk**: Medium — undo is via "Ungroup lease" which restores per-suite state, but mid-cycle ungrouping creates ambiguity in payment ledger.

---

## F6. Record a manual payment

**Actor**: admin or manager (`canEditFinance`).
**Trigger**: click `$` cell in Payments matrix → modal opens.

1. Modal (`mpmCtx` state):
   - Method: Stripe / Check / ACH / Wire / Cash / Other / Waiver
   - Reference # (check #, ACH conf, wire conf)
   - Amount $ (defaults to `contractRent`)
   - Payment date (defaults to today)
   - Memo
   - Optional: receipt photo upload
2. Stripe shortcut: if Method = Stripe, auto-opens Stripe invoice browser to link an existing invoice.
3. Submit → `u.payments[ym] = { status: 'paid', amount, date, paidVia, paidMethod, ref, memo, receiptUrl, ... }`
4. Optimistic-locked write to Firestore.

**State mutated**: `u.payments[ym]` (one entry per year-month).
**Risk**: **Critical (money)**. 5× over-recording guard pops a confirm if `amount > 5 × rent`.

---

## F7. Record a waiver / free month

**Actor**: admin or manager.
**Trigger**: same modal as F6 — pick Method = «🎁 Waived (free month)».

1. Waiver row appears: pick reason (Referral / Promotion / Goodwill / Comp month / Other).
2. **Waiver date range** (added 2026-05-11): Start + End date pickers, defaults to 1st of ym → +1 mo. Operator can change.
3. Live info panel below shows per-month coverage breakdown: «May: full month waived. June: 12 of 30 days waived → invoice should be pro-rated to $X.»
4. If reason = Referral → must specify referred suite (which suite this tenant referred). Credit fraction: 100% for 12+mo lease, 50% for 6-11mo, 0 for <6mo.
5. Submit → `u.payments[ym] = { status: 'free', amount: 0, waiverReason, waiverStart, waiverEnd, referredSuite, ... }`
6. ⚠️ **Pro-rate not yet wired** into invoice generation (helper `_unitProrationCredit` exists but not called from auto-invoice path).

**State mutated**: `u.payments[ym]` with status='free'.
**Risk**: **High** — affects billing for current AND next month if waiver crosses month boundary. Manual oversight required until pro-rate wiring lands.

---

## F8. Send a Stripe invoice (manual)

**Actor**: admin or manager.
**Trigger**: A/R Aging row → "Send invoice" button.

1. Confirm dialog (5× guard if amount unusually high vs contract rent).
2. Cloud Function call → Stripe API: create + finalize invoice.
3. Response stored on unit: `u.stripe.lastSentInvoice = { id, amount, ym, sentAt, hostedUrl }`.
4. Webhook (`invoice.payment_succeeded`) eventually flips `u.payments[ym].status = 'paid'`.

**State mutated**: `u.stripe.*` immediately; `u.payments[ym]` on webhook.
**Risk**: **Critical** — sends real invoice to real tenant via Stripe.

---

## F9. Auto-billing daily run

**Actor**: Cloud Function (scheduled, runs daily at configured time).
**Trigger**: cron schedule defined in `functions/index.js`.

1. Walk all buildings → all floors → all units with `lateFee.autoSend === true`.
2. For each, check: occupied + has tenant + `u.payments[currentYm]` is missing or status='past_due' AND days past grace.
3. If yes: create + finalize Stripe invoice with late fee line item.
4. Record `u.stripe.lastAutoInvoiceError` if Stripe rejects (red border on map cell).

**State mutated**: `u.stripe.*` per affected unit; webhook later updates `u.payments`.
**Risk**: **CRITICAL — autonomous money**. Per-building pause flag (`b.billingRulesOverride.paused`) and per-tenant on/off toggles are the safety brakes.

---

## F10. Move out a tenant

**Actor**: admin or manager.
**Trigger**: unit detail panel → «Move out» button.

1. Modal: confirm date, optional reason, optional balance forgiveness flag.
2. State mutated:
   - Snapshot of tenant info into `u.tenantHistory.push({ tenant, company, email, phone, leaseStart, leaseEnd, contractRent, sqft, movedOut: <date>, reason, ... })`
   - Clear `u.tenant`, `u.company`, `u.email`, `u.phone`, `u.contractRent`, `u.leaseStart`, `u.leaseEnd`
   - Set `u.status = 'vacant'`
3. Optionally: open a recovery case if balance > 0 (see F11).

**State mutated**: many fields cleared on `u`; `u.tenantHistory` appended; potentially `state.recoveryCases`.
**Risk**: High — legal endgame; financial reconciliation required.

---

## F11. Open a recovery (collections) case

**Actor**: admin or manager.
**Trigger**: After F10 if balance > 0, OR manually via Recovery panel.

1. Case captures: tenant identity (snapshotted), unitId, balanceOwed, agency assignment, status (in_collections / written_off / recovered), events log.
2. State mutated: `state.recoveryCases.push({...})`.
3. Recovery panel surfaces age, agency, last activity.

**Risk**: High — legal documentation. Agency assignment may trigger external workflows.

---

## F12. Send a lease for signing (DocuSign)

**Actor**: admin or manager.
**Trigger**: Lease lifecycle UI on a unit → "Send lease".

1. Generate lease PDF from template (HTML template + variable substitution).
2. Cloud Function call → DocuSign API: create envelope, send to tenant email.
3. Envelope tracked on `u.leaseEnvelopes.push({ envelopeId, status: 'sent', sentAt, recipientEmail, ... })`.
4. Webhook updates status as recipient signs / declines / expires.

**State mutated**: `u.leaseEnvelopes`.
**Risk**: High — legal documents go to real tenants.

---

## F13. View Rent Roll

**Actor**: any with `canSeeRentRoll`.
**Trigger**: left rail → 📋 Rent roll.

1. `renderRentRoll()` walks all buildings → all units → builds rows.
2. `filterRentRollRows()` applies multi-select filters: building, floor, status, window, sink, expiring-only, search.
3. Defaults to active building (since 2026-05-10).
4. Table supports column sort, drag-reorder, gear-menu visibility, CSV export.

**State mutated**: per-user UI prefs (`sfa_rr_*` localStorage keys).
**Risk**: Low (read).

---

## F14. View A/R Aging

**Actor**: admin or manager (`canSeeFinance`).
**Trigger**: left rail → Billing → Aging tab.

1. `buildAgingRows()` walks units, computes per-month outstanding balance.
2. Buckets into Current / 1-30d / 31-60d / 61-90d / 90+.
3. Filters: building, floor, status, manager, min owed, only-overdue chip.
4. Rows clickable → drill to tenant detail / send late notice / record payment.

**Risk**: Low (read), but **High** when operator clicks "send late fee" actions from row.

---

## F15. Configure Investment Analysis (BRRRR)

**Actor**: admin only (`canSeeFinanceAnalytics`).
**Trigger**: left rail → 💲 Fin. analytics.

1. If no investment record for current building: 4 quick-estimate cards displayed (GPR / EGI / NOI / Building Value @ 7% cap).
2. Click "+ Create full record →" → seeds editable record with smart defaults:
   - `externalValuation = NOI / 7%` (income approach)
   - `refiAmount = 0.65 × externalValuation` (65% LTV)
   - `purchasePrice = 0` (operator must enter — we don't fabricate)
3. Sub-tabs available: Overview, Cash Flow, Hold Period, Sensitivity, Compare, AI Heuristic Insights.
4. Sliders for cap rate / vacancy / opex / refi terms.

**State mutated**: `state.investments[buildingId]`.
**Risk**: Low — analytics-only; doesn't touch operational billing.

---

## F16. Switch active building

**Actor**: any role.
**Trigger**: top-bar building dropdown → click building name.

1. `switchBuilding(bid)` runs:
   - `state.ui.currentBuildingId = bid`
   - `state.ui.currentFloorId = <last floor of new building>`
   - Clears unit selection
   - `_resetBuildingFiltersToActive()` snaps all open tables' building filters to the new building
   - On `financeAnalytics` view: explicit `renderHomeForecast()` + `renderHomeInvest()`
2. `renderAll()` re-renders everything in the new scope.

**State mutated**: `state.ui.currentBuildingId`, `state.ui.currentFloorId`.
**Risk**: Low.

---

## F17. Move label («123» tool)

**Actor**: admin or any with `canEdit` + Edit Mode.
**Trigger**: bottom-toolbar «123» button (hotkey L).

1. `setMode('label')` — cyan dashed boxes appear over each unit's label digits.
2. Click + drag the dashed box → updates `u.labelDX`, `u.labelDY` (top-left of label block in unit-local coords).
3. Snap to other labels (alignment guides shown in green).
4. Click without drag → selects the unit (right panel updates).
5. Press V (or click Select tool) to exit.

**State mutated**: `u.labelDX`, `u.labelDY`.
**Risk**: Low.

---

## F18. Bulk-edit unit properties via shift-select

**Actor**: admin or manager.
**Trigger**: shift-click multiple units → bulk action bar appears.

1. Multi-select tracked in `selectedIds[]`.
2. Bulk actions: align (left/center/right/top/middle/bottom), distribute, set type, set capacity, set rent, set window/sink, archive, delete, group as one lease.
3. Each action iterates `selectedIds` and applies the change.

**State mutated**: many units at once.
**Risk**: Medium — undo via Ctrl+Z (single step).

---

## F19. Calibrate floor scale

**Actor**: any with `canEdit`.
**Trigger**: bottom-toolbar Calibrate-line (📏) or Calibrate-area (□ ft²) tool.

1. **Calibrate-line**: drag a reference line of known real-world length → modal asks for length in ft → computes `pxPerFt`.
2. **Calibrate-area**: drag a rectangle on a known room → modal asks for ft² → computes `pxPerFt`.
3. State mutated: `floor.scale = { pxPerFt, source, calibratedAt, ... }`.

**Risk**: Medium — affects every unit's auto-computed sqft. Mistakes propagate via `_autoUpdateUnitSqft`.

⚠️ Common confusion (per 2026-05-11 incident): operator confuses Calibrate-area (□ ft²) with Floor outline tool. Error message redirects to outline tool now.

---

## F20. Cloud-sync conflict recovery

**Actor**: admin or manager.
**Trigger**: red `#syncBanner` appears with "Cloud sync failed: stored version X does not match required base Y".

1. Two action buttons (added 2026-05-10):
   - **↑ Force push** — adopts cloud `_rev` as new base, pushes local. Destructive to cloud-side divergence.
   - **↓ Pull cloud** — discards local unsaved changes, pulls cloud version.
2. Operator picks based on which side they trust. Confirm dialog warns about teammate edits.

**State mutated**: depends on choice. Force push = local wins. Pull = cloud wins.
**Risk**: **High** — both options are destructive in opposite directions.

⚠️ Same-user same-doc burst writes (e.g. Stripe webhook landing + manual edit colliding) auto-rebase silently. The banner only appears on REAL cross-user conflicts or stale tabs.
