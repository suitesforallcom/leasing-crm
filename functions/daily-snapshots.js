/**
 * Daily snapshots (Phase 15) — aggregates per-employee metrics at end of day
 * and writes to /workspaces/{wid}/data/state under state.dailyHistory[<email>]
 * (last 90 entries FIFO). Enables real streak count + Most-X-in-a-day records
 * in MyDay.
 *
 * Triggered:
 *   - onSchedule daily at 23:55 UTC (just before midnight rollover).
 *   - adminRunSnapshot — manual trigger for backfill (root-admin only).
 *
 * Snapshot shape (one per employee per day):
 *   { date: 'YYYY-MM-DD',
 *     email,
 *     uid,
 *     sentEmails,
 *     receivedEmails,
 *     repliedEmails,
 *     contracts,
 *     hoursWorked,
 *     score,
 *     targetHit,    // boolean — daily targets met (3+ of 5)
 *   }
 */

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const WORKSPACE_ID = 'default';
const ROOT_ADMINS = ['tony@al-en.com'];
const HISTORY_CAP = 90; // ~3 months of daily snapshots per employee

const db = admin.firestore();

function _todayDateString() {
  // UTC date string — same boundary for all employees regardless of TZ.
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function _startOfDayMs(dateStr) {
  return new Date(dateStr + 'T00:00:00.000Z').getTime();
}
function _endOfDayMs(dateStr) {
  return new Date(dateStr + 'T23:59:59.999Z').getTime();
}

/**
 * Computes per-employee daily metrics for the given date string by reading
 * sessions + state.* in Firestore. Returns map: email → metrics.
 */
async function _computeSnapshotsForDate(dateStr) {
  const stateSnap = await db.doc(`workspaces/${WORKSPACE_ID}/data/state`).get();
  if (!stateSnap.exists) return {};
  const doc = stateSnap.data() || {};
  const state = doc.state || {};
  const gmailActivity = Array.isArray(state.gmailActivity) ? state.gmailActivity : [];

  const dayStart = _startOfDayMs(dateStr);
  const dayEnd = _endOfDayMs(dateStr);

  // Sessions for hours-worked + login
  const sessionsSnap = await db.collection(`workspaces/${WORKSPACE_ID}/sessions`).get();
  const sessionByEmail = {};
  for (const s of sessionsSnap.docs) {
    const data = s.data() || {};
    if (data.email) sessionByEmail[data.email.toLowerCase()] = data;
  }

  // Aggregate per email
  const per = {}; // email → { ...metrics }
  function _bucket(email) {
    const e = (email || '').toLowerCase();
    if (!e) return null;
    if (!per[e]) per[e] = {
      email: e, uid: '', sentEmails: 0, receivedEmails: 0, repliedEmails: 0,
      contracts: 0, hoursWorked: 0, score: 0, targetHit: false,
    };
    return per[e];
  }

  // Walk gmailActivity for sent/received/replied
  for (const g of gmailActivity) {
    if (!g || !g.ts) continue;
    const ms = new Date(g.ts).getTime();
    if (ms < dayStart || ms > dayEnd) continue;
    const owner = (g.owner || g.from || '').toLowerCase();
    const b = _bucket(owner);
    if (!b) continue;
    if (g.direction === 'received') b.receivedEmails++;
    else {
      b.sentEmails++;
      if (g.inReplyTo) b.repliedEmails++;
    }
  }

  // Walk u.outreach for matched gmail-api emails + walk leaseEnvelopes for contracts
  for (const bld of (state.buildings || [])) {
    for (const f of (bld.floors || [])) {
      for (const u of (f.units || [])) {
        for (const o of (u.outreach || [])) {
          if (!o || !o.ts) continue;
          if (o.source !== 'gmail-api') continue;
          const ms = new Date(o.ts).getTime();
          if (ms < dayStart || ms > dayEnd) continue;
          const owner = (o.ownerEmail || o.sentBy || '').toLowerCase();
          const b = _bucket(owner);
          if (!b) continue;
          if (o.direction === 'received') b.receivedEmails++;
          else {
            b.sentEmails++;
            if (o.inReplyTo) b.repliedEmails++;
          }
        }
        for (const env of (u.leaseEnvelopes || [])) {
          if (!env || !env.sentAt) continue;
          const ms = new Date(env.sentAt).getTime();
          if (ms < dayStart || ms > dayEnd) continue;
          const b = _bucket(env.sentBy);
          if (!b) continue;
          b.contracts++;
        }
      }
    }
  }

  // Hours worked + score (computed at end of day from session span)
  for (const email of Object.keys(per)) {
    const s = sessionByEmail[email];
    if (s && s.firstLoginToday && s.lastActivityAt) {
      const start = new Date(s.firstLoginToday).getTime();
      const end = new Date(s.lastActivityAt).getTime();
      if (end > start) {
        per[email].hoursWorked = Math.min(12, Math.round((end - start) / 36e5 * 10) / 10);
      }
      per[email].uid = s.uid || '';
    }
    // Composite score — simple weighted; 30% contracts (target 4/mo so 4/30=0.13 daily),
    // 25% sentEmails (target 20/day), bonuses cap at 100.
    const m = per[email];
    const contracts_pct = Math.min(1, m.contracts / 1); // any contract = 100%
    const emails_pct = Math.min(1, m.sentEmails / 20);
    const hours_pct = Math.min(1, m.hoursWorked / 8);
    m.score = Math.round((contracts_pct * 30 + emails_pct * 50 + hours_pct * 20));
    // Target hit if score ≥ 60 (i.e. 3 of 5 sub-targets effectively).
    m.targetHit = m.score >= 60;
  }

  return per;
}

/**
 * Writes per-employee snapshots into doc.state.dailyHistory.
 * Existing entries for same date are replaced (idempotent).
 * Keeps last HISTORY_CAP entries per email.
 */
async function _writeSnapshots(dateStr, perEmail) {
  const ref = db.doc(`workspaces/${WORKSPACE_ID}/data/state`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('state doc missing');
    const doc = snap.data();
    doc.state = doc.state || {};
    doc.state.dailyHistory = doc.state.dailyHistory || {};
    for (const email of Object.keys(perEmail)) {
      const arr = Array.isArray(doc.state.dailyHistory[email]) ? doc.state.dailyHistory[email] : [];
      // Remove any existing entry for this date
      const filtered = arr.filter(e => e && e.date !== dateStr);
      filtered.push({ date: dateStr, ...perEmail[email] });
      // FIFO trim
      doc.state.dailyHistory[email] = filtered.sort((a, b) => a.date.localeCompare(b.date)).slice(-HISTORY_CAP);
    }
    tx.set(ref, doc);
  });
}

