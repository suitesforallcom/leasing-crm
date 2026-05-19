/**
 * SuitesForAll — Cloud Functions entrypoint.
 *
 * What lives here:
 *   - Stripe integration: Customer sync, Invoice creation, Subscription
 *     (auto-pay), and the webhook handler that writes paid-status back into
 *     Firestore so the Payments matrix updates in real time.
 *
 * Secrets (set via `firebase functions:secrets:set`):
 *   - STRIPE_SECRET_KEY       live mode: sk_live_...   test mode: sk_test_...
 *   - STRIPE_WEBHOOK_SECRET   from Stripe Dashboard → Webhooks → Signing secret
 *
 * Region: us-central1 (default). If you move hosting regions later, update.
 */

const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {defineSecret, defineString} = require('firebase-functions/params');
const {setGlobalOptions} = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// Workspace model: the HTML client keeps a single state doc per workspace
// at /workspaces/{id}/data/state. Phase 1 has one workspace 'default' —
// matches WORKSPACE_ID in the client.
const WORKSPACE_ID = 'default';

// Keep cold starts fast and cost predictable.
setGlobalOptions({region: 'us-central1', memory: '512MiB', maxInstances: 10});

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
// Optional second secret — populated only when running in a staging /
// dev Firebase project so devs and CI can exercise the full Stripe
// integration without touching live keys.
//   firebase functions:secrets:set STRIPE_TEST_KEY
//   firebase functions:secrets:set STRIPE_TEST_WEBHOOK_SECRET
//   firebase functions:config:set env.mode="test"  (or set ENV in Cloud Run)
// In production, leave these unset — the function falls back to the
// live keys above.
const STRIPE_TEST_KEY = defineSecret('STRIPE_TEST_KEY');
const STRIPE_TEST_WEBHOOK_SECRET = defineSecret('STRIPE_TEST_WEBHOOK_SECRET');
const ENV_MODE = defineString('ENV', { default: 'production' });

function _isStripeTestMode() {
  // ENV='test' → use test keys IF they exist. If only the live keys
  // are set (single-project deployments), we still use those.
  const mode = (ENV_MODE.value() || 'production').toLowerCase();
  if (mode !== 'test' && mode !== 'staging') return false;
  try { return !!STRIPE_TEST_KEY.value(); }
  catch { return false; }
}

// Lazy Stripe client — avoids constructing it at import time.
// Reset on key rotation by checking the resolved key on each call;
// if it differs from the cached client's key, rebuild.
let _stripe = null;
let _stripeKeyUsed = null;
function getStripe() {
  const key = _isStripeTestMode()
    ? STRIPE_TEST_KEY.value()
    : STRIPE_SECRET_KEY.value();
  if (!key) {
    throw new HttpsError('failed-precondition',
      `Stripe key is not configured (mode=${_isStripeTestMode() ? 'test' : 'live'}). ` +
      `Run: firebase functions:secrets:set STRIPE_SECRET_KEY (or STRIPE_TEST_KEY for test mode)`);
  }
  if (_stripe && _stripeKeyUsed === key) return _stripe;
  _stripe = require('stripe')(key, {apiVersion: '2024-12-18.acacia'});
  _stripeKeyUsed = key;
  if (_isStripeTestMode()) logger.info('[stripe] using TEST mode key');
  return _stripe;
}

// Webhook secret resolver — symmetric with getStripe.
function getStripeWebhookSecret() {
  if (_isStripeTestMode()) {
    try {
      const v = STRIPE_TEST_WEBHOOK_SECRET.value();
      if (v) return v;
    } catch {}
  }
  return STRIPE_WEBHOOK_SECRET.value();
}

// =========================================================================
// ===== Auth helpers ======================================================
// Mirror the ROOT_ADMINS + member-role pattern used client-side. Every
// callable must pass `requireEditor(auth)` before touching billing data.
//
// SINGLE SOURCE OF TRUTH for hardcoded root admins. This list MUST stay
// in lockstep with:
//   - firestore.rules :26      (function isRootAdmin)
//   - floor-map-editor.html :ROOT_ADMINS constant
// To add a new root admin WITHOUT a redeploy of all three places, write
// a doc at /workspaces/_config/rootAdminAllowlist/{email-lowercased}.
// Cloud Functions read both lists in `_isRootAdmin()`. (Rules can't
// cheaply do the get() per-check, so for rules-side root admin you
// still need to update the hardcoded list and redeploy.)
// =========================================================================
const ROOT_ADMINS = ['tony@al-en.com'];

// In-process cache of the Firestore extension allowlist with TTL so we
// don't hammer Firestore on every callable invocation. Refreshed lazily.
let _rootAdminCache = { items: null, fetchedAt: 0 };
const ROOT_ADMIN_CACHE_TTL_MS = 60_000;

async function _isRootAdmin(email) {
  if (!email) return false;
  const lower = String(email).toLowerCase().trim();
  if (ROOT_ADMINS.includes(lower)) return true;
  // Extension allowlist — check Firestore (cached).
  try {
    if (!_rootAdminCache.items
        || Date.now() - _rootAdminCache.fetchedAt > ROOT_ADMIN_CACHE_TTL_MS) {
      const snap = await db.collection('workspaces/_config/rootAdminAllowlist')
        .select()
        .get();
      _rootAdminCache = {
        items: new Set(snap.docs.map(d => d.id.toLowerCase())),
        fetchedAt: Date.now(),
      };
    }
    return _rootAdminCache.items.has(lower);
  } catch (e) {
    logger.warn('[auth] root-admin allowlist read failed: ' + e.message);
    return false;
  }
}

async function requireEditor(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in required');
  const email = (auth.token?.email || '').toLowerCase();
  if (ROOT_ADMINS.includes(email)) return {role: 'admin', email};
  const memberRef = db.doc(`workspaces/${WORKSPACE_ID}/members/${auth.uid}`);
  const snap = await memberRef.get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'Not a workspace member');
  const role = snap.data()?.role;
  if (!['admin', 'manager', 'mapeditor'].includes(role)) {
    throw new HttpsError('permission-denied', `Role '${role}' cannot modify billing`);
  }
  return {role, email};
}

// =========================================================================
// ===== Shared state utilities ============================================
// The client stores workspace state at /workspaces/{wid}/data/state with
// this envelope: { _rev, _updatedAt, _updatedBy, _size, state: {...} }.
// All the real content (buildings, tenants, stripeCustomers, settings...)
// lives under the `state` key — NOT at the top level. Everything here
// unwraps that envelope so callers don't have to remember.
// =========================================================================
const stateDocRef = () => db.doc(`workspaces/${WORKSPACE_ID}/data/state`);

// Read — returns the inner `state` object, or {} if doc doesn't exist yet.
async function readWorkspaceState() {
  const snap = await stateDocRef().get();
  const data = snap.data() || {};
  // Support both shapes: wrapped (expected) and legacy flat (fallback).
  return data.state && typeof data.state === 'object' ? data.state : data;
}

// Write — runs a transactional mutation of the `state` sub-object. `mutate`
// receives the current state and may modify it in place. We bump _rev so
// the client's onSnapshot picks up our change and does not echo it back.
async function mutateWorkspaceState(mutate) {
  await db.runTransaction(async (tx) => {
    const ref = stateDocRef();
    const snap = await tx.get(ref);
    const data = snap.data() || {};
    const isWrapped = data.state && typeof data.state === 'object';
    const state = isWrapped ? data.state : data;
    await mutate(state);
    const out = isWrapped ? {
      ...data,
      state,
      _rev: (data._rev || 0) + 1,
      _updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      _updatedBy: 'cloud-function',
    } : {
      ...state,
      _rev: (state._rev || 0) + 1,
      _updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      _updatedBy: 'cloud-function',
    };
    tx.set(ref, out);
  });
}

function findUnit(state, {buildingId, floorId, unitId}) {
  if (!state || !Array.isArray(state.buildings)) return null;
  const building = state.buildings.find(b => b.id === buildingId);
  if (!building || !Array.isArray(building.floors)) return null;
  const floor = building.floors.find(f => f.id === floorId);
  if (!floor || !Array.isArray(floor.units)) return null;
  const unit = floor.units.find(u => u.id === unitId);
  if (!unit) return null;
  return {building, floor, unit};
}

// Pull rent amount to invoice. Contract rent (signed) wins over asking rent.
function unitRentCents(unit) {
  const r = Number(unit.contractRent) || Number(unit.rent) || 0;
  return Math.round(r * 100);
}

// =========================================================================
// ===== Custom invoice number encoder ====================================
// Packs purpose / suite / billing-month / issue-date into a short string
// that's human-readable: the 3-letter month abbreviation sits right
// after the suite number so the operator can decode at a glance
// without consulting a legend.
//
//   Format (rent):      {P}-{SUITE}-{MON}{YY}-{MON}{DD}-{RAND}
//   Format (non-rent):  {P}-{SUITE}-{MON}{DD}-{RAND}
//
//   P        purpose letter: R/L/K/D/C/X
//   SUITE    suite id, alphanumeric only, upper-case
//   MON      3-letter month abbreviation (JAN..DEC), upper-case
//   YY       last two digits of year (rent-only — non-rent invoices
//            are one-off, the issued month already pins them in time)
//   DD       issue day of month, zero-padded
//   RAND     two base-36 chars for uniqueness (avoids "same day, same
//            suite" collisions that would reject the invoice)
//
// Examples:
//   R-305-MAY25-APR24-X7   = Rent, Suite 305, May 2025 rent, issued Apr 24.
//   X-427-APR20-9I         = Custom (deposit), Suite 427, issued Apr 20.
//
// Length budget: Stripe allows up to 26 chars for invoice.number.
//   Rent (4-digit suite):     1+1+4+1+5+1+5+1+2 = 21 chars ✓
//   Rent (6-char alpha suite): 23 chars ✓
// =========================================================================
// Purpose → letter prefix mapping. Each invoice number starts with
// these so the operator can tell at a glance what the charge is for.
//
//   R   = rent (manually sent)
//   RA  = rent (automatically sent by the cron)
//   L   = late fee
//   D   = security deposit  (was sharing 'X' with custom; split out so
//                            deposit invoices are visually distinct)
//   DM  = damages           (was 'D'; renamed to avoid clash with deposit)
//   K   = keys / access cards
//   C   = cleaning
//   X   = custom (one-off, not falling into any above bucket)
const PURPOSE_CODE = {
  rent: 'R', late_fee: 'L', keys: 'K',
  damages: 'DM', cleaning: 'C', custom: 'X',
  deposit: 'D',
};
const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function buildCustomInvoiceNumber({purpose, unitId, ym, auto}) {
  // Rent + auto-flag → "RA" prefix to distinguish cron-fired invoices
  // from manually-sent ones. All other purposes ignore the auto flag.
  let p = PURPOSE_CODE[purpose] || 'X';
  if (purpose === 'rent' && auto) p = 'RA';
  const suite = String(unitId || '').replace(/[^A-Z0-9]/gi, '').toUpperCase() || 'X';
  const now = new Date();
  // Render the issue date + time in Florida time (America/New_York —
  // automatically handles EDT vs EST for daylight savings). Previously
  // we used UTC for tz-stable matching against the cron schedule, but
  // the operator runs out of Florida and 05:33 UTC stamps for invoices
  // they actually sent at 01:33 EDT created confusion later. Local tz
  // on both date + time keeps APR29-0133 readable at a glance.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  // formatToParts returns abbreviated month text ("May"); upper-case to MAY
  // so it matches the legacy MONTH_ABBR strings we use elsewhere.
  const monthCode = (parts.month || '').toUpperCase();
  // hour:'2-digit' with hour12:false returns "24" for midnight on some
  // engines; normalize to "00".
  const hh = (parts.hour === '24') ? '00' : (parts.hour || '00');
  const issuedCode = monthCode + (parts.day || '00');
  // 24-hour HHMM stamp in Florida time — encodes when the invoice was
  // sent. Lets ops distinguish multiple invoices for the same unit on
  // the same day (e.g. cron at 09:00 vs operator manual resend at 14:30)
  // at a glance, without opening Stripe.
  const timeCode = hh + (parts.minute || '00');
  // 6-char base36 random suffix (~2.18 billion values) — replaces the
  // previous 2-char (1296 values) which had a realistic collision rate
  // under burst (e.g., cron firing across 50 units in the same minute
  // produced ~1-in-26 chance of a collision pair). 6 chars makes
  // collisions essentially impossible for any realistic workload, and
  // the 26-char Stripe invoice.number limit still accommodates the
  // wider suffix in normal cases (the length guard below peels it off
  // if the unit ID is unusually long).
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0');

  // Build with full bits, then peel off optional segments if we exceed
  // Stripe's 26-char invoice.number limit (rare — only triggers for
  // very long suite IDs + 'RA' prefix). Order of removal preserves
  // the most informational signals: random first, then time.
  const billingPart = (purpose === 'rent' && ym && /^\d{4}-\d{2}$/.test(ym))
    ? `-${MONTH_ABBR[+ym.split('-')[1] - 1]}${ym.slice(2,4)}`
    : '';
  let n = `${p}-${suite}${billingPart}-${issuedCode}-${timeCode}-${rand}`;
  if (n.length > 26) n = `${p}-${suite}${billingPart}-${issuedCode}-${timeCode}`;
  if (n.length > 26) n = `${p}-${suite}${billingPart}-${issuedCode}-${rand}`;
  return n;
}

