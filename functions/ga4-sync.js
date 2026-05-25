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
  // 2026-05-25 fix: GA4 runReport БЕЗ dimensions возвращает данные в
  // rows[0].metricValues, а НЕ в totals (totals только когда есть
  // dimensions). Fallback на rows[0] когда totals пустые.
  let totalsRaw = (report.totals && report.totals[0] && report.totals[0].metricValues) || null;
  if (!totalsRaw && report.rows && report.rows.length === 1 && dims.length === 0) {
    totalsRaw = report.rows[0].metricValues || [];
  }
  totalsRaw = totalsRaw || [];
  const totalsObj = {};
  totalsRaw.forEach((v, i) => { totalsObj[mets[i]] = Number(v.value) || 0; });
  return { rows, totals: totalsObj, rowCount: report.rowCount || rows.length };
}

// Top-level YYYY-MM-DD formatter (used by both _runSync and _runSyncRange)
function _fmtDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
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

/* ============================================================
   2026-05-25 Tony — ga4SyncRange callable
   On-demand range-based GA4 data fetch with comparison support.
   Used by redesigned Analytics page (period selector + delta tiles).

   Args (in request.data):
     period?: 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'mtd' |
              'lastMonth' | 'all' | 'custom'   (default 'today')
     custom?: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
     compareTo?: 'previous' | 'lastYear' | 'none'  (default 'previous')
     hourly?: boolean  (auto-true when period length ≤ 2 days)

   Returns:
     { ok, propertyId, period, granularity ('hourly'|'daily'),
       currentRange: { start, end, label },
       previousRange: { ... } | null,
       summary: { current, previous, deltas },
       timeseries: [{ key, current, previous }],
       sourceMedium / landingPages / events / devices / geo:
         [{ dims, current, previous }],
       fetchedAt }
   ============================================================ */
function _resolveRange(period, custom, today) {
  const todayYmd = _fmtDate(today);
  function shift(d, days) { return new Date(d.getTime() + days * 86400000); }
  function ymd(d) { return _fmtDate(d); }
  function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function prevMonthStart(d) { return new Date(d.getFullYear(), d.getMonth() - 1, 1); }
  function prevMonthEnd(d) { return new Date(d.getFullYear(), d.getMonth(), 0); }

  let start, end, label;
  switch (period) {
    case 'today':
      start = todayYmd; end = todayYmd; label = 'Today (' + todayYmd + ')'; break;
    case 'yesterday':
      { const y = shift(today, -1); start = ymd(y); end = ymd(y); label = 'Yesterday (' + start + ')'; }
      break;
    case '7d':
      start = ymd(shift(today, -6)); end = todayYmd; label = 'Last 7 days'; break;
    case '30d':
      start = ymd(shift(today, -29)); end = todayYmd; label = 'Last 30 days'; break;
    case '90d':
      start = ymd(shift(today, -89)); end = todayYmd; label = 'Last 90 days'; break;
    case 'mtd':
      start = ymd(monthStart(today)); end = todayYmd; label = 'Month to date'; break;
    case 'lastMonth':
      start = ymd(prevMonthStart(today)); end = ymd(prevMonthEnd(today)); label = 'Last month'; break;
    case 'all':
      // GA4 Data API max lookback ≈ 14 months for property
      start = ymd(shift(today, -395)); end = todayYmd; label = 'All time (last 395d)'; break;
    case 'custom':
      start = (custom && custom.start) || todayYmd;
      end = (custom && custom.end) || todayYmd;
      label = 'Custom (' + start + ' → ' + end + ')';
      break;
    default:
      start = todayYmd; end = todayYmd; label = 'Today';
  }
  return { start, end, label };
}

function _resolveComparisonRange(currentRange, compareTo, today) {
  if (compareTo === 'none') return null;
  const cStart = new Date(currentRange.start + 'T00:00:00');
  const cEnd = new Date(currentRange.end + 'T00:00:00');
  const lengthDays = Math.round((cEnd.getTime() - cStart.getTime()) / 86400000) + 1;

  if (compareTo === 'lastYear') {
    const lyStart = new Date(cStart); lyStart.setFullYear(lyStart.getFullYear() - 1);
    const lyEnd = new Date(cEnd); lyEnd.setFullYear(lyEnd.getFullYear() - 1);
    return { start: _fmtDate(lyStart), end: _fmtDate(lyEnd), label: 'Same period last year' };
  }
  // 'previous' — equal-length window immediately before currentRange
  const prevEnd = new Date(cStart.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - (lengthDays - 1) * 86400000);
  return {
    start: _fmtDate(prevStart),
    end: _fmtDate(prevEnd),
    label: 'Previous ' + lengthDays + ' day' + (lengthDays === 1 ? '' : 's'),
  };
}

