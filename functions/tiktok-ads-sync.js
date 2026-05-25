/**
 * TikTok (TikTok For Business) Ads sync — Phase 2 marketing integration.
 *
 * Architecture mirrors meta-ads-sync.js — one Cloud Function discovers all
 * advertisers (ad accounts) the access token has access to, pulls daily
 * insights per advertiser, and writes consolidated payload to
 * `workspaces/{wid}/data/marketing.sources.tiktok`.
 *
 * Auth:
 *   TIKTOK_ACCESS_TOKEN — long-lived access token from TikTok For Business
 *   Developer Center (created via Sandbox app, no review needed):
 *     1. https://business-api.tiktok.com/portal/ → My Apps → Create app
 *     2. Open the app → Sandbox → Add advertiser → Authorize
 *     3. Copy the Sandbox Access Token (valid until manually revoked)
 *   Set via:
 *     firebase functions:secrets:set TIKTOK_ACCESS_TOKEN
 *
 *   API docs: https://business-api.tiktok.com/portal/docs?id=1739946839226370
 *   Required permissions: Ad Account Management (read), Reporting (read)
 *
 * Optional setting (operator-controlled via Pulse Connections):
 *   `workspaces/{wid}/data/marketing-settings.tiktokAdvertiserIds: [...]`
 *   If present, sync ONLY those advertisers. If absent / empty → sync all.
 *
 * Storage shape (under sources.tiktok in marketing doc):
 *   {
 *     source: 'tiktok',
 *     fetchedAt, ingestedAt, daysBack,
 *     accountsJson: '[{id, name, currency, status, totals, daily}]'
 *     accountCount, dailyRowCount,
 *     totals: {cost, clicks, impressions, conversions},
 *     campaignsJson: '[]',   // not used (campaigns inside advertisers)
 *   }
 *
 * Cron: every 60 min. Manual: tiktokAdsSyncNow callable.
 */

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const TIKTOK_ACCESS_TOKEN = defineSecret('TIKTOK_ACCESS_TOKEN');
// App credentials — нужны для /oauth2/* endpoints (introspection).
// app_id публичный (виден в OAuth redirect URL), secret — Firebase secret.
const TIKTOK_APP_ID = '7643724741798281232';
const TIKTOK_APP_SECRET = defineSecret('TIKTOK_APP_SECRET');
const WORKSPACE_ID = 'default';
const ROOT_ADMINS = ['tony@al-en.com'];
// TikTok Business API base. v1.3 — current stable as of 2026-05.
const TIKTOK_API = 'https://business-api.tiktok.com/open_api/v1.3';
// Days of daily breakdown to pull per advertiser. Matches Meta + Google
// Ads windows so SpendSection date-picker works consistently.
const DAYS_BACK = 90;
// Safety caps — same as meta-ads-sync to keep doc size bounded.
const MAX_ADVERTISERS = 50;
const MAX_DAILY_ROWS_PER_ACCT = 100;  // 90 daily + buffer

const db = admin.firestore();

// ---------- HTTP helper ----------
// TikTok puts access_token in `Access-Token` header (NOT query param like Meta).
// Response shape: { code, message, data, request_id }.
// code === 0 = success, anything else = error (message has detail).
async function _tt(token, path, params = {}) {
  const url = path.startsWith('http') ? path : (TIKTOK_API + path);
  const qp = Object.keys(params).length
    ? '?' + new URLSearchParams(params).toString()
    : '';
  const res = await fetch(url + qp, {
    method: 'GET',
    headers: { 'Access-Token': token, 'Content-Type': 'application/json' },
  });
  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); }
  catch (e) { throw new Error(`TikTok API ${res.status} (non-JSON): ${body.slice(0, 200)}`); }
  if (!res.ok || parsed.code !== 0) {
    throw new Error(`TikTok API ${res.status} code=${parsed.code}: ${parsed.message || body.slice(0, 200)}`);
  }
  return parsed.data || {};
}

// ---------- Settings ----------
async function _readSettings() {
  try {
    const snap = await db.doc(`workspaces/${WORKSPACE_ID}/data/marketing-settings`).get();
    if (!snap.exists) return {};
    return snap.data() || {};
  } catch (e) {
    logger.warn(`[tiktok-ads-sync] settings read failed (non-fatal): ${e.message}`);
    return {};
  }
}