// =========================================================================
// ===== Stripe — Customer sync ============================================
// Ensures a Stripe Customer exists for a given tenant email. Idempotent.
// =========================================================================
exports.ensureStripeCustomer = onCall(
  {secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 60, memory: '512MiB'},
  async (req) => {
    const {email, name, unitId, buildingId} = req.data || {};
    await requireEditor(req.auth);
    if (!email || !name) {
      throw new HttpsError('invalid-argument', 'email and name are required');
    }
    const stripe = getStripe();

    const emailLower = email.toLowerCase();
    const state = await readWorkspaceState();
    const existingId = state.stripeCustomers?.[emailLower]?.customerId;

    if (existingId) {
      try {
        const existing = await stripe.customers.retrieve(existingId);
        if (!existing.deleted) {
          return {customerId: existingId, email, name, reused: true};
        }
      } catch (err) {
        logger.warn(`[stripe] customer ${existingId} not found, re-creating`);
      }
    }

    // Stripe-side search by email. Does NOT require our workspaceId tag —
    // customers made outside our app (via Xero sync, manual Stripe Dashboard
    // entry, etc.) should still be found. We claim whichever one has a
    // non-deleted match and tag it with our metadata so future lookups are
    // instant.
    // SAFETY: sanitize email before substituting into Stripe's quoted
    // search syntax. An email containing a `"` could otherwise close
    // the string and inject extra clauses (e.g., to broaden the search
    // beyond this workspace). Same fix as the createStripeInvoice path.
    const safeEmail = String(emailLower).replace(/[\\"]/g, '');
    const search = await stripe.customers.search({
      query: `email:"${safeEmail}"`,
      limit: 5,
    });
    // Prefer a customer that already has our workspace tag (cheapest).
    // SAFETY (#80): if the email matches but customer is tagged with
    // a DIFFERENT workspace, do NOT adopt it — adopting would let
    // workspace A re-tag workspace B's customer and route their next
    // invoice to A. Only adopt customers that are either untagged
    // (legitimate Xero / manual Stripe Dashboard entries) or already
    // tagged for THIS workspace. Conflicting tag → fall through to
    // create a fresh customer (Stripe allows duplicate emails).
    let customer =
      search.data.find(c => !c.deleted && c.metadata?.workspaceId === WORKSPACE_ID) ||
      search.data.find(c => !c.deleted && !c.metadata?.workspaceId) ||
      null;
    // Diagnostic: if there's a conflicting (other-workspace) match,
    // log it so admins notice cross-workspace email reuse.
    const conflictMatch = search.data.find(c => !c.deleted
      && c.metadata?.workspaceId
      && c.metadata.workspaceId !== WORKSPACE_ID);
    if (conflictMatch && !customer) {
      logger.warn(`[stripe] email ${emailLower} has Stripe customer ${conflictMatch.id} tagged for workspace "${conflictMatch.metadata.workspaceId}" — creating a NEW customer for ours instead of adopting`);
    }

    if (customer) {
      // Adopt: if the customer isn't tagged yet, add our workspaceId + unit
      // pointer so future searches find it the fast way.
      const needsTag = customer.metadata?.workspaceId !== WORKSPACE_ID;
      if (needsTag) {
        try {
          await stripe.customers.update(customer.id, {
            metadata: {
              ...(customer.metadata || {}),
              workspaceId: WORKSPACE_ID,
              unitId: unitId || customer.metadata?.unitId || '',
              buildingId: buildingId || customer.metadata?.buildingId || '',
              source: customer.metadata?.source || 'suitesforall-adopted',
            },
          });
        } catch (err) {
          logger.warn(`[stripe] could not tag adopted customer ${customer.id}: ${err.message}`);
        }
      }
      logger.info(`[stripe] linked existing customer ${customer.id} for ${emailLower} (adopted=${needsTag})`);
    } else {
      customer = await stripe.customers.create({
        email, name,
        metadata: {
          workspaceId: WORKSPACE_ID,
          unitId: unitId || '',
          buildingId: buildingId || '',
          source: 'suitesforall',
        },
      });
      logger.info(`[stripe] created customer ${customer.id} for ${emailLower}`);
    }

    await mutateWorkspaceState((s) => {
      s.stripeCustomers = s.stripeCustomers || {};
      s.stripeCustomers[emailLower] = {
        customerId: customer.id,
        name,
        updatedAt: new Date().toISOString(),
      };
    });

    return {customerId: customer.id, email, name, reused: false};
  }
);

// =========================================================================
// ===== Stripe — Create Invoice ===========================================
// Creates a one-off invoice for a specific unit + month. Uses auto_advance
// so Stripe finalizes and emails the tenant in a single call.
// =========================================================================
exports.createStripeInvoice = onCall(
  {secrets: [STRIPE_SECRET_KEY]},
  async (req) => {
    // RATE LIMIT — guard against runaway scripts / accidental loops in
    // operator UI. Two tiers:
    //   1. Per-(unit, ym) hard cap: at most N invoices per 24h. Stops
    //      a botched retry loop from inflating Stripe with duplicate
    //      drafts even before the dedupe check downstream catches it.
    //   2. Workspace-wide cap: at most M invoices per hour. Catches
    //      a wider runaway (loop hitting many units).
    // Implementation uses Firestore counters at /workspaces/{ws}/rateLimits/{key}.
    // Per-(unit, ym) is keyed on the day; workspace is keyed on the hour.
    const RL_PER_UNIT_PER_DAY = 5;
    const RL_PER_WORKSPACE_PER_HOUR = 100;
    {
      const d = new Date();
      const dayKey = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
      const hourKey = dayKey + String(d.getUTCHours()).padStart(2, '0');
      const wsCounterRef = db.doc(`workspaces/${WORKSPACE_ID}/rateLimits/ws_${hourKey}`);
      const wsCount = await db.runTransaction(async (tx) => {
        const snap = await tx.get(wsCounterRef);
        const cur = snap.exists ? (snap.data().count || 0) : 0;
        const next = cur + 1;
        if (next > RL_PER_WORKSPACE_PER_HOUR) return next;
        tx.set(wsCounterRef, { count: next, hourKey, _exp: Date.now() + 2 * 60 * 60 * 1000 });
        return next;
      });
      if (wsCount > RL_PER_WORKSPACE_PER_HOUR) {
        throw new HttpsError('resource-exhausted',
          `Workspace rate limit reached (${RL_PER_WORKSPACE_PER_HOUR}/hr). Wait until the next hour or contact support if this is unexpected.`);
      }
      // Per-unit-per-day check fires AFTER we know the unit. Defer below.
    }

    let {
      buildingId, floorId, unitId,
      ym,                                  // required only for rent invoices
      daysUntilDue,
      description: customDesc,             // visible to tenant (prefixed onto line item + header)
      privateNote,                         // hidden from tenant; stripe metadata only
      purpose,                             // 'rent' | 'late_fee' | 'keys' | 'damages' | 'cleaning' | 'custom'
      amountOverride,                      // dollars (optional — rent-purpose uses unit rent)
      // Optional client-provided tenant identity. When the client has
      // freshly-typed form values it hasn't pushed to Firestore yet, it
      // passes them here so we don't have to block on a pre-send push.
      // Firestore state still wins for security-sensitive fields (the
      // customer lookup always checks workspaceId metadata). These are
      // just a fallback for brand-new tenants that don't exist in state
      // yet.
      emailOverride,
      tenantNameOverride,
      // Idempotency key from the client (UUID generated at modal open).
      // Stripe dedupes by Idempotency-Key for 24h — duplicate sends
      // return the SAME invoice instead of creating a second one.
      idempotencyKey,
      // Optional operator-added one-off line items. Each entry:
      //   { description: string, amount: number (dollars), type?: 'one-time'|'late-fee' }
      // Combined alongside the rent + auto-bundled monthly subscriptions
      // into a SINGLE invoice. The new 3-column Invoice Generator UI
      // populates this from operator-added rows; legacy single-purpose
      // callers leave it undefined and the existing path runs unchanged.
      extraLineItems,
      // System-initiated send flag — when the catch-up trigger
      // (_triggerAutoInvoiceNowIfNeeded) calls this, it passes auto:true
      // so buildCustomInvoiceNumber tags the result with the "RA-"
      // prefix (instead of plain "R-"). Operator can then read the
      // invoice number on Stripe Dashboard / our Invoices table and
      // tell at a glance whether a human or the system sent it.
      auto,
    } = req.data || {};
    await requireEditor(req.auth);

    const invPurpose = purpose || 'rent';
    // Validate idempotency key shape — Stripe accepts any string up to
    // 255 chars; we restrict to UUID-like / random tokens to prevent
    // pollution of Stripe's key namespace by malformed input.
    const safeIdempotencyKey = (typeof idempotencyKey === 'string'
      && /^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey))
      ? idempotencyKey
      : null;
    // Clamp and sanitize remaining inputs that flow into Stripe.
    // Stripe rejects out-of-range values with cryptic errors; better
    // to clamp early and surface the choice in logs.
    //
    // Late fees — это уже penalty за просроченную аренду, поэтому
    // дополнительный grace на сам fee-инвойс не нужен. Минимум и
    // дефолт обнуляются → счёт due IMMEDIATELY (Stripe принимает
    // days_until_due:0 как "due_date = now"). Для остальных purpose
    // поведение прежнее: минимум 1 день, дефолт 30 дней.
    const _isLateFee = invPurpose === 'late_fee';
    const _minDays   = _isLateFee ? 0 : 1;
    const _defDays   = _isLateFee ? 0 : 30;
    const safeDaysUntilDue = Math.max(_minDays, Math.min(365,
      Number.isFinite(+daysUntilDue) ? Math.floor(+daysUntilDue) : _defDays));
    // Stripe invoice description has a 1500-char limit; we cap at 500
    // so the line item, custom_fields, and footer all stay readable.
    const safeCustomDesc = (typeof customDesc === 'string')
      ? customDesc.replace(/[\r\n]+/g, ' ').slice(0, 500)
      : undefined;
    const safePrivateNote = (typeof privateNote === 'string')
      ? privateNote.replace(/[\r\n]+/g, ' ').slice(0, 500)
      : undefined;

    if (!buildingId || !floorId || !unitId) {
      throw new HttpsError('invalid-argument',
        'buildingId, floorId, unitId are required');
    }
    // Only rent invoices REQUIRE a month — other types are one-off. For
    // non-rent invoices, ym is optional (we still stamp the current month
    // for metadata consistency if nothing supplied).
    if (invPurpose === 'rent' && !/^\d{4}-\d{2}$/.test(ym || '')) {
      throw new HttpsError('invalid-argument', 'For rent invoices, ym must be YYYY-MM');
    }
    const effectiveYm = ym && /^\d{4}-\d{2}$/.test(ym) ? ym : (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    })();

    // Per-(unit, ym, day) rate-limit check. Increments only on attempt;
    // a successful invoice + failure both count toward the cap so a
    // botched retry loop hitting the same unit can't keep trying.
    {
      const d = new Date();
      const dayKey = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
      const ymPart = (effectiveYm || '').replace(/[^0-9-]/g, '') || 'noym';
      const unitCounterRef = db.doc(`workspaces/${WORKSPACE_ID}/rateLimits/u_${unitId}_${ymPart}_${dayKey}`);
      const unitCount = await db.runTransaction(async (tx) => {
        const snap = await tx.get(unitCounterRef);
        const cur = snap.exists ? (snap.data().count || 0) : 0;
        const next = cur + 1;
        if (next > RL_PER_UNIT_PER_DAY) return next;
        tx.set(unitCounterRef, { count: next, unitId, ym: ymPart, dayKey, _exp: Date.now() + 48 * 60 * 60 * 1000 });
        return next;
      });
      if (unitCount > RL_PER_UNIT_PER_DAY) {
        throw new HttpsError('resource-exhausted',
          `Suite ${unitId} has reached the daily invoice limit (${RL_PER_UNIT_PER_DAY}/day for this billing month). If you genuinely need to send more, wait until tomorrow UTC or contact support.`);
      }
    }

    const stripe = getStripe();
    const state = await readWorkspaceState();
    const found = findUnit(state, {buildingId, floorId, unitId});
    if (!found) throw new HttpsError('not-found', 'Unit not found in workspace state');
    const {unit, building, floor} = found;

    // Email routing — emailOverride (when explicitly provided as a valid
    // address) WINS over unit.email. This lets the client route a
    // specific invoice to the unit's CC / second contact instead of the
    // primary, without permanently rewriting unit.email. Falls back to
    // unit.email otherwise. The original "fallback when missing" behavior
    // for just-added tenants is preserved (override still wins).
    //
    // Side effect: if emailOverride differs from unit.email, the
    // customer lookup below may create a SEPARATE Stripe customer for
    // that address (Stripe identifies customers by email). Acceptable
    // for the per-invoice routing use case; operator can consolidate
    // manually in Stripe Dashboard if needed.
    const email = (emailOverride && /@/.test(emailOverride))
      ? String(emailOverride).trim()
      : (unit.email && /@/.test(unit.email) ? unit.email : null);
    const tenantName = unit.tenant || unit.company
      || (tenantNameOverride ? String(tenantNameOverride).trim() : null)
      || 'Tenant';
    if (!email) {
      throw new HttpsError('failed-precondition',
        'Unit has no tenant email — add one in Rent Roll before invoicing');
    }
    // Amount: rent invoices use the unit's configured rent; other purposes
    // must supply amountOverride (in $). Defense against $0 invoices for
    // rent (but non-rent can theoretically be any positive amount).
    let rentCents;
    if (invPurpose === 'rent') {
      rentCents = unitRentCents(unit);
      if (amountOverride && Number(amountOverride) > 0) {
        rentCents = Math.round(Number(amountOverride) * 100);
      }
      if (rentCents <= 0) {
        throw new HttpsError('failed-precondition',
          'Unit has no rent amount set — add Current Rent before invoicing');
      }
    } else {
      if (!amountOverride || Number(amountOverride) <= 0) {
        throw new HttpsError('invalid-argument',
          'Non-rent invoices require amountOverride in dollars');
      }
      rentCents = Math.round(Number(amountOverride) * 100);
    }

    // Ensure Customer (inline so we don't double-RPC).
    const emailLower = email.toLowerCase();
    let customerId = state.stripeCustomers?.[emailLower]?.customerId;
    if (!customerId) {
      // SAFE: Stripe's search query syntax uses double-quoted strings.
      // Without escaping, an email containing `"` could close the
      // string and inject extra search clauses, e.g. an attacker-
      // controlled email of `x@x.com" OR metadata["workspaceId"]:"`
      // would broaden the search to other workspaces. We strip
      // backslashes and double-quotes (the only characters with
      // syntactic meaning in the query string) to guarantee the
      // email is treated as a single literal.
      const safeEmail = String(emailLower).replace(/[\\"]/g, '');
      const search = await stripe.customers.search({
        query: `email:"${safeEmail}" AND metadata["workspaceId"]:"${WORKSPACE_ID}"`,
        limit: 1,
      });
      if (search.data[0]) {
        customerId = search.data[0].id;
      } else {
        const created = await stripe.customers.create({
          email, name: tenantName,
          metadata: {workspaceId: WORKSPACE_ID, unitId, buildingId, source: 'suitesforall'},
        });
        customerId = created.id;
      }
      await mutateWorkspaceState((s) => {
        s.stripeCustomers = s.stripeCustomers || {};
        s.stripeCustomers[emailLower] = {customerId, name: tenantName, updatedAt: new Date().toISOString()};
      });
    }

    // ---- Server-side duplicate guard ---------------------------------
    // Authoritative check against Stripe itself — protects against
    // double-billing even if the client's u.stripe state is stale or
    // a user races two send clicks across devices. Scope:
    //
    //   rent     → dedupe on (unit, ym)                 → one rent invoice per month
    //   deposit  → dedupe on (unit, purpose) + legacy   → one deposit per unit
    //   keys / damages / cleaning / late_fee / custom
    //            → dedupe on (unit, purpose, ym)        → one per month, per purpose
    //
    // Operators CAN still override via `allowDuplicate: true` from the
    // caller when they legitimately need a second charge of the same
    // purpose in one month (e.g. a second damage claim). We record
    // that override in metadata for audit.
    //
    // Void / uncollectible / deleted invoices are ignored — those are
    // the legitimate re-issue paths.
    const allowDup = req.data?.allowDuplicate === true;
    try {
      if (!allowDup) {
        // PRIMARY DEDUPE: targeted Stripe Search API by metadata.
        // Catches duplicates regardless of how many invoices the
        // customer has (the previous list({limit:50}) approach
        // missed dupes for high-volume tenants whose recent month
        // had > 50 invoices). Search is eventually-consistent
        // (~10s lag for new invoices), so we ALSO keep the list-50
        // fallback below for race-against-just-created cases.
        const customDescStr = String(customDesc || '');
        const isDepositIntent = invPurpose === 'deposit'
          || (invPurpose === 'custom' && /deposit/i.test(customDescStr));
        let metadataDup = null;
        try {
          // Build a metadata-scoped search query. For rent: dedupe by
          // (unitId, ym, purpose). For deposit: dedupe by (unitId,
          // purpose) only (one deposit per unit, ever). For one-offs:
          // (unitId, purpose, ym).
          let q;
          if (invPurpose === 'rent') {
            q = `customer:"${customerId}" AND metadata["unitId"]:"${unitId}" AND metadata["purpose"]:"rent" AND metadata["ym"]:"${effectiveYm}"`;
          } else if (isDepositIntent) {
            q = `customer:"${customerId}" AND metadata["unitId"]:"${unitId}" AND metadata["purpose"]:"deposit"`;
          } else {
            q = `customer:"${customerId}" AND metadata["unitId"]:"${unitId}" AND metadata["purpose"]:"${invPurpose}" AND metadata["ym"]:"${effectiveYm}"`;
          }
          const searchRes = await stripe.invoices.search({ query: q, limit: 5 });
          metadataDup = (searchRes.data || []).find(inv =>
            !['void', 'uncollectible', 'deleted'].includes(inv.status));
        } catch (searchErr) {
          // Search API not available or threw — fall through to the
          // list-based dedupe. Don't fail the invoice over a
          // pre-flight check failure.
          logger.warn(`[createStripeInvoice] search-dedupe failed (continuing to list): ${searchErr.message}`);
        }
        if (metadataDup) {
          const labelFor = {
            rent: 'rent', deposit: 'deposit',
            keys: 'replacement keys', damages: 'damages',
            cleaning: 'cleaning fee', late_fee: 'late fee', custom: 'charge',
          };
          const kind = labelFor[invPurpose] || invPurpose;
          const errMonthLabel = new Date(`${effectiveYm}-01T00:00:00Z`)
            .toLocaleString('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'});
          const hint = invPurpose === 'deposit'
            ? `Suite ${unitId}`
            : `Suite ${unitId} · ${errMonthLabel}`;
          throw new HttpsError('already-exists',
            `A ${metadataDup.status} ${kind} invoice for ${hint} already exists (${metadataDup.id}). ` +
            `Void it on the Invoices tab if you need to re-issue, or use "Send reminder" to nudge the tenant. ` +
            `Pass allowDuplicate=true to override.`);
        }
        // FALLBACK: list-based scan catches invoices created in the
        // last ~10 seconds (before search index updated). Same logic
        // as before — this is now defense-in-depth, not the primary.
        const recent = await stripe.invoices.list({customer: customerId, limit: 50});
        // (isDepositIntent + customDescStr already declared in the
        // search block above — reuse them here.)
        const dup = (recent.data || []).find((inv) => {
          const m = inv.metadata || {};
          // Accept either 'suitesforall' (manual) or 'auto' (scheduler)
          // source so manual sends don't duplicate auto-generated ones.
          if (m.source !== 'suitesforall' && m.source !== 'auto') return false;
          if (String(m.unitId || '') !== String(unitId)) return false;
          if (['void', 'uncollectible', 'deleted'].includes(inv.status)) return false;
          if (invPurpose === 'rent') {
            return m.purpose === 'rent' && m.ym === effectiveYm;
          }
          if (isDepositIntent) {
            // Match any existing deposit invoice for this unit — accepts
            // both new (purpose='deposit') and legacy (purpose='custom'
            // + 'deposit' in desc) records.
            if (m.purpose === 'deposit') return true;
            return m.purpose === 'custom' && /deposit/i.test(inv.description || '');
          }
          // For keys / damages / cleaning / late_fee / custom — same
          // (unit, purpose, ym) can only have one active invoice
          // unless operator explicitly opts in via allowDuplicate.
          return m.purpose === invPurpose && m.ym === effectiveYm;
        });
        if (dup) {
          const labelFor = {
            rent: 'rent', deposit: 'deposit',
            keys: 'replacement keys', damages: 'damages',
            cleaning: 'cleaning fee', late_fee: 'late fee', custom: 'charge',
          };
          const kind = labelFor[invPurpose] || invPurpose;
          const errMonthLabel = new Date(`${effectiveYm}-01T00:00:00Z`)
            .toLocaleString('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'});
          const hint = invPurpose === 'deposit'
            ? `Suite ${unitId}`
            : `Suite ${unitId} · ${errMonthLabel}`;
          throw new HttpsError('already-exists',
            `A ${dup.status} ${kind} invoice for ${hint} already exists (${dup.id}). ` +
            `Void it on the Invoices tab if you need to re-issue, or use "Send reminder" to nudge the tenant. ` +
            `Pass allowDuplicate=true to override.`);
        }
      }
    } catch (err) {
      // If it's our HttpsError, rethrow. Otherwise log and continue —
      // this dedupe check is defense-in-depth, not a hard requirement.
      if (err && err.httpErrorCode) throw err;
      logger.warn(`[createStripeInvoice] dup-check failed (continuing): ${err.message}`);
    }

    // ---- Human-readable invoice copy ----------------------------------
    // Three separate fields on the Stripe invoice end up in different
    // spots on the tenant-facing PDF + email. Purpose (rent/late_fee/...)
    // decides the wording.
    const [year, month] = effectiveYm.split('-');
    const monthLabel = new Date(`${effectiveYm}-01T00:00:00Z`).toLocaleString('en-US', {month: 'long', timeZone: 'UTC'});
    const addressLine = building.address || building.name || '';
    const floorLabel = floor.name || `Floor ${floor.number || ''}`;
    const nowIso = new Date().toISOString().slice(0, 10);
    // Use the validated/clamped values computed earlier (safeDaysUntilDue,
    // safeCustomDesc, safePrivateNote). The `daysDue` and `customDesc`
    // / `privateNote` aliases below are kept so downstream string
    // interpolations and metadata writes continue to work unchanged.
    const daysDue = safeDaysUntilDue;
    customDesc = safeCustomDesc;
    privateNote = safePrivateNote;

    // Purpose-specific copy — keeps the invoice PDF self-explanatory.
    const PURPOSE_COPY = {
      rent:      {label: 'Monthly rent',     verb: 'Rent for' },
      late_fee:  {label: 'Late fee',         verb: 'Late fee for'},
      keys:      {label: 'Replacement keys', verb: 'Replacement keys for'},
      damages:   {label: 'Damages',          verb: 'Damages for'},
      cleaning:  {label: 'Cleaning fee',     verb: 'Cleaning fee for'},
      deposit:   {label: 'Security deposit', verb: 'Security deposit for'},
      custom:    {label: 'Service charge',   verb: 'Service charge for'},
    };
    const copy = PURPOSE_COPY[invPurpose] || PURPOSE_COPY.custom;

    // Top-of-invoice header.
    // EVERY invoice — rent or not — now includes the human-readable
    // period in its title. For rent it's the billing month; for
    // one-off charges (keys, damages, cleaning, etc.) it's the month
    // the charge was issued, so the operator never has to guess
    // "which month was that key charge from?" when scanning Stripe.
    const topSummary = customDesc
      ? `${copy.label}: ${customDesc} — Suite ${unitId} · ${monthLabel} ${year}`
      : (invPurpose === 'rent'
        ? `${copy.label} — Suite ${unitId} · ${monthLabel} ${year}`
        : `${copy.label} — Suite ${unitId} · ${monthLabel} ${year}`);

    // Line-item description in charges table. Always stamp the period
    // so the PDF line reads e.g. "Replacement keys for April 2026 —
    // Suite A4, 123 Main St" instead of a bare "Replacement keys".
    const lineDesc = invPurpose === 'rent'
      ? `${copy.verb} ${monthLabel} ${year} — Suite ${unitId}${addressLine ? ', ' + addressLine : ''}`
      : (customDesc
          ? `${copy.label}: ${customDesc} — ${monthLabel} ${year} · Suite ${unitId}${addressLine ? ', ' + addressLine : ''}`
          : `${copy.verb} ${monthLabel} ${year} — Suite ${unitId}${addressLine ? ', ' + addressLine : ''}`);

    // Footer: bottom-of-PDF context. Extra line appended later if
    // auto-charge is active for this invoice (see collectionMethod
    // routing below) — tenant sees an explicit heads-up about what
    // will happen if they save their card.
    //
    // Landlord line is workspace-configurable — operator's personal
    // address (tony@al-en.com) was leaking onto every tenant invoice.
    // Reads from state.settings.invoiceLandlordEmail / invoiceLandlordName
    // with a sensible business default (finance@kiwi-rentals.com /
    // SuitesForAll) so existing deployments don't break and a fresh
    // workspace doesn't expose a personal address by accident.
    const _wsSettings = (state && state.settings) || {};
    const landlordEmail = String(_wsSettings.invoiceLandlordEmail || 'finance@kiwi-rentals.com').trim();
    const landlordName  = String(_wsSettings.invoiceLandlordName  || 'SuitesForAll').trim();
    const footerParts = [
      `Property: ${addressLine}${floorLabel ? ` · ${floorLabel}` : ''}`,
      `Suite: ${unitId}`,
      invPurpose === 'rent' ? `Billing period: ${monthLabel} ${year}` : `Charge type: ${copy.label}`,
      `Invoice issued: ${nowIso}`,
      `Payment due: within ${daysDue} days`,
      `Landlord: ${landlordName}${landlordEmail ? ' · ' + landlordEmail : ''}`,
    ];

    // Pre-create the invoice item so it attaches to the invoice we make next.
    // Linking them upfront (not relying on the "pending items sweep") keeps
    // other concurrent invoice runs for the same customer from snatching
    // our line item.
    // Custom invoice number — encodes purpose / suite / month / issue date
    // so the operator can decode at a glance from Stripe Dashboard but a
    // tenant sees an opaque string. Must be set on a DRAFT invoice (Stripe
    // rejects number changes after finalization), so we create draft →
    // set number → finalize.
    // Auto flag forwards to buildCustomInvoiceNumber so system-initiated
    // sends get the "RA-" prefix (vs operator-initiated plain "R-").
    // Coerce to bool — clients sometimes send 'true' (string) or 1.
    const isAuto = (auto === true || auto === 'true' || auto === 1);
    const customNumber = buildCustomInvoiceNumber({purpose: invPurpose, unitId, ym: effectiveYm, auto: isAuto});

    // Auto-charge routing. Three inputs matter:
    //   1. Workspace-level auto-charge toggle (settings.autoInvoice.autoCharge)
    //   2. Per-unit override (unit.autoCharge: 'on' | 'off' | undefined)
    //   3. THIS invoice's autoPayConsent flag — the operator must tick a
    //      checkbox confirming the tenant agreed to auto-pay before we
    //      silently save their card. Without that consent, we fall back
    //      to plain send_invoice with NO save_default_payment_method.
    //
    // If (workspace auto-charge ON or per-unit ON) AND customer has a
    // saved default payment method → charge_automatically (no email,
    // Stripe debits card on due date).
    //
    // If (workspace auto-charge ON or per-unit ON) AND no saved PM AND
    // operator captured autoPayConsent → send_invoice + save_default_payment_method,
    // so the next invoice can auto-charge.
    //
    // Otherwise → plain send_invoice, no card saving.
    const autoPayConsent = req.data?.autoPayConsent === true;
    let collectionMethod = 'send_invoice';
    let paymentSettings = null;
    let autoChargeReason = 'none';
    try {
      const wsCfg = (state.settings && state.settings.autoInvoice) || {};
      const wsEnabled = wsCfg.autoCharge === true;
      const unitOverride = unit.autoCharge;   // 'on' | 'off' | undefined (inherit)
      const effectiveOn = unitOverride === 'on'
        || (unitOverride !== 'off' && wsEnabled);
      // Tenant-level persistent consent (captured on a prior invoice
      // or recorded in the rent roll) unlocks save-PM flow for future
      // invoices without re-asking the operator every time.
      const tenantPersistedConsent = !!(unit.autoPayConsent && unit.autoPayConsent.acceptedAt);
      const hasConsent = autoPayConsent || tenantPersistedConsent;
      if (effectiveOn) {
        // Check the customer's saved payment method
        const cust = await stripe.customers.retrieve(customerId);
        const dpm = cust && cust.invoice_settings && cust.invoice_settings.default_payment_method;
        if (dpm) {
          collectionMethod = 'charge_automatically';
          autoChargeReason = 'existing-pm';
          logger.info(`[auto-charge] ${unitId}/${effectiveYm}: using saved PM ${dpm}`);
        } else if (hasConsent) {
          // Customer hasn't paid yet — first invoice. Operator confirmed
          // the tenant authorized auto-pay, so save card after this payment.
          paymentSettings = { save_default_payment_method: 'on_confirmation' };
          autoChargeReason = 'consent-save-pm';
          logger.info(`[auto-charge] ${unitId}/${effectiveYm}: consent captured, will save on confirmation`);
        } else {
          autoChargeReason = 'consent-missing';
          logger.info(`[auto-charge] ${unitId}/${effectiveYm}: auto-charge enabled but no consent; sending plain invoice`);
        }
      }
    } catch (e) {
      logger.warn(`[auto-charge] ${unitId}: routing check failed, falling back to send_invoice — ${e.message}`);
    }

    // Append an explicit auto-debit notice to the footer so the tenant
    // sees on their invoice PDF / email what will happen + how to opt
    // out. We only add save-PM flow when consent was captured upstream
    // (operator-level checkbox or prior tenant-level consent stamp),
    // so if this text appears it means the tenant already agreed.
    let footerWithAutoCharge = footerParts.join(' · ');
    if (paymentSettings && paymentSettings.save_default_payment_method === 'on_confirmation') {
      footerWithAutoCharge += '\n\n⚡ AUTO-PAY AUTHORIZED: You authorized auto-pay for future monthly rent invoices. Paying this invoice will save your payment method; future rent invoices will be charged automatically on the due date. To revoke this authorization, reply to this email or contact your landlord.';
    } else if (collectionMethod === 'charge_automatically') {
      footerWithAutoCharge += '\n\n⚡ Your card on file will be automatically charged on the due date. To update your payment method or opt out, reply to this email or contact your landlord.';
    }
    const footerText = footerWithAutoCharge;

    // Stripe SDK accepts a per-call `idempotencyKey` option (second arg)
    // — distinct from request body. Stripe stores the key for 24h and
    // returns the same response on duplicate calls. This is the
    // industry-standard defence against double-charge bugs from network
    // retries, double-clicks, or client-side glitches.
    const stripeReqOpts = safeIdempotencyKey
      ? { idempotencyKey: safeIdempotencyKey }
      : undefined;

    const invoice = await stripe.invoices.create({
      customer: customerId,
      auto_advance: false,                // we control the finalize sequence
      collection_method: collectionMethod,
      ...(collectionMethod === 'send_invoice' ? { days_until_due: daysDue } : {}),
      ...(paymentSettings ? { payment_settings: paymentSettings } : {}),
      description: topSummary,
      footer: footerText,
      pending_invoice_items_behavior: 'exclude',
      // Every invoice shows Suite + Billing month + Charge type — the
      // three facts the tenant (and operator auditing later) needs to
      // decode what they're paying for at a glance. Stripe caps
      // custom_fields at 4, so Property is only included when it fits.
      custom_fields: ([
        {name: 'Suite',          value: String(unitId)},
        {name: 'Charge type',    value: copy.label},
        {name: 'Billing month',  value: `${monthLabel} ${year}`},
        ...(addressLine ? [{name: 'Property', value: addressLine}] : []),
      ]).slice(0, 4),
      metadata: {
        source: 'suitesforall',
        workspaceId: WORKSPACE_ID,
        buildingId, floorId, unitId,
        ym: effectiveYm,
        purpose: invPurpose,
        suite: String(unitId),
        billingMonth: `${year}-${month}`,
        customNumber,
        ...(allowDup ? {duplicateOverride: 'true'} : {}),
        ...(req.data?.autoPayConsent === true ? {autoPayConsent: 'true'} : {}),
        // Private note is kept in metadata only — visible to the operator
        // in Stripe Dashboard, NEVER rendered on the tenant's PDF/email.
        ...(privateNote ? {privateNote: String(privateNote).slice(0, 500)} : {}),
      },
    }, stripeReqOpts);

    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      amount: rentCents,
      currency: 'usd',
      description: lineDesc,
      metadata: {
        source: 'suitesforall',
        purpose: invPurpose,
        suite: String(unitId),
        billingMonth: `${year}-${month}`,
      },
    });

    // Additional monthly services (parking, cleaning, conference room,
    // etc.) — added as separate Stripe invoice line items so the
    // tenant sees the breakdown on their PDF / hosted page. Only fires
    // for rent invoices (other purposes are one-off charges and don't
    // bundle services). Only frequency='monthly' services are auto-
    // added; one-time / hourly / daily services need explicit billing.
    if (invPurpose === 'rent' && Array.isArray(unit.additionalServices)) {
      for (const svc of unit.additionalServices) {
        const freq = svc?.frequency || 'monthly';
        const amt  = +svc?.amount || 0;
        // Gate on the per-tenant flags. The master switch (`active`) means
        // the service is signed up for; `autoInvoice` opts it into the
        // automatic monthly billing flow. Both must be true; inactive or
        // manual-only services are billed by other paths.
        if (!svc?.active) continue;
        if (!svc?.autoInvoice) continue;
        if (freq !== 'monthly' || amt <= 0) continue;
        try {
          await stripe.invoiceItems.create({
            customer: customerId,
            invoice: invoice.id,
            amount: Math.round(amt * 100),
            currency: 'usd',
            description: String(svc.name || 'Additional service').slice(0, 250),
            metadata: {
              source: 'suitesforall',
              purpose: 'service',
              serviceId: String(svc.id || ''),
              suite: String(unitId),
              billingMonth: `${year}-${month}`,
            },
          });
        } catch (svcErr) {
          // Per-service failure shouldn't kill the entire invoice. Log
          // and continue — at worst the tenant gets the rent line only
          // and operator can retry the service line manually in
          // Stripe Dashboard.
          logger.warn(`[createStripeInvoice] service line "${svc.name}" failed: ${svcErr.message}`);
        }
      }
    }

    // Operator-added extra line items (from the new Invoice Generator
    // UI's "+ Add charge" rows). Each is added as a separate Stripe
    // invoice item attached to the same invoice.id, so the tenant
    // sees one combined PDF with: rent line + monthly subscriptions
    // (auto) + custom one-off charges (operator). Validates each entry
    // before sending — bad rows are skipped with a logger warning, never
    // halting the whole invoice. Caps the count at 30 so a runaway
    // client can't blow Stripe's per-invoice line limit.
    if (Array.isArray(extraLineItems) && extraLineItems.length > 0) {
      const items = extraLineItems.slice(0, 30);
      let added = 0;
      for (const item of items) {
        try {
          if (!item || typeof item !== 'object') continue;
          const desc = String(item.description || '').replace(/[\r\n]+/g, ' ').slice(0, 250).trim();
          const amt = +item.amount || 0;
          if (!desc) { logger.warn('[createStripeInvoice] extra line missing description, skipped'); continue; }
          if (amt <= 0 || !Number.isFinite(amt)) { logger.warn(`[createStripeInvoice] extra line "${desc}" has bad amount ${amt}, skipped`); continue; }
          const cents = Math.round(amt * 100);
          const itemType = (item.type === 'late-fee' ? 'late_fee'
                           : (item.type === 'recurring' ? 'service' : 'custom'));
          await stripe.invoiceItems.create({
            customer: customerId,
            invoice: invoice.id,
            amount: cents,
            currency: 'usd',
            description: desc,
            metadata: {
              source: 'suitesforall',
              purpose: itemType,
              suite: String(unitId),
              billingMonth: `${year}-${month}`,
              extraLine: 'true',
            },
          });
          added++;
        } catch (lineErr) {
          logger.warn(`[createStripeInvoice] extra line "${item?.description}" failed: ${lineErr.message}`);
        }
      }
      if (added > 0) logger.info(`[createStripeInvoice] added ${added} extra line items to ${invoice.id}`);
    }

    // Set the custom number. If it collides (extremely unlikely because of
    // the 2-char random suffix), regenerate once with a fresh suffix.
    try {
      await stripe.invoices.update(invoice.id, {number: customNumber});
    } catch (err) {
      if (err.code === 'resource_already_exists' || /already.*exists/i.test(err.message || '')) {
        const retry = buildCustomInvoiceNumber({purpose: invPurpose, unitId, ym: effectiveYm, auto: isAuto});
        logger.warn(`[stripe] invoice number ${customNumber} collided; retrying with ${retry}`);
        await stripe.invoices.update(invoice.id, {number: retry});
      } else {
        // Custom number is nice-to-have, not blocking. Log and keep going
        // with Stripe's auto-generated number.
        logger.warn(`[stripe] could not set custom invoice number: ${err.message}`);
      }
    }

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    let sent = finalized;
    if (collectionMethod === 'charge_automatically') {
      // Stripe auto-charges the saved payment method on finalize.
      // No sendInvoice call needed (there's no hosted page for the
      // tenant to pay — the card is debited automatically). If the
      // charge fails, the invoice goes past_due and Stripe's built-in
      // Smart Retry kicks in (default 4 retries over 3 weeks).
      logger.info(`[stripe] ${finalized.id} finalized with charge_automatically — card will be charged by Stripe`);
    } else {
      try {
        sent = await stripe.invoices.sendInvoice(finalized.id);
      } catch (err) {
        logger.warn(`[stripe] sendInvoice for ${finalized.id} failed: ${err.message}`);
      }
    }

    // Mirror invoice ID into unit.stripe for quick lookups and UI badges.
    // Only the most recent RENT invoice sets lastInvoiceYm (that's what the
    // Payments matrix cares about). Non-rent charges are tracked separately
    // in u.stripe.extraInvoices so they don't skew month-to-month rent view.
    await mutateWorkspaceState((s) => {
      const f = findUnit(s, {buildingId, floorId, unitId});
      if (!f) return;
      f.unit.stripe = f.unit.stripe || {};
      f.unit.stripe.customerId = customerId;
      f.unit.stripe.lastInvoiceId = sent.id;
      if (invPurpose === 'rent') {
        f.unit.stripe.lastInvoiceYm = effectiveYm;
      } else {
        f.unit.stripe.extraInvoices = f.unit.stripe.extraInvoices || [];
        f.unit.stripe.extraInvoices.unshift({
          id: sent.id,
          purpose: invPurpose,
          amount: rentCents / 100,
          created: Math.floor(Date.now() / 1000),
          description: customDesc || copy.label,
        });
        // Cap at 20 so the array doesn't grow unbounded over years
        if (f.unit.stripe.extraInvoices.length > 20) {
          f.unit.stripe.extraInvoices = f.unit.stripe.extraInvoices.slice(0, 20);
        }
      }
      // Persist auto-pay consent on the unit when operator captured it
      // for the first time — future invoices can auto-charge without
      // re-asking. Stamp sourced-by + timestamp for audit.
      if (autoPayConsent && !(f.unit.autoPayConsent && f.unit.autoPayConsent.acceptedAt)) {
        f.unit.autoPayConsent = {
          acceptedAt: new Date().toISOString(),
          acceptedBy: req.auth?.token?.email || req.auth?.uid || 'operator',
          source: 'send-invoice-modal',
          firstInvoiceId: sent.id,
        };
      }
    });

    return {
      invoiceId: sent.id,
      hostedUrl: sent.hosted_invoice_url,
      status: sent.status,
      amount: rentCents,
      customerId,
    };
  }
);