// Group GA4 multi-range report rows by dimension values; split current/previous.
function _splitByRange(report, hasComparison) {
  const dims = (report.dimensionHeaders || []).map(h => h.name);
  const mets = (report.metricHeaders || []).map(h => h.name);
  const out = [];
  for (const row of (report.rows || [])) {
    const dimVals = {};
    (row.dimensionValues || []).forEach((v, i) => { dimVals[dims[i]] = v.value; });
    const rangeIdx = dimVals.dateRange === 'date_range_1' ? 1 : 0;
    const metricObj = {};
    (row.metricValues || []).forEach((v, i) => {
      const n = Number(v.value);
      metricObj[mets[i]] = Number.isFinite(n) ? n : v.value;
    });
    const dimsClean = Object.fromEntries(Object.entries(dimVals).filter(([k]) => k !== 'dateRange'));
    const groupKey = JSON.stringify(dimsClean);
    let existing = out.find(r => r.groupKey === groupKey);
    if (!existing) {
      existing = { groupKey, dims: dimsClean, current: {}, previous: hasComparison ? {} : null };
      out.push(existing);
    }
    if (rangeIdx === 0) existing.current = metricObj;
    else if (existing.previous !== null) existing.previous = metricObj;
  }
  // Sort by current.sessions desc when possible
  out.sort((a, b) => (b.current.sessions || b.current.eventCount || 0) - (a.current.sessions || a.current.eventCount || 0));
  return out.map(({ groupKey, ...rest }) => rest);
}

function _delta(cur, prev) {
  if (prev === undefined || prev === null) return null;
  if (prev === 0) return cur > 0 ? null : 0;
  return (cur - prev) / prev;
}

