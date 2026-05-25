/**
 * GA4 (Google Analytics 4) sync — Phase 2 marketing integration.
 *
 * Pulls site analytics from Google Analytics Data API into the same
 * marketing doc so Pulse can render a dedicated Analytics page +
 * cross-reference with ad spend (true CPL = ad spend ÷ form submits).
 *
 * Architecture
 * ------------
 *   • Service-account JWT auth (no user OAuth flow needed).
 *   • Calls runReport endpoint with multiple report definitions per sync:
 *       1. Summary KPIs (sessions, users, engagedSessions, eventCount,
 *          conversions, avgSessionDuration, bounceRate)
 *       2. Source/Medium breakdown (last 30 days)
 *       3. Top landing pages by sessions
 *       4. Conversions by event name
 *       5. Device category breakdown
 *       6. Geo (country) breakdown
 *       7. Daily timeseries (last 90 days — for SpendSection x-ref)
 *   • Stored under workspaces/{wid}/data/marketing.sources.ga4
 *
 * Auth secrets:
 *   GA4_PROPERTY_ID       — numeric property ID, e.g. "475139286"
 *   GA4_SERVICE_ACCOUNT   — full service-account JSON as a single string
 *
 * Service account setup (Tony does this once):
 *   1. https://console.cloud.google.com → Create project (or pick existing)
 *   2. APIs & Services → Library → enable "Google Analytics Data API"
 *   3. APIs & Services → Credentials → Create service account
 *   4. After creating → Keys → Add Key → JSON → download
 *   5. Copy email of service account (looks like
 *      pulse-ga4@<project>.iam.gserviceaccount.com)
 *   6. In GA4 (analytics.google.com) → Admin → Property Access Management
 *      → grant the service-account email "Viewer" role on the property
 *   7. Set both secrets in Firebase:
 *      firebase functions:secrets:set GA4_PROPERTY_ID
 *      firebase functions:secrets:set GA4_SERVICE_ACCOUNT_JSON
 *
 * Cron: every 60 min. Manual: ga4SyncNow callable.
 */

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');

const GA4_PROPERTY_ID = defineSecret('GA4_PROPERTY_ID');
const GA4_SERVICE_ACCOUNT_JSON = defineSecret('GA4_SERVICE_ACCOUNT_JSON');

const WORKSPACE_ID = 'default';
const ROOT_ADMINS = ['tony@al-en.com'];
const DAYS_BACK = 90;
const TOP_N = 25;

const db = admin.firestore();