// ---------- Discover advertisers ----------
// Use /oauth2/advertiser/get/ to list advertisers the access token has
// permission for. Token-bound — different tokens see different advertisers.
async function _fetchAdvertisers(token) {
  // The endpoint returns app_id + secret-derived list of authorized
  // advertisers. For Sandbox tokens it's whoever you added in Sandbox UI.
  // For Production: all advertisers the app was authorized for via OAuth.
  // /oauth2/* endpoints REQUIRE app_id + secret в query params (не header).
  const data = await _tt(token, '/oauth2/advertiser/get/', {
    app_id: TIKTOK_APP_ID,
    secret: TIKTOK_APP_SECRET.value(),
  });
  const list = Array.isArray(data.list) ? data.list : [];
  // Enrich with /advertiser/info/ for name + currency + status (parallel).
  const ids = list.map(a => String(a.advertiser_id || a.id)).filter(Boolean).slice(0, MAX_ADVERTISERS);
  if (ids.length === 0) return [];
  let infoList = [];
  try {
    const info = await _tt(token, '/advertiser/info/', {
      advertiser_ids: JSON.stringify(ids),
      fields: JSON.stringify(['advertiser_id', 'name', 'currency', 'status', 'company', 'timezone', 'industry']),
    });
    infoList = Array.isArray(info.list) ? info.list : (Array.isArray(info) ? info : []);
  } catch (e) {
    logger.warn(`[tiktok-ads-sync] advertiser/info failed: ${e.message}`);
    // Fallback — return minimal records from the original list.
    infoList = ids.map(id => ({ advertiser_id: id, name: '(unknown)', currency: 'USD', status: 'UNKNOWN' }));
  }
  return infoList.map(a => ({
    id: String(a.advertiser_id),
    name: String(a.name || '(unnamed)'),
    currency: String(a.currency || 'USD'),
    statusCode: a.status || 'UNKNOWN',
    statusDesc: a.status || 'Unknown',
    isRestricted: /DISABLE|CLOSED|FROZEN|CANCEL/i.test(String(a.status || '')),
    timezone: a.timezone || null,
    businessId: null,
    businessName: a.company || null,
    industry: a.industry || null,
  }));
}

// ---------- Pull insights per advertiser ----------
// TikTok report endpoint: /report/integrated/get/
// data_level=AUCTION_ADVERTISER → aggregate at advertiser level (like Meta's level=account).
// report_type=BASIC, dimensions=['advertiser_id', 'stat_time_day'] → daily rows.
// metrics: spend, clicks, impressions, conversions.
async function _fetchInsights(token, advertiserId, daysBack) {
  // TikTok жёсткий лимит: max 30 дней на запрос при dimension=stat_time_day.
  // Чанкуем по 30 дней последовательно (TikTok rate-limit чувствительный).
  const CHUNK_DAYS = 30;
  const today = new Date();
  const allDaily = [];
  let lastError = null;
  for (let offset = 0; offset < daysBack; offset += CHUNK_DAYS) {
    const endOffset = offset;                                    // ближе к сегодня
    const startOffset = Math.min(offset + CHUNK_DAYS - 1, daysBack - 1);  // дальше в прошлое
    const end = _fmtDate(new Date(today.getTime() - endOffset * 86400 * 1000));
    const start = _fmtDate(new Date(today.getTime() - startOffset * 86400 * 1000));
    const params = {
      advertiser_id: advertiserId,
      report_type: 'BASIC',
      data_level: 'AUCTION_ADVERTISER',
      dimensions: JSON.stringify(['advertiser_id', 'stat_time_day']),
      metrics: JSON.stringify(['spend', 'clicks', 'impressions', 'conversion']),
      start_date: start,
      end_date: end,
      page_size: 1000,
    };
    let data;
    try {
      data = await _tt(token, '/report/integrated/get/', params);
    } catch (e) {
      logger.warn(`[tiktok-ads-sync] ${advertiserId} chunk ${start}..${end} failed: ${e.message}`);
      lastError = e.message;
      continue;  // другие чанки могут пройти
    }
    const rows = Array.isArray(data.list) ? data.list : [];
    for (const row of rows) {
      const dim = row.dimensions || {};
      const m = row.metrics || {};
      // stat_time_day comes as "YYYY-MM-DD 00:00:00" — slice to YYYY-MM-DD.
      const date = String(dim.stat_time_day || '').slice(0, 10);
      if (!date) continue;
      allDaily.push({
        date,
        cost: Number(m.spend) || 0,
        clicks: Number(m.clicks) || 0,
        impressions: Number(m.impressions) || 0,
        conversions: Number(m.conversion) || 0,
      });
    }
  }
  // Dedupe (overlap на границах чанков) + sort + cap.
  const byDate = new Map();
  for (const d of allDaily) if (!byDate.has(d.date)) byDate.set(d.date, d);
  const daily = Array.from(byDate.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, MAX_DAILY_ROWS_PER_ACCT);
  return { daily, error: lastError };
}

function _fmtDate(d) {
  return d.getFullYear() + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}