async function _runSyncRange({ period, custom, compareTo, hourly }) {
  const propertyId = GA4_PROPERTY_ID.value();
  const saJson = GA4_SERVICE_ACCOUNT_JSON.value();
  if (!propertyId || !saJson) throw new Error('GA4 secrets not bound');
  const accessToken = await _getAccessToken(saJson);

  const today = new Date();
  const currentRange = _resolveRange(period || 'today', custom, today);
  const compareToFinal = compareTo || 'previous';
  const previousRange = _resolveComparisonRange(currentRange, compareToFinal, today);
  const dateRanges = previousRange
    ? [
        { startDate: currentRange.start, endDate: currentRange.end },
        { startDate: previousRange.start, endDate: previousRange.end },
      ]
    : [{ startDate: currentRange.start, endDate: currentRange.end }];

  // Auto-hourly when range ≤ 2 days
  const rangeLengthDays = Math.round(
    (new Date(currentRange.end).getTime() - new Date(currentRange.start).getTime()) / 86400000
  ) + 1;
  const useHourly = hourly || rangeLengthDays <= 2;
  const timeDim = useHourly ? 'dateHour' : 'date';

  // 7 reports in parallel (each accepts 2 dateRanges for comparison in one call)
  const [
    summaryReport, sourceMediumReport, landingPagesReport, eventsReport,
    deviceReport, geoReport, timeseriesReport,
  ] = await Promise.all([
    _runReport(propertyId, accessToken, {
      dateRanges,
      metrics: [
        { name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' },
        { name: 'engagedSessions' }, { name: 'eventCount' }, { name: 'conversions' },
        { name: 'averageSessionDuration' }, { name: 'bounceRate' }, { name: 'screenPageViews' },
      ],
    }),
    _runReport(propertyId, accessToken, {
      dateRanges,
      dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'conversions' }, { name: 'engagedSessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: TOP_N,
    }),
    _runReport(propertyId, accessToken, {
      dateRanges,
      dimensions: [{ name: 'landingPage' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'conversions' }, { name: 'averageSessionDuration' }, { name: 'bounceRate' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: TOP_N,
    }),
    _runReport(propertyId, accessToken, {
      dateRanges,
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: TOP_N,
    }),
    _runReport(propertyId, accessToken, {
      dateRanges,
      dimensions: [{ name: 'deviceCategory' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'conversions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    }),
    _runReport(propertyId, accessToken, {
      dateRanges,
      dimensions: [{ name: 'country' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'conversions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 15,
    }),
    _runReport(propertyId, accessToken, {
      dateRanges,
      dimensions: [{ name: timeDim }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'conversions' }],
      orderBys: [{ dimension: { dimensionName: timeDim }, desc: false }],
      limit: 500,
    }),
  ]);

  // Summary — multi-range report returns rows = [current, previous].
  // When no dimensions but multiple dateRanges, GA4 auto-adds dateRange dim → 2 rows.
  const sumFlat = _flatten(summaryReport);
  let sumCur = {}, sumPrev = null;
  for (const row of sumFlat.rows) {
    const rangeIdx = row.dateRange === 'date_range_1' ? 1 : 0;
    const m = { ...row };
    delete m.dateRange;
    if (rangeIdx === 0) sumCur = m;
    else if (previousRange) sumPrev = m;
  }
  // If no dimensions case (single dateRange, no dateRange dim), fall back to flat totals
  if (!Object.keys(sumCur).length && sumFlat.totals && Object.keys(sumFlat.totals).length) {
    sumCur = sumFlat.totals;
  }
  const summaryDeltas = {};
  if (sumPrev) {
    for (const key of Object.keys(sumCur)) {
      summaryDeltas[key] = _delta(sumCur[key], sumPrev[key]);
    }
  }

  const hasComparison = !!previousRange;
  const sourceMedium = _splitByRange(sourceMediumReport, hasComparison);
  const landingPages = _splitByRange(landingPagesReport, hasComparison);
  const events = _splitByRange(eventsReport, hasComparison);
  const devices = _splitByRange(deviceReport, hasComparison);
  const geo = _splitByRange(geoReport, hasComparison);

  // Timeseries — normalize key + split current/previous
  const tsFlat = _flatten(timeseriesReport);
  const tsByKey = {};
  for (const row of tsFlat.rows) {
    const rawKey = row[timeDim];
    if (!rawKey) continue;
    const rangeIdx = row.dateRange === 'date_range_1' ? 1 : 0;
    let normKey = rawKey;
    if (useHourly && rawKey.length === 10) {
      // YYYYMMDDHH → "YYYY-MM-DD HH:00"
      normKey = rawKey.slice(0,4) + '-' + rawKey.slice(4,6) + '-' + rawKey.slice(6,8) + ' ' + rawKey.slice(8,10) + ':00';
    } else if (!useHourly && rawKey.length === 8) {
      normKey = rawKey.slice(0,4) + '-' + rawKey.slice(4,6) + '-' + rawKey.slice(6,8);
    }
    // For comparison, group "current" and "previous" by relative position rather than literal key
    // (since previous key dates differ). We'll keep them at the index position within their range.
    const groupKey = rangeIdx === 0 ? normKey : 'prev_' + normKey;
    if (!tsByKey[groupKey]) tsByKey[groupKey] = { key: normKey, rangeIdx };
    tsByKey[groupKey].sessions = row.sessions || 0;
    tsByKey[groupKey].users = row.totalUsers || 0;
    tsByKey[groupKey].conversions = row.conversions || 0;
  }
  // Build aligned timeseries: index 0 of current ↔ index 0 of previous
  const currentTs = Object.values(tsByKey).filter(r => r.rangeIdx === 0).sort((a,b) => a.key.localeCompare(b.key));
  const previousTs = Object.values(tsByKey).filter(r => r.rangeIdx === 1).sort((a,b) => a.key.localeCompare(b.key));
  const timeseries = currentTs.map((c, i) => ({
    key: c.key,
    current: { sessions: c.sessions, users: c.users, conversions: c.conversions },
    previous: previousTs[i] ? { sessions: previousTs[i].sessions, users: previousTs[i].users, conversions: previousTs[i].conversions } : null,
  }));

  return {
    ok: true,
    propertyId,
    period: period || 'today',
    compareTo: compareToFinal,
    granularity: useHourly ? 'hourly' : 'daily',
    currentRange,
    previousRange,
    summary: { current: sumCur, previous: sumPrev, deltas: summaryDeltas },
    timeseries,
    sourceMedium,
    landingPages,
    events,
    devices,
    geo,
    fetchedAt: new Date().toISOString(),
  };
}

exports.ga4SyncRange = onCall(
  { secrets: [GA4_PROPERTY_ID, GA4_SERVICE_ACCOUNT_JSON], timeoutSeconds: 60 },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    const { period, custom, compareTo, hourly } = request.data || {};
    try {
      const result = await _runSyncRange({ period, custom, compareTo, hourly });
      return result;
    } catch (e) {
      logger.error('[ga4-sync-range] FAIL: ' + e.message, e);
      throw new HttpsError('internal', e.message);
    }
  }
);