// =========================================================================
// ===== Stripe — Start Auto-Pay ===========================================
// Returns a Stripe Checkout Session URL for a monthly subscription. Tenant
// visits the URL, saves an ACH account or card, and Stripe activates the
// subscription. Stripe then charges on the 1st of every month and fires
// invoice.payment_succeeded → our webhook → Payments matrix updates.
// =========================================================================
exports.startAutoPay = onCall(
  {secrets: [STRIPE_SECRET_KEY]},
  async (req) => {
    const {buildingId, floorId, unitId, successUrl, cancelUrl} = req.data || {};
    await requireEditor(req.auth);

    if (!buildingId || !floorId || !unitId) {
      throw new HttpsError('invalid-argument',
        'buildingId, floorId, unitId are required');
    }

    const stripe = getStripe();
    const state = await readWorkspaceState();
    const found = findUnit(state, {buildingId, floorId, unitId});
    if (!found) throw new HttpsError('not-found', 'Unit not found');
    const {unit, building} = found;

    const email = unit.email;
    if (!email) throw new HttpsError('failed-precondition', 'Tenant email missing');
    const tenantName = unit.tenant || unit.company || 'Tenant';
    const rentCents = unitRentCents(unit);
    if (rentCents <= 0) throw new HttpsError('failed-precondition', 'Rent amount missing');

    // Ensure Stripe Customer
    const emailLower = email.toLowerCase();
    let customerId = state.stripeCustomers?.[emailLower]?.customerId;
    if (!customerId) {
      const created = await stripe.customers.create({
        email, name: tenantName,
        metadata: {workspaceId: WORKSPACE_ID, unitId, buildingId, source: 'suitesforall'},
      });
      customerId = created.id;
      await mutateWorkspaceState((s) => {
        s.stripeCustomers = s.stripeCustomers || {};
        s.stripeCustomers[emailLower] = {customerId, name: tenantName, updatedAt: new Date().toISOString()};
      });
    }

    // Create a Checkout Session. mode='subscription' with inline price_data
    // avoids having to maintain a Stripe Price catalog per unit.
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      payment_method_types: ['card', 'us_bank_account'],  // ACH (cheaper) + card fallback
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Monthly rent — ${building.name || building.address || ''} · Suite ${unitId}`,
          },
          unit_amount: rentCents,
          recurring: {interval: 'month'},
        },
        quantity: 1,
      }],
      subscription_data: {
        metadata: {
          source: 'suitesforall',
          workspaceId: WORKSPACE_ID,
          buildingId, floorId, unitId,
        },
      },
      success_url: successUrl || 'https://suitesforall.web.app/?autopay=ok',
      cancel_url:  cancelUrl  || 'https://suitesforall.web.app/?autopay=cancel',
      metadata: {
        source: 'suitesforall',
        workspaceId: WORKSPACE_ID,
        buildingId, floorId, unitId,
      },
    });

    return {checkoutUrl: session.url, customerId};
  }
);

// =========================================================================
// ===== Stripe — List invoices ===========================================
// Pages through Stripe invoices for this workspace and returns a compact
// shape the UI can render as a Stripe-Dashboard-style table. Filtering
// and status-bucketing happens client-side because Stripe's filter API
// doesn't support all our needs (e.g., metadata.source).
// =========================================================================
exports.listStripeInvoices = onCall(
  {secrets: [STRIPE_SECRET_KEY]},
  async (req) => {
    await requireEditor(req.auth);
    const {limit, startingAfter, status, customer} = req.data || {};
    const stripe = getStripe();
    const args = {
      limit: Math.min(Math.max(+limit || 50, 1), 100),
      expand: ['data.customer'],
    };
    if (startingAfter) args.starting_after = startingAfter;
    if (status && ['draft','open','paid','uncollectible','void'].includes(status)) {
      args.status = status;
    }
    // Targeted fetch — when caller has a Stripe customer id, scope the
    // listing to that customer. This is essential for unit Finance tabs:
    // the workspace-wide "last 100 invoices" cache only covers a few days
    // on busy accounts, so older invoices for a given tenant fall off.
    // A customer-scoped call returns ALL invoices for that tenant up to
    // the limit, regardless of how many other invoices the workspace has
    // sent in between. Stripe customer ids look like "cus_…"; ignore
    // anything else to avoid passing junk through.
    if (typeof customer === 'string' && /^cus_[A-Za-z0-9]+$/.test(customer)) {
      // SCOPE CHECK — without this, an editor could pass any cus_ id
      // (e.g., obtained from another workspace's exposed Stripe data)
      // and our function would dutifully list invoices for that
      // customer, leaking unrelated billing info. Verify the customer
      // is one we actually know in this workspace's state.
      const state = await readWorkspaceState();
      let known = false;
      // Path 1: customer appears in any unit's stripe.customerId
      outer: for (const b of (state.buildings || [])) {
        for (const f of (b.floors || [])) {
          for (const u of (f.units || [])) {
            if (u?.stripe?.customerId === customer) { known = true; break outer; }
          }
        }
      }
      // Path 2: customer in the email→customerId mapping
      if (!known && state.stripeCustomers) {
        for (const k of Object.keys(state.stripeCustomers)) {
          if (state.stripeCustomers[k]?.customerId === customer) { known = true; break; }
        }
      }
      // Path 3: last resort — fetch the customer and check workspace
      // metadata. Costs a Stripe round-trip, so skip if not needed.
      if (!known) {
        try {
          const stripe = getStripe();
          const cust = await stripe.customers.retrieve(customer);
          if (cust && !cust.deleted && cust.metadata?.workspaceId === WORKSPACE_ID) {
            known = true;
          }
        } catch (e) {
          // Treat retrieval failure as "not known" — fail closed.
          logger.warn(`[listStripeInvoices] customer ${customer} retrieve failed: ${e.message}`);
        }
      }
      if (!known) {
        throw new HttpsError('permission-denied',
          `Customer ${customer} is not in this workspace`);
      }
      args.customer = customer;
    }
    const page = await stripe.invoices.list(args);
    const now = Math.floor(Date.now() / 1000);
    const rows = page.data
      .filter(inv => !inv.metadata || inv.metadata.source === 'suitesforall' || !inv.metadata.source)
      .map(inv => {
        const customer = (typeof inv.customer === 'object') ? inv.customer : null;
        // Derive "past due" client-friendly bucket
        const isPastDue = inv.status === 'open' && inv.due_date && inv.due_date < now;
        return {
          id: inv.id,
          number: inv.number || inv.id,
          status: inv.status,
          bucket: isPastDue ? 'past_due' : inv.status,
          total: (inv.total || 0) / 100,
          amountRemaining: (inv.amount_remaining || 0) / 100,
          amountPaid: (inv.amount_paid || 0) / 100,
          currency: (inv.currency || 'usd').toUpperCase(),
          customerId: typeof inv.customer === 'string' ? inv.customer : customer?.id,
          customerName: customer?.name || inv.customer_name || '',
          customerEmail: customer?.email || inv.customer_email || '',
          description: inv.description || '',
          created: inv.created ? inv.created * 1000 : null,
          dueDate: inv.due_date ? inv.due_date * 1000 : null,
          hostedUrl: inv.hosted_invoice_url || null,
          pdfUrl: inv.invoice_pdf || null,
          metadata: inv.metadata || {},
        };
      });
    return {
      rows,
      hasMore: page.has_more,
      nextCursor: page.has_more ? page.data[page.data.length - 1].id : null,
    };
  }
);

// =========================================================================
// ===== Stripe — Resend invoice (manual reminder) ========================
// Triggers Stripe to send the invoice email again. Called from the A/R
// Aging "Send reminder" quick-action and the bulk reminder button.
// =========================================================================
exports.stripeResendInvoice = onCall(
  {secrets: [STRIPE_SECRET_KEY]},
  async (req) => {
    await requireEditor(req.auth);
    const {invoiceId, customerId} = req.data || {};
    if (!invoiceId && !customerId) {
      throw new HttpsError('invalid-argument', 'Either invoiceId or customerId is required');
    }
    const stripe = getStripe();
    try {
      let targetInvoiceId = invoiceId;

      // Fallback path: no invoiceId → auto-discover the most recent OPEN
      // invoice for the customer. Handles the case where the client only
      // has u.stripe.customerId but no u.stripe.lastInvoiceId (e.g.
      // invoices created outside the app, imported via reconcile, etc.).
      if (!targetInvoiceId) {
        const openInvs = await stripe.invoices.list({
          customer: customerId,
          status: 'open',
          limit: 10,
        });
        if (!openInvs.data.length) {
          throw new HttpsError('failed-precondition',
            `No open invoices for this customer. Create an invoice first, or use Reconcile to link existing ones.`);
        }
        // Most recent first — Stripe sorts list() by created desc by default.
        targetInvoiceId = openInvs.data[0].id;
        logger.info(`[stripeResend] auto-discovered invoice ${targetInvoiceId} for customer ${customerId}`);
      }

      const inv = await stripe.invoices.retrieve(targetInvoiceId);
      if (inv.status !== 'open') {
        throw new HttpsError('failed-precondition', `Invoice is ${inv.status} — only "open" invoices can be re-sent`);
      }
      const sent = await stripe.invoices.sendInvoice(targetInvoiceId);
      logger.info(`[stripeResend] ${targetInvoiceId} → email re-sent`);
      return {
        invoiceId: targetInvoiceId,
        status: sent.status,
        hostedUrl: sent.hosted_invoice_url || null,
        autoDiscovered: !invoiceId,
      };
    } catch (err) {
      if (err.httpErrorCode) throw err;
      logger.error('[stripeResend] failed:', err.message, err.stack);
      throw new HttpsError('internal', `Resend failed: ${err.message || err}`);
    }
  }
);

// =========================================================================
// ===== Stripe — Void or delete an invoice ================================
// Client calls this with just invoiceId. We retrieve the invoice to see
// its current status and route to the right Stripe action:
//
//   draft              → stripe.invoices.del()         (invoice disappears)
//   open, past_due,    → stripe.invoices.voidInvoice() (marked void, kept)
//   uncollectible
//   paid               → refuse (requires refund flow, not delete)
//   void               → no-op, already void
//
// This keeps the API surface tiny (one callable) and protects callers
// from guessing Stripe's status rules. Returns { invoiceId, action,
// status } so the client knows what actually happened and can update
// its local cache accordingly.
// =========================================================================
exports.voidOrDeleteStripeInvoice = onCall(
  {secrets: [STRIPE_SECRET_KEY]},
  async (req) => {
    await requireEditor(req.auth);
    const {invoiceId} = req.data || {};
    if (!invoiceId) {
      throw new HttpsError('invalid-argument', 'invoiceId is required');
    }
    const stripe = getStripe();
    const actor = req.auth?.token?.email || req.auth?.uid || 'unknown';
    // Helper to log every void/delete to the workspace audit collection.
    // Best-effort — never block the underlying Stripe action on audit
    // write failure.
    const writeAudit = async (action, payload) => {
      try {
        await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
          ts: admin.firestore.FieldValue.serverTimestamp(),
          actor,
          actorUid: req.auth?.uid || null,
          action: 'invoice.' + action,
          source: 'voidOrDeleteStripeInvoice',
          invoiceId,
          ...payload,
        });
      } catch (e) {
        logger.warn('[voidOrDelete] audit write failed: ' + e.message);
      }
    };
    try {
      const inv = await stripe.invoices.retrieve(invoiceId);
      const status = inv.status;
      const meta = inv.metadata || {};
      const auditCtx = {
        unitId: meta.unitId || '',
        ym: meta.ym || '',
        amount: ((inv.total || 0) / 100),
        before: { status, amountPaid: ((inv.amount_paid || 0) / 100) },
      };

      if (status === 'paid') {
        throw new HttpsError('failed-precondition',
          'Paid invoices cannot be deleted — use the Refund flow instead.');
      }
      if (status === 'void') {
        // Idempotent: repeated calls after a void are fine, just tell caller.
        return {invoiceId, action: 'noop', status: 'void'};
      }
      if (status === 'draft') {
        const del = await stripe.invoices.del(invoiceId);
        logger.info(`[voidOrDelete] ${invoiceId} deleted (was draft)`);
        await writeAudit('deleted', {
          ...auditCtx,
          after: { status: 'deleted' },
          note: `Deleted draft invoice ${invoiceId} for Suite ${meta.unitId || '?'}` + (meta.ym ? ` · ${meta.ym}` : ''),
        });
        return {invoiceId, action: 'deleted', status: del.deleted ? 'deleted' : 'draft'};
      }
      // open / past_due / uncollectible → void
      const voided = await stripe.invoices.voidInvoice(invoiceId);
      logger.info(`[voidOrDelete] ${invoiceId} voided (was ${status})`);
      await writeAudit('voided', {
        ...auditCtx,
        after: { status: voided.status || 'void' },
        note: `Voided ${status} invoice ${invoiceId} for Suite ${meta.unitId || '?'}` + (meta.ym ? ` · ${meta.ym}` : ''),
      });
      return {invoiceId, action: 'voided', status: voided.status};
    } catch (err) {
      if (err.httpErrorCode) throw err;
      logger.error('[voidOrDelete] failed:', err.message, err.stack);
      // Audit the failure too — operator clicked Void, we couldn't, that
      // matters for forensic investigation.
      await writeAudit('void-failed', { note: 'Failure: ' + err.message });
      throw new HttpsError('internal', `Void/Delete failed: ${err.message || err}`);
    }
  }
);

// =========================================================================
// ===== Stripe — Bulk auto-connect customers =============================
// Walks every occupied unit that has an email, tries to find a matching
// Stripe Customer by email, and links it. One button in the UI adopts all
// the Xero-synced / manually-created customers across the whole portfolio.
//
// Two-pass:
//   1. Page through Stripe customers once, index by email (cheap)
//   2. For each occupied unit with email, match against index
// This avoids N separate search calls — one Stripe RPC per ~100 customers.
// =========================================================================
exports.bulkConnectStripeCustomers = onCall(
  {secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 300, memory: '1GiB'},
  async (req) => { try {
    try {
      await requireEditor(req.auth);
    } catch (err) {
      logger.error('[bulkConnect] auth failed:', err.message);
      throw err;
    }
    const stripe = getStripe();
    let state;
    try {
      state = await readWorkspaceState();
      logger.info(`[bulkConnect] state loaded — ${(state.buildings || []).length} buildings`);
    } catch (err) {
      logger.error('[bulkConnect] state read failed:', err.message);
      throw new HttpsError('internal', `Failed to read workspace state: ${err.message}`);
    }

    // 1) Index all Stripe customers by lowercase email. FULL pagination
    // (no 30-page cap that previously truncated workspaces with > 3,000
    // customers — those tenants would silently appear as "noMatch" even
    // though their Stripe customers DID exist further in the list).
    // Soft cap at 100,000 to prevent a runaway against a corrupt
    // pagination response (defense-in-depth).
    const byEmail = new Map();   // email -> customer
    let cursor = null, pulled = 0;
    const HARD_CAP = 100000;
    const startTime = Date.now();
    const TIME_BUDGET_MS = 270 * 1000;   // leave 30s headroom in 300s timeout
    try {
      while (true) {
        const args = {limit: 100};
        if (cursor) args.starting_after = cursor;
        const res = await stripe.customers.list(args);
        for (const c of res.data) {
          pulled++;
          if (c.deleted || !c.email) continue;
          const k = c.email.toLowerCase();
          const existing = byEmail.get(k);
          if (!existing || c.metadata?.workspaceId === WORKSPACE_ID) byEmail.set(k, c);
        }
        if (!res.has_more) break;
        cursor = res.data[res.data.length - 1]?.id;
        if (!cursor) break;
        if (pulled >= HARD_CAP) {
          logger.warn(`[bulkConnect] reached HARD_CAP of ${HARD_CAP} customers — bailing`);
          break;
        }
        if (Date.now() - startTime > TIME_BUDGET_MS) {
          logger.warn(`[bulkConnect] time budget exceeded after ${pulled} customers — bailing (rerun to continue)`);
          break;
        }
      }
      logger.info(`[bulkConnect] pulled ${pulled} Stripe customers, ${byEmail.size} unique emails`);
    } catch (err) {
      logger.error('[bulkConnect] Stripe customers.list failed:', err.message);
      throw new HttpsError('internal', `Stripe list failed: ${err.message}`);
    }

    // 2) Walk occupied units with email, match them
    const newlyLinked = []; // {unitId, customerId, email, adopted}
    const alreadyLinked = [];
    const missingEmail = [];
    const noMatch = [];

    const toTag = []; // customers we need to update with workspace tag
    const stateMirrorUpdates = {};   // emailLower -> {customerId, name}

    for (const b of state.buildings || []) {
      for (const f of b.floors || []) {
        for (const u of f.units || []) {
          if (u.deletedAt) continue; // soft-deleted (archived) unit
          // Only skip units that are explicitly non-rentable OR are clearly
          // shared infrastructure (stairs, elevators, restrooms, mechanical).
          // We used to require type === 'office' which incorrectly skipped
          // legitimate tenants like salons/retail marked with a custom type.
          if (u.rentable === false) continue;
          const NON_RENTABLE_TYPES = new Set(['stairs','elevator','toilet','mechanical','atrium']);
          if (u.type && NON_RENTABLE_TYPES.has(u.type)) continue;
          if (u.status !== 'occupied') continue;
          const email = u.email ? u.email.toLowerCase() : '';
          const name = u.tenant || u.company || 'Tenant';
          if (!email) { missingEmail.push({unitId: u.id}); continue; }
          if (u.stripe?.customerId) {
            alreadyLinked.push({unitId: u.id, customerId: u.stripe.customerId});
            // Still mirror into state.stripeCustomers for consistency
            stateMirrorUpdates[email] = {customerId: u.stripe.customerId, name};
            continue;
          }
          const match = byEmail.get(email);
          if (!match) { noMatch.push({unitId: u.id, email, name}); continue; }
          newlyLinked.push({
            unitId: u.id, buildingId: b.id, floorId: f.id,
            customerId: match.id, email, name,
            adopted: match.metadata?.workspaceId !== WORKSPACE_ID,
          });
          if (match.metadata?.workspaceId !== WORKSPACE_ID) {
            toTag.push({id: match.id, unitId: u.id, buildingId: b.id, existingMeta: match.metadata || {}});
          }
          stateMirrorUpdates[email] = {customerId: match.id, name};
        }
      }
    }

    // 3) Tag adopted customers so future searches are O(1).  Cap concurrency
    //    to 5 so we don't hammer the Stripe rate limiter. Errors are
    //    swallowed per-customer — tagging is best-effort.
    let tagged = 0, tagFailed = 0;
    for (let i = 0; i < toTag.length; i += 5) {
      const batch = toTag.slice(i, i + 5);
      await Promise.all(batch.map(async (t) => {
        try {
          await stripe.customers.update(t.id, {
            metadata: {
              ...t.existingMeta,
              workspaceId: WORKSPACE_ID,
              unitId: t.unitId || t.existingMeta.unitId || '',
              buildingId: t.buildingId || t.existingMeta.buildingId || '',
              source: t.existingMeta.source || 'suitesforall-adopted',
            },
          });
          tagged++;
        } catch (err) {
          tagFailed++;
          logger.warn(`[bulkConnect] tag failed for ${t.id}: ${err.message}`);
        }
      }));
    }
    logger.info(`[bulkConnect] tagged ${tagged}/${toTag.length} adopted customers (${tagFailed} failed)`);

    // 4) Mirror all the links back into our state — the mapping +
    //    u.stripe.customerId per unit — in one transaction.
    try {
      if (newlyLinked.length || Object.keys(stateMirrorUpdates).length) {
        await mutateWorkspaceState((s) => {
          s.stripeCustomers = s.stripeCustomers || {};
          for (const [email, info] of Object.entries(stateMirrorUpdates)) {
            s.stripeCustomers[email] = {
              customerId: info.customerId,
              name: info.name,
              updatedAt: new Date().toISOString(),
            };
          }
          for (const link of newlyLinked) {
            const f = findUnit(s, {buildingId: link.buildingId, floorId: link.floorId, unitId: link.unitId});
            if (!f) continue;
            f.unit.stripe = f.unit.stripe || {};
            f.unit.stripe.customerId = link.customerId;
          }
        });
      }
    } catch (err) {
      logger.error('[bulkConnect] state write failed:', err.message, err.stack);
      throw new HttpsError('internal', `Failed to persist links: ${err.message}`);
    }

    logger.info(`[bulkConnect] done — newly=${newlyLinked.length} already=${alreadyLinked.length} noMatch=${noMatch.length} missingEmail=${missingEmail.length}`);
    return {
      stripeCustomersPulled: pulled,
      newlyLinked: newlyLinked.length,
      alreadyLinked: alreadyLinked.length,
      missingEmail: missingEmail.length,
      noMatch: noMatch.length,
      newlyLinkedRows: newlyLinked,
      noMatchRows: noMatch,
      missingEmailRows: missingEmail,
    };
  } catch (err) {
    // Catch-all: anything unhandled (e.g. a typo, unexpected shape) gets
    // surfaced with its real message instead of the generic "INTERNAL".
    if (err.httpErrorCode) throw err;  // Already an HttpsError — preserve code
    logger.error('[bulkConnect] uncaught error:', err.message, err.stack);
    throw new HttpsError('internal', `Bulk connect failed: ${err.message || err}`);
  } }
);

// =========================================================================
// ===== Stripe — Reconcile existing invoices with units ==================
// Walks all Stripe invoices in the last N days and tries to match each
// one to a unit in state. Match order (strongest signal first):
//   1. invoice.metadata.unitId + buildingId + floorId (our own)
//   2. invoice.metadata.suite  + customer email → find unit by id+email
//   3. customer.email match in state.stripeCustomers[email]
//   4. customer.email + suite# regex in description
// For each paid invoice that matched and isn't already paid in our state,
// set u.payments[ym] = paid with Stripe reference. Returns a report.
// =========================================================================
exports.reconcileStripeInvoices = onCall(
  {secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 300, memory: '1GiB'},
  async (req) => { try {
    try {
      await requireEditor(req.auth);
    } catch (err) {
      logger.error('[reconcile] auth failed:', err.message);
      throw err;
    }
    const {sinceDays, apply} = req.data || {};
    const stripe = getStripe();
    let state;
    try {
      state = await readWorkspaceState();
      logger.info(`[reconcile] state loaded — ${(state.buildings || []).length} buildings, sinceDays=${sinceDays||180}, apply=${!!apply}`);
    } catch (err) {
      logger.error('[reconcile] state read failed:', err.message);
      throw new HttpsError('internal', `Failed to read workspace state: ${err.message}`);
    }

    // Index our units by several keys so we can look them up quickly.
    const byEmailLower = new Map();   // emailLower -> [{b,f,u}]
    const bySuiteId    = new Map();   // suiteId uppercase -> [{b,f,u}]
    for (const b of state.buildings || []) {
      for (const f of b.floors || []) {
        for (const u of f.units || []) {
          if (u.rentable === false) continue;
          if (u.deletedAt) continue;
          const record = {b, f, u};
          if (u.email) {
            const k = String(u.email).toLowerCase();
            (byEmailLower.get(k) || byEmailLower.set(k, []).get(k)).push(record);
          }
          if (u.id) {
            const k = String(u.id).toUpperCase();
            (bySuiteId.get(k) || bySuiteId.set(k, []).get(k)).push(record);
          }
        }
      }
    }

    const cutoffSec = Math.floor((Date.now() - (Number(sinceDays) || 180) * 86400000) / 1000);
    const matched  = [];   // {invoiceId, unitId, buildingId, floorId, ym, status, via}
    const unmatched = [];  // {invoiceId, customer, description, total}
    let cursor = null, processed = 0;
    const startTimeMs = Date.now();
    const TIME_BUDGET_MS = 270 * 1000;   // leave 30s headroom in 300s timeout
    const HARD_CAP_INVOICES = 50000;

    // FULL pagination using Stripe's `created[gte]` server-side filter
    // — invoices older than the cutoff are NEVER fetched, so we don't
    // burn pages on irrelevant history. Replaces the previous 10-page
    // (1000 invoice) cap that could miss legitimate matches when an
    // older invoice slipped past in created order.
    try {
    while (true) {
      const args = {
        limit: 100,
        expand: ['data.customer'],
        created: { gte: cutoffSec },
      };
      if (cursor) args.starting_after = cursor;
      const res = await stripe.invoices.list(args);
      for (const inv of res.data) {
        processed++;

        // Attempt match — most specific signal first.
        const md = inv.metadata || {};
        let match = null, via = null;

        if (md.unitId && md.buildingId && md.floorId) {
          const f = findUnit(state, {buildingId: md.buildingId, floorId: md.floorId, unitId: md.unitId});
          if (f) { match = f; via = 'metadata'; }
        }
        const cust = (typeof inv.customer === 'object') ? inv.customer : null;
        const custEmail = cust?.email || inv.customer_email || '';
        const emailLower = custEmail ? custEmail.toLowerCase() : '';

        if (!match && md.suite) {
          const candidates = bySuiteId.get(String(md.suite).toUpperCase()) || [];
          if (candidates.length === 1)            { match = candidates[0]; via = 'metadata-suite'; }
          else if (candidates.length > 1 && emailLower) {
            match = candidates.find(x => String(x.u.email||'').toLowerCase() === emailLower);
            if (match) via = 'metadata-suite+email';
          }
        }

        if (!match && emailLower) {
          const candidates = byEmailLower.get(emailLower) || [];
          if (candidates.length === 1) { match = candidates[0]; via = 'email'; }
          else if (candidates.length > 1) {
            // Ambiguous — try to break tie by parsing "Suite X" out of desc
            const desc = (inv.description || '') + ' ' + (inv.lines?.data?.[0]?.description || '');
            const suiteMatch = /suite\s*([a-z0-9]+)/i.exec(desc);
            if (suiteMatch) {
              const sUp = suiteMatch[1].toUpperCase();
              match = candidates.find(x => String(x.u.id).toUpperCase() === sUp);
              if (match) via = 'email+desc';
            }
          }
        }

        if (!match) {
          // Parse "Suite X" out of description alone as last resort
          const desc = (inv.description || '') + ' ' + (inv.lines?.data?.[0]?.description || '');
          const suiteMatch = /suite\s*([a-z0-9]+)/i.exec(desc);
          if (suiteMatch) {
            const cands = bySuiteId.get(suiteMatch[1].toUpperCase()) || [];
            if (cands.length === 1) { match = cands[0]; via = 'desc-regex'; }
          }
        }

        if (!match) {
          unmatched.push({
            invoiceId: inv.id,
            customer: cust?.name || custEmail || 'Unknown',
            customerEmail: custEmail,
            description: inv.description || '',
            status: inv.status,
            total: (inv.total || 0) / 100,
            created: inv.created * 1000,
          });
          continue;
        }

        // Derive the target month (ym). Prefer metadata, then invoice period,
        // then invoice creation month.
        let ym = md.billingMonth || md.ym;
        if (!ym && inv.period_start) {
          const d = new Date(inv.period_start * 1000);
          ym = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        }
        if (!ym) {
          const d = new Date(inv.created * 1000);
          ym = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        }

        matched.push({
          invoiceId: inv.id,
          invoiceNumber: inv.number || inv.id,
          buildingId: match.b.id, floorId: match.f.id, unitId: match.u.id,
          tenantName: match.u.tenant || match.u.company || '',
          ym,
          status: inv.status,
          total: (inv.total || 0) / 100,
          amountPaid: (inv.amount_paid || 0) / 100,
          paidAt: inv.status_transitions?.paid_at ? inv.status_transitions.paid_at * 1000 : null,
          chargeId: inv.charge || null,
          hostedUrl: inv.hosted_invoice_url || null,
          via,
          alreadyTracked: !!(match.u.payments?.[ym]?.status === 'paid' && match.u.payments[ym]?.stripe?.invoiceId === inv.id),
        });
      }
      // Safe pagination + budget guards. With the server-side
      // `created[gte]` filter we no longer need the per-row cutoff
      // check — Stripe never returns older invoices.
      const lastInv = res.data[res.data.length - 1];
      cursor = (res.has_more && lastInv?.id) ? lastInv.id : null;
      if (!cursor) break;
      if (processed >= HARD_CAP_INVOICES) {
        logger.warn(`[reconcile] reached HARD_CAP of ${HARD_CAP_INVOICES} — bailing`);
        break;
      }
      if (Date.now() - startTimeMs > TIME_BUDGET_MS) {
        logger.warn(`[reconcile] time budget exceeded after ${processed} invoices — bailing (rerun for remainder)`);
        break;
      }
    }
    } catch (err) {
      logger.error('[reconcile] Stripe list failed:', err.message, err.stack);
      throw new HttpsError('internal', `Stripe list failed: ${err.message}`);
    }
    logger.info(`[reconcile] scanned ${processed} invoices, matched=${matched.length}, unmatched=${unmatched.length}`);

    // Apply mode: actually write the matched paid invoices into state.
    // Only "paid" invoices get written — drafts/open/void are informational.
    let applied = 0;
    if (apply) {
      const toApply = matched.filter(m => m.status === 'paid' && !m.alreadyTracked);
      if (toApply.length) {
        try {
          await mutateWorkspaceState((s) => {
            for (const m of toApply) {
              const f = findUnit(s, {buildingId: m.buildingId, floorId: m.floorId, unitId: m.unitId});
              if (!f) continue;
              f.unit.payments = f.unit.payments || {};
              f.unit.payments[m.ym] = {
                status: 'paid',
                amount: m.amountPaid || m.total,
                date: m.paidAt ? new Date(m.paidAt).toISOString().slice(0, 10) : null,
                stripe: {
                  invoiceId: m.invoiceId,
                  chargeId: m.chargeId,
                  hostedInvoiceUrl: m.hostedUrl,
                  paidAt: m.paidAt,
                  linkedVia: m.via,
                },
              };
              f.unit.stripe = f.unit.stripe || {};
              f.unit.stripe.lastInvoiceId = m.invoiceId;
              f.unit.stripe.lastInvoiceYm = m.ym;
              applied++;
            }
          });
        } catch (err) {
          logger.error('[reconcile] apply write failed:', err.message, err.stack);
          throw new HttpsError('internal', `Failed to persist links: ${err.message}`);
        }
      }
    }

    return {
      processed,
      matched: matched.length,
      unmatched: unmatched.length,
      appliedCount: applied,
      matchedRows: matched,
      unmatchedRows: unmatched,
    };
  } catch (err) {
    if (err.httpErrorCode) throw err;
    logger.error('[reconcile] uncaught error:', err.message, err.stack);
    throw new HttpsError('internal', `Reconcile failed: ${err.message || err}`);
  } }
);

// =========================================================================
// ===== Stripe — Cancel subscription ======================================
// Fires when a unit is archived (soft-deleted). Cancels the monthly auto-pay
// subscription so Stripe doesn't keep charging a tenant that moved out.
// Safe to call if no subscription exists — returns {canceled: false}.
// =========================================================================
exports.cancelStripeSubscription = onCall(
  {secrets: [STRIPE_SECRET_KEY]},
  async (req) => {
    const {buildingId, floorId, unitId} = req.data || {};
    await requireEditor(req.auth);

    if (!buildingId || !floorId || !unitId) {
      throw new HttpsError('invalid-argument',
        'buildingId, floorId, unitId are required');
    }

    const state = await readWorkspaceState();
    const found = findUnit(state, {buildingId, floorId, unitId});
    if (!found) throw new HttpsError('not-found', 'Unit not found');

    const subscriptionId = found.unit.stripe?.subscriptionId;
    if (!subscriptionId) return {canceled: false, reason: 'no-subscription'};

    const stripe = getStripe();
    let canceled = null;
    try {
      canceled = await stripe.subscriptions.cancel(subscriptionId);
    } catch (err) {
      if (err.code === 'resource_missing') {
        logger.info(`[stripe] subscription ${subscriptionId} already gone`);
      } else {
        throw new HttpsError('internal', `Stripe cancel failed: ${err.message}`);
      }
    }

    await mutateWorkspaceState((s) => {
      const f = findUnit(s, {buildingId, floorId, unitId});
      if (!f) return;
      f.unit.stripe = f.unit.stripe || {};
      f.unit.stripe.subscriptionStatus = 'canceled';
      f.unit.stripe.autoPayEnabled = false;
    });

    return {canceled: true, subscriptionId, status: canceled?.status || 'canceled'};
  }
);

// =========================================================================
// ===== Stripe — Webhook handler ==========================================
// Every Stripe event the destination subscribes to lands here. Signature
// is verified against STRIPE_WEBHOOK_SECRET before we trust the payload.
//
// We only mutate state on three outcomes:
//   - invoice.payment_succeeded  → mark u.payments[ym] = 'paid'
//   - invoice.payment_failed     → mark u.payments[ym] = 'late'
//   - customer.subscription.*    → sync u.stripe.subscriptionId / status
// =========================================================================
exports.stripeWebhook = onRequest(
  {secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET]},
  async (req, res) => {
    const stripe = getStripe();
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, getStripeWebhookSecret());
    } catch (err) {
      logger.error('[stripe] webhook signature verify failed:', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    // EVENT-LEVEL IDEMPOTENCY GUARD. Stripe's Smart Retries can deliver
    // the same event up to 3+ times during transient errors. Even though
    // our handlers are mostly idempotent, EACH retry incurs a Firestore
    // transaction + audit write — and webhook handlers that mutate
    // _invoiceBus would race-thrash the broadcast field on duplicate
    // delivery. Track seen event ids in a small TTL collection.
    //
    // Implementation: best-effort write with `failurePolicy=continue`
    // semantics — if the dedupe write itself fails (e.g., transient
    // Firestore unavailable), we still proceed with the handler rather
    // than skip the event entirely. False-positive duplicate is far
    // worse than processing twice.
    const seenEventRef = db.doc(`workspaces/${WORKSPACE_ID}/webhookEvents/${event.id}`);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(seenEventRef);
        if (snap.exists) {
          throw new Error('[duplicate-event]');
        }
        tx.set(seenEventRef, {
          eventType: event.type,
          firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
          // Auto-cleanup hint — Firestore TTL field. Configure TTL on
          // `webhookEvents._ttl` in Firebase console for free pruning.
          _ttl: admin.firestore.Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
      });
    } catch (dupErr) {
      if (/duplicate-event/.test(dupErr.message)) {
        logger.info(`[stripe] event ${event.id} (${event.type}) already processed — skipping`);
        res.json({received: true, duplicate: true});
        return;
      }
      // Other transaction errors — log and proceed (continue-on-error).
      logger.warn(`[stripe] event-dedupe write failed for ${event.id}: ${dupErr.message} — proceeding`);
    }

    try {
      switch (event.type) {
        case 'invoice.payment_succeeded':
          await handleInvoicePaid(event.data.object);
          break;
        case 'invoice.payment_failed':
          await handleInvoiceFailed(event.data.object);
          break;
        case 'invoice.voided':
        case 'invoice.marked_uncollectible':
          // An invoice that was voided in Stripe Dashboard (or via our
          // own voidOrDeleteStripeInvoice CF) needs to flip the matrix
          // off "open" for that month. Otherwise the operator UI keeps
          // showing it as outstanding and nags reminders forever.
          await handleInvoiceVoided(event.data.object, event.type);
          break;
        case 'charge.refunded':
          await handleChargeRefunded(event.data.object);
          break;
        case 'charge.dispute.created':
          await handleChargeDisputed(event.data.object);
          break;
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          await handleSubscriptionUpdate(event.data.object);
          break;
        case 'customer.subscription.deleted':
          await handleSubscriptionDelete(event.data.object);
          break;
        case 'customer.deleted':
          await handleCustomerDeleted(event.data.object);
          break;
        default:
          logger.info(`[stripe] ignored event type ${event.type}`);
      }
      res.json({received: true});
    } catch (err) {
      logger.error(`[stripe] ${event.type} handler failed:`, err);
      // Distinguish PERMANENT errors from TRANSIENT ones to avoid the
      // 72-hour Stripe retry storm on bugs that will never succeed
      // (e.g., findUnit returns null because the workspace was wiped).
      // Permanent indicators: HttpsError 'not-found' / 'invalid-argument'
      // / 'failed-precondition' / 'permission-denied' or our own thrown
      // errors with a "[permanent]" tag. Returning 200 tells Stripe the
      // event was received and shouldn't be retried — it's then up to
      // operators to investigate via the audit/log entry below.
      const permanentCodes = ['not-found', 'invalid-argument', 'failed-precondition', 'permission-denied'];
      const isPermanent = err && (
        permanentCodes.includes(err.code) ||
        permanentCodes.includes(err.details?.code) ||
        /\[permanent\]/.test(err.message || '')
      );
      if (isPermanent) {
        // Log loud + audit so the failure is visible without Stripe
        // hammering us for 3 days.
        logger.error(`[stripe] PERMANENT failure on ${event.type} ${event.id} — returning 200 to suppress retries: ${err.message}`);
        try {
          await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
            ts: admin.firestore.FieldValue.serverTimestamp(),
            actor: 'stripe-webhook',
            action: 'webhook.permanent-failure',
            source: 'stripeWebhook',
            note: `${event.type} ${event.id}: ${err.message}`.slice(0, 500),
          });
        } catch {}
        res.status(200).json({received: true, permanentFailure: true});
        return;
      }
      // Transient: 500 triggers Stripe retry (Smart Retries: 4 attempts
      // over 3 weeks). Our handlers are idempotent, so retry is safe.
      res.status(500).send(`Handler error: ${err.message}`);
    }
  }
);

// Handle invoice.voided + invoice.marked_uncollectible. Flip any
// payment row that referenced this invoice to a non-paid state, clear
// the deposit/move-in stamp if it pointed at this invoice, and
// broadcast _invoiceBus so clients refresh the row immediately.
async function handleInvoiceVoided(invoice, eventType) {
  const meta = invoice.metadata || {};
  if (meta.source !== 'suitesforall' && meta.source !== 'auto') {
    logger.info(`[stripe] ${eventType} ${invoice.id} not ours; ignored`);
    return;
  }
  const {buildingId, floorId, unitId, ym, purpose} = meta;
  if (!buildingId || !floorId || !unitId) {
    logger.warn(`[stripe] ${eventType} ${invoice.id} missing metadata`);
    return;
  }
  const newStatus = eventType === 'invoice.marked_uncollectible' ? 'uncollectible' : 'void';
  await mutateWorkspaceState((s) => {
    const f = findUnit(s, {buildingId, floorId, unitId});
    if (!f) return;
    const u = f.unit;
    u.stripe = u.stripe || {};
    // Clear deposit stamp if this invoice was the deposit.
    if (u.stripe.depositInvoice?.invoiceId === invoice.id) {
      u.stripe.depositInvoice.status = newStatus;
    }
    if (u.stripe.moveInRent?.invoiceId === invoice.id) {
      u.stripe.moveInRent.status = newStatus;
    }
    // CRITICAL: clear the "last invoice for this cycle" stamps if they
    // pointed at THIS now-voided invoice. Without this, both the
    // catch-up trigger (_triggerAutoInvoiceNowIfNeeded on the client)
    // and the daily cron (runAutoInvoices) will skip the unit forever
    // — they short-circuit on `lastInvoiceYm === ym` regardless of
    // whether that invoice is still alive. Operator's mental model:
    // "I voided May rent and turned AUTO on, system should re-issue
    // May." This block makes that work.
    if (u.stripe.lastInvoiceId === invoice.id) {
      delete u.stripe.lastInvoiceId;
      delete u.stripe.lastInvoiceYm;
    }
    if (u.stripe.autoSentYm && ym && u.stripe.autoSentYm === ym) {
      // The cron stamp also gates against re-fire for the same cycle.
      // Clear when the voided invoice is the one that earned the stamp.
      // No invoice-id field on autoSentYm so we conservatively check
      // against the invoice's own ym from metadata.
      delete u.stripe.autoSentYm;
    }
    // For rent invoices: if the matrix had this exact invoice as paid,
    // it's no longer paid. Revert to a neutral 'pending' (NOT 'late' —
    // lateness is a function of due date and grace, recomputed by
    // _computeUnitMoney). Preserves any prior history[] so the
    // forensic trail is intact.
    if (purpose === 'rent' && ym) {
      u.payments = u.payments || {};
      const cur = u.payments[ym];
      if (cur && cur.stripe?.invoiceId === invoice.id) {
        const history = Array.isArray(cur.history) ? cur.history.slice() : [];
        history.push({
          ts: new Date().toISOString(),
          status: cur.status,
          amount: cur.amount || 0,
          invoiceId: invoice.id,
          replacedReason: 'invoice-' + newStatus,
        });
        while (history.length > 10) history.shift();
        u.payments[ym] = {
          status: 'pending',
          amount: 0,
          ...(cur.paidVia ? { paidVia: cur.paidVia, paidBy: cur.paidBy, memo: cur.memo } : {}),
          history,
        };
      }
    }
    s._invoiceBus = {
      invoiceId: invoice.id,
      status: newStatus,
      ym: ym || null,
      purpose: purpose || 'custom',
      unitId, buildingId, floorId,
      at: Date.now(),
    };
  });
  logger.info(`[stripe] invoice ${invoice.id} marked ${newStatus} for ${unitId}/${ym || '-'}`);
}

// Handle charge.refunded. Refunds are a separate event from invoice
// status changes — Stripe doesn't void the invoice, just records the
// refund. We add a history entry so the operator can see "this paid
// invoice was later refunded" without digging through Stripe Dashboard.
async function handleChargeRefunded(charge) {
  const invoiceId = charge.invoice;
  if (!invoiceId) return;
  const stripe = getStripe();
  let inv;
  try { inv = await stripe.invoices.retrieve(invoiceId); }
  catch (e) { logger.warn(`[stripe] charge.refunded: cannot fetch invoice ${invoiceId}: ${e.message}`); return; }
  const meta = inv.metadata || {};
  if (meta.source !== 'suitesforall' && meta.source !== 'auto') return;
  const {buildingId, floorId, unitId, ym, purpose} = meta;
  if (!buildingId || !floorId || !unitId) return;
  const refundedAmt = (charge.amount_refunded || 0) / 100;
  const totalAmt = (charge.amount || 0) / 100;
  const fullyRefunded = refundedAmt >= totalAmt - 0.01;
  await mutateWorkspaceState((s) => {
    const f = findUnit(s, {buildingId, floorId, unitId});
    if (!f) return;
    const u = f.unit;
    u.payments = u.payments || {};
    if (purpose === 'rent' && ym && u.payments[ym]) {
      const cur = u.payments[ym];
      const history = Array.isArray(cur.history) ? cur.history.slice() : [];
      history.push({
        ts: new Date().toISOString(),
        status: cur.status,
        amount: cur.amount || 0,
        invoiceId,
        chargeId: charge.id,
        refundedAmount: refundedAmt,
        replacedReason: fullyRefunded ? 'charge-refunded-full' : 'charge-refunded-partial',
      });
      while (history.length > 10) history.shift();
      u.payments[ym] = fullyRefunded
        ? { status: 'refunded', amount: 0, history, refundedAt: new Date().toISOString() }
        : { ...cur, status: 'partial', amount: Math.max(0, (cur.amount || 0) - refundedAmt), history };
    }
    s._invoiceBus = {
      invoiceId, status: fullyRefunded ? 'refunded' : 'partial-refund',
      ym: ym || null, purpose: purpose || 'custom',
      unitId, buildingId, floorId,
      amountPaid: Math.max(0, totalAmt - refundedAmt),
      at: Date.now(),
    };
  });
  logger.info(`[stripe] charge ${charge.id} refunded $${refundedAmt} for invoice ${invoiceId}`);
}

// Handle charge.dispute.created. Disputes are a HOT operator alert —
// money may be clawed back. We don't change payment status (Stripe
// will fire follow-up events when the dispute resolves), but we log
// a high-priority audit entry so the operator sees it immediately
// in the audit feed.
async function handleChargeDisputed(charge) {
  const invoiceId = charge.invoice;
  let unitMeta = null;
  if (invoiceId) {
    try {
      const stripe = getStripe();
      const inv = await stripe.invoices.retrieve(invoiceId);
      unitMeta = inv.metadata || {};
    } catch (e) {
      logger.warn(`[stripe] dispute: cannot fetch invoice ${invoiceId}: ${e.message}`);
    }
  }
  try {
    await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
      ts: admin.firestore.FieldValue.serverTimestamp(),
      actor: 'stripe-webhook',
      action: 'charge.disputed',
      source: 'stripeWebhook',
      invoiceId: invoiceId || '',
      unitId: unitMeta?.unitId || '',
      ym: unitMeta?.ym || '',
      amount: ((charge.amount || 0) / 100),
      note: `DISPUTE OPENED: charge ${charge.id} — reason: ${charge.dispute?.reason || 'unknown'}. Funds may be reversed. Respond in Stripe Dashboard within 7 days.`,
    });
  } catch {}
  logger.error(`[stripe] DISPUTE OPENED: charge ${charge.id}, invoice ${invoiceId}, reason ${charge.dispute?.reason || 'unknown'}`);
}

// ---- Webhook handlers ---------------------------------------------------

async function handleInvoicePaid(invoice) {
  const meta = invoice.metadata || {};
  if (meta.source !== 'suitesforall' && meta.source !== 'auto') {
    logger.info(`[stripe] invoice ${invoice.id} not ours (source="${meta.source}"); ignored`);
    return;
  }
  const {buildingId, floorId, unitId, ym, purpose} = meta;
  if (!buildingId || !floorId || !unitId) {
    logger.warn(`[stripe] invoice ${invoice.id} missing metadata; cannot route`);
    return;
  }
  // CUSTOMER VERIFICATION — defense against payment hijack via crafted
  // metadata. Anyone with Stripe Dashboard access (or a leaked API key)
  // could create an invoice tagged source='suitesforall' + unitId='426'
  // and pay it from any random customer to mark our Suite 426 paid.
  // Verify the invoice's customer is one we actually know — either
  // tagged with this workspace's metadata, or already linked to the
  // unit's stripe.customerId in state.
  try {
    const customerId = typeof invoice.customer === 'string'
      ? invoice.customer
      : invoice.customer?.id;
    if (!customerId) {
      logger.warn(`[stripe] invoice ${invoice.id} has no customer; refusing to route`);
      return;
    }
    const state = await readWorkspaceState();
    const found = findUnit(state, {buildingId, floorId, unitId});
    const unitCustomerId = found?.unit?.stripe?.customerId || null;
    let trusted = false;
    if (unitCustomerId && unitCustomerId === customerId) {
      // Customer already linked to THIS unit — trusted.
      trusted = true;
    } else if (state.stripeCustomers) {
      // Customer appears in our workspace mapping — trusted.
      for (const k of Object.keys(state.stripeCustomers)) {
        if (state.stripeCustomers[k]?.customerId === customerId) {
          trusted = true;
          break;
        }
      }
    }
    if (!trusted) {
      // Last chance: fetch the customer and check workspace metadata.
      try {
        const stripe = getStripe();
        const cust = await stripe.customers.retrieve(customerId);
        if (cust && !cust.deleted && cust.metadata?.workspaceId === WORKSPACE_ID) {
          trusted = true;
        }
      } catch (custErr) {
        logger.warn(`[stripe] customer fetch failed for ${customerId}: ${custErr.message}`);
      }
    }
    if (!trusted) {
      logger.error(`[stripe] REJECTED invoice ${invoice.id} for ${unitId}/${ym}: customer ${customerId} not in workspace state or tagged metadata. Possible payment hijack attempt — investigate Stripe Dashboard for unauthorized invoice creation.`);
      return;
    }
  } catch (verifyErr) {
    logger.error(`[stripe] customer verification failed for invoice ${invoice.id}: ${verifyErr.message}`);
    // Fail closed — refuse to apply if we can't verify.
    return;
  }

  // Non-rent invoices — for deposit, flip the stamp status + release
  // any stale send-lock so the Move-in card shows ✓ Paid instead of
  // ✉ Sent. For other custom charges (late fees, keys) we still just
  // log, since there's no per-month matrix to update.
  if (purpose && purpose !== 'rent') {
    await mutateWorkspaceState((s) => {
      const f = findUnit(s, {buildingId, floorId, unitId});
      if (!f) return;
      const u = f.unit;
      u.stripe = u.stripe || {};
      // Match deposit by invoice id OR by /deposit/ in description
      // (handles invoices created via the Stripe dashboard without
      // our metadata.purpose='deposit' tag).
      const isDepositByStamp = u.stripe.depositInvoice?.invoiceId === invoice.id;
      const isDepositByDesc = /\bdeposit\b/i.test(invoice.description || '');
      if (isDepositByStamp || isDepositByDesc) {
        u.stripe.depositInvoice = {
          ...(u.stripe.depositInvoice || {}),
          invoiceId: invoice.id,
          amount: (invoice.amount_paid || invoice.total || 0) / 100,
          status: 'paid',
          paidAt: (invoice.status_transitions?.paid_at || Math.floor(Date.now() / 1000)) * 1000,
        };
        delete u.stripe._sendingDepositAt;
      }
      // Broadcast signal for non-rent invoices too, so the Invoices page
      // and right-panel history flip the row to "paid" without a refresh.
      s._invoiceBus = {
        invoiceId: invoice.id,
        status: 'paid',
        ym: ym || null,
        purpose: purpose || 'custom',
        unitId, buildingId, floorId,
        amountPaid: (invoice.amount_paid || invoice.total || 0) / 100,
        amountRemaining: 0,
        at: Date.now(),
      };
    });
    logger.info(`[stripe] non-rent invoice ${invoice.id} paid (purpose=${purpose}); stamp updated for ${unitId}`);
    return;
  }
  if (!ym) {
    logger.warn(`[stripe] rent invoice ${invoice.id} missing ym; cannot apply to matrix`);
    return;
  }
  // Paid amount in cents → dollars. Use amount_paid not total because of discounts.
  const amount = (invoice.amount_paid || invoice.total || 0) / 100;
  const chargeId = invoice.charge || null;
  const paidAt = (invoice.status_transitions?.paid_at || Math.floor(Date.now() / 1000)) * 1000;
  const paymentMethod = await inferPaymentMethod(invoice);

  await mutateWorkspaceState((s) => {
    const f = findUnit(s, {buildingId, floorId, unitId});
    if (!f) {
      logger.warn(`[stripe] invoice ${invoice.id}: unit ${unitId} not found`);
      return;
    }
    f.unit.payments = f.unit.payments || {};
    const prior = f.unit.payments[ym] || {};
    if (prior.status === 'paid' && prior.stripe?.invoiceId === invoice.id) {
      logger.info(`[stripe] invoice ${invoice.id} already applied to ${unitId}/${ym}`);
      return;
    }
    // PRESERVE PRIOR PAYMENT — if a prior record exists (manual payment,
    // earlier invoice for the same month, waiver), don't blow it away.
    // Stash it into a per-month history array so the operator can see
    // the full sequence later, and keep the original paidVia/paidBy/
    // receiptUrl/memo intact at the top level when we already had a
    // manual entry. Without this, a webhook for a NEW invoice in the
    // same month silently overwrote prior manual records — operators
    // lost paper trails for cash/check payments they'd recorded.
    const priorHistory = Array.isArray(prior.history) ? prior.history.slice() : [];
    if (prior.status && (prior.amount > 0 || prior.paidVia || prior.stripe?.invoiceId)) {
      priorHistory.push({
        ts: new Date().toISOString(),
        status: prior.status,
        amount: prior.amount || 0,
        paidVia: prior.paidVia || prior.paidMethod || null,
        paidBy: prior.paidBy || null,
        invoiceId: prior.stripe?.invoiceId || null,
        receiptUrl: prior.receiptUrl || null,
        memo: prior.memo || null,
        replacedBy: invoice.id,
        replacedReason: 'webhook-paid-replaces-prior',
      });
    }
    // Cap history at 10 — any single month with > 10 payment events is
    // an operator workflow problem, not data we need to keep.
    while (priorHistory.length > 10) priorHistory.shift();

    f.unit.payments[ym] = {
      status: 'paid',
      amount,
      date: new Date(paidAt).toISOString().slice(0, 10),
      // Carry forward operator-set fields when the prior was a real
      // payment, so the manual paper trail is not lost on the rendered
      // ledger. The webhook's machine fields go into `stripe` below.
      ...(prior.paidVia ? { paidVia: prior.paidVia } : {}),
      ...(prior.paidBy ? { paidBy: prior.paidBy } : {}),
      ...(prior.memo ? { memo: prior.memo } : {}),
      ...(prior.receiptUrl ? { receiptUrl: prior.receiptUrl, receiptPath: prior.receiptPath } : {}),
      ...(priorHistory.length ? { history: priorHistory } : {}),
      stripe: {
        invoiceId: invoice.id,
        chargeId,
        paymentMethod,
        hostedInvoiceUrl: invoice.hosted_invoice_url || null,
        paidAt,
      },
    };
    f.unit.stripe = f.unit.stripe || {};
    f.unit.stripe.customerId = invoice.customer || f.unit.stripe.customerId;
    f.unit.stripe.lastInvoiceId = invoice.id;
    f.unit.stripe.lastInvoiceYm = ym;
    // Clear any dead send-lock — the invoice is paid, the send clearly
    // finished. Prevents the ⏳ spinner from lingering on paid rows.
    delete f.unit.stripe._sendingRentAt;
    // Clear auto-charge failure flag — this unit just successfully paid,
    // so whatever failed previously has been resolved (card replaced,
    // Smart Retry succeeded, or tenant paid manually).
    delete f.unit.stripe.lastChargeFailure;
    // If this rent invoice is the tracked move-in rent, mark it paid.
    if (f.unit.stripe.moveInRent?.invoiceId === invoice.id) {
      f.unit.stripe.moveInRent.status = 'paid';
    }
    // Broadcast a slim signal so the client's onSnapshot handler can
    // patch the matching row in _invoicesCache in real time (without
    // re-fetching the whole Stripe list). Lives on state root — not
    // copied into fbApplyRemote's key set, but readable from doc.state.
    s._invoiceBus = {
      invoiceId: invoice.id,
      status: 'paid',
      ym: ym || null,
      purpose: purpose || 'rent',
      unitId, buildingId, floorId,
      amountPaid: amount,
      amountRemaining: 0,
      at: Date.now(),
    };
  });
  logger.info(`[stripe] ✓ paid: ${unitId}/${ym} via invoice ${invoice.id} ($${amount})`);
}

async function handleInvoiceFailed(invoice) {
  const meta = invoice.metadata || {};
  if (meta.source !== 'suitesforall') return;
  const {buildingId, floorId, unitId, ym} = meta;
  if (!buildingId || !floorId || !unitId || !ym) return;

  await mutateWorkspaceState((s) => {
    const f = findUnit(s, {buildingId, floorId, unitId});
    if (!f) return;
    f.unit.payments = f.unit.payments || {};
    if (f.unit.payments[ym]?.status === 'paid') return;
    f.unit.payments[ym] = {
      status: 'late',
      amount: (invoice.amount_due || 0) / 100,
      stripe: {
        invoiceId: invoice.id,
        hostedInvoiceUrl: invoice.hosted_invoice_url || null,
        attemptCount: invoice.attempt_count || 1,
        failureCode: invoice.last_finalization_error?.code
          || invoice.last_finalization_error?.type
          || 'charge_failed',
        failureMessage: invoice.last_finalization_error?.message || null,
      },
    };
    // Surface a persistent "auto-charge failed" stamp on the unit itself
    // so the floor map + rent roll can render a red ! badge and
    // dashboards can count failures. Cleared when a subsequent invoice
    // for the same unit is paid (see handleInvoicePaid).
    f.unit.stripe = f.unit.stripe || {};
    f.unit.stripe.lastChargeFailure = {
      invoiceId: invoice.id,
      ym,
      hostedInvoiceUrl: invoice.hosted_invoice_url || null,
      attemptCount: invoice.attempt_count || 1,
      failedAt: new Date().toISOString(),
      amount: (invoice.amount_due || 0) / 100,
      code: invoice.last_finalization_error?.code || 'charge_failed',
    };
    // Broadcast signal so the Invoices page flips row to past_due/failed
    // visual state in real time.
    s._invoiceBus = {
      invoiceId: invoice.id,
      status: 'failed',
      ym: ym || null,
      purpose: meta.purpose || 'rent',
      unitId, buildingId, floorId,
      amountPaid: 0,
      amountRemaining: (invoice.amount_due || 0) / 100,
      attemptCount: invoice.attempt_count || 1,
      code: invoice.last_finalization_error?.code || 'charge_failed',
      at: Date.now(),
    };
  });
  logger.warn(`[stripe] ✗ failed: ${unitId}/${ym} on invoice ${invoice.id} (attempt ${invoice.attempt_count || 1})`);

  // Audit — payment failure is a money operation; operator needs a
  // forensic trail (when did it first fail, how many retries, what
  // failure code) without digging through Cloud Function logs.
  try {
    await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
      ts: admin.firestore.FieldValue.serverTimestamp(),
      actor: 'stripe-webhook',
      action: 'payment.failed',
      source: 'stripeWebhook',
      buildingId, floorId, unitId,
      ym: ym || '',
      invoiceId: invoice.id,
      amount: (invoice.amount_due || 0) / 100,
      note: `Charge failed (attempt ${invoice.attempt_count || 1}): ${
        invoice.last_finalization_error?.code || 'charge_failed'}` +
        (invoice.last_finalization_error?.message ? ' — ' + String(invoice.last_finalization_error.message).slice(0, 200) : ''),
    });
  } catch (auditErr) {
    logger.warn('[stripe] payment.failed audit write failed: ' + auditErr.message);
  }
}

async function handleSubscriptionUpdate(sub) {
  const meta = sub.metadata || {};
  if (meta.source !== 'suitesforall') return;
  const {buildingId, floorId, unitId} = meta;
  if (!buildingId || !floorId || !unitId) return;

  await mutateWorkspaceState((s) => {
    const f = findUnit(s, {buildingId, floorId, unitId});
    if (!f) return;
    f.unit.stripe = f.unit.stripe || {};
    f.unit.stripe.subscriptionId = sub.id;
    f.unit.stripe.subscriptionStatus = sub.status;
    f.unit.stripe.autoPayEnabled = sub.status === 'active' || sub.status === 'trialing';
  });
  logger.info(`[stripe] subscription ${sub.id} for ${unitId} → ${sub.status}`);
}

// Handle customer.deleted — fired when a Stripe customer is deleted
// via Dashboard or API. Walks the workspace state and unlinks any unit
// pointing to this customer (clears u.stripe.customerId and the
// email→customer mapping). Without this handler, units keep stale
// customerIds and subsequent invoice attempts fail silently.
async function handleCustomerDeleted(customer) {
  if (!customer || !customer.id) return;
  const customerId = customer.id;
  const customerEmail = (customer.email || '').toLowerCase();
  await mutateWorkspaceState((s) => {
    let unlinked = 0;
    // Walk every unit looking for the customerId.
    for (const b of (s.buildings || [])) {
      for (const f of (b.floors || [])) {
        for (const u of (f.units || [])) {
          if (u?.stripe?.customerId === customerId) {
            u.stripe.customerId = null;
            u.stripe.customerDeletedAt = new Date().toISOString();
            unlinked++;
          }
        }
      }
    }
    // Drop email → customer mapping.
    if (customerEmail && s.stripeCustomers && s.stripeCustomers[customerEmail]?.customerId === customerId) {
      delete s.stripeCustomers[customerEmail];
    }
    s._customerDeletedSignal = {
      customerId,
      email: customerEmail,
      unitsUnlinked: unlinked,
      at: Date.now(),
    };
  });
  logger.warn(`[stripe] customer ${customerId} (${customerEmail}) deleted in Stripe — workspace state unlinked`);
  // Audit — high-impact (future invoices for this tenant will require
  // creating a new customer). Operator needs to know.
  try {
    await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
      ts: admin.firestore.FieldValue.serverTimestamp(),
      actor: 'stripe-webhook',
      action: 'customer.deleted',
      source: 'stripeWebhook',
      note: `Stripe customer ${customerId} (${customerEmail || 'no-email'}) was deleted. All units pointing to this customer have been unlinked. Future invoices will create a NEW Stripe customer record.`,
    });
  } catch (e) {
    logger.warn('[stripe] customer.deleted audit write failed: ' + e.message);
  }
}

async function handleSubscriptionDelete(sub) {
  const meta = sub.metadata || {};
  if (meta.source !== 'suitesforall') return;
  const {buildingId, floorId, unitId} = meta;
  if (!buildingId || !floorId || !unitId) return;

  await mutateWorkspaceState((s) => {
    const f = findUnit(s, {buildingId, floorId, unitId});
    if (!f) return;
    f.unit.stripe = f.unit.stripe || {};
    f.unit.stripe.subscriptionId = null;
    f.unit.stripe.subscriptionStatus = 'canceled';
    f.unit.stripe.autoPayEnabled = false;
  });
  logger.info(`[stripe] subscription ${sub.id} for ${unitId} canceled`);

  // Audit — subscription cancellation stops future auto-billing for
  // this tenant. Operator needs to know it happened (especially when
  // canceled via Stripe Dashboard, not via our app).
  try {
    await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
      ts: admin.firestore.FieldValue.serverTimestamp(),
      actor: 'stripe-webhook',
      action: 'subscription.canceled',
      source: 'stripeWebhook',
      buildingId, floorId, unitId,
      note: `Subscription ${sub.id} canceled (source: ${sub.cancellation_details?.reason || 'unknown'})${sub.cancellation_details?.comment ? ' — ' + String(sub.cancellation_details.comment).slice(0, 200) : ''}. Future auto-pay invoices will NOT be sent for this unit until a new subscription is created.`,
    });
  } catch (e) {
    logger.warn('[stripe] subscription.canceled audit write failed: ' + e.message);
  }
}

// Best-effort: figure out if a paid invoice used ACH or card. Useful for
// displaying the method on the paid-cell badge.
async function inferPaymentMethod(invoice) {
  try {
    // Webhook payloads from Stripe sometimes already include the
    // expanded charge object (depends on event subscription config).
    // Check first to avoid the extra round-trip — every saved RPC
    // halves webhook handler latency at high volume.
    if (invoice.charge && typeof invoice.charge === 'object'
        && invoice.charge.payment_method_details?.type) {
      return invoice.charge.payment_method_details.type;
    }
    // Same for payment_intent if expanded.
    if (invoice.payment_intent && typeof invoice.payment_intent === 'object'
        && invoice.payment_intent.charges?.data?.[0]?.payment_method_details?.type) {
      return invoice.payment_intent.charges.data[0].payment_method_details.type;
    }
    if (!invoice.charge) return 'unknown';
    // Last-resort: explicit retrieve. Use expand to grab payment_method
    // details in the same call instead of a second separate retrieve.
    const stripe = getStripe();
    const ch = await stripe.charges.retrieve(invoice.charge, {
      expand: ['payment_method'],
    });
    return ch.payment_method_details?.type || 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

// =========================================================================
// ===== Scheduled auto-invoice runner =====================================
// =========================================================================
// Fires daily (UTC midnight). For each occupied unit with auto-invoicing
// enabled, checks if TODAY is the send-day (config.sendDay) and whether
// NEXT MONTH's rent has already been invoiced. If not, creates a Stripe
// invoice via the same helper createStripeInvoice uses.
//
// Safety:
//   - Idempotent: checks u.stripe.autoSentYm so one-per-month is enforced
//   - Skips: no email, no rent, already-paid-next-month, missing customer
//   - Respects per-unit override (u.autoInvoice === 'off' wins over global)
//
// Deploy: `firebase deploy --only functions:runAutoInvoices`
// Verify: `firebase functions:log --only runAutoInvoices`
// =========================================================================
const {onSchedule} = require('firebase-functions/v2/scheduler');

exports.runAutoInvoices = onSchedule(
  {
    schedule: '0 9 * * *',         // 09:00 UTC daily (~5am ET, ~2am PT)
    timeZone: 'UTC',
    secrets: [STRIPE_SECRET_KEY],
    memory: '512MiB',
    timeoutSeconds: 540,           // 9 min — we could have hundreds of units
  },
  async () => {
    const stateRef = db.doc(`workspaces/${WORKSPACE_ID}/data/state`);
    const snap = await stateRef.get();
    if (!snap.exists) { logger.info('[auto-invoice] no state doc, skipping'); return; }
    const state = snap.data().state || {};
    const cfg = (state.settings && state.settings.autoInvoice) || {};
    if (!cfg.enabled) { logger.info('[auto-invoice] workspace disabled, skipping'); return; }

    // CHECKPOINT — track progress in /workspaces/{ws}/cronProgress/auto-invoice
    // so a mid-run timeout (540s cap) doesn't leave half the units invoiced
    // and half not. Each unit gets stamped after success; on next invocation
    // (whether by cron or operator manual rerun via "Run now"), we skip
    // anything stamped within the last 24h.
    const checkpointRef = db.doc(`workspaces/${WORKSPACE_ID}/cronProgress/auto-invoice`);
    let checkpoint;
    try {
      const ckSnap = await checkpointRef.get();
      checkpoint = ckSnap.exists ? (ckSnap.data() || {}) : {};
    } catch (e) {
      checkpoint = {};
    }
    const stampedRecently = new Set(
      Object.entries(checkpoint.processed || {})
        .filter(([, ms]) => Number(ms) > Date.now() - 24 * 60 * 60 * 1000)
        .map(([id]) => id)
    );
    const startTimeMs = Date.now();
    const TIME_BUDGET_MS = 480 * 1000;   // leave 60s headroom in 540s timeout
    const newCheckpoint = Object.assign({}, checkpoint.processed || {});
    let abortedEarly = false;

    // Helper called per-unit. Caller passes `unitKey` (b|f|u format).
    // Returns true if the unit was processed (or skipped intentionally),
    // false if the cron should bail out for time / quota reasons.
    function _shouldProcessUnit(unitKey) {
      if (stampedRecently.has(unitKey)) {
        return 'skip-recent';
      }
      if (Date.now() - startTimeMs > TIME_BUDGET_MS) {
        abortedEarly = true;
        return 'abort-budget';
      }
      return 'process';
    }
    function _markUnitProcessed(unitKey) {
      newCheckpoint[unitKey] = Date.now();
    }
    // Persisted at the very end so a crash mid-run still leaves progress
    // in newCheckpoint that we'll write on next successful completion.
    async function _persistCheckpoint(extra) {
      try {
        await checkpointRef.set(Object.assign({
          processed: newCheckpoint,
          lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
          lastRunAbortedEarly: abortedEarly,
        }, extra || {}));
      } catch (e) {
        logger.warn('[auto-invoice] checkpoint write failed: ' + e.message);
      }
    }
    // Expose helpers to the rest of the function via globals so the
    // existing per-unit loop body (further below) can opt in.
    globalThis.__autoInvShouldProcess = _shouldProcessUnit;
    globalThis.__autoInvMarkProcessed = _markUnitProcessed;
    globalThis.__autoInvPersistCheckpoint = _persistCheckpoint;

    const today = new Date();
    // New config: sendBeforeDays = N days BEFORE the 1st of next month.
    // Computed per-cycle so it handles variable month lengths (28/29/30/31).
    // Legacy fallback: if only sendDay is set, convert (31 - sendDay) to
    // approximate the equivalent "days before 1st". Both coexist until
    // a workspace saves new-style settings.
    let globalBefore;
    if (cfg.sendBeforeDays != null) {
      globalBefore = Math.max(1, Math.min(28, +cfg.sendBeforeDays || 0)) || 10;
    } else if (cfg.sendDay) {
      globalBefore = Math.max(1, Math.min(28, 31 - (+cfg.sendDay || 0))) || 10;
    } else {
      globalBefore = 10;
    }
    const dueDays = Math.max(1, Math.min(30, +cfg.daysUntilDue || 10));

    // Target = 1st of NEXT month in UTC. nextYm is the YYYY-MM key.
    // The "should we fire today?" check moved INTO the per-unit loop
    // below so per-unit autoInvoiceBeforeDays overrides can schedule
    // different units on different days (e.g. building-wide default
    // = 10 days before 1st, but suite 437 is 15 days before).
    //
    // TIMEZONE-AWARE: when state.settings.timeZone is set (e.g.
    // 'America/Los_Angeles'), compute "today" and "1st of next month"
    // in that zone instead of UTC. Otherwise the cron firing at 09:00
    // UTC means owners on PT see invoices generated 1-2 AM local —
    // and the "1st of next month" calculation crosses days at the
    // wrong moment near month boundaries (Sep 1 PT ≠ Sep 1 UTC for
    // the period Aug 31 17:00 PT - Sep 1 00:00 UTC).
    const wsTimeZone = (state.settings && state.settings.timeZone) || 'UTC';
    let nm, nextYm, todayInZone;
    try {
      // Use Intl.DateTimeFormat to extract Y/M/D in the workspace zone.
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: wsTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const parts = fmt.formatToParts(today).reduce((a, p) => {
        if (p.type !== 'literal') a[p.type] = +p.value;
        return a;
      }, {});
      // Build a UTC-anchored Date at the local 1st-of-next-month for
      // arithmetic (subtracting days in ms is simpler this way).
      let nmYear = parts.year, nmMonth = parts.month;  // 1-indexed
      nmMonth += 1;
      if (nmMonth > 12) { nmMonth = 1; nmYear += 1; }
      nm = new Date(Date.UTC(nmYear, nmMonth - 1, 1));
      nextYm = `${nmYear}-${String(nmMonth).padStart(2, '0')}`;
      todayInZone = parts;
      logger.info(`[auto-invoice] timezone=${wsTimeZone} today=${parts.year}-${String(parts.month).padStart(2,'0')}-${String(parts.day).padStart(2,'0')} → nextYm=${nextYm}`);
    } catch (tzErr) {
      // Fall back to UTC on bad timezone string.
      logger.warn(`[auto-invoice] invalid settings.timeZone "${wsTimeZone}", falling back to UTC: ${tzErr.message}`);
      nm = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
      nextYm = `${nm.getUTCFullYear()}-${String(nm.getUTCMonth()+1).padStart(2,'0')}`;
    }

    let sent = 0, skipped = 0, failed = 0;
    const stripe = getStripe();

    for (const b of state.buildings || []) {
      for (const f of b.floors || []) {
        for (const u of f.units || []) {
          if (u.deletedAt) { skipped++; continue; }
          if (u.status !== 'occupied') { skipped++; continue; }
          // Per-unit override beats global
          const explicit = u.autoInvoice;
          if (explicit === 'off') { skipped++; continue; }
          // Inherit path: global enabled (checked above), so 'inherit' = on
          if (!u.tenant && !u.company) { skipped++; continue; }
          if (!u.email || !/@/.test(u.email || '')) { skipped++; continue; }
          const rent = +u.contractRent || +u.rent || 0;
          if (rent <= 0) { skipped++; continue; }
          // Per-unit "send N days before 1st" override (falls back to
          // workspace globalBefore). Skip this unit unless today
          // matches its computed send date for the upcoming cycle.
          const unitBefore = (u.autoInvoiceBeforeDays != null && u.autoInvoiceBeforeDays !== '')
            ? Math.max(1, Math.min(28, +u.autoInvoiceBeforeDays || 0))
            : 0;
          const beforeDays = unitBefore || globalBefore;
          const unitSendDate = new Date(nm.getTime() - beforeDays * 86400_000);
          if (today.getUTCFullYear() !== unitSendDate.getUTCFullYear()
           || today.getUTCMonth()    !== unitSendDate.getUTCMonth()
           || today.getUTCDate()     !== unitSendDate.getUTCDate()) {
            skipped++; continue;
          }
          // Already invoiced this cycle? autoSentYm normally short-
          // circuits. But if the operator voided the previous invoice
          // for this cycle and we still have a stale lastInvoiceId
          // pointing at it, the stamp is misleading — the cycle is
          // open again and should re-fire. Verify Stripe-side status
          // before respecting the stamp.
          if (u.stripe && u.stripe.autoSentYm === nextYm) {
            let cycleStillBlocked = true;
            const lastId = u.stripe.lastInvoiceId;
            if (lastId) {
              try {
                const prev = await stripe.invoices.retrieve(lastId);
                if (prev && (prev.status === 'void' || prev.status === 'uncollectible' || prev.deleted)) {
                  cycleStillBlocked = false;
                  logger.info(`[auto-invoice] ${u.id}: prior cycle invoice ${lastId} is ${prev.status || 'deleted'}; re-issuing`);
                }
              } catch (e) {
                // 404 = invoice gone (deleted). Treat as unblocked.
                if (e.statusCode === 404 || /No such invoice/i.test(e.message || '')) {
                  cycleStillBlocked = false;
                  logger.info(`[auto-invoice] ${u.id}: prior cycle invoice ${lastId} not found on Stripe; re-issuing`);
                } else {
                  logger.warn(`[auto-invoice] ${u.id}: cannot verify ${lastId} status (${e.message}); honoring stamp to be safe`);
                }
              }
            }
            if (cycleStillBlocked) { skipped++; continue; }
            // Stamp is stale — clear it before re-issuing so the new
            // invoice gets a clean stamp on success below.
            delete u.stripe.autoSentYm;
            delete u.stripe.lastInvoiceId;
            delete u.stripe.lastInvoiceYm;
          }
          // Already paid?
          // 'paid' / 'free' / 'waived' all mean this cycle is settled —
          // operator either collected rent or comped the month (referral
          // credit, goodwill). DON'T create a Stripe invoice for any of
          // those, otherwise we bill a tenant whose month was already
          // marked as a credit (Tony hit this on Suite 407 — May was
          // marked Free for a referral but the cron sent an invoice
          // anyway).
          if (u.payments && u.payments[nextYm]
              && ['paid', 'free', 'waived'].includes(u.payments[nextYm].status)) {
            skipped++; continue;
          }
          // Lease must be active — don't invoice past leaseEnd
          if (u.until) {
            const until = new Date(u.until + 'T00:00:00Z');
            if (!isNaN(until.getTime()) && until.getTime() < nm.getTime()) { skipped++; continue; }
          }

          // Create the invoice via Stripe
          try {
            const customerId = u.stripe?.customerId;
            if (!customerId) {
              logger.warn(`[auto-invoice] ${u.id}: no stripe customerId, skipping`);
              skipped++;
              continue;
            }

            // Cross-flow dedupe vs MANUAL sends. createStripeInvoice
            // stamps u.stripe.lastInvoiceYm but NOT autoSentYm, so the
            // autoSentYm short-circuit above doesn't catch a manually
            // issued rent invoice — without this guard cron would
            // double-bill the tenant. Mirrors the Stripe Search query
            // used by createStripeInvoice (line 671). Search is
            // eventually-consistent (~10s lag), fine for a daily cron.
            try {
              const dupQ = `customer:"${customerId}" AND metadata["unitId"]:"${u.id}" `
                         + `AND metadata["purpose"]:"rent" AND metadata["ym"]:"${nextYm}"`;
              const dupRes = await stripe.invoices.search({ query: dupQ, limit: 5 });
              const liveDup = (dupRes.data || []).find(inv =>
                !['void', 'uncollectible', 'deleted'].includes(inv.status));
              if (liveDup) {
                logger.info(`[auto-invoice] ${u.id}: rent for ${nextYm} already exists (${liveDup.id}, ${liveDup.status}); skipping cron-create`);
                skipped++;
                continue;
              }
            } catch (searchErr) {
              // Don't block the cron over a Search API hiccup — log and
              // proceed. Stripe-level idempotency key still guards
              // against same-day re-fires from cron itself.
              logger.warn(`[auto-invoice] ${u.id}: dup-search failed (${searchErr.message}); proceeding without cross-flow dedupe`);
            }

            const description = `Monthly rent — ${nm.toLocaleString('en-US', {month:'long', year:'numeric', timeZone:'UTC'})} · Suite ${u.id}`;
            const due = Math.floor((Date.now() + dueDays * 86400_000) / 1000);

            // Idempotency key: ensures no duplicates even if retry happens
            const idempotencyKey = `auto-rent-${u.id}-${nextYm}`;

            // Invoice item (line)
            await stripe.invoiceItems.create({
              customer: customerId,
              amount: Math.round(rent * 100),
              currency: 'usd',
              description,
              metadata: { unitId: u.id, buildingId: b.id, floorId: f.id, ym: nextYm, purpose: 'rent', source: 'auto' },
            }, { idempotencyKey: idempotencyKey + '-item' });

            // Auto-include monthly additional services as line items
            // (parking, cleaning, conference room, etc.). Mirrors the
            // same logic in createStripeInvoice; one-time / hourly /
            // daily services are not included in the recurring rent
            // bill.
            if (Array.isArray(u.additionalServices)) {
              for (const svc of u.additionalServices) {
                const freq = svc?.frequency || 'monthly';
                const amt = +svc?.amount || 0;
                // Mirror the manual-flow gating: must be active for this
                // tenant AND opted into auto-invoice AND a positive monthly
                // amount. Inactive or manual-only services are skipped.
                if (!svc?.active) continue;
                if (!svc?.autoInvoice) continue;
                if (freq !== 'monthly' || amt <= 0) continue;
                try {
                  await stripe.invoiceItems.create({
                    customer: customerId,
                    amount: Math.round(amt * 100),
                    currency: 'usd',
                    description: String(svc.name || 'Additional service').slice(0, 250),
                    metadata: { unitId: u.id, buildingId: b.id, floorId: f.id, ym: nextYm, purpose: 'service', serviceId: String(svc.id || ''), source: 'auto' },
                  }, { idempotencyKey: idempotencyKey + '-svc-' + (svc.id || svc.name || '').slice(0, 30) });
                } catch (svcErr) {
                  logger.warn(`[runAutoInvoices] service line "${svc.name}" for ${u.id} failed: ${svcErr.message}`);
                }
              }
            }

            // Custom invoice number with "RA-" prefix marking this as
            // an auto-generated rent invoice (vs manual "R-").
            const autoNumber = buildCustomInvoiceNumber({
              purpose: 'rent', unitId: u.id, ym: nextYm, auto: true,
            });

            // Auto-charge routing — same as createStripeInvoice. If the
            // workspace/unit has auto-charge enabled AND the tenant's
            // Stripe customer has a saved default payment method, bill
            // automatically (no email). Otherwise fall back to hosted
            // invoice email with save_default_payment_method so the
            // next cycle can auto-charge.
            const wsAutoCharge = cfg.autoCharge === true;
            const unitAc = u.autoCharge;
            const acOn = unitAc === 'on' || (unitAc !== 'off' && wsAutoCharge);
            let acMethod = 'send_invoice';
            let acPaymentSettings = null;
            if (acOn) {
              try {
                const cust = await stripe.customers.retrieve(customerId);
                const dpm = cust?.invoice_settings?.default_payment_method;
                if (dpm) {
                  acMethod = 'charge_automatically';
                } else {
                  acPaymentSettings = { save_default_payment_method: 'on_confirmation' };
                }
              } catch (e) {
                logger.warn(`[auto-invoice] ${u.id}: customer retrieve failed, using send_invoice — ${e.message}`);
              }
            }

            // Footer parity with the manual createStripeInvoice path —
            // auto-invoices used to ship without the "Property / Suite /
            // Landlord" footer block, so tenants saw a slightly different
            // PDF depending on whether the cron or the operator sent it.
            // Reads the same workspace landlord settings; defaults match
            // the manual path exactly.
            const _autoLandlordEmail = String(state.settings?.invoiceLandlordEmail || 'finance@kiwi-rentals.com').trim();
            const _autoLandlordName  = String(state.settings?.invoiceLandlordName  || 'SuitesForAll').trim();
            const _autoMonthLabel = nm.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
            const _autoYear = nm.getUTCFullYear();
            const _autoFooter = [
              `Property: ${b.address || b.name || ''}${f.name ? ' · ' + f.name : ''}`,
              `Suite: ${u.id}`,
              `Billing period: ${_autoMonthLabel} ${_autoYear}`,
              `Invoice issued: ${new Date().toISOString().slice(0, 10)}`,
              `Payment due: within ${dueDays} days`,
              `Landlord: ${_autoLandlordName}${_autoLandlordEmail ? ' · ' + _autoLandlordEmail : ''}`,
            ].join(' · ');

            // Invoice
            const inv = await stripe.invoices.create({
              customer: customerId,
              auto_advance: true,
              collection_method: acMethod,
              ...(acMethod === 'send_invoice' ? { days_until_due: dueDays } : {}),
              ...(acPaymentSettings ? { payment_settings: acPaymentSettings } : {}),
              metadata: { unitId: u.id, buildingId: b.id, floorId: f.id, ym: nextYm, purpose: 'rent', source: 'auto' },
              description,
              footer: _autoFooter,
            }, { idempotencyKey });
            // Apply the custom number AFTER create (Stripe rejects it
            // on create for send_invoice collection with auto_advance).
            try {
              await stripe.invoices.update(inv.id, { number: autoNumber });
            } catch (e) {
              logger.warn(`[auto-invoice] ${u.id}: couldn't set number ${autoNumber} — ${e.message}`);
            }
            if (acMethod === 'send_invoice') {
              await stripe.invoices.sendInvoice(inv.id);
            } else {
              logger.info(`[auto-invoice] ${u.id}: auto-charging saved card (charge_automatically)`);
            }

            // Stamp u.stripe so next run skips
            u.stripe = u.stripe || {};
            u.stripe.autoSentYm = nextYm;
            u.stripe.lastInvoiceId = inv.id;
            u.stripe.lastInvoiceYm = nextYm;
            sent++;
            logger.info(`[auto-invoice] sent to ${u.email} (${u.id}) · $${rent} · ${nextYm}`);
          } catch (err) {
            failed++;
            logger.error(`[auto-invoice] ${u.id} failed:`, err.message || err);
          }
        }
      }
    }

    // Persist updated state (u.stripe stamps)
    if (sent > 0) {
      state._rev = (state._rev || 0) + 1;
      await stateRef.set({ state, _rev: state._rev, _updatedAt: admin.firestore.FieldValue.serverTimestamp(), _updatedBy: 'auto-invoice' }, { merge: true });
    }
    // Persist checkpoint — even if we ran the full set this time, the
    // record of which units we processed in the last 24h means a manual
    // re-trigger today won't double-fire on units we already invoiced.
    try {
      if (typeof __autoInvPersistCheckpoint === 'function') {
        await __autoInvPersistCheckpoint({
          totalSent: sent, totalSkipped: skipped, totalFailed: failed,
        });
      }
    } catch {}
    // If we aborted early due to time budget, log loud so an alert can fire.
    // The next cron tick (or operator-triggered re-run via a Run Now button)
    // will pick up where we left off via the checkpoint.
    if (typeof globalThis.__autoInvShouldProcess === 'function') {
      // Nothing more to do — checkpoint persisted above.
    }
    logger.info(`[auto-invoice] done · sent=${sent} skipped=${skipped} failed=${failed}`);
  }
);

