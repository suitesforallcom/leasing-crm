/**
 * Aircall ingest (Phase 18) — polling-based. Every 5 minutes the scheduled
 * function fetches new calls from the Aircall REST API and writes them to
 * state.callActivity[<operator-email>][...]. data-shim then buckets these
 * into today/MTD/hourly stats per employee.
 *
 * Schema written to doc.state.callActivity[email] = [
 *   { aircallId, ts, direction, durationSec, answerSec, status,
 *     fromNumber, toNumber, recordingUrl }
 * ]
 * Per-email cap: 1000 most-recent calls (memory + Firestore doc size).
 *
 * Auth: HTTP Basic with API_ID:API_TOKEN.
 * Rate limit: 60 req/min/token. Pacing: 200ms between paged requests.
 *
 * Functions:
 *   pullAircallStats   — onSchedule '* /5 * * * *' (every 5 min, incremental)
 *   adminPullAircall   — onCall (manual bootstrap / refresh, admin-only)
 */

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const AIRCALL_API_ID = defineSecret('AIRCALL_API_ID');
const AIRCALL_API_TOKEN = defineSecret('AIRCALL_API_TOKEN');

const WORKSPACE_ID = 'default';
const ROOT_ADMINS = ['tony@al-en.com'];
const AIRCALL_BASE = 'https://api.aircall.io/v1';
const PER_PAGE = 50;                   // max allowed by Aircall
const REQ_PACE_MS = 250;                // ~4 req/sec → safe under 60/min limit
const PER_EMAIL_CAP = 1000;             // keep last N calls per operator
const STATE_PATH = `workspaces/${WORKSPACE_ID}/data/state`;
const META_PATH = `workspaces/${WORKSPACE_ID}/meta/aircallSync`;

if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();

function _authHeader() {
  const id = AIRCALL_API_ID.value();
  const tok = AIRCALL_API_TOKEN.value();
  if (!id || !tok) throw new Error('AIRCALL credentials not configured');
  const basic = Buffer.from(`${id}:${tok}`).toString('base64');
  return { Authorization: `Basic ${basic}`, Accept: 'application/json' };
}