// ---------- JWT helper (Service Account → Access Token) ----------
// Implements RFC 7523 — exchange a signed JWT for a Google OAuth2
// access token. Pure node-crypto, no google-auth-library dependency
// (CLAUDE.md: new deps need explicit approval).
async function _getAccessToken(serviceAccountJson) {
  const sa = (typeof serviceAccountJson === 'string')
    ? JSON.parse(serviceAccountJson)
    : serviceAccountJson;
  if (!sa.client_email || !sa.private_key) {
    throw new Error('Service account JSON missing client_email or private_key');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64u(header)}.${b64u(claim)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(sa.private_key, 'base64url');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Google token exchange ${res.status}: ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  if (!data.access_token) throw new Error('No access_token in response: ' + body.slice(0, 200));
  return data.access_token;
}

// ---------- GA4 Data API helper ----------
async function _runReport(propertyId, accessToken, body) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GA4 runReport ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

// Parse runReport response → flat array of { dim1, dim2..., metric1, ... }
function _flatten(report) {
  const dims = (report.dimensionHeaders || []).map(h => h.name);
  const mets = (report.metricHeaders || []).map(h => h.name);
  const rows = (report.rows || []).map(r => {
    const out = {};
    (r.dimensionValues || []).forEach((v, i) => { out[dims[i]] = v.value; });
    (r.metricValues || []).forEach((v, i) => {
      const n = Number(v.value);
      out[mets[i]] = Number.isFinite(n) ? n : v.value;
    });
    return out;
  });
  const totals = (report.totals && report.totals[0] && report.totals[0].metricValues) || [];
  const totalsObj = {};
  totals.forEach((v, i) => { totalsObj[mets[i]] = Number(v.value) || 0; });
  return { rows, totals: totalsObj, rowCount: report.rowCount || rows.length };
}

// ---------- Main sync ----------
async function _runSync() {
  const propertyId = GA4_PROPERTY_ID.value();
  const saJson = GA4_SERVICE_ACCOUNT_JSON.value();
  if (!propertyId) throw new Error('GA4_PROPERTY_ID secret not bound');
  if (!saJson) throw new Error('GA4_SERVICE_ACCOUNT_JSON secret not bound');

  const t0 = Date.now();
  const accessToken = await _getAccessToken(saJson);
  logger.info(`[ga4-sync] got access token for property ${propertyId}`);

  const today = new Date();
  const _fmt = (d) => d.toISOString().slice(0, 10);
  const end = _fmt(today);
  const start = _fmt(new Date(today.getTime() - DAYS_BACK * 86400 * 1000));
  const dateRange = { startDate: start, endDate: end };

  // Report 1 — Summary KPIs (totals only)
  const summaryReport = await _runReport(propertyId, accessToken, {
    dateRanges: [dateRange],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'engagedSessions' },
      { name: 'eventCount' },
      { name: 'conversions' },
      { name: 'averageSessionDuration' },
      { name: 'bounceRate' },
      { name: 'screenPageViews' },
    ],
  });

  // Report 2 — Source/Medium breakdown
  const sourceMediumReport = await _runReport(propertyId, accessToken, {
    dateRanges: [dateRange],
    dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'conversions' },
      { name: 'engagedSessions' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: TOP_N,
  });

  // Report 3 — Top landing pages
  const landingPagesReport = await _runReport(propertyId, accessToken, {
    dateRanges: [dateRange],
    dimensions: [{ name: 'landingPage' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'conversions' },
      { name: 'averageSessionDuration' },
      { name: 'bounceRate' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: TOP_N,
  });

  // Report 4 — Conversions / events by name
  const eventsReport = await _runReport(propertyId, accessToken, {
    dateRanges: [dateRange],
    dimensions: [{ name: 'eventName' }],
    metrics: [
      { name: 'eventCount' },
      { name: 'totalUsers' },
      { name: 'eventCountPerUser' },
    ],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: TOP_N,
  });

  // Report 5 — Device category
  const deviceReport = await _runReport(propertyId, accessToken, {
    dateRanges: [dateRange],
    dimensions: [{ name: 'deviceCategory' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'conversions' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
  });

  // Report 6 — Geo (country)
  const geoReport = await _runReport(propertyId, accessToken, {
    dateRanges: [dateRange],
    dimensions: [{ name: 'country' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'conversions' },
    ],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 15,
  });

  // Report 7 — Daily timeseries (for cross-reference with ad spend dates)
  const dailyReport = await _runReport(propertyId, accessToken, {
    dateRanges: [dateRange],
    dimensions: [{ name: 'date' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'conversions' },
    ],
    orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }],
    limit: 100,
  });

  // Flatten + collect
  const summary = _flatten(summaryReport).totals;
  const sourceMedium = _flatten(sourceMediumReport).rows;
  const landingPages = _flatten(landingPagesReport).rows;
  const events = _flatten(eventsReport).rows;
  const devices = _flatten(deviceReport).rows;
  const geo = _flatten(geoReport).rows;
  const daily = _flatten(dailyReport).rows.map(r => ({
    // GA4 date format YYYYMMDD → YYYY-MM-DD
    date: r.date.length === 8 ? `${r.date.slice(0,4)}-${r.date.slice(4,6)}-${r.date.slice(6,8)}` : r.date,
    sessions: r.sessions || 0,
    users: r.totalUsers || 0,
    conversions: r.conversions || 0,
  }));

  // Write payload
  const ingestedAt = new Date().toISOString();
  const mRef = db.doc(`workspaces/${WORKSPACE_ID}/data/marketing`);
  const sourcePayload = {
    source: 'ga4',
    fetchedAt: ingestedAt,
    ingestedAt,
    daysBack: DAYS_BACK,
    propertyId,
    summary,
    // JSON-stringify heavier rows arrays to dodge Firestore index cap
    sourceMediumJson: JSON.stringify(sourceMedium),
    landingPagesJson: JSON.stringify(landingPages),
    eventsJson: JSON.stringify(events),
    devicesJson: JSON.stringify(devices),
    geoJson: JSON.stringify(geo),
    dailyJson: JSON.stringify(daily),
    rowCounts: {
      sourceMedium: sourceMedium.length,
      landingPages: landingPages.length,
      events: events.length,
      devices: devices.length,
      geo: geo.length,
      daily: daily.length,
    },
  };
  await mRef.set({
    updatedAt: ingestedAt,
    sources: { ga4: sourcePayload },
  }, { merge: true });

  // Audit row
  try {
    await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
      action: 'marketing.ga4-sync',
      ts: Date.now(),
      actor: 'system:ga4-sync',
      note: `GA4 sync: ${summary.sessions || 0} sessions, ${summary.totalUsers || 0} users, ${summary.conversions || 0} conversions across ${daily.length} days`,
      counts: { sessions: summary.sessions || 0, users: summary.totalUsers || 0, conversions: summary.conversions || 0 },
    });
  } catch (e) {
    logger.warn('[ga4-sync] audit-write failed: ' + e.message);
  }

  const durMs = Date.now() - t0;
  logger.info(`[ga4-sync] DONE in ${durMs}ms: ${summary.sessions || 0} sessions, ${summary.conversions || 0} conversions`);
  return {
    sessions: summary.sessions || 0,
    users: summary.totalUsers || 0,
    conversions: summary.conversions || 0,
    daily: daily.length,
    durMs,
  };
}

// ---------- Public exports ----------
exports.ga4Sync = onSchedule(
  {
    schedule: 'every 60 minutes',
    timeZone: 'UTC',
    timeoutSeconds: 300,
    memory: '256MiB',
    secrets: [GA4_PROPERTY_ID, GA4_SERVICE_ACCOUNT_JSON],
  },
  async () => {
    try {
      const counts = await _runSync();
      logger.info('[ga4-sync] scheduled OK', counts);
    } catch (e) {
      logger.error('[ga4-sync] scheduled FAIL: ' + e.message, e);
      throw e;
    }
  }
);

exports.ga4SyncNow = onCall(
  { secrets: [GA4_PROPERTY_ID, GA4_SERVICE_ACCOUNT_JSON], timeoutSeconds: 300 },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    const counts = await _runSync();
    return { ok: true, counts };
  }
);