// ===========================================================================
// ===== Late-fee auto-send cron (Phase 2) ==================================
// Daily 09:00 UTC. Walks 12-mo window per unit, identifies overdue months,
// и для каждого месяца, который ещё не был выставлен, создаёт Stripe invoice
// с purpose='late_fee'. Three safety gates protect tenants from accidental
// charges:
//   1. Per-unit u.lateFeeOverride.autoSend (cascade workspace→building→
//      floor→unit). Operator opt-in per tenant — flipped via the LF auto-send
//      pill in Auto-billing Coverage table or unit drawer.
//   2. Workspace state.settings.lateFee.autoSendLive (default false). When
//      false, cron logs every action it WOULD take but never calls Stripe.
//      Operator monitors logs 2-3 days, then flips live in Settings → Billing.
//   3. Triple idempotency layer: Stripe idempotency-key auto-lf-{uid}-{ym},
//      Stripe Search dedupe vs prior late-fee invoices for same unit/ym, and
//      u.stripe.lateFeeSent[ym] = invoiceId stamp prevents re-billing.
// ===========================================================================

// Server-side mirror of getLateFeeConfig() (floor-map-editor.html L115330).
// Cascade workspace → building → floor → unit, with fromLease delegation
// + building-paused hard-disable. Returns the merged effective config.
function _resolveLateFeeConfigServer(state, b, f, u) {
  const def = {
    enabled: true, graceDays: 5, type: 'percent', amount: 8,
    frequency: 'monthly', applyTo: 'total',
    requireGuaranteedPayment: true, suspendAccessAfterLate: false,
    autoSend: false,
  };
  let cfg = Object.assign({}, def, (state && state.settings && state.settings.lateFee) || {});
  // Building override
  const bOvr = b && b.billingRulesOverride && b.billingRulesOverride.lateFee;
  if (bOvr && typeof bOvr === 'object') {
    if (bOvr.source === 'fromLease') {
      // fromLease: применяем только enabled, цифры оставляем на per-unit override
      if (bOvr.enabled !== undefined) cfg = Object.assign({}, cfg, { enabled: bOvr.enabled === true });
    } else {
      cfg = Object.assign({}, cfg, bOvr);
    }
  }
  // Floor override
  const fOvr = f && f.billingRulesOverride && f.billingRulesOverride.lateFee;
  if (fOvr && typeof fOvr === 'object') {
    if (fOvr.source === 'fromLease') {
      if (fOvr.enabled !== undefined) cfg = Object.assign({}, cfg, { enabled: fOvr.enabled === true });
    } else {
      cfg = Object.assign({}, cfg, fOvr);
    }
  }
  // Unit override
  if (u && u.lateFeeOverride && typeof u.lateFeeOverride === 'object') {
    cfg = Object.assign({}, cfg, u.lateFeeOverride);
  }
  // Building-level pause hard-disables late-fee автоматику для всех юнитов в здании.
  if (b && b.billingRulesOverride && b.billingRulesOverride.paused === true) {
    cfg = Object.assign({}, cfg, { enabled: false });
  }
  return cfg;
}

