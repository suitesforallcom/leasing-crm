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
 * Phase 18 — Aircall в практике не назначает `user` на звонок если
 * номер используется несколькими операторами (общий building-number)
 * или если входящий звонок брошен (short_abandoned). Чтобы такие звонки
 * не потерять, парсим `number.name`: если содержит имя оператора
 * (full name из state.employees) — атрибутируем. Иначе SKIP (звонок
 * остаётся orphan'ом).
 *
 * Загружаем employees один раз и строим словарь { lowerCaseFullName, ... }
 * для substring-матчинга в _normalizeCall.
 */
async function _fetchEmployeeRoster() {
  const stateRef = db().doc(STATE_PATH);
  const snap = await stateRef.get();
  if (!snap.exists) return [];
  const doc = snap.data() || {};
  const emps = (doc.state && Array.isArray(doc.state.employees)) ? doc.state.employees : [];
  return emps
    .filter(e => e && e.email && e.status !== 'terminated' && e.trackInPulse !== false)
    .map(e => ({
      email: e.email.toLowerCase(),
      fullName: (e.fullName || '').toLowerCase().trim(),
      // Тоже split на части для substring match (например, для «Ann»
      // и «Noel» отдельно, на случай если number.name = «Ann Number»).
      firstName: (e.fullName || '').split(/\s+/)[0]?.toLowerCase() || '',
      lastName: (e.fullName || '').split(/\s+/).slice(-1)[0]?.toLowerCase() || '',
    }));
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
 *   2. c.number.name parsed against employee roster (e.g. «Ann Noel Number»)
 *   3. SKIP — orphan call (e.g. building-shared «Bay Vista Dr» number).
 */
function _normalizeCall(c, userMap, employeeRoster) {
  if (!c || !c.id) return null;
  const startedSec = c.started_at || 0;
  if (!startedSec) return null;
  const ts = startedSec * 1000;
  const answeredSec = c.answered_at || 0;
  const endedSec = c.ended_at || 0;
  const durationSec = c.duration || (endedSec && startedSec ? endedSec - startedSec : 0);
  const answerSec = answeredSec && startedSec ? answeredSec - startedSec : null;

  let status = 'answered';
  if (c.missed_call_reason || (!answeredSec && c.direction === 'inbound')) status = 'missed';
  if (c.voicemail) status = 'voicemail';

  // 1. Try explicit user assignment from Aircall
  let ownerEmail = c.user && c.user.id ? userMap.get(String(c.user.id)) : null;
  let attribution = 'aircall-user';
  // 2. Fallback: parse number.name for operator full name
  if (!ownerEmail && c.number && c.number.name) {
    const matched = _matchOperatorFromNumberName(c.number.name, employeeRoster);
    if (matched) {
      ownerEmail = matched;
      attribution = 'number-name-heuristic';
    }
  }
  if (!ownerEmail) return null;  // 3. SKIP orphan

  return {
    aircallId: c.id,
    ownerEmail,
    ts,
    direction: c.direction === 'outbound' ? 'outbound' : 'inbound',
    durationSec,
    answerSec,
    status,
    fromNumber: c.raw_digits || c.from || '',
    toNumber: c.to || '',
    numberName: c.number && c.number.name ? c.number.name : null,
    recordingUrl: c.recording || c.voicemail || null,
    _attribution: attribution,  // для дебага в логе
  };
}

/**
 * Walk Aircall /v1/calls from `fromSec` until either no more pages OR
 * we hit `maxCalls` (safety stop for very busy accounts).
 */
async function _fetchCallsSince(fromSec, userMap, employeeRoster, maxCalls = 5000) {
  const out = [];
  let totalRaw = 0;
  let skippedOrphan = 0;
  const attributionStats = { 'aircall-user': 0, 'number-name-heuristic': 0 };
  let next = `/calls?from=${fromSec}&per_page=${PER_PAGE}&order=asc`;
  let pageCount = 0;
  while (next && out.length < maxCalls) {
    const data = await _aircallFetch(next);
    pageCount++;
    for (const c of (data.calls || [])) {
      totalRaw++;
      const norm = _normalizeCall(c, userMap, employeeRoster);
      if (norm) {
        attributionStats[norm._attribution] = (attributionStats[norm._attribution] || 0) + 1;
        // drop debug field before returning
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
  logger.info(`[aircall] fetched ${out.length}/${totalRaw} calls (${skippedOrphan} orphan) across ${pageCount} pages (from=${fromSec})`);
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
  const [userMap, employeeRoster] = await Promise.all([
    _fetchUserMap(),
    _fetchEmployeeRoster(),
  ]);
  logger.info(`[aircall] user map size = ${userMap.size}, employee roster size = ${employeeRoster.length}`);
  logger.info(`[aircall] roster names: ${employeeRoster.map(e => e.fullName).join(', ')}`);

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

  const calls = await _fetchCallsSince(fromSec, userMap, employeeRoster, isBootstrap ? 20000 : 2000);
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