// =========================================================================
// Scheduled — runs daily at 23:55 UTC.
// =========================================================================
exports.runDailySnapshot = onSchedule(
  {
    schedule: '55 23 * * *',
    timeZone: 'UTC',
    timeoutSeconds: 300,
    memory: '256MiB',
  },
  async () => {
    const dateStr = _todayDateString();
    const per = await _computeSnapshotsForDate(dateStr);
    const emails = Object.keys(per);
    if (!emails.length) {
      logger.info('[daily-snapshot] no employees with activity today', { dateStr });
      return;
    }
    await _writeSnapshots(dateStr, per);
    logger.info('[daily-snapshot] wrote', { dateStr, count: emails.length });
  }
);

// =========================================================================
// Manual — root admin only. For backfilling missing days or running now.
// Body: { date?: 'YYYY-MM-DD' } — defaults to today.
// =========================================================================
exports.adminRunSnapshot = onCall(
  { timeoutSeconds: 300 },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    const dateStr = request.data?.date || _todayDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new HttpsError('invalid-argument', 'date must be YYYY-MM-DD');
    }
    const per = await _computeSnapshotsForDate(dateStr);
    await _writeSnapshots(dateStr, per);
    return { ok: true, dateStr, count: Object.keys(per).length, summary: per };
  }
);