// Server-side mirror of _firstTenancyYm (floor-map-editor.html L71096).
// Returns YYYY-MM of the earliest tenancy stamp on the unit, or null
// if neither _tenantAddedAt nor leaseStart is set.
function _firstTenancyYmServer(u) {
  if (!u) return null;
  let earliestMs = Infinity;
  for (const ref of [u._tenantAddedAt, u.leaseStart]) {
    if (!ref) continue;
    const d = new Date(String(ref).length <= 10 ? ref + 'T00:00:00Z' : ref);
    if (!isNaN(d.getTime()) && d.getTime() < earliestMs) earliestMs = d.getTime();
  }
  if (!isFinite(earliestMs)) return null;
  const d = new Date(earliestMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Server-side mirror of lateFeePreviewFor (floor-map-editor.html L115423),
// but returns ONE entry per overdue month (cron creates per-month invoices,
// not a single aggregated one). Each entry: { ym, base, fee, monthLabel }.
// Honors cfg.frequency === 'once' cap.
function _computeOverdueMonths(u, cfg, todayInZoneParts) {
  if (!cfg || !cfg.enabled) return [];
  // Today как UTC-полночь, выведенная из workspace-zone parts. Нам нужна
  // только день-точность для подсчёта days-since-due.
  const todayUtc = new Date(Date.UTC(
    todayInZoneParts.year,
    todayInZoneParts.month - 1,
    todayInZoneParts.day
  ));
  const curY = todayInZoneParts.year, curM = todayInZoneParts.month;  // 1-indexed
  const firstYm = _firstTenancyYmServer(u);
  const overdueList = [];
  let monthsOwed = 0;
  // Walk oldest → newest in 12-mo window.
  for (let i = 11; i >= 0; i--) {
    let mYear = curY, mMonth = curM - i;
    while (mMonth < 1) { mMonth += 12; mYear -= 1; }
    const ym = `${mYear}-${String(mMonth).padStart(2, '0')}`;
    if (firstYm && ym < firstYm) continue;     // before tenancy began
    const p = u && u.payments && u.payments[ym];
    if (p && (p.status === 'paid' || p.status === 'free' || p.status === 'waived')) continue;
    // Days since 1st of this month, in UTC.
    const dueDate = new Date(Date.UTC(mYear, mMonth - 1, 1));
    const days = Math.floor((todayUtc - dueDate) / 86400000);
    if (days < (cfg.graceDays || 0)) continue;
    monthsOwed++;
    if (cfg.frequency === 'once' && monthsOwed > 1) continue;
    // Compute base
    let base = +u.contractRent || +u.rent || 0;
    if (cfg.applyTo === 'total') {
      const ex = u && u.extraCharges && u.extraCharges[ym];
      if (ex && typeof ex === 'object') {
        base += (+ex.taxes || 0) + (+ex.services || 0) + (+ex.other || 0);
      }
    }
    const fee = cfg.type === 'percent'
      ? base * (+cfg.amount / 100)
      : +cfg.amount;
    if (!(fee > 0)) continue;
    overdueList.push({
      ym,
      base: Math.round(base * 100) / 100,
      fee: Math.round(fee * 100) / 100,
      monthLabel: new Date(Date.UTC(mYear, mMonth - 1, 1))
        .toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    });
  }
  return overdueList;
}

// Inner handler shared by onSchedule (daily cron) + onCall (Run-now button).
// opts:
//   forceDryRun: bool — override workspace autoSendLive=true to dry-run anyway
//   manualTrigger: bool — log marker so logs distinguish cron vs operator-clicked
async function _runAutoLateFeesHandler(opts) {
  const forceDryRun = !!(opts && opts.forceDryRun);
  const manualTrigger = !!(opts && opts.manualTrigger);

  const stateRef = db.doc(`workspaces/${WORKSPACE_ID}/data/state`);
  const snap = await stateRef.get();
  if (!snap.exists) {
    logger.info('[auto-late-fee] no state doc, skipping');
    return { sent: 0, skipped: 0, failed: 0, dryRun: 0, mode: 'no-state' };
  }
  const state = snap.data().state || {};
  const wsLfCfg = (state.settings && state.settings.lateFee) || {};

  // Workspace-wide live gate. Default false → cron логирует но не вызывает
  // Stripe. После 2-3 дней наблюдения за логами оператор флипает switch в
  // Settings → Billing. forceDryRun (от Run-now button) принудительно
  // оставляет dry-run даже если workspace уже live — чтобы оператор мог
  // «посмотреть что бы крон сделал сегодня» без реальных charge.
  const liveMode = (wsLfCfg.autoSendLive === true) && !forceDryRun;
  const mode = liveMode ? 'LIVE' : 'DRY-RUN';
  logger.info(`[auto-late-fee] starting · mode=${mode}${manualTrigger ? ' · manual trigger' : ''}`);

  // Checkpoint — track per-unit processing within the last 24h, so a
  // mid-run timeout doesn't double-process the same units on re-trigger.
  const checkpointRef = db.doc(`workspaces/${WORKSPACE_ID}/cronProgress/auto-late-fee`);
  let checkpoint;
  try {
    const ckSnap = await checkpointRef.get();
    checkpoint = ckSnap.exists ? (ckSnap.data() || {}) : {};
  } catch (e) {
    checkpoint = {};
  }
  const stampedRecently = new Set(
    Object.entries(checkpoint.processed || {})
      .filter(([, ms]) => Number(ms) > Date.now() - 24 * 60 * 60 * 1000)
      .map(([id]) => id)
  );
  const startTimeMs = Date.now();
  const TIME_BUDGET_MS = 480 * 1000;   // leave 60s headroom in 540s timeout
  const newCheckpoint = Object.assign({}, checkpoint.processed || {});
  let abortedEarly = false;

  // Workspace timezone for "today". Without this, operator on PT sees
  // graceDays calculation drift across month boundaries near midnight UTC.
  const wsTimeZone = (state.settings && state.settings.timeZone) || 'UTC';
  let todayInZoneParts;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: wsTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    todayInZoneParts = fmt.formatToParts(new Date()).reduce((a, p) => {
      if (p.type !== 'literal') a[p.type] = +p.value;
      return a;
    }, {});
    logger.info(`[auto-late-fee] timezone=${wsTimeZone} today=${todayInZoneParts.year}-${String(todayInZoneParts.month).padStart(2,'0')}-${String(todayInZoneParts.day).padStart(2,'0')}`);
  } catch (e) {
    logger.warn(`[auto-late-fee] invalid timezone "${wsTimeZone}" (${e.message}), falling back to UTC`);
    const t = new Date();
    todayInZoneParts = { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
  }

  let sent = 0, skipped = 0, failed = 0, dryRunCount = 0;
  const stripe = liveMode ? getStripe() : null;
  const dryRunActions = []; // [{unitId, ym, fee, base, customerId}]

  outer: for (const b of state.buildings || []) {
    for (const f of b.floors || []) {
      for (const u of f.units || []) {
        const unitKey = `${b.id}|${f.id}|${u.id}`;
        if (stampedRecently.has(unitKey)) { skipped++; continue; }
        if (Date.now() - startTimeMs > TIME_BUDGET_MS) {
          abortedEarly = true;
          logger.warn(`[auto-late-fee] time budget exceeded, aborting at unit ${unitKey}`);
          break outer;
        }

        // Standard gates
        if (u.deletedAt) { skipped++; continue; }
        if (u.status !== 'occupied') { skipped++; continue; }
        if (!u.tenant && !u.company) { skipped++; continue; }
        if (!u.email || !/@/.test(u.email || '')) { skipped++; continue; }
        // Group consolidation: для multi-suite leases считаем только head
        // (groupRole='primary'). Non-primary members в финансовой консолидации
        // — «shadow» юниты, у них нет своих payments/extraCharges (Phase A
        // миграция переносит всё на head). Биллинг late fee только с head'а
        // — иначе мы создадим 3 invoice'а на одну группу из 3 юнитов.
        if (u.groupId && u.groupRole !== 'primary') { skipped++; continue; }

        // Resolve cascade config
        const cfg = _resolveLateFeeConfigServer(state, b, f, u);
        if (!cfg.enabled)  { skipped++; continue; }   // calc disabled → no fees
        if (!cfg.autoSend) { skipped++; continue; }   // send disabled → operator hasn't opted in

        // Lease must still be active(ish) to bill late fees. Ended >30 days
        // ago → skip; collections logic handles old debt elsewhere.
        if (u.until) {
          const until = new Date(u.until + 'T00:00:00Z');
          const todayUtc = new Date(Date.UTC(
            todayInZoneParts.year, todayInZoneParts.month - 1, todayInZoneParts.day
          ));
          if (!isNaN(until.getTime()) && until.getTime() < todayUtc.getTime() - 30 * 86400000) {
            skipped++;
            continue;
          }
        }

        // Compute overdue months
        const overdues = _computeOverdueMonths(u, cfg, todayInZoneParts);
        if (overdues.length === 0) { skipped++; continue; }

        // Filter out months we've already invoiced (per stamp).
        const lateFeeSent = (u.stripe && u.stripe.lateFeeSent) || {};
        const todoMonths = overdues.filter(o => !lateFeeSent[o.ym]);
        if (todoMonths.length === 0) { skipped++; continue; }

        const customerId = u.stripe && u.stripe.customerId;

        // DRY-RUN — log + bail without touching Stripe
        if (!liveMode) {
          for (const o of todoMonths) {
            dryRunActions.push({
              unitId: u.id, buildingId: b.id, floorId: f.id,
              ym: o.ym, fee: o.fee, base: o.base,
              customerId: customerId || '(no-customer)',
              monthLabel: o.monthLabel,
            });
            dryRunCount++;
          }
          newCheckpoint[unitKey] = Date.now();
          continue;
        }

        // LIVE MODE — issue per-month Stripe invoices
        if (!customerId) {
          logger.warn(`[auto-late-fee] ${u.id}: no stripe customerId, skipping in LIVE mode`);
          skipped++;
          continue;
        }

        for (const o of todoMonths) {
          try {
            // Cross-flow dedupe vs MANUAL sends. createStripeInvoice can
            // also emit purpose='late_fee' invoices (operator clicks
            // "Send late fee" in the unit drawer); without this guard
            // cron would double-bill. Stripe Search is eventually-
            // consistent (~10s lag), fine for a daily cron.
            try {
              const dupQ = `customer:"${customerId}" AND metadata["unitId"]:"${u.id}" `
                         + `AND metadata["purpose"]:"late_fee" AND metadata["ym"]:"${o.ym}"`;
              const dupRes = await stripe.invoices.search({ query: dupQ, limit: 5 });
              const liveDup = (dupRes.data || []).find(inv =>
                !['void', 'uncollectible', 'deleted'].includes(inv.status));
              if (liveDup) {
                logger.info(`[auto-late-fee] ${u.id}: late-fee for ${o.ym} already exists (${liveDup.id}, ${liveDup.status}); stamping + skipping`);
                u.stripe = u.stripe || {};
                u.stripe.lateFeeSent = u.stripe.lateFeeSent || {};
                u.stripe.lateFeeSent[o.ym] = liveDup.id;
                skipped++;
                continue;
              }
            } catch (searchErr) {
              logger.warn(`[auto-late-fee] ${u.id}/${o.ym}: dup-search failed (${searchErr.message}); proceeding with idempotency-key`);
            }

            const description = `Late fee — ${o.monthLabel} unpaid · Suite ${u.id}`;
            const dueDays = 0;  // late fees due IMMEDIATELY — penalty за rent, без дополнительного grace
            const idempotencyKey = `auto-lf-${u.id}-${o.ym}`;

            // Invoice item line
            await stripe.invoiceItems.create({
              customer: customerId,
              amount: Math.round(o.fee * 100),
              currency: 'usd',
              description,
              metadata: {
                unitId: u.id, buildingId: b.id, floorId: f.id,
                ym: o.ym, purpose: 'late_fee', source: 'auto',
                baseAmount: String(o.base),
                feeType: cfg.type, feeAmount: String(cfg.amount),
              },
            }, { idempotencyKey: idempotencyKey + '-item' });

            // Auto-charge routing — same logic as runAutoInvoices. If
            // workspace+unit auto-charge is on AND tenant has a saved
            // default_payment_method, charge_automatically; else
            // send_invoice with save_default_payment_method.
            const wsAutoCharge = (state.settings && state.settings.autoInvoice && state.settings.autoInvoice.autoCharge) === true;
            const unitAc = u.autoCharge;
            const acOn = unitAc === 'on' || (unitAc !== 'off' && wsAutoCharge);
            let acMethod = 'send_invoice';
            let acPaymentSettings = null;
            if (acOn) {
              try {
                const cust = await stripe.customers.retrieve(customerId);
                const dpm = cust && cust.invoice_settings && cust.invoice_settings.default_payment_method;
                if (dpm) {
                  acMethod = 'charge_automatically';
                } else {
                  acPaymentSettings = { save_default_payment_method: 'on_confirmation' };
                }
              } catch (e) {
                logger.warn(`[auto-late-fee] ${u.id}/${o.ym}: customer retrieve failed, using send_invoice — ${e.message}`);
              }
            }

            // Footer parity с manual createStripeInvoice path —
            // тот же property/suite/landlord block чтобы tenant видел
            // одинаковый PDF независимо от того кто послал.
            const _autoLandlordEmail = String((state.settings && state.settings.invoiceLandlordEmail) || 'finance@kiwi-rentals.com').trim();
            const _autoLandlordName  = String((state.settings && state.settings.invoiceLandlordName)  || 'SuitesForAll').trim();
            const _calcLabel = cfg.type === 'percent'
              ? `${cfg.amount}% × $${o.base.toFixed(2)} = $${o.fee.toFixed(2)}`
              : `$${cfg.amount} flat`;
            const _autoFooter = [
              `Property: ${b.address || b.name || ''}${f.name ? ' · ' + f.name : ''}`,
              `Suite: ${u.id}`,
              `Late fee for: ${o.monthLabel}`,
              `Calculated: ${_calcLabel}`,
              `Grace period: ${cfg.graceDays || 0} days`,
              `Payment due: within ${dueDays} days`,
              `Landlord: ${_autoLandlordName}${_autoLandlordEmail ? ' · ' + _autoLandlordEmail : ''}`,
            ].join(' · ');

            const inv = await stripe.invoices.create({
              customer: customerId,
              auto_advance: true,
              collection_method: acMethod,
              ...(acMethod === 'send_invoice' ? { days_until_due: dueDays } : {}),
              ...(acPaymentSettings ? { payment_settings: acPaymentSettings } : {}),
              metadata: {
                unitId: u.id, buildingId: b.id, floorId: f.id,
                ym: o.ym, purpose: 'late_fee', source: 'auto',
              },
              description,
              footer: _autoFooter,
            }, { idempotencyKey });

            // Custom invoice number — "L-" prefix per PURPOSE_CODE.late_fee
            const lfNumber = buildCustomInvoiceNumber({
              purpose: 'late_fee', unitId: u.id, ym: o.ym, auto: false,
            });
            try {
              await stripe.invoices.update(inv.id, { number: lfNumber });
            } catch (e) {
              logger.warn(`[auto-late-fee] ${u.id}/${o.ym}: couldn't set number ${lfNumber} — ${e.message}`);
            }

            if (acMethod === 'send_invoice') {
              await stripe.invoices.sendInvoice(inv.id);
            } else {
              logger.info(`[auto-late-fee] ${u.id}/${o.ym}: auto-charging saved card (charge_automatically)`);
            }

            // Stamp — preventing re-billing on next cron tick.
            u.stripe = u.stripe || {};
            u.stripe.lateFeeSent = u.stripe.lateFeeSent || {};
            u.stripe.lateFeeSent[o.ym] = inv.id;
            sent++;
            logger.info(`[auto-late-fee] sent to ${u.email} (${u.id}/${o.ym}) · $${o.fee.toFixed(2)} · ${inv.id}`);
          } catch (err) {
            failed++;
            logger.error(`[auto-late-fee] ${u.id}/${o.ym} failed:`, err.message || err);
          }
        }
        newCheckpoint[unitKey] = Date.now();
      }
    }
  }

  // Persist updated state if anything was actually invoiced.
  if (sent > 0) {
    state._rev = (state._rev || 0) + 1;
    await stateRef.set(
      {
        state, _rev: state._rev,
        _updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        _updatedBy: 'auto-late-fee',
      },
      { merge: true }
    );
  }

  // Persist checkpoint + dry-run summary (capped at 50 actions so the
  // doc doesn't grow unbounded over weeks of dry-runs).
  try {
    await checkpointRef.set({
      processed: newCheckpoint,
      lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
      lastRunAbortedEarly: abortedEarly,
      lastRunMode: mode,
      lastRunSent: sent,
      lastRunSkipped: skipped,
      lastRunFailed: failed,
      lastRunDryRunCount: dryRunCount,
      lastDryRunActions: dryRunActions.slice(0, 50),
    });
  } catch (e) {
    logger.warn(`[auto-late-fee] checkpoint write failed: ${e.message}`);
  }

  // Loud summary
  if (!liveMode && dryRunCount > 0) {
    logger.info(`[auto-late-fee] DRY-RUN — would have sent ${dryRunCount} late-fee invoice(s). First 10:`);
    for (const a of dryRunActions.slice(0, 10)) {
      logger.info(`  · ${a.unitId} · ${a.ym} · $${a.fee.toFixed(2)} (base $${a.base.toFixed(2)}) · cust=${a.customerId}`);
    }
    if (dryRunCount > 10) logger.info(`  ... and ${dryRunCount - 10} more`);
    logger.info('[auto-late-fee] To go LIVE: flip state.settings.lateFee.autoSendLive = true in Settings → Billing.');
  }
  logger.info(`[auto-late-fee] done · mode=${mode} · sent=${sent} · skipped=${skipped} · failed=${failed} · dryRunCount=${dryRunCount}`);

  return {
    sent, skipped, failed, dryRun: dryRunCount, mode, abortedEarly,
    sampleActions: dryRunActions.slice(0, 20),
  };
}

exports.runAutoLateFees = onSchedule(
  {
    schedule: '0 9 * * *',         // 09:00 UTC daily — same as runAutoInvoices
    timeZone: 'UTC',
    secrets: [STRIPE_SECRET_KEY],
    memory: '512MiB',
    timeoutSeconds: 540,
  },
  async () => {
    try {
      await _runAutoLateFeesHandler({});
    } catch (e) {
      logger.error('[auto-late-fee] cron handler crashed:', e.message || e);
      throw e;
    }
  }
);

// Manual run-now from Settings → Billing. Lets the operator trigger the
// cron on demand — useful for verifying dry-run output без ожидания 24h.
// Always enforces requireEditor. If req.data.forceDryRun=true, dry-run
// even if workspace is live (preview without billing).
exports.triggerAutoLateFeesNow = onCall(
  {secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 540, memory: '512MiB'},
  async (req) => {
    await requireEditor(req.auth);
    const forceDryRun = req.data && req.data.forceDryRun === true;
    return await _runAutoLateFeesHandler({ forceDryRun, manualTrigger: true });
  }
);

// ===========================================================================
// ===== UniFi Access (Phase 1b) =============================================
// Real provisioning / revoke callables. Kept in a separate module so the
// Stripe logic above stays isolated. The module receives this file's
// shared helpers (requireEditor, admin, logger, WORKSPACE_ID) as deps so
// there's no duplication of workspace conventions.
// ===========================================================================
require('./unifi').registerUnifiFunctions({
  exports: module.exports,
  HttpsError,
  onCall,
  defineSecret,
  defineString,
  admin,
  requireEditor,
  logger,
  workspaceId: WORKSPACE_ID,
});

// =========================================================================
// ===== Daily Firestore backup =============================================
// Snapshots the entire workspace state document every day so we can roll
// back to any of the last 90 days if data is corrupted, accidentally
// deleted, or overwritten by a buggy update.
//
// Storage layout:
//   /workspaces/{wsId}/backups/{YYYY-MM-DD}
//      { capturedAt, capturedBy, _rev, sizeBytes, state }
//
// The cron at 03:00 UTC writes a snapshot with the date as the doc id —
// this gives us natural deduplication if the cron retries within the day.
// On-demand backups (operator-triggered) write to the same path with a
// '-manual-{HHmm}' suffix so they never collide with the daily.
//
// Retention: a daily prune step deletes anything older than 90 days.
//
// Restore: a separate callable below replaces the live state with a
// chosen backup, AFTER first creating a "pre-restore" safety snapshot —
// so a botched restore can itself be undone.
// =========================================================================

// YYYY-MM-DD in UTC — used as the daily backup doc id.
function _backupDateId(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Stamp every backup with the schema version that produced it. On
// restore, runMigrations(state, fromVer) brings older backups forward
// to today's shape so a 6-month-old snapshot doesn't crash on missing
// fields. Bump this whenever you add a structural change (new
// required field, renamed top-level key, etc.).
const BACKUP_SCHEMA_VERSION = 1;

// Shared snapshot writer used by both the cron and the manual trigger.
// Returns { docId, sizeBytes, _rev, chunked } so callers can confirm
// what was captured. On failure, throws — caller logs and decides
// what to do.
//
// CHUNKING: Firestore's 1 MiB doc cap means workspaces approaching
// that size can't fit their state in a single backup doc. When
// stateBody serialises >800KB, we split state.buildings across
// /backups/{id}/chunks/{i} subdocuments (each chunk gets ~200KB of
// buildings) and store only the metadata + non-buildings fields in
// the main doc. Restore reads the main + reassembles chunks.
async function _writeBackupSnapshot({ workspaceId, docId, capturedBy, reason }) {
  const stateRef = db.doc(`workspaces/${workspaceId}/data/state`);
  const stateSnap = await stateRef.get();
  if (!stateSnap.exists) {
    throw new Error('No state document to back up');
  }
  const stateDoc = stateSnap.data() || {};
  const stateBody = stateDoc.state || {};
  const json = JSON.stringify(stateBody);
  const sizeBytes = Buffer.byteLength(json, 'utf8');

  const backupRef = db.doc(`workspaces/${workspaceId}/backups/${docId}`);
  const baseFields = {
    capturedAt: admin.firestore.FieldValue.serverTimestamp(),
    capturedBy: capturedBy || 'system',
    reason: reason || 'scheduled',
    _rev: stateDoc._rev || 0,
    _schemaVersion: BACKUP_SCHEMA_VERSION,
    sizeBytes,
  };

  // Threshold for chunking — 800KB leaves room for the metadata wrapper
  // even after the state field is stripped.
  if (sizeBytes <= 800 * 1024) {
    // Inline path — fits in one doc.
    await backupRef.set({ ...baseFields, chunked: false, state: stateBody });
    // Verify read-back: catches the (rare but real) silent partial-write
    // scenarios where Firestore acks but the body is missing/corrupt.
    // Without this, the daily backup could appear to succeed for weeks
    // while the actual saved bytes are unusable on restore.
    try {
      const verify = await backupRef.get();
      const vBody = verify.exists ? verify.data() : null;
      if (!vBody || !vBody.state || (Array.isArray(stateBody.buildings)
            && (vBody.state.buildings || []).length !== stateBody.buildings.length)) {
        logger.error(`[backup] VERIFY FAILED for ${docId} — read-back returned wrong shape`);
        throw new Error('Backup verify failed — read-back mismatch');
      }
    } catch (vErr) {
      // Don't swallow — caller (cron / manual trigger) should know the
      // backup is unreliable. The pre-existing snapshot file is left
      // in place; next call will overwrite.
      logger.error(`[backup] verify error for ${docId}: ${vErr.message}`);
      throw vErr;
    }
    return { docId, sizeBytes, _rev: stateDoc._rev || 0, chunked: false };
  }

  // CHUNKED path — buildings are the heavy field; split them across
  // sub-docs and store everything else inline. Each chunk ~200KB so we
  // stay well under 1 MiB.
  const buildings = Array.isArray(stateBody.buildings) ? stateBody.buildings : [];
  const stateMinusBuildings = { ...stateBody };
  delete stateMinusBuildings.buildings;
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  for (const b of buildings) {
    const bJson = JSON.stringify(b);
    const bSize = Buffer.byteLength(bJson, 'utf8');
    if (cur.length && curBytes + bSize > 200 * 1024) {
      chunks.push(cur);
      cur = []; curBytes = 0;
    }
    cur.push(b);
    curBytes += bSize;
  }
  if (cur.length) chunks.push(cur);
  // Write chunks first; if any fail, the main doc isn't created so we
  // never end up with a half-written backup that looks valid.
  const batch = db.batch();
  chunks.forEach((chunk, i) => {
    const chunkRef = db.collection(backupRef.path + '/chunks').doc(String(i).padStart(4, '0'));
    batch.set(chunkRef, { buildings: chunk, idx: i });
  });
  // Finally write the main doc with chunked=true and chunkCount so
  // restore knows how many chunks to read.
  batch.set(backupRef, {
    ...baseFields,
    chunked: true,
    chunkCount: chunks.length,
    state: stateMinusBuildings,
  });
  await batch.commit();
  logger.info(`[backup] chunked ${docId} into ${chunks.length} chunks (${sizeBytes}B total)`);
  return { docId, sizeBytes, _rev: stateDoc._rev || 0, chunked: true, chunkCount: chunks.length };
}

// Reassemble a chunked backup body by pulling the main doc + every
// chunk subdoc. Returns the same shape as inline backups.
async function _readBackupSnapshotBody(workspaceId, docId) {
  const ref = db.doc(`workspaces/${workspaceId}/backups/${docId}`);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const body = snap.data() || {};
  if (!body.chunked) return body;
  // Reassemble.
  const chunkSnap = await db.collection(ref.path + '/chunks')
    .orderBy(admin.firestore.FieldPath.documentId())
    .get();
  const buildings = [];
  chunkSnap.docs.forEach(d => {
    const data = d.data();
    if (Array.isArray(data?.buildings)) buildings.push(...data.buildings);
  });
  return {
    ...body,
    state: { ...(body.state || {}), buildings },
  };
}

// Schema migration runner — applies any schema diffs needed to bring
// an old backup body forward. New entries here as the schema evolves.
function migrateBackupState(stateBody, fromVer) {
  const ver = fromVer || 0;
  let s = stateBody;
  if (ver < 1) {
    // 0 → 1: ensure top-level arrays exist (older backups may be missing
    // tenants/leases/contracts entirely).
    s = {
      tenants:   [],
      leases:    [],
      contracts: [],
      settings:  {},
      ...s,
      buildings: Array.isArray(s.buildings) ? s.buildings : [],
    };
  }
  // Future: if (ver < 2) { ... }
  return s;
}

// Prune backups older than RETAIN_DAYS so the collection doesn't grow
// unbounded. Doc ids are date-prefixed so we can compare lexically
// without parsing.
async function _pruneOldBackups({ workspaceId, retainDays = 90 }) {
  const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000);
  const cutoffId = _backupDateId(cutoff);
  const col = db.collection(`workspaces/${workspaceId}/backups`);
  // Query by id range AND project to no fields — without the .select()
  // the previous version pulled the FULL state body of every backup
  // we were about to delete (each up to ~1MiB). With 90 days × ~600KB
  // average that was 54MB read on every prune. .select() with an
  // empty field list returns refs only — typically <1KB total
  // regardless of how many backups match.
  const snap = await col
    .where(admin.firestore.FieldPath.documentId(), '<', cutoffId)
    .select()                          // refs only, no data fields
    .limit(450)                        // batch limit headroom (Firestore: 500)
    .get();
  if (snap.empty) return { deleted: 0 };
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  return { deleted: snap.size, hasMore: snap.size === 450 };
}

// Monthly backup-restorability check. Picks a random recent backup
// (excluding ones from the last 24h — too fresh for true regression
// signal), reads the full body back, parses it, asserts non-empty
// buildings + valid _rev. Fires an alert audit entry if any check
// fails — early warning before someone tries to restore in anger and
// finds the backup is unusable.
exports.monthlyBackupVerify = onSchedule(
  {
    schedule: '0 5 1 * *',          // 05:00 UTC, 1st of each month
    timeZone: 'UTC',
    memory: '512MiB',
    timeoutSeconds: 120,
  },
  async () => {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const dayAgoId = _backupDateId(new Date(dayAgo));
    const col = db.collection(`workspaces/${WORKSPACE_ID}/backups`);
    const snap = await col
      .where(admin.firestore.FieldPath.documentId(), '<', dayAgoId)
      .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
      .limit(30)
      .get();
    if (snap.empty) {
      logger.warn('[backup-verify] no recent backups to test');
      return;
    }
    // Pick a random one from the page so we eventually exercise different
    // ages/sizes over the year.
    const pick = snap.docs[Math.floor(Math.random() * snap.docs.length)];
    const id = pick.id;
    const body = pick.data() || {};
    const errors = [];
    if (!body.state) errors.push('no .state field');
    else {
      const s = body.state;
      if (!Array.isArray(s.buildings)) errors.push('buildings missing or not an array');
      else if (s.buildings.length === 0) errors.push('buildings array empty');
      if (typeof body._rev !== 'number' || body._rev < 0) errors.push('invalid _rev');
      if (typeof body.sizeBytes !== 'number' || body.sizeBytes < 100) errors.push('sizeBytes implausibly small');
    }
    if (errors.length === 0) {
      logger.info(`[backup-verify] OK ${id} (rev ${body._rev}, ${body.sizeBytes}B, ${body.state.buildings.length} buildings)`);
      return;
    }
    // Loud alert via audit so the operator notices.
    logger.error(`[backup-verify] FAILURE on ${id}: ${errors.join('; ')}`);
    try {
      await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
        ts: admin.firestore.FieldValue.serverTimestamp(),
        actor: 'monthly-verify-cron',
        action: 'backup.verify-failed',
        source: 'monthlyBackupVerify',
        note: `Random backup ${id} failed verification: ${errors.join('; ')}`,
      });
    } catch {}
  }
);