// ---------- Main sync ----------
async function _runSync() {
  const token = TIKTOK_ACCESS_TOKEN.value();
  if (!token) throw new Error('TIKTOK_ACCESS_TOKEN secret not bound');

  const t0 = Date.now();
  const settings = await _readSettings();
  const filterIds = Array.isArray(settings.tiktokAdvertiserIds) && settings.tiktokAdvertiserIds.length > 0
    ? new Set(settings.tiktokAdvertiserIds.map(s => String(s)))
    : null;

  // 1. Discover advertisers
  const allAdvertisers = await _fetchAdvertisers(token);
  logger.info(`[tiktok-ads-sync] discovered ${allAdvertisers.length} advertisers`);

  // 2. Filter (per settings) or all
  const targetAdvertisers = filterIds
    ? allAdvertisers.filter(a => filterIds.has(a.id))
    : allAdvertisers;
  logger.info(`[tiktok-ads-sync] syncing ${targetAdvertisers.length} (filter active: ${!!filterIds})`);

  // 3. Pull insights per advertiser (sequential — TikTok has stricter rate limits)
  const accounts = [];
  let totalCost = 0, totalClicks = 0, totalImpressions = 0, totalConversions = 0;
  let totalDailyRows = 0;
  for (const acct of targetAdvertisers) {
    const { daily, error } = await _fetchInsights(token, acct.id, DAYS_BACK);
    const totals = daily.reduce((acc, d) => ({
      cost: acc.cost + d.cost,
      clicks: acc.clicks + d.clicks,
      impressions: acc.impressions + d.impressions,
      conversions: acc.conversions + d.conversions,
    }), { cost: 0, clicks: 0, impressions: 0, conversions: 0 });
    accounts.push({ ...acct, daily, totals, error });
    totalCost += totals.cost;
    totalClicks += totals.clicks;
    totalImpressions += totals.impressions;
    totalConversions += totals.conversions;
    totalDailyRows += daily.length;
  }

  // 4. Write to Firestore
  const ingestedAt = new Date().toISOString();
  const mRef = db.doc(`workspaces/${WORKSPACE_ID}/data/marketing`);
  const sourcePayload = {
    source: 'tiktok',
    fetchedAt: ingestedAt,
    ingestedAt,
    daysBack: DAYS_BACK,
    // JSON-stringify to stay under Firestore index-entries cap.
    accountsJson: JSON.stringify(accounts),
    accountCount: accounts.length,
    discoveredAccountCount: allAdvertisers.length,
    dailyRowCount: totalDailyRows,
    totals: {
      cost: totalCost,
      clicks: totalClicks,
      impressions: totalImpressions,
      conversions: totalConversions,
    },
    campaignsJson: '[]',
    campaignCount: 0,
  };
  await mRef.set({
    updatedAt: ingestedAt,
    sources: { tiktok: sourcePayload },
    tiktokDiscoveredAccountsJson: JSON.stringify(allAdvertisers),
  }, { merge: true });

  // 5. Audit row
  try {
    await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
      action: 'marketing.tiktok-sync',
      ts: Date.now(),
      actor: 'system:tiktok-ads-sync',
      note: `TikTok sync: ${accounts.length}/${allAdvertisers.length} advertisers, $${totalCost.toFixed(2)} spend, ${totalClicks} clicks, ${totalConversions} conversions across ${totalDailyRows} daily rows`,
      counts: { accounts: accounts.length, discovered: allAdvertisers.length, dailyRows: totalDailyRows },
      totals: { cost: totalCost, clicks: totalClicks, conversions: totalConversions },
    });
  } catch (e) {
    logger.warn('[tiktok-ads-sync] audit-write failed: ' + e.message);
  }

  const durMs = Date.now() - t0;
  logger.info(`[tiktok-ads-sync] DONE in ${durMs}ms: ${accounts.length} advertisers, $${totalCost.toFixed(2)} spend, ${totalDailyRows} daily rows`);
  return {
    accounts: accounts.length,
    discovered: allAdvertisers.length,
    totalCost,
    totalClicks,
    totalConversions,
    dailyRows: totalDailyRows,
    durMs,
  };
}

// ---------- Public exports ----------
exports.tiktokAdsSync = onSchedule(
  {
    schedule: 'every 60 minutes',
    timeZone: 'UTC',
    timeoutSeconds: 540,
    memory: '256MiB',
    secrets: [TIKTOK_ACCESS_TOKEN, TIKTOK_APP_SECRET],
  },
  async () => {
    try {
      const counts = await _runSync();
      logger.info('[tiktok-ads-sync] scheduled OK', counts);
    } catch (e) {
      logger.error('[tiktok-ads-sync] scheduled FAIL: ' + e.message, e);
      throw e;
    }
  }
);

exports.tiktokAdsSyncNow = onCall(
  { secrets: [TIKTOK_ACCESS_TOKEN, TIKTOK_APP_SECRET], timeoutSeconds: 540 },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    const counts = await _runSync();
    return { ok: true, counts };
  }
);

// Settings — read/write which TikTok advertisers to pull.
exports.tiktokSettingsSet = onCall(
  { timeoutSeconds: 30 },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    const ids = Array.isArray(request.data?.tiktokAdvertiserIds)
      ? request.data.tiktokAdvertiserIds.map(s => String(s)).slice(0, 50)
      : [];
    const notes = request.data?.tiktokAccountNotes && typeof request.data.tiktokAccountNotes === 'object'
      ? request.data.tiktokAccountNotes
      : {};
    await db.doc(`workspaces/${WORKSPACE_ID}/data/marketing-settings`).set({
      tiktokAdvertiserIds: ids,
      tiktokAccountNotes: notes,
      updatedAt: new Date().toISOString(),
      updatedBy: email,
    }, { merge: true });
    return { ok: true, count: ids.length };
  }
);
