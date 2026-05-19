/**
 * Calendar ingest (Phase 14) — polling-based, simpler than Gmail's
 * watch/push model. Every 5 minutes the scheduled function pulls today's
 * + tomorrow's events for each workspace manager/admin via the Google
 * Calendar API, then writes a normalized list to state.calendarEvents
 * (per-employee).
 *
 * Reuses the same service-account credential (GMAIL_SA_KEY) that's already
 * granted domain-wide delegation. Operator just adds the second scope to
 * the existing Workspace DWD entry:
 *   https://www.googleapis.com/auth/calendar.events.readonly
 *
 * Then enable Calendar API in the project + scheduled CF runs.
 *
 * Schema written to doc.state.calendarEvents[email] = [
 *   { summary, start, end, attendees, location, htmlLink, status }
 * ]
 *
 * Pulse's MyDay reads st.calendarEvents[emp.email] for Today's Schedule.
 */

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const {google} = require('googleapis');

const GMAIL_SA_KEY = defineSecret('GMAIL_SA_KEY'); // re-use existing
const WORKSPACE_ID = 'default';
const ROOT_ADMINS = ['tony@al-en.com'];

let _saCache = null;
function _getServiceAccount() {
  if (_saCache) return _saCache;
  const raw = GMAIL_SA_KEY.value();
  if (!raw) throw new Error('GMAIL_SA_KEY not configured');
  _saCache = JSON.parse(raw);
  return _saCache;
}

function _calendarClientFor(userEmail) {
  const sa = _getServiceAccount();
  const jwt = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
    subject: userEmail,
  });
  return google.calendar({ version: 'v3', auth: jwt });
}

async function _fetchTodayEventsForEmail(email) {
  const cal = _calendarClientFor(email);
  const now = new Date();
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const endOfTomorrow = new Date(now); endOfTomorrow.setHours(0, 0, 0, 0);
  endOfTomorrow.setDate(endOfTomorrow.getDate() + 2); // today + tomorrow window
  const res = await cal.events.list({
    calendarId: 'primary',
    timeMin: startOfToday.toISOString(),
    timeMax: endOfTomorrow.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });
  const items = res.data.items || [];
  return items.map(ev => ({
    id: ev.id,
    summary: (ev.summary || '(no title)').slice(0, 200),
    start: ev.start?.dateTime || ev.start?.date || null,
    end: ev.end?.dateTime || ev.end?.date || null,
    attendeesCount: Array.isArray(ev.attendees) ? ev.attendees.length : 0,
    location: (ev.location || '').slice(0, 200),
    htmlLink: ev.htmlLink || null,
    status: ev.status || 'confirmed',
  }));
}

async function _runRefreshForAllMembers() {
  const db = admin.firestore();
  const membersSnap = await db.collection(`workspaces/${WORKSPACE_ID}/members`).get();
  const updates = {};
  let processed = 0, failed = 0;
  for (const m of membersSnap.docs) {
    const data = m.data() || {};
    const email = (data.email || '').toLowerCase().trim();
    if (!email) continue;
    if (data.archived) continue;
    if (data.role !== 'admin' && data.role !== 'manager') continue;
    try {
      updates[email] = await _fetchTodayEventsForEmail(email);
      processed++;
    } catch (e) {
      failed++;
      logger.warn('[calendar-refresh] failed for', email, e.message);
    }
  }
  // Persist to state
  const ref = db.doc(`workspaces/${WORKSPACE_ID}/data/state`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const doc = snap.data();
    doc.state = doc.state || {};
    doc.state.calendarEvents = Object.assign(doc.state.calendarEvents || {}, updates);
    tx.set(ref, doc);
  });
  return { processed, failed };
}

exports.refreshCalendarEvents = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'UTC',
    secrets: [GMAIL_SA_KEY],
    timeoutSeconds: 540,
    memory: '256MiB',
  },
  async () => {
    const result = await _runRefreshForAllMembers();
    logger.info('[calendar-refresh]', result);
  }
);

exports.adminRefreshCalendar = onCall(
  { secrets: [GMAIL_SA_KEY], timeoutSeconds: 540 },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    return await _runRefreshForAllMembers();
  }
);