// Frequent (every-15-minute) snapshots — added after the array-degradation
// incident on 2026-04-29 demonstrated that a single daily backup is too
// coarse: 1.5 hours of work was lost between the 03:00 UTC daily snapshot
// and the moment state corruption occurred. With 15-minute frequents,
// the worst-case data loss window drops from ~24 hours to ~15 minutes.
//
// Storage cost: at ~524 KB per snapshot × 96 snapshots/day = 50 MB/day,
// × 48-hour retention = 96 MB resident in Firestore. Pennies/month.
//
// Doc id format `{YYYY-MM-DD}-{HHMM}` (UTC) — distinct from the daily
// (`{YYYY-MM-DD}` only) and from manual (`{YYYY-MM-DD}-manual-{HHMMSS}`)
// so the UI can badge each kind. Pruning logic below keeps frequent
// backups for FREQUENT_RETENTION_HOURS only; daily/manual untouched.
const FREQUENT_RETENTION_HOURS = 48;

function _frequentBackupId(d = new Date()) {
  const date = _backupDateId(d);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${date}-${hh}${mm}`;
}

// Prune frequent backups (id matches /^\d{4}-\d{2}-\d{2}-\d{4}$/) older
// than retention. Daily and manual snapshots are NOT touched here — they
// have their own 90-day prune in _pruneOldBackups.
async function _pruneOldFrequentBackups({ workspaceId, retentionHours = FREQUENT_RETENTION_HOURS }) {
  const cutoffMs = Date.now() - retentionHours * 60 * 60 * 1000;
  const col = db.collection(`workspaces/${workspaceId}/backups`);
  // Frequent ids sort lexicographically by datetime, so we can range-query
  // by id. Lower bound = epoch start; upper bound = cutoff prefix.
  const cutoffDate = new Date(cutoffMs);
  const cutoffId = _frequentBackupId(cutoffDate);
  // Filter to only frequent-shaped ids by limiting query end at the
  // cutoff datetime — but id range alone catches all sorts of
  // shorter-id backups too, so post-filter in code by regex.
  const snap = await col
    .where(admin.firestore.FieldPath.documentId(), '<', cutoffId)
    .select()
    .limit(450)
    .get();
  if (snap.empty) return { deleted: 0 };
  const FREQ_ID = /^\d{4}-\d{2}-\d{2}-\d{4}$/;
  const batch = db.batch();
  let n = 0;
  snap.docs.forEach(d => {
    if (FREQ_ID.test(d.id)) { batch.delete(d.ref); n++; }
  });
  if (n === 0) return { deleted: 0 };
  await batch.commit();
  return { deleted: n, hasMore: snap.size === 450 };
}

exports.frequentBackupSnapshot = onSchedule(
  {
    schedule: '*/15 * * * *',      // every 15 minutes UTC
    timeZone: 'UTC',
    memory: '512MiB',
    timeoutSeconds: 120,
  },
  async () => {
    try {
      const docId = _frequentBackupId();
      const result = await _writeBackupSnapshot({
        workspaceId: WORKSPACE_ID,
        docId,
        capturedBy: 'system',
        reason: 'frequent-cron-15min',
      });
      logger.info(`[backup] frequent snapshot ${result.docId} written (${result.sizeBytes}B, rev ${result._rev})`);
      // Prune ONLY frequent backups older than retention. Daily prune
      // runs separately from dailyBackupSnapshot and uses _pruneOldBackups.
      const pruned = await _pruneOldFrequentBackups({ workspaceId: WORKSPACE_ID });
      if (pruned.deleted) logger.info(`[backup] pruned ${pruned.deleted} frequent backups older than ${FREQUENT_RETENTION_HOURS}h`);
    } catch (err) {
      logger.error('[backup] frequent snapshot failed:', err);
      throw err;
    }
  }
);

exports.dailyBackupSnapshot = onSchedule(
  {
    schedule: '0 3 * * *',         // 03:00 UTC daily (off-peak in all US zones)
    timeZone: 'UTC',
    memory: '512MiB',
    timeoutSeconds: 300,
  },
  async () => {
    try {
      const docId = _backupDateId();
      const result = await _writeBackupSnapshot({
        workspaceId: WORKSPACE_ID,
        docId,
        capturedBy: 'system',
        reason: 'daily-cron',
      });
      logger.info(`[backup] daily snapshot ${result.docId} written (${result.sizeBytes}B, rev ${result._rev})`);
      const prune = await _pruneOldBackups({ workspaceId: WORKSPACE_ID });
      if (prune.deleted) logger.info(`[backup] pruned ${prune.deleted} backups older than 90d`);
    } catch (err) {
      logger.error('[backup] daily snapshot failed:', err);
      throw err;  // surface to Cloud Scheduler retry logic
    }
  }
);

// Operator-triggered manual snapshot — used by the "Take backup now"
// button in Settings, and automatically by the restore flow as a
// safety pre-image. Returns { docId, sizeBytes, _rev }.
exports.takeManualBackup = onCall(
  {memory: '512MiB', timeoutSeconds: 60},
  async (req) => {
    await requireEditor(req.auth);
    // Rate limit — at most 10 manual backups per 24h workspace-wide.
    // Each backup snapshots the full state body; without this an
    // operator scripting the button could fill Firestore with
    // gigabytes of redundant snapshots in minutes.
    const MANUAL_BACKUP_PER_DAY = 10;
    {
      const d = new Date();
      const dayKey = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
      const counterRef = db.doc(`workspaces/${WORKSPACE_ID}/rateLimits/manualBackup_${dayKey}`);
      const count = await db.runTransaction(async (tx) => {
        const snap = await tx.get(counterRef);
        const cur = snap.exists ? (snap.data().count || 0) : 0;
        const next = cur + 1;
        if (next > MANUAL_BACKUP_PER_DAY) return next;
        tx.set(counterRef, { count: next, dayKey, _exp: Date.now() + 48 * 60 * 60 * 1000 });
        return next;
      });
      if (count > MANUAL_BACKUP_PER_DAY) {
        throw new HttpsError('resource-exhausted',
          `Manual backup limit reached for today (${MANUAL_BACKUP_PER_DAY}/day). The daily 03:00 UTC cron still runs unaffected.`);
      }
    }
    const reason = (req.data && req.data.reason) || 'manual';
    // Always-unique doc id with HHMMSS suffix — never collides with the
    // daily snapshot or with another manual trigger from the same day.
    const now = new Date();
    const time = String(now.getUTCHours()).padStart(2, '0')
               + String(now.getUTCMinutes()).padStart(2, '0')
               + String(now.getUTCSeconds()).padStart(2, '0');
    const docId = `${_backupDateId(now)}-manual-${time}`;
    const capturedBy = req.auth?.token?.email || req.auth?.uid || 'unknown';
    const result = await _writeBackupSnapshot({
      workspaceId: WORKSPACE_ID,
      docId,
      capturedBy,
      reason,
    });
    return result;
  }
);

// List all backup docs (most recent first) — feeds the Settings UI.
// Returns lightweight metadata (no full state body) so the list is
// snappy even with 90+ daily backups. The full state is fetched only
// when the operator clicks Restore.
exports.listBackups = onCall(
  {memory: '256MiB', timeoutSeconds: 30},
  async (req) => {
    await requireEditor(req.auth);
    const col = db.collection(`workspaces/${WORKSPACE_ID}/backups`);
    // Doc IDs are YYYY-MM-DD (and YYYY-MM-DD-manual-HHMM) — lex-sortable.
    // Sorting server-side by __name__ DESC requires a custom Firestore
    // index; backup count is bounded by 90-day retention so it's
    // cheaper to fetch all and sort in JS than to maintain the index.
    //
    // CRITICAL: use .select() to project ONLY metadata fields — without it
    // Firestore returns the full doc including `state` (the entire workspace
    // JSON snapshot, can be MBs) and 90 docs blow past the 256 MiB limit.
    const snap = await col
      .select('capturedAt', 'capturedBy', 'reason', '_rev', 'sizeBytes')
      .get();
    const items = snap.docs.map(d => {
      const x = d.data() || {};
      return {
        id: d.id,
        capturedAt: x.capturedAt?.toMillis?.() || null,
        capturedBy: x.capturedBy || '',
        reason: x.reason || '',
        _rev: x._rev || 0,
        sizeBytes: x.sizeBytes || 0,
      };
    });
    items.sort((a, b) => b.id.localeCompare(a.id));
    return { items: items.slice(0, 120) };
  }
);

// =========================================================================
// ===== Audit log =========================================================
// Append-only record of consequential changes — payment status flips,
// invoice sends, lease changes, bulk operations. Lets the operator
// answer "I marked X paid, why is it now showing Y?" without guessing.
//
// Storage: /workspaces/{wsId}/audit/{auto-id}
//   { ts, actor, action, unitId, ym, before, after, note, source }
//
// Wide-net: any caller can record an entry by hitting the recordAudit
// callable. The schema is intentionally loose so different feature areas
// can attach what they need without churn. Clients pre-pack `before` /
// `after` from their own state — server doesn't try to compute diffs.
//
// Retention: indefinite for now (low write volume). Can prune later.
// =========================================================================
exports.recordAudit = onCall(
  {memory: '256MiB', timeoutSeconds: 30},
  async (req) => {
    await requireEditor(req.auth);
    const d = req.data || {};
    // Whitelist fields — silently drop unknowns so a buggy client
    // can't pollute the log with arbitrary blobs.
    const entry = {
      ts: admin.firestore.FieldValue.serverTimestamp(),
      actor: req.auth?.token?.email || req.auth?.uid || 'unknown',
      actorUid: req.auth?.uid || null,
      action: String(d.action || 'unknown').slice(0, 64),
      source: String(d.source || 'app').slice(0, 32),
    };
    if (d.unitId)    entry.unitId   = String(d.unitId).slice(0, 32);
    if (d.buildingId) entry.buildingId = String(d.buildingId).slice(0, 32);
    if (d.floorId)   entry.floorId  = String(d.floorId).slice(0, 32);
    if (d.ym)        entry.ym       = String(d.ym).slice(0, 7);
    if (d.note)      entry.note     = String(d.note).slice(0, 500);
    if (d.invoiceId) entry.invoiceId = String(d.invoiceId).slice(0, 64);
    if (d.amount != null) entry.amount = +d.amount || 0;
    // Trace ID — passed through stripeCallable's wrapper so the audit
    // entry can be cross-referenced with client logs and CF logs for
    // the same user action.
    if (d._traceId && /^t_[A-Za-z0-9_-]{4,40}$/.test(String(d._traceId))) {
      entry.traceId = String(d._traceId);
    }
    // before/after are JSON-serializable snapshots — clamp size to
    // protect Firestore (10KB plenty for a single payment record).
    const clamp = (v) => {
      if (v == null) return v;
      const json = JSON.stringify(v);
      if (json.length > 10240) return { _truncated: true, preview: json.slice(0, 1024) };
      return v;
    };
    if (d.before !== undefined) entry.before = clamp(d.before);
    if (d.after !== undefined)  entry.after  = clamp(d.after);
    const ref = await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add(entry);
    return { id: ref.id };
  }
);

// List recent audit entries with optional filters. Pagination via
// startAfter (last seen ts as ms). Default limit 50.
exports.listAuditEntries = onCall(
  {memory: '256MiB', timeoutSeconds: 30},
  async (req) => {
    await requireEditor(req.auth);
    const d = req.data || {};
    const limit = Math.min(Math.max(+d.limit || 50, 1), 500);
    // Validate + cap filter strings — without this an attacker (or
    // a buggy client) could pass huge strings that bloat the Firestore
    // query and waste read quota. 64 chars is comfortably above legit
    // unit IDs / action names / email addresses.
    const safeStr = (v, max) => {
      if (v == null) return null;
      const s = String(v).slice(0, max || 64).trim();
      return s ? s : null;
    };
    const fUnit  = safeStr(d.unitId, 32);
    const fAction = safeStr(d.action, 64);
    const fActor = safeStr(d.actor, 200);
    let q = db.collection(`workspaces/${WORKSPACE_ID}/audit`)
      .orderBy('ts', 'desc');
    if (fUnit)   q = q.where('unitId', '==', fUnit);
    if (fAction) q = q.where('action', '==', fAction);
    if (fActor)  q = q.where('actor', '==', fActor);
    if (d.startAfterMs && Number.isFinite(+d.startAfterMs)) {
      const ts = admin.firestore.Timestamp.fromMillis(+d.startAfterMs);
      q = q.startAfter(ts);
    }
    q = q.limit(limit);
    const snap = await q.get();
    const items = snap.docs.map(doc => {
      const x = doc.data() || {};
      return {
        id: doc.id,
        ts: x.ts?.toMillis?.() || null,
        actor: x.actor || '',
        action: x.action || '',
        source: x.source || '',
        unitId: x.unitId || '',
        buildingId: x.buildingId || '',
        floorId: x.floorId || '',
        ym: x.ym || '',
        note: x.note || '',
        invoiceId: x.invoiceId || '',
        amount: x.amount || 0,
        before: x.before == null ? null : x.before,
        after: x.after == null ? null : x.after,
      };
    });
    return { items, hasMore: items.length === limit };
  }
);

// Restore a chosen backup. Steps:
//   1. Take a pre-restore safety snapshot of CURRENT state so the
//      restore can itself be rolled back.
//   2. Read the chosen backup's state body.
//   3. Overwrite live state — bumping _rev so all connected clients
//      pick up the change via their onSnapshot listeners.
//
// Caller passes { backupId } — the doc id from listBackups.
// Returns { restoredFrom, preRestoreBackupId, _rev }.
exports.restoreBackup = onCall(
  {memory: '512MiB', timeoutSeconds: 120},
  async (req) => {
    await requireEditor(req.auth);
    const backupId = (req.data && req.data.backupId) || '';
    if (!backupId || typeof backupId !== 'string') {
      throw new HttpsError('invalid-argument', 'backupId required');
    }
    // Read through the chunk-aware loader so chunked backups are
    // transparently reassembled. Older inline backups bypass the
    // subcollection read.
    const backupBody = await _readBackupSnapshotBody(WORKSPACE_ID, backupId);
    if (!backupBody) {
      throw new HttpsError('not-found', `backup ${backupId} not found`);
    }
    if (!backupBody.state) {
      throw new HttpsError('failed-precondition', 'backup has no state body');
    }
    // Run schema migrations BEFORE writing live state — converts older
    // backup shapes to today's schema so missing fields don't crash
    // current code paths.
    backupBody.state = migrateBackupState(
      backupBody.state,
      backupBody._schemaVersion || 0
    );
    // Step 1: pre-restore safety snapshot.
    const now = new Date();
    const time = String(now.getUTCHours()).padStart(2, '0')
               + String(now.getUTCMinutes()).padStart(2, '0')
               + String(now.getUTCSeconds()).padStart(2, '0');
    const preId = `${_backupDateId(now)}-prerestore-${time}`;
    const capturedBy = req.auth?.token?.email || req.auth?.uid || 'unknown';
    let preResult = null;
    try {
      preResult = await _writeBackupSnapshot({
        workspaceId: WORKSPACE_ID,
        docId: preId,
        capturedBy,
        reason: `pre-restore safety (target: ${backupId})`,
      });
    } catch (err) {
      // If the live state doesn't exist (fresh workspace), proceed
      // without a pre-restore snapshot — there's nothing to back up.
      if (!/no state document/i.test(err.message || '')) throw err;
      logger.warn('[restore] no live state to back up, proceeding');
    }
    // Sanitize the restored state body BEFORE writing — strip transient
    // fields that would otherwise replay stale signals into every
    // connected client:
    //   - _invoiceBus: webhook signal that flips invoice rows in clients'
    //     UIs. Stale value would cause clients to mark a current invoice
    //     paid/failed based on a 6-month-old event.
    //   - _restoredFrom / _restoredAt: bookkeeping that belongs to live
    //     state, not to a backup body (the backup itself didn't restore
    //     anything).
    const sanitizedBody = Object.assign({}, backupBody.state || {});
    if (sanitizedBody._invoiceBus !== undefined) delete sanitizedBody._invoiceBus;
    if (sanitizedBody._restoredFrom !== undefined) delete sanitizedBody._restoredFrom;
    if (sanitizedBody._restoredAt !== undefined) delete sanitizedBody._restoredAt;

    // Step 2+3: write the restored body INSIDE a transaction so any
    // concurrent client write that lands between our pre-restore
    // snapshot and the overwrite is detected and rejected. Without
    // the transaction, an operator typing into a unit panel during
    // the ~50ms restore window would have their change silently
    // dropped (it'd only exist in the pre-restore snapshot but not
    // in the new live state).
    const stateRef = db.doc(`workspaces/${WORKSPACE_ID}/data/state`);
    const newRev = await db.runTransaction(async (tx) => {
      const liveSnap = await tx.get(stateRef);
      const liveRev = liveSnap.exists ? (liveSnap.data()._rev || 0) : 0;
      const next = liveRev + 1;
      tx.set(stateRef, {
        _rev: next,
        _updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        _updatedBy: req.auth?.uid || 'restore',
        _restoredFrom: backupId,
        _restoredAt: admin.firestore.FieldValue.serverTimestamp(),
        state: sanitizedBody,
      });
      return next;
    });
    logger.info(`[restore] live state replaced from backup ${backupId} (new rev ${newRev}, by ${capturedBy})`);

    // Audit — restore is the highest-impact admin action; we must have
    // a permanent server-side record of who restored what and when.
    try {
      await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
        ts: admin.firestore.FieldValue.serverTimestamp(),
        actor: capturedBy,
        actorUid: req.auth?.uid || null,
        action: 'state.restore',
        source: 'restoreBackup-cf',
        note: `Restored live state from backup ${backupId}; pre-restore safety snapshot: ${preResult ? preResult.docId : '(none)'}`,
        before: { _rev: (await stateRef.get()).data()?._rev || 0 },
        after: { _rev: newRev, restoredFrom: backupId },
      });
    } catch (auditErr) {
      logger.warn('[restore] audit write failed (continuing): ' + auditErr.message);
    }
    return {
      restoredFrom: backupId,
      preRestoreBackupId: preResult ? preResult.docId : null,
      _rev: newRev,
    };
  }
);

// =========================================================================
// ===== PII / GDPR — Right to Be Forgotten ===============================
// Cloud Function that scrubs personally-identifiable information for a
// tenant who's exercised their GDPR / CCPA "right to be forgotten" or
// for compliance-driven retention reduction.
//
// What it does:
//   1. Walks every unit's tenantHistory[] and clears PII fields (email,
//      tel, tenantAddress, tenantDocs URLs) for snapshots matching
//      the target email. Preserves financial fields (amounts, dates,
//      lease terms) — those are legitimate business records the
//      landlord must retain for tax/audit purposes.
//   2. Removes the email→customerId entry from state.stripeCustomers.
//   3. Tags the matching Stripe customer with metadata.gdpr_erased=true
//      so future Stripe Dashboard actions show the redaction status.
//   4. Writes an audit entry recording who erased whom + when.
//
// The CURRENT live tenant on a unit (if email matches) is NOT erased
// automatically — the operator must move them out first. This prevents
// accidental erasure of an active tenant.
// =========================================================================
exports.eraseTenantPii = onCall(
  {secrets: [STRIPE_SECRET_KEY, STRIPE_TEST_KEY], memory: '512MiB', timeoutSeconds: 60},
  async (req) => {
    await requireEditor(req.auth);
    const emailRaw = (req.data && req.data.email) || '';
    const email = String(emailRaw).toLowerCase().trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpsError('invalid-argument', 'Valid email required');
    }
    const reason = String((req.data && req.data.reason) || 'gdpr-request').slice(0, 200);
    const actor = req.auth?.token?.email || req.auth?.uid || 'unknown';

    // Refuse to erase the currently-active tenant on any unit. Operator
    // must move the tenant out (which moves their info into tenantHistory)
    // before we can scrub.
    const stateRef = db.doc(`workspaces/${WORKSPACE_ID}/data/state`);
    const liveSnap = await stateRef.get();
    if (!liveSnap.exists) throw new HttpsError('not-found', 'No state to erase from');
    const live = liveSnap.data().state || {};
    const activeMatches = [];
    for (const b of (live.buildings || [])) {
      for (const f of (b.floors || [])) {
        for (const u of (f.units || [])) {
          if ((u.email || '').toLowerCase().trim() === email) {
            activeMatches.push(`Suite ${u.id}`);
          }
        }
      }
    }
    if (activeMatches.length > 0) {
      throw new HttpsError('failed-precondition',
        `Cannot erase: tenant is still ACTIVE on ${activeMatches.join(', ')}. ` +
        `Move them out (Unit menu → Move out tenant) first, then run erase again.`);
    }

    // Mutate within a transaction so concurrent client writes can't
    // re-introduce PII between read and write.
    let scrubCount = 0;
    let stripeCustRemoved = false;
    let stripeCustomerId = null;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(stateRef);
      if (!snap.exists) return;
      const data = snap.data();
      const state = data.state || {};
      // Walk tenantHistory[] and scrub PII on matching snapshots.
      for (const b of (state.buildings || [])) {
        for (const f of (b.floors || [])) {
          for (const u of (f.units || [])) {
            if (!Array.isArray(u.tenantHistory)) continue;
            for (const h of u.tenantHistory) {
              if ((h.email || '').toLowerCase().trim() === email) {
                // Preserve financial fields; redact PII.
                h.email = '[redacted]';
                h.tel = '';
                h.tenantAddress = '';
                if (Array.isArray(h.tenantDocs)) h.tenantDocs = [];
                h.gdprErasedAt = new Date().toISOString();
                h.gdprErasedBy = actor;
                h.gdprErasedReason = reason;
                scrubCount++;
              }
            }
          }
        }
      }
      // Drop email→customer mapping.
      if (state.stripeCustomers && state.stripeCustomers[email]) {
        stripeCustomerId = state.stripeCustomers[email].customerId || null;
        delete state.stripeCustomers[email];
        stripeCustRemoved = true;
      }
      const newRev = (data._rev || 0) + 1;
      tx.set(stateRef, {
        _rev: newRev,
        _updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        _updatedBy: req.auth?.uid || 'erase',
        state,
      });
    });

    // Tag the Stripe customer (best-effort — failure shouldn't block
    // the local scrub).
    if (stripeCustomerId) {
      try {
        const stripe = getStripe();
        await stripe.customers.update(stripeCustomerId, {
          metadata: { gdpr_erased: 'true', gdpr_erased_at: new Date().toISOString() },
        });
      } catch (e) {
        logger.warn(`[eraseTenantPii] could not tag Stripe customer ${stripeCustomerId}: ${e.message}`);
      }
    }

    // Audit — required for compliance proof.
    try {
      await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
        ts: admin.firestore.FieldValue.serverTimestamp(),
        actor,
        actorUid: req.auth?.uid || null,
        action: 'pii.erase',
        source: 'eraseTenantPii',
        note: `Erased PII for ${email} · scrubbed ${scrubCount} history snapshot(s)` + (stripeCustRemoved ? ' · removed Stripe customer link' : '') + ' · reason: ' + reason,
      });
    } catch (e) {
      logger.warn('[eraseTenantPii] audit write failed: ' + e.message);
    }

    return {
      email,
      historySnapshotsScrubbed: scrubCount,
      stripeCustomerLinkRemoved: stripeCustRemoved,
      stripeCustomerId: stripeCustomerId || null,
    };
  }
);

// =========================================================================
// ===== Stripe Financial Connections — Bank Feed (Phase 1: Connect) =======
// Operator connects their business bank (Capital One etc.) so the app can
// later pull incoming wire/ACH/check deposits and match them against open
// invoices automatically. Phase 1 is OAuth onboarding only — transaction
// polling, matcher, and review board land in subsequent phases.
//
// Flow:
//   1. Operator clicks "Connect bank" in Settings → Bank Connections.
//   2. Client calls connectBankAccount → backend creates a Stripe FC
//      Session bound to the per-workspace Operator Customer (separate
//      from tenant customers in state.stripeCustomers).
//   3. Client opens Stripe.js widget with the returned client_secret;
//      operator picks bank (Capital One Spark Business), authenticates,
//      grants permissions.
//   4. Widget returns success → client calls finalizeBankConnection
//      with the session id. Backend re-fetches the session, reads the
//      confirmed account ids, and appends one record per new account
//      to state.bankConnections[].
//   5. Disconnect: stripe.financialConnections.accounts.disconnect →
//      mark local record status='disconnected'.
// =========================================================================

// Get-or-create the per-workspace Stripe Customer that owns the FC
// account-holder relationship. This Customer represents the operator's
// business and is distinct from per-tenant Customers in
// state.stripeCustomers. Reused across all Bank Feed sessions so all
// connected accounts roll up to one Stripe-side owner.
async function _ensureOperatorCustomer(state, operatorEmail) {
  if (state.operatorStripeCustomerId) return state.operatorStripeCustomerId;
  const stripe = getStripe();
  const cust = await stripe.customers.create({
    email: operatorEmail || undefined,
    name: `SuitesForAll Operator (${WORKSPACE_ID})`,
    description: 'Owner Customer for Financial Connections (bank feed)',
    metadata: {
      workspaceId: WORKSPACE_ID,
      role: 'operator',
      source: 'suitesforall-bank-feed',
    },
  });
  await mutateWorkspaceState((s) => {
    s.operatorStripeCustomerId = cust.id;
  });
  logger.info(`[bank-feed] created operator customer ${cust.id} for ${operatorEmail || '(no email)'}`);
  return cust.id;
}

exports.connectBankAccount = onCall(
  {secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 30},
  async (req) => {
    await requireEditor(req.auth);
    const stripe = getStripe();
    const state = await readWorkspaceState();
    const operatorEmail = (req.auth?.token?.email || '').toLowerCase();
    const customerId = await _ensureOperatorCustomer(state, operatorEmail);
    const session = await stripe.financialConnections.sessions.create({
      account_holder: { type: 'customer', customer: customerId },
      // Permissions:
      //   transactions  — required (this is the whole point of Phase 2+)
      //   balances      — useful to show operator the current balance
      //   ownership     — verifies account holder name; helps with matching
      //                   wires whose memo line drops the company name.
      permissions: ['transactions', 'balances', 'ownership'],
      filters: { countries: ['US'] },
    });
    logger.info(`[bank-feed] connectBankAccount: created FC session ${session.id} for operator ${operatorEmail}`);
    return {
      clientSecret: session.client_secret,
      sessionId: session.id,
    };
  }
);

exports.finalizeBankConnection = onCall(
  {secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 30},
  async (req) => {
    await requireEditor(req.auth);
    const sessionId = req.data?.sessionId;
    if (!sessionId) {
      throw new HttpsError('invalid-argument', 'sessionId is required');
    }
    const stripe = getStripe();
    const session = await stripe.financialConnections.sessions.retrieve(sessionId, {
      expand: ['accounts'],
    });
    const accounts = session.accounts?.data || [];
    if (!accounts.length) {
      logger.warn(`[bank-feed] finalizeBankConnection: session ${sessionId} returned 0 accounts (operator likely cancelled)`);
      return { connected: 0, accounts: [] };
    }
    const operatorEmail = (req.auth?.token?.email || '').toLowerCase();
    const newConnections = [];
    await mutateWorkspaceState((s) => {
      s.bankConnections = s.bankConnections || [];
      for (const acc of accounts) {
        // Dedup pass 1: same Stripe FC account id → reactivate.
        let existing = s.bankConnections.find(c => c.stripeFcAccountId === acc.id);
        // Dedup pass 2: re-connecting the same bank typically gets a
        // *new* FC account ID from Stripe (the old one was disconnected).
        // Match by institution + last4 against any disconnected record so
        // the operator's Reconnect flow replaces the ghost cleanly instead
        // of leaving a dead row + a fresh duplicate.
        if (!existing) {
          const last4 = (acc.last4 || '').toLowerCase();
          const inst = (acc.institution_name || '').toLowerCase();
          if (last4 && inst) {
            existing = s.bankConnections.find(c =>
              c.status === 'disconnected'
              && (c.accountLast4 || '').toLowerCase() === last4
              && (c.institutionName || '').toLowerCase() === inst
            );
            if (existing) {
              // Replace ghost: keep its lastPolledAt watermark but swap in
              // the new FC account id so subsequent pulls/disconnects work.
              existing.stripeFcAccountId = acc.id;
              existing.id = 'bc_' + acc.id;
            }
          }
        }
        if (existing) {
          existing.status = acc.status || 'active';
          existing.permissions = acc.permissions || existing.permissions || [];
          existing.reconnectedAt = new Date().toISOString();
          delete existing.disconnectedAt;
          continue;
        }
        const conn = {
          id: 'bc_' + acc.id,
          stripeFcAccountId: acc.id,
          institutionName: acc.institution_name || 'Unknown bank',
          accountLast4: acc.last4 || '',
          accountCategory: acc.category || '',          // 'cash' | 'credit' | 'investment' | 'other'
          accountSubcategory: acc.subcategory || '',    // 'checking' | 'savings' | etc.
          displayName: acc.display_name
            || `${acc.institution_name || 'Bank'} ····${acc.last4 || '????'}`,
          permissions: acc.permissions || [],
          status: acc.status || 'active',
          connectedAt: new Date().toISOString(),
          connectedBy: operatorEmail,
          lastPolledAt: null,
        };
        s.bankConnections.push(conn);
        newConnections.push(conn);
      }
    });
    logger.info(`[bank-feed] finalizeBankConnection: linked ${newConnections.length} new account(s), reactivated ${accounts.length - newConnections.length} (session ${sessionId})`);
    // Trigger transaction refresh for every linked/reactivated account so
    // Stripe starts preparing transactions immediately. Without this the
    // first poll throws `financial_connections_no_successful_transaction_refresh`
    // and returns 0 transactions even when the account has months of history.
    // Refresh is async on Stripe's side (1-2 min); we don't await per-account
    // success — just kick it off so it's ready by next poll.
    for (const acc of accounts) {
      await _ensureTransactionRefresh(stripe, acc.id);
    }
    return {
      connected: newConnections.length,
      reactivated: accounts.length - newConnections.length,
      accounts: newConnections,
    };
  }
);

exports.disconnectBankAccount = onCall(
  {secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 30},
  async (req) => {
    await requireEditor(req.auth);
    const fcAccountId = req.data?.stripeFcAccountId;
    if (!fcAccountId) {
      throw new HttpsError('invalid-argument', 'stripeFcAccountId is required');
    }
    const stripe = getStripe();
    let detached = false;
    let detachError = null;
    try {
      await stripe.financialConnections.accounts.disconnect(fcAccountId);
      detached = true;
    } catch (e) {
      // If Stripe says it's already detached / 404, that's fine — we
      // still proceed to clean up our local state record. Surface the
      // error so the client can show a softer "already disconnected"
      // notice rather than failing hard.
      detachError = e.message || String(e);
      logger.warn(`[bank-feed] disconnectBankAccount: Stripe detach failed (${detachError}) — proceeding to local cleanup`);
    }
    await mutateWorkspaceState((s) => {
      if (!Array.isArray(s.bankConnections)) return;
      const c = s.bankConnections.find(x => x.stripeFcAccountId === fcAccountId);
      if (c) {
        c.status = 'disconnected';
        c.disconnectedAt = new Date().toISOString();
      }
    });
    return { detached, detachError };
  }
);

// Hard-delete a disconnected bank-connection record from state. Operator
// uses this to clean up "ghost" rows from cancelled connect flows or
// long-gone accounts. SAFETY: only deletes if status === 'disconnected' so
// an active feed can never be wiped by accident.
exports.removeBankConnection = onCall(
  {timeoutSeconds: 30},
  async (req) => {
    await requireEditor(req.auth);
    const fcAccountId = req.data?.stripeFcAccountId;
    if (!fcAccountId) {
      throw new HttpsError('invalid-argument', 'stripeFcAccountId is required');
    }
    let removed = false;
    let blockedActive = false;
    await mutateWorkspaceState((s) => {
      if (!Array.isArray(s.bankConnections)) return;
      const idx = s.bankConnections.findIndex(c => c.stripeFcAccountId === fcAccountId);
      if (idx < 0) return;
      if (s.bankConnections[idx].status !== 'disconnected') {
        blockedActive = true;
        return;
      }
      s.bankConnections.splice(idx, 1);
      removed = true;
    });
    if (blockedActive) {
      throw new HttpsError('failed-precondition',
        'Account is still active — disconnect it first, then remove.');
    }
    logger.info(`[bank-feed] removeBankConnection: deleted record ${fcAccountId} (removed=${removed})`);
    return { removed };
  }
);

// Diagnostic: pull the live Stripe FC account state for a connection so the
// operator can see why transactions aren't arriving (permissions missing,
// refresh stuck, account inactive, etc.) without needing the Stripe Dashboard.
exports.diagnoseBankAccount = onCall(
  {secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 30},
  async (req) => {
    await requireEditor(req.auth);
    const fcAccountId = req.data?.stripeFcAccountId;
    if (!fcAccountId) {
      throw new HttpsError('invalid-argument', 'stripeFcAccountId is required');
    }
    const stripe = getStripe();
    let acc = null;
    try {
      acc = await stripe.financialConnections.accounts.retrieve(fcAccountId);
    } catch (err) {
      throw new HttpsError('not-found', `Stripe could not retrieve ${fcAccountId}: ${err.message || err}`);
    }
    // Trigger a fresh refresh + capture its returned status.
    let refreshResult = null;
    try {
      refreshResult = await stripe.financialConnections.accounts.refresh(
        fcAccountId,
        { features: ['transactions'] }
      );
    } catch (err) {
      refreshResult = { error: err.message || String(err), code: err.code || null };
    }
    // Quick try at listing 1 transaction to see if list now works.
    let listSample = null;
    try {
      const page = await stripe.financialConnections.transactions.list({
        account: fcAccountId,
        limit: 5,
      });
      listSample = {
        ok: true,
        count: page.data.length,
        sample: page.data.slice(0, 2).map(t => ({
          id: t.id, amount: t.amount, description: t.description,
          transacted_at: t.transacted_at, status: t.status,
        })),
      };
    } catch (err) {
      listSample = { ok: false, error: err.message || String(err), code: err.code || null };
    }
    const summary = {
      id: acc.id,
      institution: acc.institution_name,
      last4: acc.last4,
      category: acc.category,
      subcategory: acc.subcategory,
      status: acc.status,
      permissions: acc.permissions || [],
      hasTransactionsPermission: (acc.permissions || []).includes('transactions'),
      transaction_refresh: acc.transaction_refresh || null,
      balance_refresh: acc.balance_refresh || null,
      ownership_refresh: acc.ownership_refresh || null,
      latestRefreshTrigger: refreshResult,
      listSample,
    };
    logger.info(`[bank-feed] diagnoseBankAccount ${fcAccountId}: perms=${summary.permissions.join(',')} txnRefresh=${JSON.stringify(summary.transaction_refresh)} listOk=${listSample.ok} listCount=${listSample.count || 0}`);
    return summary;
  }
);

// Reconcile state.bankConnections against Stripe's authoritative list of
// FC accounts attached to our operator Customer. Catches "ghost" accounts
// linked in Stripe but missing from our state (e.g. from earlier sessions
// that landed at Stripe but failed to round-trip into our state) and
// surfaces real-time status changes (Stripe can mark an account inactive
// without us calling disconnect).
exports.syncBankConnections = onCall(
  {secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 30},
  async (req) => {
    await requireEditor(req.auth);
    const stripe = getStripe();
    const state = await readWorkspaceState();
    const customerId = state.operatorStripeCustomerId;
    if (!customerId) {
      // Nothing to sync — operator has never opened the FC widget.
      return { added: 0, updated: 0, total: 0, accounts: [] };
    }
    // Page through every FC account attached to this customer.
    const stripeAccounts = [];
    let startingAfter = undefined;
    for (;;) {
      const page = await stripe.financialConnections.accounts.list({
        account_holder: { customer: customerId },
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      stripeAccounts.push(...page.data);
      if (!page.has_more) break;
      startingAfter = page.data[page.data.length - 1].id;
    }
    let added = 0, updated = 0;
    const operatorEmail = (req.auth?.token?.email || '').toLowerCase();
    await mutateWorkspaceState((s) => {
      s.bankConnections = s.bankConnections || [];
      for (const acc of stripeAccounts) {
        const existing = s.bankConnections.find(c => c.stripeFcAccountId === acc.id);
        if (existing) {
          // Refresh mutable fields. Stripe is authoritative for status,
          // permissions, and last4/institution (rarely change but possible
          // after a re-auth / institution rename).
          if (existing.status !== (acc.status || existing.status)) updated++;
          existing.status = acc.status || existing.status || 'active';
          existing.permissions = acc.permissions || existing.permissions || [];
          existing.institutionName = acc.institution_name || existing.institutionName;
          existing.accountLast4 = acc.last4 || existing.accountLast4;
          existing.accountCategory = acc.category || existing.accountCategory;
          existing.accountSubcategory = acc.subcategory || existing.accountSubcategory;
          existing.lastSyncedAt = new Date().toISOString();
          continue;
        }
        s.bankConnections.push({
          id: 'bc_' + acc.id,
          stripeFcAccountId: acc.id,
          institutionName: acc.institution_name || 'Unknown bank',
          accountLast4: acc.last4 || '',
          accountCategory: acc.category || '',
          accountSubcategory: acc.subcategory || '',
          displayName: acc.display_name
            || `${acc.institution_name || 'Bank'} ····${acc.last4 || '????'}`,
          permissions: acc.permissions || [],
          status: acc.status || 'active',
          connectedAt: new Date().toISOString(),
          connectedBy: operatorEmail,
          lastPolledAt: null,
          lastSyncedAt: new Date().toISOString(),
          syncedFromStripe: true,  // marks records reconciled (not freshly OAuthed)
        });
        added++;
      }
    });
    logger.info(`[bank-feed] syncBankConnections: customer=${customerId} stripe=${stripeAccounts.length} added=${added} updated=${updated}`);
    return {
      added,
      updated,
      total: stripeAccounts.length,
      accounts: stripeAccounts.map(a => ({
        id: a.id, last4: a.last4, status: a.status, institution: a.institution_name,
      })),
    };
  }
);

// =========================================================================
// ===== Bank Feed Phase 2 — transaction polling ===========================
// Cron + on-demand puller for incoming bank transactions (rent payments,
// wire deposits, ACH credits) from connected Stripe Financial Connections
// accounts. Storage: /workspaces/{wsId}/bankTransactions/{txnId}.
//
// First connect: backfill 365 days. Subsequent polls: incremental from
// the account's lastPolledAt watermark.
//
// Per-account polling cadence is configurable via
// bankConnections[].pollIntervalHours (1, 6, 24, 168, or 0=manual-only).
// Default 24. The bankFeedScheduledPoll cron runs hourly and only polls
// accounts whose last poll is older than their interval.
// =========================================================================

const BANK_FEED_BACKFILL_DAYS = 365;

// Stripe FC requires an explicit transaction-feature refresh before
// `transactions.list` will return data on a freshly-connected account.
// Without it, `list` throws `financial_connections_no_successful_transaction_refresh`.
// Calling refresh is idempotent — Stripe coalesces concurrent requests.
async function _ensureTransactionRefresh(stripe, fcAccountId) {
  try {
    const r = await stripe.financialConnections.accounts.refresh(
      fcAccountId,
      { features: ['transactions'] }
    );
    logger.info(`[bank-feed] triggered transaction refresh ${fcAccountId}: status=${r?.transaction_refresh?.status || 'unknown'}`);
    return { ok: true, status: r?.transaction_refresh?.status || null };
  } catch (err) {
    logger.warn(`[bank-feed] transaction refresh ${fcAccountId} failed: ${err?.message || err}`);
    return { ok: false, error: err?.message || String(err) };
  }
}

// Pull every transaction Stripe FC has for an account since `sinceUnix`
// (or all-time if sinceUnix is null). Returns the count actually written
// to Firestore (excluding dedup hits). When `state` is supplied, the
// matcher runs inline against each new credit transaction.
async function _pullTransactionsForAccount({stripe, fcAccountId, sinceUnix, state}) {
  const col = db.collection(`workspaces/${WORKSPACE_ID}/bankTransactions`);
  let written = 0, skipped = 0, scanned = 0, suggested = 0;
  let startingAfter = undefined;
  let refreshTriggered = false;
  for (;;) {
    const params = {
      account: fcAccountId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
      ...(sinceUnix ? { transacted_at: { gte: sinceUnix } } : {}),
    };
    let page;
    try {
      page = await stripe.financialConnections.transactions.list(params);
    } catch (err) {
      // Stripe FC has not yet successfully refreshed transactions for this
      // account — trigger refresh and bail out so the operator's UI can show
      // a helpful "preparing" message. Next poll (cron or manual) will succeed
      // once Stripe finishes processing (typically 1-2 min).
      if (err?.code === 'financial_connections_no_successful_transaction_refresh'
          || /no_successful_transaction_refresh/i.test(err?.message || '')) {
        const r = await _ensureTransactionRefresh(stripe, fcAccountId);
        return {
          scanned, written, skipped, suggested,
          transactionRefreshTriggered: true,
          transactionRefreshStatus: r.status || 'pending',
          notice: 'Stripe is preparing transactions for this account. Try again in 1-2 minutes.',
        };
      }
      throw err;
    }
    scanned += page.data.length;
    // Batched writes — Firestore caps at 500 ops per batch; we use 100.
    const batch = db.batch();
    for (const t of page.data) {
      const ref = col.doc(t.id);
      const baseDoc = {
        id: t.id,
        accountId: t.account,
        amount: t.amount,                       // cents (negative=debit, positive=credit)
        currency: t.currency,
        description: t.description || '',
        transactedAt: t.transacted_at || null,  // unix seconds
        statusTransitions: t.status_transitions || null,
        status: t.status,                       // 'pending' | 'posted' | 'void'
        seenAt: admin.firestore.FieldValue.serverTimestamp(),
        matchState: 'unmatched',
        matchedTenantId: null,
        matchedUnitId: null,
        matchedYm: null,
        checkImageUrl: null,
      };
      // Run matcher inline if state was supplied. Skip if the txn is
      // already confirmed/dismissed (merge:true preserves those fields).
      if (state) {
        const m = _matchTransaction(state, baseDoc);
        if (m) {
          Object.assign(baseDoc, m, { matchState: 'suggested' });
          suggested++;
        }
      }
      batch.set(ref, baseDoc, { merge: true });
      written++;
    }
    if (page.data.length) await batch.commit();
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return { scanned, written, skipped, suggested };
}

// Update the watermark + call the matcher after a successful pull.
// `transactionRefreshTriggered` = poll bailed out because Stripe wasn't ready
// yet; do NOT advance lastPolledAt or backfillCompleted, otherwise next poll's
// incremental window will skip the historical transactions Stripe is about to
// land. `written > 0` flips backfillCompleted=true so we can switch from the
// 365-day backfill window to incremental polling thereafter.
async function _markAccountPolled({fcAccountId, scanned, written, transactionRefreshStatus, transactionRefreshTriggered}) {
  const nowIso = new Date().toISOString();
  await mutateWorkspaceState((s) => {
    if (!Array.isArray(s.bankConnections)) return;
    const c = s.bankConnections.find(x => x.stripeFcAccountId === fcAccountId);
    if (!c) return;
    if (transactionRefreshTriggered) {
      // Stripe wasn't ready — record the attempt but do not advance the
      // watermark, otherwise the next poll's incremental query will exclude
      // historical transactions Stripe is about to backfill.
      c.transactionRefreshStatus = transactionRefreshStatus || 'pending';
      c.lastPollScanned = scanned;
      c.lastPollWritten = written;
      return;
    }
    c.lastPolledAt = nowIso;
    c.lastPollScanned = scanned;
    c.lastPollWritten = written;
    if (written > 0) {
      // We've actually pulled real data → backfill done, future polls go
      // incremental from this lastPolledAt.
      c.backfillCompleted = true;
    }
    // Poll succeeded — clear any stale "preparing" hint regardless of
    // whether we got 0 or N transactions back.
    delete c.transactionRefreshStatus;
  });
}

// Manual / on-demand: pull a single account or all active accounts.
// Operator hits "Refresh now" in Settings, or this is invoked at the
// tail of finalizeBankConnection for the 365-day backfill.
exports.pollBankTransactions = onCall(
  {secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 300, memory: '512MiB'},
  async (req) => {
    await requireEditor(req.auth);
    const stripe = getStripe();
    const targetFcId = req.data?.stripeFcAccountId || null;  // null = poll all
    const isBackfill = req.data?.backfill === true;
    const state = await readWorkspaceState();
    const conns = (state.bankConnections || [])
      .filter(c => c.status === 'active')
      .filter(c => !targetFcId || c.stripeFcAccountId === targetFcId);
    if (!conns.length) {
      return { polled: 0, totalWritten: 0, accounts: [] };
    }
    const results = [];
    for (const c of conns) {
      // Window decision: stay in 365-day backfill mode until we've actually
      // pulled at least one transaction (`backfillCompleted`). Otherwise an
      // initial poll that happens before Stripe finishes its first refresh
      // would advance lastPolledAt to "now" and the next incremental poll
      // would query `transacted_at >= now`, missing every historical txn.
      const since = isBackfill || !c.backfillCompleted || !c.lastPolledAt
        ? Math.floor(Date.now() / 1000) - (BANK_FEED_BACKFILL_DAYS * 86400)
        : Math.floor(new Date(c.lastPolledAt).getTime() / 1000);
      try {
        const r = await _pullTransactionsForAccount({
          stripe,
          fcAccountId: c.stripeFcAccountId,
          sinceUnix: since,
          state,                         // enables inline matching
        });
        await _markAccountPolled({
          fcAccountId: c.stripeFcAccountId,
          scanned: r.scanned,
          written: r.written,
          transactionRefreshStatus: r.transactionRefreshStatus,
          transactionRefreshTriggered: r.transactionRefreshTriggered,
        });
        results.push({ fcAccountId: c.stripeFcAccountId, ...r, error: null });
        logger.info(`[bank-feed] poll ${c.stripeFcAccountId}: scanned=${r.scanned} written=${r.written} backfill=${isBackfill}${r.transactionRefreshTriggered ? ' (refresh-triggered)' : ''}`);
      } catch (err) {
        logger.error(`[bank-feed] poll ${c.stripeFcAccountId} failed:`, err);
        results.push({ fcAccountId: c.stripeFcAccountId, error: err.message || String(err) });
      }
    }
    return {
      polled: results.length,
      totalWritten: results.reduce((sum, r) => sum + (r.written || 0), 0),
      accounts: results,
    };
  }
);

// Hourly cron — checks each active connection's pollIntervalHours and
// lastPolledAt and polls if due. Default interval 24h if unset.
exports.bankFeedScheduledPoll = onSchedule(
  {
    schedule: '7 * * * *',           // every hour at :07 (offset from other crons)
    timeZone: 'UTC',
    memory: '512MiB',
    timeoutSeconds: 540,
    secrets: [STRIPE_SECRET_KEY],
  },
  async () => {
    const state = await readWorkspaceState();
    const conns = (state.bankConnections || []).filter(c => c.status === 'active');
    if (!conns.length) return;
    const now = Date.now();
    const due = conns.filter(c => {
      const intervalH = +c.pollIntervalHours;
      const interval = Number.isFinite(intervalH) ? intervalH : 24;
      if (interval === 0) return false;            // manual-only
      if (!c.lastPolledAt) return true;            // never polled
      const ageMs = now - new Date(c.lastPolledAt).getTime();
      return ageMs >= interval * 3600 * 1000;
    });
    if (!due.length) {
      logger.info(`[bank-feed] cron: 0/${conns.length} accounts due`);
      return;
    }
    const stripe = getStripe();
    let totalWritten = 0;
    for (const c of due) {
      // Same window logic as the on-demand poller: stay in 365-day backfill
      // mode until backfillCompleted=true (set by _markAccountPolled when the
      // first poll actually writes data).
      const sinceUnix = (!c.backfillCompleted || !c.lastPolledAt)
        ? Math.floor(now / 1000) - (BANK_FEED_BACKFILL_DAYS * 86400)
        : Math.floor(new Date(c.lastPolledAt).getTime() / 1000);
      try {
        const r = await _pullTransactionsForAccount({
          stripe,
          fcAccountId: c.stripeFcAccountId,
          sinceUnix,
          state,                         // enables inline matching
        });
        await _markAccountPolled({
          fcAccountId: c.stripeFcAccountId,
          scanned: r.scanned,
          written: r.written,
          transactionRefreshStatus: r.transactionRefreshStatus,
          transactionRefreshTriggered: r.transactionRefreshTriggered,
        });
        totalWritten += r.written;
        logger.info(`[bank-feed] cron ${c.stripeFcAccountId}: scanned=${r.scanned} written=${r.written}${r.transactionRefreshTriggered ? ' (refresh-triggered)' : ''}`);
      } catch (err) {
        logger.error(`[bank-feed] cron ${c.stripeFcAccountId} failed:`, err);
      }
    }
    logger.info(`[bank-feed] cron complete: ${due.length}/${conns.length} polled, ${totalWritten} new txns`);
  }
);

// Update per-account polling cadence. Operator picks from Settings UI.
exports.setBankPollInterval = onCall(
  {timeoutSeconds: 30},
  async (req) => {
    await requireEditor(req.auth);
    const fcAccountId = req.data?.stripeFcAccountId;
    const hours = +req.data?.hours;
    if (!fcAccountId) throw new HttpsError('invalid-argument', 'stripeFcAccountId is required');
    const ALLOWED = [0, 1, 6, 24, 168];
    if (!ALLOWED.includes(hours)) {
      throw new HttpsError('invalid-argument', `hours must be one of ${ALLOWED.join(',')}`);
    }
    await mutateWorkspaceState((s) => {
      if (!Array.isArray(s.bankConnections)) return;
      const c = s.bankConnections.find(x => x.stripeFcAccountId === fcAccountId);
      if (!c) return;
      c.pollIntervalHours = hours;
    });
    return { ok: true, hours };
  }
);

// =========================================================================
// ===== Bank Feed Phase 3 — auto-matcher (description → tenant) ===========
// For each incoming credit transaction, fuzzy-match the bank description
// against tenant.company / tenant.name. Strong match → 'suggested'.
// Operator confirms in the Bank Activity panel; confirmation creates the
// rent payment record. Dismiss marks as not-a-rent-payment.
// =========================================================================

function _normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- YM helpers (YYYY-MM strings) ----
function _ymForDate(d) {
  if (!d || isNaN(d)) return null;
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}`;
}
function _ymStep(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}
function _ymDueUnix(ym) {
  return Math.floor(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1) / 1000);
}