async function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _aircallFetch(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${AIRCALL_BASE}${path}`;
  const res = await fetch(url, { ...opts, headers: { ..._authHeader(), ...(opts.headers || {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Aircall ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Pull ALL Aircall users → map { aircallUserId → email }.
 * Paginated; users.json returns `meta.next_page_link` if more.
 */
async function _fetchUserMap() {
  const map = new Map();
  let next = `/users?per_page=${PER_PAGE}`;
  while (next) {
    const data = await _aircallFetch(next);
    for (const u of (data.users || [])) {
      if (u && u.id && u.email) map.set(String(u.id), u.email.toLowerCase());
    }
    next = data.meta && data.meta.next_page_link
      ? data.meta.next_page_link.replace(AIRCALL_BASE, '')
      : null;
    if (next) await _sleep(REQ_PACE_MS);
  }
  return map;
}

/**
 * Phase 18 rev — Aircall `/v1/calls` returns `user: null` for calls
 * on numbers shared across users OR when no operator picked up. But
 * `/v1/numbers/:id` returns `users[]` array showing which operator(s)
 * the number is assigned to. Build a `numberId → primaryUserEmail` map
 * so we can attribute calls via the number when c.user is null.
 *
 * Note: LIST endpoint `/v1/numbers` returns minimal data without users.
 * We need to fetch each number individually. With 5-15 numbers/account
 * the round-trip cost is negligible (≤4 sec at 250ms pacing).
 *
 * If a number has multiple users → pick the first (consistent across runs).
 * If a number has no users → return null (orphan; falls through to
 * heuristic from number.name).
 */
async function _fetchNumberMaps() {
  const numberToUser = new Map();              // numberId → primaryUserEmail
  const userToNumbers = new Map();             // userEmail → [{id, name, digits}]
  // 1. List all numbers (minimal data).
  let next = `/numbers?per_page=${PER_PAGE}`;
  const allNumberIds = [];
  while (next) {
    const data = await _aircallFetch(next);
    for (const n of (data.numbers || [])) {
      if (n && n.id) allNumberIds.push(String(n.id));
    }
    next = data.meta && data.meta.next_page_link
      ? data.meta.next_page_link.replace(AIRCALL_BASE, '')
      : null;
    if (next) await _sleep(REQ_PACE_MS);
  }
  // 2. Fetch each number individually for the users array.
  for (const nid of allNumberIds) {
    try {
      const data = await _aircallFetch(`/numbers/${nid}`);
      const num = (data && data.number) || {};
      const users = Array.isArray(num.users) ? num.users : [];
      // Diagnostic warning — multi-user numbers cause biased attribution
      // (we always pick users[0]; Aircall ordering is not deterministic).
      if (users.length > 1) {
        const userList = users.map(u => u.email || '?').join(', ');
        logger.warn(`[aircall] number ${num.id} «${num.name}» has ${users.length} users assigned (${userList}) — calls will all attribute to ${users[0].email}; consider 1-user-per-number or webhook ingest`);
      }
      if (users.length > 0 && users[0] && users[0].email) {
        numberToUser.set(String(num.id), users[0].email.toLowerCase());
      }
      // Build reverse map (user → numbers they own). For multi-user numbers
      // we list the number under EACH user — operator should see they have
      // access to it even if attribution biases to users[0].
      const numberRec = {
        id: num.id,
        name: num.name || '',
        digits: num.digits || '',
        country: num.country || '',
        isDefault: false, // не выводится list endpoint'ом; PUNT — пока не размечаем default
      };
      for (const u of users) {
        if (!u || !u.email) continue;
        const e = u.email.toLowerCase();
        if (!userToNumbers.has(e)) userToNumbers.set(e, []);
        userToNumbers.get(e).push(numberRec);
      }
      await _sleep(REQ_PACE_MS);
    } catch (e) {
      logger.warn(`[aircall] number ${nid} fetch failed: ${e.message}`);
    }
  }
  return { numberToUser, userToNumbers };
}

/**
 * Phase 18 — load employee roster для number.name heuristic AND tenant
 * map для caller-phone-to-tenant matching.
 */
async function _fetchEmployeeRoster() {
  const stateRef = db().doc(STATE_PATH);
  const snap = await stateRef.get();
  if (!snap.exists) return { roster: [], tenantsByPhone: new Map() };
  const doc = snap.data() || {};
  const emps = (doc.state && Array.isArray(doc.state.employees)) ? doc.state.employees : [];
  const roster = emps
    .filter(e => e && e.email && e.status !== 'terminated' && e.trackInPulse !== false)
    .map(e => ({
      email: e.email.toLowerCase(),
      fullName: (e.fullName || '').toLowerCase().trim(),
      firstName: (e.fullName || '').split(/\s+/)[0]?.toLowerCase() || '',
      lastName: (e.fullName || '').split(/\s+/).slice(-1)[0]?.toLowerCase() || '',
    }));

  // Phase 18 rev — build phone → tenant index. Walk buildings/floors/units;
  // each unit has u.phone (tenant phone). Normalize phone (digits-only) for
  // robust matching against c.raw_digits from Aircall.
  const tenantsByPhone = new Map();
  const buildings = (doc.state && Array.isArray(doc.state.buildings)) ? doc.state.buildings : [];
  for (const b of buildings) {
    for (const f of (b.floors || [])) {
      for (const u of (f.units || [])) {
        if (!u || !u.phone) continue;
        const digits = String(u.phone).replace(/[^\d]/g, '');
        if (digits.length < 7) continue;
        // Store last-10-digits (US convention) for fuzzy match — handles
        // «+1 312 871 8354» vs «3128718354» vs «(312) 871-8354» equally.
        const key = digits.slice(-10);
        tenantsByPhone.set(key, {
          unitId: u.id,
          suite: u.id,
          tenantName: u.tenant || u.company || '(no tenant name)',
          buildingId: b.id,
          buildingName: b.name || b.address || '',
        });
      }
    }
  }
  return { roster, tenantsByPhone };
}

/**
 * Match number.name → operator email. Returns null if no confident match.
 * Trade-off: lower false-positive rate > higher false-negative rate.
 * Только substring match на firstName И lastName (оба должны присутствовать).
 * «Ann Noel Number» → match Ann + Noel → Ann Noel's email.
 * «Bay Vista Dr» → no name match → null (orphan).
 */
function _matchOperatorFromNumberName(numberName, roster) {
  if (!numberName) return null;
  const lower = String(numberName).toLowerCase();
  for (const emp of roster) {
    if (!emp.firstName || !emp.lastName) continue;
    if (emp.firstName.length < 2) continue; // защита от too-short names
    // Требуем оба имени в number.name — это надёжный сигнал
    if (lower.includes(emp.firstName) && lower.includes(emp.lastName)) {
      return emp.email;
    }
  }
  return null;
}

/**
 * Normalize an Aircall call object → state schema.
 * Returns null for invalid records.
 * Owner attribution priority:
 *   1. c.user.email (Aircall explicitly assigned operator)
 *   2. c.number.id → numberToUserMap (number assigned to user in Settings)
 *   3. c.number.name parsed against employee roster (substring match)
 *   4. SKIP — orphan call (no user, no number assignment, no name match)
 */
function _normalizeCall(c, userMap, numberToUserMap, employeeRoster, tenantsByPhone) {
  if (!c || !c.id) return null;
  const startedSec = c.started_at || 0;
  if (!startedSec) return null;
  const ts = startedSec * 1000;
  const answeredSec = c.answered_at || 0;
  const endedSec = c.ended_at || 0;
  const durationSec = c.duration || (endedSec && startedSec ? endedSec - startedSec : 0);
  const answerSec = answeredSec && startedSec ? answeredSec - startedSec : null;
  // Phase 18 rev — talk time = ended - answered (real conversation duration).
  // pickup/wait = answered - started.  total = duration.
  const talkSec = (answeredSec && endedSec && endedSec > answeredSec) ? (endedSec - answeredSec) : 0;

  let status = 'answered';
  if (c.missed_call_reason || (!answeredSec && c.direction === 'inbound')) status = 'missed';
  if (c.voicemail) status = 'voicemail';

  // 1. Try explicit user assignment from Aircall
  let ownerEmail = c.user && c.user.id ? userMap.get(String(c.user.id)) : null;
  let attribution = 'aircall-user';
  // 2. Fallback: number → user assignment (Aircall Settings)
  if (!ownerEmail && c.number && c.number.id) {
    const matched = numberToUserMap.get(String(c.number.id));
    if (matched) {
      ownerEmail = matched;
      attribution = 'number-assignment';
    }
  }
  // 3. Last-resort: parse number.name for operator full name
  if (!ownerEmail && c.number && c.number.name) {
    const matched = _matchOperatorFromNumberName(c.number.name, employeeRoster);
    if (matched) {
      ownerEmail = matched;
      attribution = 'number-name-heuristic';
    }
  }
  if (!ownerEmail) return null;  // 4. SKIP orphan

  // Phase 18 rev — tenant match by counterparty phone.
  // For inbound: c.raw_digits = caller. For outbound: c.to = called number.
  const counterpartyRaw = c.direction === 'outbound'
    ? (c.to || '')
    : (c.raw_digits || c.from || '');
  let tenantMatch = null;
  if (counterpartyRaw && tenantsByPhone) {
    const cpDigits = String(counterpartyRaw).replace(/[^\d]/g, '').slice(-10);
    if (cpDigits.length === 10) {
      const t = tenantsByPhone.get(cpDigits);
      if (t) tenantMatch = t;
    }
  }

  // Phase 18 rev — tags + cost from Aircall (если plan supports)
  const tags = Array.isArray(c.tags) ? c.tags.map(t => ({ id: t.id, name: t.name, color: t.color })) : [];
  const cost = c.cost != null ? +c.cost : 0;

  return {
    aircallId: c.id,
    ownerEmail,
    ts,
    direction: c.direction === 'outbound' ? 'outbound' : 'inbound',
    durationSec,
    answerSec,
    talkSec,
    status,
    fromNumber: c.raw_digits || c.from || '',
    toNumber: c.to || '',
    numberName: c.number && c.number.name ? c.number.name : null,
    recordingUrl: c.recording || c.voicemail || null,
    tenantMatch,
    tags,
    cost,
    _attribution: attribution,
  };
}

/**
 * Walk Aircall /v1/calls from `fromSec` until either no more pages OR
 * we hit `maxCalls` (safety stop for very busy accounts).
 */
async function _fetchCallsSince(fromSec, userMap, numberToUserMap, employeeRoster, tenantsByPhone, maxCalls = 5000) {
  const out = [];
  let totalRaw = 0;
  let skippedOrphan = 0;
  let tenantMatched = 0;
  const attributionStats = { 'aircall-user': 0, 'number-assignment': 0, 'number-name-heuristic': 0 };
  let next = `/calls?from=${fromSec}&per_page=${PER_PAGE}&order=asc`;
  let pageCount = 0;
  while (next && out.length < maxCalls) {
    const data = await _aircallFetch(next);
    pageCount++;
    for (const c of (data.calls || [])) {
      totalRaw++;
      const norm = _normalizeCall(c, userMap, numberToUserMap, employeeRoster, tenantsByPhone);
      if (norm) {
        attributionStats[norm._attribution] = (attributionStats[norm._attribution] || 0) + 1;
        if (norm.tenantMatch) tenantMatched++;
        delete norm._attribution;
        out.push(norm);
      } else {
        skippedOrphan++;
      }
    }
    next = data.meta && data.meta.next_page_link
      ? data.meta.next_page_link.replace(AIRCALL_BASE, '')
      : null;
    if (next) await _sleep(REQ_PACE_MS);
  }
  logger.info(`[aircall] fetched ${out.length}/${totalRaw} calls (${skippedOrphan} orphan, ${tenantMatched} tenant-matched) across ${pageCount} pages (from=${fromSec})`);
  logger.info(`[aircall] attribution: ${JSON.stringify(attributionStats)}`);
  return out;
}

/**
 * Merge fetched calls into doc.state.callActivity[email]. Dedup by aircallId.
 * Caps each array at PER_EMAIL_CAP most-recent.
 */
async function _writeCallsToState(calls) {
  if (!calls.length) return { written: 0, byEmail: {} };
  const docRef = db().doc(STATE_PATH);
  let written = 0;
  const byEmail = {};
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const doc = snap.exists ? (snap.data() || {}) : {};
    doc.state = doc.state || {};
    const activity = doc.state.callActivity || {};

    for (const call of calls) {
      const email = call.ownerEmail;
      if (!email) continue;
      activity[email] = activity[email] || [];
      // Dedup by aircallId
      if (activity[email].some(x => x && x.aircallId === call.aircallId)) continue;
      // Strip ownerEmail (it's the key) and push
      const { ownerEmail, ...rec } = call;
      activity[email].push(rec);
      written++;
      byEmail[email] = (byEmail[email] || 0) + 1;
    }
    // Sort + cap each operator's array
    for (const email of Object.keys(activity)) {
      activity[email].sort((a, b) => (b.ts || 0) - (a.ts || 0));
      if (activity[email].length > PER_EMAIL_CAP) {
        activity[email] = activity[email].slice(0, PER_EMAIL_CAP);
      }
    }
    doc.state.callActivity = activity;
    tx.set(docRef, doc, { merge: true });
  });
  return { written, byEmail };
}

/**
 * Read+update sync cursor — track last successful pull time so incremental
 * polling doesn't re-fetch everything every 5 minutes.
 */
async function _getLastSync() {
  const snap = await db().doc(META_PATH).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  return d.lastSyncSec || null;
}
async function _setLastSync(sec) {
  await db().doc(META_PATH).set({
    lastSyncSec: sec,
    lastSyncAt: new Date().toISOString(),
  }, { merge: true });
}

/**
 * Core ingest routine — used by both scheduled + admin-callable.
 */
async function _runPull({ sinceSec, isBootstrap = false }) {
  const [userMap, numberMaps, rosterData] = await Promise.all([
    _fetchUserMap(),
    _fetchNumberMaps(),
    _fetchEmployeeRoster(),
  ]);
  const { numberToUser: numberToUserMap, userToNumbers } = numberMaps;
  const { roster: employeeRoster, tenantsByPhone } = rosterData;
  logger.info(`[aircall] user map size = ${userMap.size}, number→user map size = ${numberToUserMap.size}, employee roster size = ${employeeRoster.length}, tenant phone index size = ${tenantsByPhone.size}`);
  logger.info(`[aircall] roster names: ${employeeRoster.map(e => e.fullName).join(', ')}`);
  logger.info(`[aircall] number assignments: ${Array.from(numberToUserMap.entries()).map(([n, e]) => `${n}→${e}`).join(', ')}`);

  // Phase 18 rev — persist userToNumbers map to state so Pulse data-shim
  // can render phone numbers per operator on the employee detail page.
  // Format: { email → [{id, name, digits, country, isDefault}] }
  try {
    const userNumbersObj = {};
    for (const [email, nums] of userToNumbers.entries()) {
      userNumbersObj[email] = nums;
    }
    await db().doc(STATE_PATH).set({
      state: { aircallUserNumbers: userNumbersObj },
    }, { merge: true });
    logger.info(`[aircall] persisted aircallUserNumbers for ${userToNumbers.size} operators`);
  } catch (e) {
    logger.warn(`[aircall] persist userNumbers failed: ${e.message}`);
  }

  // For incremental: use lastSync. For bootstrap: explicit sinceSec.
  let fromSec = sinceSec;
  if (!fromSec) {
    const last = await _getLastSync();
    if (last) {
      // Pull from 5 min before last sync to handle late-arriving events
      fromSec = Math.max(0, last - 5 * 60);
    } else {
      // No prior sync — default 30 days
      fromSec = Math.floor((Date.now() - 30 * 86400 * 1000) / 1000);
    }
  }

  const calls = await _fetchCallsSince(fromSec, userMap, numberToUserMap, employeeRoster, tenantsByPhone, isBootstrap ? 20000 : 2000);
  const { written, byEmail } = await _writeCallsToState(calls);

  // Advance cursor to NOW (slightly conservative — we re-fetch with 5min overlap above)
  const nowSec = Math.floor(Date.now() / 1000);
  await _setLastSync(nowSec);

  return {
    ok: true,
    fromSec,
    fetched: calls.length,
    written,
    byEmail,
    userMapSize: userMap.size,
    rosterSize: employeeRoster.length,
    nowSec,
  };
}

/* ------------- Exported Cloud Functions ------------- */

exports.pullAircallStats = onSchedule(
  {
    schedule: '*/5 * * * *',
    timeZone: 'UTC',
    secrets: [AIRCALL_API_ID, AIRCALL_API_TOKEN],
    memory: '512MiB',
    timeoutSeconds: 540,
  },
  async () => {
    try {
      const result = await _runPull({ isBootstrap: false });
      logger.info('[aircall] scheduled pull complete', result);
    } catch (err) {
      logger.error('[aircall] scheduled pull failed', err);
    }
  }
);

exports.adminPullAircall = onCall(
  {
    secrets: [AIRCALL_API_ID, AIRCALL_API_TOKEN],
    memory: '1GiB',
    timeoutSeconds: 540,
  },
  async (request) => {
    const callerEmail = (request.auth && request.auth.token && request.auth.token.email) || '';
    if (!ROOT_ADMINS.includes(callerEmail.toLowerCase())) {
      throw new HttpsError('permission-denied', 'Admin only');
    }
    const daysBack = Math.max(1, Math.min(365, +request.data?.daysBack || 30));
    const fromSec = Math.floor((Date.now() - daysBack * 86400 * 1000) / 1000);
    logger.info(`[aircall] admin bootstrap: ${daysBack} days back, from=${fromSec}`);
    const result = await _runPull({ sinceSec: fromSec, isBootstrap: true });
    return result;
  }
);

/* ============================================================
 * Phase 18 — push tenants to Aircall Contacts via API.
 * When operator gets an incoming call from a known tenant phone,
 * Aircall App (desktop/mobile) will display «Suite 305 · ABC Medical»
 * instead of «(312) 871-8354» — significantly speeds up answer time
 * and reduces wrong-call errors.
 *
 * Strategy:
 *  - Walk state.buildings → all units with non-empty u.phone.
 *  - For each, upsert into Aircall: search existing by phone digits
 *    via GET /v1/contacts/search?phone_number=...; if found → update;
 *    else POST /v1/contacts.
 *  - Schema: { first_name: «Suite 305», last_name: tenant/company,
 *              phone_numbers: [{ label: 'main', value: '+1...' }],
 *              information: '...building name, address...' }
 *  - Dedup: store mapping `tenant.aircallContactId` on the unit so
 *    re-runs use PUT instead of re-creating.
 *
 * Rate limit: 60 req/min. With phone search + write, ~2 req/tenant.
 * For 100 tenants ~ 3-4 min runtime. Cap at 500 tenants per run.
 * ============================================================ */

async function _pushTenantsToAircall(callerEmail) {
  const stateRef = db().doc(STATE_PATH);
  const snap = await stateRef.get();
  if (!snap.exists) return { ok: false, error: 'state doc missing' };

  const doc = snap.data() || {};
  const state = doc.state || {};
  const buildings = Array.isArray(state.buildings) ? state.buildings : [];

  // Collect tenants with phone numbers
  const tenants = [];
  for (const b of buildings) {
    for (const f of (b.floors || [])) {
      for (const u of (f.units || [])) {
        if (!u || !u.phone) continue;
        const digits = String(u.phone).replace(/[^\d]/g, '');
        if (digits.length < 10) continue;
        // Normalize to E.164-ish: if 10 digits, prepend +1; else as-is.
        const e164 = digits.length === 10 ? '+1' + digits : '+' + digits;
        tenants.push({
          unitId: u.id,
          buildingId: b.id,
          buildingName: b.name || b.address || b.id,
          phone: e164,
          phoneDigits: digits.slice(-10),
          tenantName: u.tenant || u.company || '',
          existingAircallId: u._aircallContactId || null,
        });
      }
    }
  }

  if (!tenants.length) {
    return { ok: true, total: 0, created: 0, updated: 0, errors: [] };
  }

  const MAX = 500;
  const stats = { total: tenants.length, processed: 0, created: 0, updated: 0, skipped: 0, errors: [] };
  // Track unit-level updates to push back into state at the end
  const aircallIdByUnitId = {};

  for (const t of tenants.slice(0, MAX)) {
    try {
      let aircallId = t.existingAircallId;
      // If no cached id, search Aircall by phone digits.
      if (!aircallId) {
        const searchData = await _aircallFetch(`/contacts/search?phone_number=${encodeURIComponent(t.phone)}`);
        const found = (searchData && Array.isArray(searchData.contacts)) ? searchData.contacts[0] : null;
        if (found && found.id) aircallId = found.id;
        await _sleep(REQ_PACE_MS);
      }

      const payload = {
        first_name: 'Suite ' + (t.unitId || '?'),
        last_name: t.tenantName || '',
        information: t.buildingName ? `Building: ${t.buildingName}` : '',
        phone_numbers: [{ label: 'main', value: t.phone }],
      };

      if (aircallId) {
        // Update
        await _aircallFetch(`/contacts/${aircallId}`, {
          method: 'POST',  // Aircall uses POST for updates per their docs
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        stats.updated++;
      } else {
        // Create
        const res = await _aircallFetch('/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const created = (res && res.contact) || {};
        if (created.id) aircallId = created.id;
        stats.created++;
      }

      if (aircallId) {
        aircallIdByUnitId[t.unitId] = aircallId;
      }
      stats.processed++;
      await _sleep(REQ_PACE_MS);
    } catch (err) {
      stats.errors.push({ unitId: t.unitId, error: err.message || String(err) });
      logger.warn(`[aircall-push] unit ${t.unitId} failed: ${err.message}`);
    }
  }

  // Write back aircallContactId per unit in one transaction
  if (Object.keys(aircallIdByUnitId).length > 0) {
    try {
      await db().runTransaction(async (tx) => {
        const snap = await tx.get(stateRef);
        const d = snap.exists ? (snap.data() || {}) : {};
        const buildings = (d.state && Array.isArray(d.state.buildings)) ? d.state.buildings : [];
        for (const b of buildings) {
          for (const f of (b.floors || [])) {
            for (const u of (f.units || [])) {
              if (u && aircallIdByUnitId[u.id]) {
                u._aircallContactId = aircallIdByUnitId[u.id];
              }
            }
          }
        }
        d.state.buildings = buildings;
        tx.set(stateRef, d, { merge: true });
      });
    } catch (e) {
      logger.warn(`[aircall-push] state write-back failed: ${e.message}`);
    }
  }

  logger.info(`[aircall-push] complete: ${JSON.stringify(stats)}`);
  return Object.assign({ ok: true, triggeredBy: callerEmail }, stats);
}

/* ============================================================
 * Phase 18 — getAircallRecording: fetch FRESH S3 signed URL for
 * a call recording on demand. Aircall recording URLs are time-
 * limited (~57 min via X-Amz-Expires=3419), так что URL'ы хранящиеся
 * в state.callActivity протухают через час после pull. Этот callable
 * вызывается из Pulse UI при клике на ▶ Play и возвращает свежий URL.
 *
 * Permission: ROOT_ADMINS only (PII — call recordings).
 * ============================================================ */
exports.getAircallRecording = onCall(
  {
    secrets: [AIRCALL_API_ID, AIRCALL_API_TOKEN],
    memory: '256MiB',
    timeoutSeconds: 30,
  },
  async (request) => {
    const callerEmail = (request.auth && request.auth.token && request.auth.token.email) || '';
    if (!ROOT_ADMINS.includes(callerEmail.toLowerCase())) {
      throw new HttpsError('permission-denied', 'Admin only');
    }
    const aircallId = request.data && request.data.aircallId;
    if (!aircallId) throw new HttpsError('invalid-argument', 'aircallId required');
    try {
      const data = await _aircallFetch(`/calls/${aircallId}`);
      const call = (data && data.call) || {};
      return {
        aircallId,
        recordingUrl: call.recording || null,
        voicemailUrl: call.voicemail || null,
      };
    } catch (e) {
      logger.warn(`[aircall-recording] fetch failed for ${aircallId}: ${e.message}`);
      throw new HttpsError('internal', e.message || 'Failed to fetch recording');
    }
  }
);

exports.syncTenantsToAircall = onCall(
  {
    secrets: [AIRCALL_API_ID, AIRCALL_API_TOKEN],
    memory: '1GiB',
    timeoutSeconds: 540,
  },
  async (request) => {
    const callerEmail = (request.auth && request.auth.token && request.auth.token.email) || '';
    if (!ROOT_ADMINS.includes(callerEmail.toLowerCase())) {
      throw new HttpsError('permission-denied', 'Admin only');
    }
    logger.info(`[aircall-push] triggered by ${callerEmail}`);
    return await _pushTenantsToAircall(callerEmail);
  }
);