// Compute unpaid months for a unit between leaseStart and asOfYm.
// Returns [{ ym, expectedCents, dueUnix }, …]. Skips months with status='paid'.
function _unitUnpaidInvoices(u, asOfYm) {
  const out = [];
  if (!u.leaseStart) return out;
  const startD = new Date(u.leaseStart);
  const startYm = _ymForDate(startD);
  if (!startYm || startYm > asOfYm) return out;
  let endYm = asOfYm;
  if (u.until) {
    const untilYm = _ymForDate(new Date(u.until));
    if (untilYm && untilYm < endYm) endYm = untilYm;
  }
  const expectedCents = Math.round(((+u.contractRent) || (+u.rent) || 0) * 100);
  if (!expectedCents) return out;
  let ym = startYm;
  let guard = 0;
  while (ym <= endYm && guard++ < 240) {     // cap 20 years for safety
    const p = (u.payments || {})[ym];
    if (!p || p.status !== 'paid') {
      out.push({ ym, expectedCents, dueUnix: _ymDueUnix(ym) });
    }
    ym = _ymStep(ym, 1);
  }
  return out;
}

// Count past payments via check / bank-feed → "tenant historically pays by check".
function _unitCheckPaymentCount(u) {
  let n = 0;
  for (const ym of Object.keys(u.payments || {})) {
    const p = u.payments[ym];
    if (!p || p.status !== 'paid') continue;
    if (p.source === 'check' || p.source === 'bank-feed') n++;
  }
  return n;
}

// Walk state, build candidate pool. Skips non-head members of grouped leases
// (operator's mental model: one group = one lease — payment goes to head).
function _matcherCandidates(state) {
  const asOfYm = _ymForDate(new Date()) || new Date().toISOString().slice(0, 7);
  const out = [];
  for (const b of state.buildings || []) {
    for (const f of b.floors || []) {
      for (const u of f.units || []) {
        if (u.status !== 'occupied') continue;
        if (u.groupId && u.groupRole !== 'primary') continue;
        if (!u.tenant && !u.company) continue;
        const monthlyCents = Math.round(((+u.contractRent) || (+u.rent) || 0) * 100);
        out.push({
          unitId: u.id,
          buildingId: b.id,
          floorId: f.id,
          tenant: u.tenant || '',
          company: u.company || '',
          contractRent: +u.contractRent || +u.rent || 0,
          monthlyCents,
          unpaidInvoices: _unitUnpaidInvoices(u, asOfYm),
          checkPayCount: _unitCheckPaymentCount(u),
        });
      }
    }
  }
  return out;
}

// Score a single candidate against a txn using the operator's point rubric:
//   exact unpaid-invoice amount   +50
//   tenant/company in description +30 (token overlap +10 fallback)
//   single-unpaid-invoice tenant  +20
//   close-but-not-exact amount    +15  (within $20 or 2%)
//   amount === monthly rent       +15  (only if not already exact-invoice)
//   txn 1–7 days after due date   +15
//   tenant pays by check (≥2)     +10
//   ambiguity (other candidate also exact-matched)  −30  (applied later)
//
// Returns { points, breakdown:[[label,delta],...], exactInvoice|null,
//           closeInvoice|null }.
function _matchPoints(cand, txnAmountCents, txnUnix, descNorm) {
  const breakdown = [];
  let points = 0;

  // F: name match (+30) or token-overlap fallback (+10)
  const company = _normalizeForMatch(cand.company);
  const tenant = _normalizeForMatch(cand.tenant);
  if (company && descNorm.includes(company)) {
    points += 30; breakdown.push(['nameInDesc:company', 30]);
  } else if (tenant && tenant.length > 4 && descNorm.includes(tenant)) {
    points += 30; breakdown.push(['nameInDesc:tenant', 30]);
  } else {
    const descTokens = new Set(descNorm.split(' ').filter(t => t.length > 2));
    const candTokens = [...company.split(' '), ...tenant.split(' ')]
      .filter(t => t.length > 2);
    const hits = candTokens.filter(t => descTokens.has(t)).length;
    if (hits >= 2) { points += 10; breakdown.push([`tokenOverlap:${hits}`, 10]); }
  }

  // A/I: amount vs unpaid invoices
  let exactInvoice = null, closeInvoice = null;
  for (const inv of cand.unpaidInvoices) {
    if (txnAmountCents === inv.expectedCents) { exactInvoice = inv; break; }
    const tol = Math.max(2000, Math.round(inv.expectedCents * 0.02));
    if (!closeInvoice && Math.abs(txnAmountCents - inv.expectedCents) <= tol) {
      closeInvoice = inv;
    }
  }
  if (exactInvoice) {
    points += 50; breakdown.push(['unpaidInvoiceExact', 50]);
  } else if (closeInvoice) {
    points += 15; breakdown.push(['unpaidInvoiceClose', 15]);
  }

  // E: amount === monthly rent (skip if already counted as exact-invoice)
  if (!exactInvoice && cand.monthlyCents && txnAmountCents === cand.monthlyCents) {
    points += 15; breakdown.push(['monthlyRentExact', 15]);
  }

  // C: due-date window 1–7 days after the matched invoice's 1st-of-month
  const ref = exactInvoice || closeInvoice;
  if (ref && txnUnix) {
    const daysAfter = (txnUnix - ref.dueUnix) / 86400;
    if (daysAfter >= 1 && daysAfter <= 7) {
      points += 15; breakdown.push(['dueDateWindow', 15]);
    }
  }

  // D: tenant historically pays by check / bank-feed
  if (cand.checkPayCount >= 2) {
    points += 10; breakdown.push(['paysByCheckHistory', 10]);
  }

  // H: tenant has exactly one unpaid invoice
  if (cand.unpaidInvoices.length === 1) {
    points += 20; breakdown.push(['singleUnpaidInvoice', 20]);
  }

  return { points, breakdown, exactInvoice, closeInvoice };
}

// Pick best candidate by points. Returns null below 60-point threshold.
// Confidence buckets: ≥90 'high', 60–89 'medium', else null (unmatched).
function _matchTransaction(state, txn) {
  if (txn.amount <= 0) return null;       // only credits
  const descNorm = _normalizeForMatch(txn.description);
  const cands = _matcherCandidates(state);
  if (!cands.length) return null;
  const txnUnix = txn.transactedAt || null;

  const scored = cands.map(c => ({
    cand: c,
    ..._matchPoints(c, txn.amount, txnUnix, descNorm),
  }));

  // J: ambiguity penalty — if >1 candidate exact-matched the amount, −30 each
  // K: uniqueness bonus — if EXACTLY 1 candidate exact-matched, +20.
  // Rationale: when only one tenant in the entire portfolio has an unpaid
  // invoice for this exact amount, that's a strong signal even when the
  // bank description ("Customer Deposit", "Mobile Deposit", "Paid Check")
  // contains zero tenant text. Without this, a bare exactInvoice match
  // scores 50 (under the 60 threshold) and the operator gets "No match"
  // for a transaction we could have confidently routed.
  const exactMatchers = scored.filter(s => s.exactInvoice);
  if (exactMatchers.length > 1) {
    for (const s of exactMatchers) {
      s.points -= 30;
      s.breakdown.push(['ambiguityPenalty', -30]);
    }
  } else if (exactMatchers.length === 1) {
    exactMatchers[0].points += 20;
    exactMatchers[0].breakdown.push(['uniqueAmountBonus', 20]);
  }

  let best = null;
  for (const s of scored) {
    if (s.points >= 60 && (!best || s.points > best.points)) best = s;
  }
  if (!best) return null;

  const conf = best.points >= 90 ? 'high' : 'medium';

  // YM: prefer matched invoice's ym (so payment lands on the actual unpaid month);
  // else txn's ym; else current month.
  let ym;
  const refInv = best.exactInvoice || best.closeInvoice;
  if (refInv) {
    ym = refInv.ym;
  } else if (txnUnix) {
    ym = new Date(txnUnix * 1000).toISOString().slice(0, 7);
  } else {
    ym = new Date().toISOString().slice(0, 7);
  }

  return {
    matchedTenantId: best.cand.unitId,    // tenants don't have stable ids; key by unit
    matchedUnitId: best.cand.unitId,
    matchedBuildingId: best.cand.buildingId,
    matchedFloorId: best.cand.floorId,
    matchedYm: ym,
    matchScore: Math.min(1, Math.max(0, best.points / 100)),  // 0..1 back-compat
    matchPoints: best.points,
    matchConfidence: conf,                 // 'high' | 'medium'
    // Firestore rejects nested arrays — flatten [[label,delta],...] into
    // [{label,delta},...] so the doc writes cleanly.
    matchBreakdown: (best.breakdown || []).map(([label, delta]) => ({ label, delta })),
    suggestedRent: best.cand.contractRent,
  };
}

// Re-run the matcher across all unmatched/suggested transactions.
// Called by the operator after editing tenants (e.g. fixing a typo
// in company name) so old transactions get a fresh chance.
exports.runBankFeedMatcher = onCall(
  {timeoutSeconds: 120, memory: '512MiB'},
  async (req) => {
    await requireEditor(req.auth);
    const state = await readWorkspaceState();
    const col = db.collection(`workspaces/${WORKSPACE_ID}/bankTransactions`);
    const snap = await col
      .where('matchState', 'in', ['unmatched', 'suggested'])
      .get();
    let updated = 0, suggested = 0;
    const batch = db.batch();
    for (const d of snap.docs) {
      const txn = d.data();
      const m = _matchTransaction(state, txn);
      if (m) {
        batch.set(d.ref, {
          ...m,
          matchState: 'suggested',
          matcherRunAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        suggested++;
      } else if (txn.matchState === 'suggested') {
        // Was suggested before but no longer matches anyone → revert.
        batch.set(d.ref, {
          matchState: 'unmatched',
          matchedTenantId: null,
          matchedUnitId: null,
          matchedYm: null,
          matchScore: null,
          suggestedRent: null,
        }, { merge: true });
      }
      updated++;
    }
    if (updated) await batch.commit();
    logger.info(`[bank-feed] matcher ran: ${updated} txns reviewed, ${suggested} suggestions`);
    return { reviewed: updated, suggested };
  }
);

// Lightweight read for the Bank Activity panel.
exports.listBankTransactions = onCall(
  {timeoutSeconds: 30, memory: '256MiB'},
  async (req) => {
    await requireEditor(req.auth);
    const filter = req.data?.filter || 'pending';   // 'pending' | 'all' | 'confirmed' | 'dismissed'
    // Cap at 2000 — operator wants to see at least 12 months of activity in
    // one shot, and a busy property's monthly volume can easily exceed 100
    // transactions, so the original 500 cap was clipping ~half the year off
    // the queue. Firestore's where('in') + sort-in-JS approach scales fine
    // up to a few thousand docs (workspace's bank-txn collection is bounded).
    const limit = Math.min(+req.data?.limit || 200, 2000);
    const col = db.collection(`workspaces/${WORKSPACE_ID}/bankTransactions`);
    let q = col;
    if (filter === 'pending') {
      q = q.where('matchState', 'in', ['unmatched', 'suggested']);
    } else if (filter === 'confirmed') {
      q = q.where('matchState', '==', 'confirmed');
    } else if (filter === 'dismissed') {
      q = q.where('matchState', '==', 'dismissed');
    }
    // Sort + limit in JS to avoid composite-index requirements.
    const snap = await q.get();
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    items.sort((a, b) => (b.transactedAt || 0) - (a.transactedAt || 0));
    return { items: items.slice(0, limit) };
  }
);

// Suggest bank transactions to attach to a specific lease/month inside the
// "Record Manual Payment" modal. Filters server-side so the modal pulls a
// short list of plausible matches instead of all 300+ pending rows.
//
// Inputs (req.data):
//   ym                 'YYYY-MM' — the billing month the operator picked
//   amountCents        target amount in cents (the modal's expected rent)
//   amountTolerancePct ±N% window around amountCents (default 15)
//   dateRangeDays      ±N days window around the billing month (default 30)
//   accountIds         optional whitelist of bank-account ids; empty = all
//   includeStates      ['unmatched','suggested'] by default — operator
//                      almost never wants 'confirmed' here, but allow override
//   limit              up to 25
//
// Output: { items: [...txns sorted by amount-distance then date-distance] }
exports.listBankTransactionsForUnit = onCall(
  {timeoutSeconds: 30, memory: '256MiB'},
  async (req) => {
    await requireEditor(req.auth);
    const ym = String(req.data?.ym || '');
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      throw new HttpsError('invalid-argument', 'ym (YYYY-MM) required');
    }
    const targetCents = +req.data?.amountCents || 0;
    const tolPct = Math.max(0, Math.min(100, +req.data?.amountTolerancePct || 15));
    // includeAllStates=true (передаётся из Browse-all-transactions модалки)
    // снимает все «продуктовые» фильтры — оператор хочет видеть АБСОЛЮТНО
    // всё на счёте, чтобы вручную сматчить то, что автомат пропустил.
    // В этом режиме поднимаем cap'ы на range/limit и отключаем
    // matchState/debit/amount фильтры. Дефолты для inline-suggestions
    // (узкие лимиты 25/120d) сохраняются для всех остальных вызовов.
    const includeAllStates = !!req.data?.includeAllStates;
    const rangeDays = includeAllStates
      ? Math.max(1, Math.min(800, +req.data?.dateRangeDays || 90))
      : Math.max(1, Math.min(120, +req.data?.dateRangeDays || 30));
    const accountIds = Array.isArray(req.data?.accountIds) ? req.data.accountIds.filter(Boolean) : [];
    const includeStates = Array.isArray(req.data?.includeStates) && req.data.includeStates.length
      ? req.data.includeStates : ['unmatched', 'suggested'];
    const limit = includeAllStates
      ? Math.max(1, Math.min(500, +req.data?.limit || 100))
      : Math.max(1, Math.min(25, +req.data?.limit || 10));

    // Compute the date window: month-of-ym ± rangeDays. Anchored at the
    // start of `ym` and the end of `ym` so a January query gets December
    // 15 → February 14 by default (covers "rent paid early" + "paid late").
    const monthStart = Math.floor(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1) / 1000);
    const monthEnd = Math.floor(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 1) / 1000) - 1;
    const fromUnix = monthStart - rangeDays * 86400;
    const toUnix = monthEnd + rangeDays * 86400;

    const col = db.collection(`workspaces/${WORKSPACE_ID}/bankTransactions`);
    // В browse-режиме НЕ фильтруем по matchState — оператор хочет видеть
    // даже уже подтверждённые/смэтченные строки. Иначе — узкая выборка.
    const snap = includeAllStates
      ? await col.get()
      : await col.where('matchState', 'in', includeStates).get();

    const tolCents = targetCents > 0 ? Math.max(2000, Math.round(targetCents * tolPct / 100)) : Infinity;
    const rows = [];
    for (const d of snap.docs) {
      const t = d.data();
      // В browse-режиме показываем дебиты тоже — оператор просил «все
      // транзакции». В suggestion-режиме — только credits (rent = credit).
      if (!includeAllStates && !(+t.amount > 0)) continue;
      // Account whitelist (when provided).
      if (accountIds.length && !accountIds.includes(t.accountId)) continue;
      // Date window — skip transactions with no transactedAt rather than
      // include-and-confuse-the-operator.
      if (!t.transactedAt || t.transactedAt < fromUnix || t.transactedAt > toUnix) continue;
      // Amount window — пропускаем только в suggestion-режиме. В browse
      // tolPct приходит =100 от клиента, так что эффективно тоже отключено.
      if (!includeAllStates && targetCents > 0 && Math.abs(+t.amount - targetCents) > tolCents) continue;
      rows.push({ id: d.id, ...t });
    }

    // Rank: closest amount first, then closest to the middle of the month.
    const monthMid = (monthStart + monthEnd) / 2;
    rows.sort((a, b) => {
      const aAmt = targetCents > 0 ? Math.abs(+a.amount - targetCents) : 0;
      const bAmt = targetCents > 0 ? Math.abs(+b.amount - targetCents) : 0;
      if (aAmt !== bAmt) return aAmt - bAmt;
      const aDt = Math.abs((a.transactedAt || 0) - monthMid);
      const bDt = Math.abs((b.transactedAt || 0) - monthMid);
      return aDt - bDt;
    });
    return { items: rows.slice(0, limit) };
  }
);

// Operator-supplied bank statements (CSV / XLSX / OFX / QFX / QBO).
// Used when Stripe Financial Connections + the bank only expose ~90 days
// of history but the operator needs older months (Capital One typically
// caps at 90d via Stripe FC). Items are written into the same
// bankTransactions collection as Stripe-pulled rows so the matcher,
// "Bank Activity" panel, and "Record Manual Payment" suggestions all
// pick them up uniformly.
//
// Inputs (req.data):
//   items: [{ date: 'YYYY-MM-DD', amountCents: number (negative=debit),
//             description: string, externalId?: string }]
//   sourceLabel: string (e.g. "Capital One CSV - 2026-05-03 12:34")
//                — becomes accountId 'import:csv:<sourceLabel>' so
//                  imported rows are visually distinguishable from Stripe
//   runMatcher: bool — run inline matcher over each new credit row
//   accountTag?: string — short label (e.g. 'Capital One …5709') for UI
//
// Dedup: each row gets a deterministic doc-id of
//   imp_<first 16 hex chars of sha1(date|amountCents|description)>
// so re-importing the same statement is a no-op (Firestore merge:true
// replays the same id, count surfaces in `skipped`).
exports.importBankTransactions = onCall(
  {timeoutSeconds: 120, memory: '512MiB'},
  async (req) => {
    await requireEditor(req.auth);
    const items = Array.isArray(req.data?.items) ? req.data.items : [];
    if (!items.length) {
      throw new HttpsError('invalid-argument', 'items[] is required');
    }
    if (items.length > 5000) {
      throw new HttpsError('invalid-argument', 'max 5000 rows per import');
    }
    const sourceLabel = String(req.data?.sourceLabel || 'manual-import').slice(0, 120);
    const accountTag = String(req.data?.accountTag || '').slice(0, 80);
    const runMatcher = req.data?.runMatcher !== false;            // default true
    const accountId = `import:${sourceLabel.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 100)}`;

    const crypto = require('crypto');
    const state = runMatcher ? await readWorkspaceState() : null;
    const col = db.collection(`workspaces/${WORKSPACE_ID}/bankTransactions`);

    // Day-clamp: any date already covered by an existing transaction (Stripe
    // pull or earlier import) is treated as "fully accounted for" and rows
    // for that day get dropped from this import. Operator's call: they don't
    // want overlap with Stripe's window double-counted just because the
    // descriptions differ. Pull the distinct date set once up front.
    const existingDates = new Set();
    {
      const snap = await col.select('transactedAt').get();
      for (const d of snap.docs) {
        const ts = d.get('transactedAt');
        if (!ts) continue;
        existingDates.add(new Date(ts * 1000).toISOString().slice(0, 10));
      }
    }

    let scanned = 0, written = 0, skipped = 0, suggested = 0, malformed = 0, clamped = 0;
    let batch = db.batch();
    let inBatch = 0;
    const seenIds = new Set();   // intra-batch dedup

    for (const raw of items) {
      scanned++;
      const date = String(raw?.date || '').trim();
      const desc = String(raw?.description || '').trim();
      const amt = Math.round(+raw?.amountCents);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amt) || amt === 0) {
        malformed++;
        continue;
      }
      // Day-clamp: skip if any existing transaction (Stripe or imported)
      // already covers this day.
      if (existingDates.has(date)) { clamped++; continue; }

      const transactedAt = Math.floor(new Date(date + 'T12:00:00Z').getTime() / 1000);
      if (!Number.isFinite(transactedAt)) { malformed++; continue; }

      const hashSrc = `${date}|${amt}|${desc.toLowerCase()}`;
      const hash = crypto.createHash('sha1').update(hashSrc).digest('hex').slice(0, 16);
      const docId = `imp_${hash}`;
      if (seenIds.has(docId)) { skipped++; continue; }    // dup within file
      seenIds.add(docId);

      // Pre-check existing by id — catches the rare case where a row's day
      // wasn't covered yet but it duplicates a previously-imported hash.
      const existing = await col.doc(docId).get();
      if (existing.exists) { skipped++; continue; }

      const baseDoc = {
        id: docId,
        accountId,
        accountTag: accountTag || null,
        amount: amt,
        currency: 'usd',
        description: desc || '(imported)',
        transactedAt,
        statusTransitions: null,
        status: 'posted',
        seenAt: admin.firestore.FieldValue.serverTimestamp(),
        importedAt: admin.firestore.FieldValue.serverTimestamp(),
        importedBy: req.auth?.uid || null,
        importSource: sourceLabel,
        matchState: 'unmatched',
        matchedTenantId: null,
        matchedUnitId: null,
        matchedYm: null,
        checkImageUrl: null,
      };

      if (runMatcher && state) {
        const m = _matchTransaction(state, baseDoc);
        if (m) {
          Object.assign(baseDoc, m, { matchState: 'suggested' });
          suggested++;
        }
      }

      batch.set(col.doc(docId), baseDoc, { merge: true });
      written++;
      inBatch++;
      // Firestore caps writes at 500 per batch — flush at 400 to stay safe.
      if (inBatch >= 400) {
        await batch.commit();
        batch = db.batch();
        inBatch = 0;
      }
    }
    if (inBatch > 0) await batch.commit();

    logger.info(`[bank-feed] import "${sourceLabel}": scanned=${scanned} written=${written} skipped=${skipped} clamped=${clamped} suggested=${suggested} malformed=${malformed}`);
    return { scanned, written, skipped, clamped, suggested, malformed };
  }
);

// Confirm a suggested match (or apply an operator override). Optionally
// records the rent payment in state.
exports.confirmBankMatch = onCall(
  {timeoutSeconds: 60, memory: '256MiB'},
  async (req) => {
    await requireEditor(req.auth);
    const txnId = String(req.data?.txnId || '');
    const unitId = String(req.data?.unitId || '');
    const ym = String(req.data?.ym || '');
    const recordPayment = req.data?.recordPayment !== false;   // default true
    if (!txnId || !unitId || !/^\d{4}-\d{2}$/.test(ym)) {
      throw new HttpsError('invalid-argument', 'txnId, unitId, ym (YYYY-MM) required');
    }
    const ref = db.doc(`workspaces/${WORKSPACE_ID}/bankTransactions/${txnId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'transaction not found');
    const txn = snap.data();
    const operatorEmail = (req.auth?.token?.email || '').toLowerCase();

    if (recordPayment) {
      await mutateWorkspaceState((s) => {
        outer: for (const b of s.buildings || []) {
          for (const f of b.floors || []) {
            for (const u of f.units || []) {
              if (u.id !== unitId) continue;
              u.payments = u.payments || {};
              const existing = u.payments[ym] || {};
              u.payments[ym] = {
                ...existing,
                status: 'paid',
                paidAt: new Date(txn.transactedAt ? txn.transactedAt * 1000 : Date.now()).toISOString(),
                amount: Math.abs(txn.amount) / 100,
                source: 'bank-feed',
                bankTxnId: txnId,
                confirmedBy: operatorEmail,
              };
              break outer;
            }
          }
        }
      });
    }

    await ref.set({
      matchState: 'confirmed',
      matchedUnitId: unitId,
      matchedTenantId: unitId,
      matchedYm: ym,
      confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
      confirmedBy: operatorEmail,
    }, { merge: true });

    logger.info(`[bank-feed] confirmed txn ${txnId} → unit ${unitId} ym ${ym} (paymentRecorded=${recordPayment})`);
    return { ok: true };
  }
);

// Operator marks transaction as not-a-rent-payment (refund, transfer,
// vendor payment, etc.). It stops appearing in the pending list.
exports.dismissBankMatch = onCall(
  {timeoutSeconds: 30},
  async (req) => {
    await requireEditor(req.auth);
    const txnId = String(req.data?.txnId || '');
    if (!txnId) throw new HttpsError('invalid-argument', 'txnId required');
    const ref = db.doc(`workspaces/${WORKSPACE_ID}/bankTransactions/${txnId}`);
    const operatorEmail = (req.auth?.token?.email || '').toLowerCase();
    await ref.set({
      matchState: 'dismissed',
      dismissedAt: admin.firestore.FieldValue.serverTimestamp(),
      dismissedBy: operatorEmail,
    }, { merge: true });
    return { ok: true };
  }
);

// ============================================================================
// DocuSign JWT-grant proxy (FIXES_LOG Entry 20 — 2026-05-17)
// ============================================================================
// Replaces the browser OAuth + localStorage-tokens flow. JWT private key lives
// in Secret Manager; browser NEVER sees raw tokens. Solves:
//   1. Manager permission bug: previously only admin could read tokens from
//      Firestore /workspaces/{id}/integrations/docusign (firestore.rules:256).
//      Managers got "DocuSign not connected" toast. Now manager invokes CF;
//      CF holds tokens server-side; rules don't gate it.
//   2. 30-day re-authorize bug: Auth Code refresh tokens expired after 30
//      days. JWT grant has consent_for_life — server mints fresh access
//      tokens via signed JWT assertions, no human in the loop.
//
// Config doc at workspaces/{id}/integrations/docusign:
//   { integrationKey, userId, apiAccountId, baseUri, oauthHost, env,
//     authMode: 'jwt', consentedAt, consentedBy }
// Audit log at workspaces/{id}/docusign_log/{autoId}.

const DOCUSIGN_PRIVATE_KEY = defineSecret('DOCUSIGN_PRIVATE_KEY');

// In-memory access-token cache (per CF instance). DocuSign JWT access tokens
// live for 1 hour by default. We refresh 60s early to avoid mid-call expiry.
let _dsTokenCache = null;

async function _dsLoadConfig() {
  const snap = await db.doc(`workspaces/${WORKSPACE_ID}/integrations/docusign`).get();
  if (!snap.exists) {
    throw new HttpsError('failed-precondition',
      'DocuSign config missing — admin must run /init DocuSign JWT setup');
  }
  const cfg = snap.data() || {};
  if (cfg.authMode !== 'jwt') {
    throw new HttpsError('failed-precondition',
      `DocuSign config authMode is "${cfg.authMode || '(unset)'}", expected "jwt".`);
  }
  if (!cfg.integrationKey || !cfg.userId || !cfg.baseUri || !cfg.oauthHost) {
    throw new HttpsError('failed-precondition',
      'DocuSign config incomplete (need integrationKey, userId, baseUri, oauthHost)');
  }
  if (!cfg.apiAccountId && !cfg.accountId) {
    throw new HttpsError('failed-precondition',
      'DocuSign config missing accountId / apiAccountId');
  }
  return cfg;
}

async function _dsGetAccessToken() {
  if (_dsTokenCache && _dsTokenCache.expiresAt > Date.now() + 60_000) {
    return _dsTokenCache;
  }
  const jwt = require('jsonwebtoken');
  const cfg = await _dsLoadConfig();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: cfg.integrationKey,
    sub: cfg.userId,
    iat: now,
    exp: now + 3600,  // JWT lifetime; DocuSign accepts up to 1 hour
    aud: cfg.oauthHost,  // 'account.docusign.com' for prod, 'account-d.docusign.com' for demo
    scope: 'signature impersonation',
  };
  const privateKey = DOCUSIGN_PRIVATE_KEY.value();
  const assertion = jwt.sign(payload, privateKey, { algorithm: 'RS256' });
  const tokenUrl = `https://${cfg.oauthHost}/oauth/token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    logger.error('[docusign:jwt] token exchange failed', { status: res.status, body: txt.slice(0, 500) });
    // Most common cause: consent_required → admin needs to re-run the consent URL.
    if (txt.includes('consent_required')) {
      throw new HttpsError('failed-precondition',
        'DocuSign JWT consent expired — admin must re-grant access via /consent URL');
    }
    throw new HttpsError('internal', `DocuSign JWT token exchange failed (${res.status})`);
  }
  const data = await res.json();
  _dsTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + ((data.expires_in || 3600) - 60) * 1000,
    baseUri: cfg.baseUri,
    accountId: cfg.apiAccountId || cfg.accountId,
    cfg,
  };
  return _dsTokenCache;
}

// Bypasses Firestore rules — admin SDK call. Verifies caller's workspace role
// for the CF entry point, NOT the underlying API call.
async function _dsAssertCanSendLeases(authContext) {
  if (!authContext || !authContext.uid) {
    throw new HttpsError('unauthenticated', 'Sign in to send leases');
  }
  const snap = await db.doc(`workspaces/${WORKSPACE_ID}/members/${authContext.uid}`).get();
  if (!snap.exists) {
    throw new HttpsError('permission-denied', 'Not a workspace member');
  }
  const m = snap.data() || {};
  if (m.archived) {
    throw new HttpsError('permission-denied', 'Account archived');
  }
  if (m.role !== 'admin' && m.role !== 'manager') {
    throw new HttpsError('permission-denied', `Role "${m.role || 'viewer'}" cannot send leases`);
  }
  return { uid: authContext.uid, email: m.email || authContext.token?.email || null, role: m.role };
}

// Generic DocuSign REST relay. Handles auth header injection + error mapping.
async function _dsApi(path, options = {}) {
  const t = await _dsGetAccessToken();
  const url = `${t.baseUri}/restapi/v2.1/accounts/${t.accountId}${path}`;
  const headers = Object.assign({}, options.headers || {});
  headers['Authorization'] = `Bearer ${t.token}`;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method: options.method || 'GET', headers, body: options.body });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    logger.error('[docusign:api] failed', { path, status: res.status, body: txt.slice(0, 1000) });
    throw new HttpsError('internal', `DocuSign API ${path} failed (${res.status}): ${txt.slice(0, 300)}`);
  }
  return res;
}

async function _dsAudit(action, callerInfo, extra) {
  try {
    await db.collection(`workspaces/${WORKSPACE_ID}/docusign_log`).add({
      action,
      callerUid: callerInfo.uid,
      callerEmail: callerInfo.email || null,
      callerRole: callerInfo.role || null,
      at: admin.firestore.FieldValue.serverTimestamp(),
      ...(extra || {}),
    });
  } catch (e) { logger.warn('[docusign:audit] log write failed', e); }
}

// Send envelope. Client builds the full DocuSign payload (template body OR
// inline HTML + recipients/tabs/notification/emailSettings) — CF relays it.
//
// Server-authoritative state write (FIXES_LOG Entry 22, 2026-05-18):
// After DocuSign success, CF ALSO writes the envelope record into
// state.buildings[bid].floors[fid].units[uid].leaseEnvelopes via a
// Firestore transaction. Client used to push it after the CF call, but
// follower tabs (Web Locks FIXES_LOG Entry 16) skip Firestore writes —
// envelope went out, email arrived, but state never reflected it (Suite
// 403, Drew/manager, 2026-05-18 02:27 UTC was the first observed loss).
// Now the write rides on the SERVER side via admin SDK so it can't be
// blocked by tab leadership rules.
exports.dsSendEnvelope = onCall(
  { secrets: [DOCUSIGN_PRIVATE_KEY], timeoutSeconds: 90 },
  async (request) => {
    const caller = await _dsAssertCanSendLeases(request.auth);
    const { payload, recipientEmail, unitId, buildingId, floorId, envelopeMeta } = request.data || {};
    if (!payload || typeof payload !== 'object') {
      throw new HttpsError('invalid-argument', 'payload (envelope body) required');
    }
    if (!recipientEmail) {
      throw new HttpsError('invalid-argument', 'recipientEmail required for audit');
    }
    if (!unitId || !buildingId || !floorId) {
      throw new HttpsError('invalid-argument', 'unitId + buildingId + floorId required for server-authoritative state write');
    }
    const res = await _dsApi('/envelopes', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    // Build the envelope record that will land in u.leaseEnvelopes. Client
    // may supply additional metadata via envelopeMeta (leaseStart, leaseEnd,
    // rent, mode, recipientName, subject, templateId). Server-authoritative
    // fields (envelopeId, status, sentAt, sentBy) always win.
    const nowIso = new Date().toISOString();
    const envelopeRecord = {
      // Server-authoritative
      envelopeId: data.envelopeId,
      status: data.status || 'sent',
      createdAt: nowIso,
      sentAt: nowIso,
      lastChecked: nowIso,
      sentBy: caller.email || caller.uid,
      sentByUid: caller.uid,
      recipientEmail,
      // Client-supplied (may be undefined)
      recipientName:  (envelopeMeta && envelopeMeta.recipientName)  || null,
      subject:        (envelopeMeta && envelopeMeta.subject)        || payload.emailSubject || null,
      templateId:     (envelopeMeta && envelopeMeta.templateId)     || payload.templateId || null,
      mode:           (envelopeMeta && envelopeMeta.mode)           || (payload.templateId ? 'template' : 'inline'),
      leaseStart:     (envelopeMeta && envelopeMeta.leaseStart)     || null,
      leaseEnd:       (envelopeMeta && envelopeMeta.leaseEnd)       || null,
      rent:           (envelopeMeta && envelopeMeta.rent != null) ? +envelopeMeta.rent : 0,
    };

    // Transactional state push. Read state, walk to target unit, push
    // envelope, write state back. Retries automatically on conflict.
    const stateRef = db.doc(`workspaces/${WORKSPACE_ID}/data/state`);
    let writeOk = false;
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(stateRef);
        if (!snap.exists) throw new Error('state document missing');
        const state = snap.data() || {};
        const b = (state.buildings || []).find(x => x.id === buildingId);
        if (!b) throw new Error(`building ${buildingId} not found in state`);
        const f = (b.floors || []).find(x => x.id === floorId);
        if (!f) throw new Error(`floor ${floorId} not found in state`);
        const u = (f.units || []).find(x => x.id === unitId);
        if (!u) throw new Error(`unit ${unitId} not found in state`);

        // Idempotency — if we already wrote this envelope (e.g. retry from
        // the same caller), skip. Caller's audit log entry already exists.
        u.leaseEnvelopes = Array.isArray(u.leaseEnvelopes) ? u.leaseEnvelopes : [];
        const dup = u.leaseEnvelopes.find(e => e && (e.envelopeId === data.envelopeId || e.id === data.envelopeId));
        if (dup) return;

        u.leaseEnvelopes.push(envelopeRecord);
        u.currentLeaseEnvelopeId = data.envelopeId;

        // Outreach trail so the Activity Log on the unit panel reflects this
        // send. Same shape the client used to write post-CF.
        u.outreach = Array.isArray(u.outreach) ? u.outreach : [];
        u.outreach.push({
          type: 'lease',
          ts: nowIso,
          text: `DocuSign lease sent to ${recipientEmail} (envelope ${data.envelopeId.slice(0, 8)}…)`,
          envelopeId: data.envelopeId,
          recipientEmail,
          sentBy: caller.email || caller.uid,
        });

        tx.set(stateRef, state);
      });
      writeOk = true;
    } catch (e) {
      logger.error('[docusign:state-write] failed', { envelopeId: data.envelopeId, unitId, error: e.message });
      // DocuSign envelope is created, audit log gets the failure too — operator
      // can reconcile via _dsReconcileEnvelopes on the client. We do NOT throw
      // here because the envelope physically went out (email reaching tenant);
      // throwing would mislead the operator into thinking nothing happened.
    }

    await _dsAudit('send', caller, {
      envelopeId: data.envelopeId,
      recipientEmail,
      status: data.status || null,
      hasTemplateId: !!payload.templateId,
      unitId, buildingId, floorId,
      stateWriteOk: writeOk,
    });

    return {
      envelopeId: data.envelopeId,
      status: data.status || 'sent',
      statusDateTime: data.statusDateTime,
      envelopeRecord,
      stateWriteOk: writeOk,
    };
  }
);

// Read envelope (status polling, recipient info, last-checked, etc.).
exports.dsGetEnvelope = onCall(
  { secrets: [DOCUSIGN_PRIVATE_KEY], timeoutSeconds: 30 },
  async (request) => {
    await _dsAssertCanSendLeases(request.auth);
    const { envelopeId } = request.data || {};
    if (!envelopeId) throw new HttpsError('invalid-argument', 'envelopeId required');
    const res = await _dsApi(`/envelopes/${encodeURIComponent(envelopeId)}?include=recipients`);
    return await res.json();
  }
);

// Batch-status — fetch many envelopes by id. Used by lease polling tracker
// to avoid N HTTP round-trips for N envelopes. DocuSign's /envelopes
// endpoint with envelope_ids query supports up to 1000 ids per request.
exports.dsListEnvelopes = onCall(
  { secrets: [DOCUSIGN_PRIVATE_KEY], timeoutSeconds: 60 },
  async (request) => {
    await _dsAssertCanSendLeases(request.auth);
    const { envelopeIds, fromDate } = request.data || {};
    if (!Array.isArray(envelopeIds) || envelopeIds.length === 0) {
      throw new HttpsError('invalid-argument', 'envelopeIds (non-empty array) required');
    }
    const qs = new URLSearchParams({
      envelope_ids: envelopeIds.join(','),
      from_date: fromDate || '2024-01-01',
      include: 'recipients',
    });
    const res = await _dsApi(`/envelopes?${qs.toString()}`);
    const data = await res.json();
    return { envelopes: data.envelopes || [] };
  }
);

// Re-email the signing notification to the recipient.
exports.dsResend = onCall(
  { secrets: [DOCUSIGN_PRIVATE_KEY], timeoutSeconds: 30 },
  async (request) => {
    const caller = await _dsAssertCanSendLeases(request.auth);
    const { envelopeId } = request.data || {};
    if (!envelopeId) throw new HttpsError('invalid-argument', 'envelopeId required');
    await _dsApi(`/envelopes/${encodeURIComponent(envelopeId)}?resend_envelope=true`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'sent' }),
    });
    await _dsAudit('resend', caller, { envelopeId });
    return { ok: true };
  }
);

// Void (cancel) a pending envelope.
exports.dsVoid = onCall(
  { secrets: [DOCUSIGN_PRIVATE_KEY], timeoutSeconds: 30 },
  async (request) => {
    const caller = await _dsAssertCanSendLeases(request.auth);
    const { envelopeId, reason } = request.data || {};
    if (!envelopeId) throw new HttpsError('invalid-argument', 'envelopeId required');
    await _dsApi(`/envelopes/${encodeURIComponent(envelopeId)}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'voided', voidedReason: reason || 'Cancelled by operator' }),
    });
    await _dsAudit('void', caller, { envelopeId, reason: reason || null });
    return { ok: true };
  }
);

// List the templates available in this DocuSign account.
exports.dsListTemplates = onCall(
  { secrets: [DOCUSIGN_PRIVATE_KEY], timeoutSeconds: 30 },
  async (request) => {
    await _dsAssertCanSendLeases(request.auth);
    const res = await _dsApi('/templates?count=100');
    const data = await res.json();
    return { templates: data.envelopeTemplates || [], total: +data.totalSetSize || 0 };
  }
);

// Fetch the combined signed PDF for an envelope. Returned as base64 so the
// client can either preview or upload to Cloud Storage for archival.
exports.dsDownloadCombinedPdf = onCall(
  { secrets: [DOCUSIGN_PRIVATE_KEY], timeoutSeconds: 60, memory: '1GiB' },
  async (request) => {
    const caller = await _dsAssertCanSendLeases(request.auth);
    const { envelopeId } = request.data || {};
    if (!envelopeId) throw new HttpsError('invalid-argument', 'envelopeId required');
    const res = await _dsApi(`/envelopes/${encodeURIComponent(envelopeId)}/documents/combined`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await _dsAudit('download', caller, { envelopeId, sizeKb: Math.round(buffer.length / 1024) });
    return { pdfBase64: buffer.toString('base64'), mimeType: 'application/pdf', sizeBytes: buffer.length };
  }
);

// One-time bootstrap — write the integration config to Firestore so the
// API functions above can find it. Admin-only. Idempotent: caller can re-run
// to update any field (e.g. rotated user_id, env change, region migration).
exports.dsConfigureJwt = onCall(
  { timeoutSeconds: 10 },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in');
    const snap = await db.doc(`workspaces/${WORKSPACE_ID}/members/${request.auth.uid}`).get();
    const m = snap.exists ? (snap.data() || {}) : {};
    if (m.role !== 'admin') throw new HttpsError('permission-denied', 'Admin only');
    const { integrationKey, userId, accountId, apiAccountId, baseUri, oauthHost, env } = request.data || {};
    if (!integrationKey || !userId || !baseUri || !oauthHost) {
      throw new HttpsError('invalid-argument',
        'integrationKey, userId, baseUri, oauthHost required');
    }
    const doc = {
      integrationKey, userId, accountId: accountId || null,
      apiAccountId: apiAccountId || null,
      baseUri, oauthHost, env: env || 'prod_eu',
      authMode: 'jwt',
      consentedAt: admin.firestore.FieldValue.serverTimestamp(),
      consentedBy: m.email || request.auth.token?.email || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await db.doc(`workspaces/${WORKSPACE_ID}/integrations/docusign`).set(doc, { merge: true });
    // Bust the in-memory cache so the next API call re-reads config.
    _dsTokenCache = null;
    return { ok: true };
  }
);

// =========================================================================
// ===== Gmail ingest (FIXES_LOG Entry 27 — Phase 8) =======================
// Авто-трекинг исходящей почты сотрудников через Gmail API + Pub/Sub.
// Полный модуль вынесен в functions/gmail-ingest.js; здесь только
// re-export, чтобы firebase-functions нашёл их при деплое.
// =========================================================================
const _gmail = require('./gmail-ingest');
exports.onGmailPush             = _gmail.onGmailPush;
exports.bootstrapGmailWatch     = _gmail.bootstrapGmailWatch;
exports.adminBootstrapGmailWatch = _gmail.adminBootstrapGmailWatch;
exports.adminStopGmailWatch     = _gmail.adminStopGmailWatch;

