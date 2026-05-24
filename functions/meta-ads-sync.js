/**
 * Meta (Facebook + Instagram) Ads sync — Phase 2 marketing integration.
 *
 * Architecture mirrors Google Ads ingest path but pulls server-side via
 * Graph API instead of waiting for an in-platform script callback. One
 * Cloud Function discovers all ad accounts the System User has access to,
 * pulls daily-granular insights for each, and writes the consolidated
 * payload to `workspaces/{wid}/data/marketing.sources.meta`.
 *
 * Auth:
 *   META_ACCESS_TOKEN — long-lived System User token (Business Manager →
 *   System Users → Generate New Token). Set via:
 *     firebase functions:secrets:set META_ACCESS_TOKEN
 *   Permissions required: ads_read, business_management
 *
 * Optional setting (operator-controlled via Pulse Marketing Settings):
 *   `workspaces/{wid}/data/marketing-settings.metaAdAccountIds: [act_X, ...]`
 *   If present, sync ONLY those accounts. If absent / empty → sync all
 *   accounts the System User can see.
 *
 * Storage shape (under sources.meta in marketing doc):
 *   {
 *     source: 'meta',
 *     fetchedAt, ingestedAt, daysBack,
 *     accountsJson: '[{id, name, currency, status, accountStatusDesc,
 *                      isRestricted, totals, daily}]'   // ALWAYS stringified
 *     accountCount, dailyRowCount,
 *     totals: {cost, clicks, impressions, conversions}, // rollup across accts
 *     campaigns: [],   // not used for Meta — campaigns are inside accounts
 *     campaignsJson: '[]',
 *   }
 *
 * Cron: every 60 min. Manual: metaAdsSyncNow callable.
 */

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const META_ACCESS_TOKEN = defineSecret('META_ACCESS_TOKEN');
const WORKSPACE_ID = 'default';
const ROOT_ADMINS = ['tony@al-en.com'];
// Graph API base. v22.0 is the current stable version as of 2026-05.
const GRAPH = 'https://graph.facebook.com/v22.0';
// How many days of daily breakdown to pull per account. Matches Google
// Ads script's window so SpendSection date-picker works consistently.
const DAYS_BACK = 90;
// Trim to keep doc small. 30 accts × 90 days = 2700 rows × ~80 bytes
// = 216 KB. Plus daily JSON-string serialization stays under the
// Firestore 40K index-entries cap (one entry per stringified field).
const MAX_ACCOUNTS = 50;
const MAX_DAILY_ROWS_PER_ACCT = 100;  // 90 daily + buffer

const db = admin.firestore();

// ---------- HTTP helper ----------
async function _g(token, path, params = {}) {
  const url = path.startsWith('http') ? path : (GRAPH + path);
  const qp = new URLSearchParams({ access_token: token, ...params });
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(url + sep + qp.toString());
  const body = await res.text();
  if (!res.ok) {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch (e) {}
    const msg = parsed.error?.message || body.slice(0, 400);
    throw new Error(`Graph API ${res.status}: ${msg}`);
  }
  return JSON.parse(body);
}

// Paginate through Graph API responses until exhausted or maxPages.
async function _gPaginate(token, path, params = {}, maxPages = 10) {
  const out = [];
  let next = null;
  for (let page = 0; page < maxPages; page++) {
    const data = next ? await _g(token, next) : await _g(token, path, params);
    const items = data.data || [];
    out.push(...items);
    next = data.paging?.next;
    if (!next) break;
  }
  return out;
}

// ---------- Settings ----------
async function _readSettings() {
  try {
    const snap = await db.doc(`workspaces/${WORKSPACE_ID}/data/marketing-settings`).get();
    if (!snap.exists) return {};
    return snap.data() || {};
  } catch (e) {
    logger.warn(`[meta-ads-sync] settings read failed (non-fatal): ${e.message}`);
    return {};
  }
}

// ---------- Discover ad accounts ----------
async function _fetchAccounts(token) {
  // GET /me/adaccounts returns all accounts the System User has access to.
  // Fields: id (act_XXX), name, currency, account_status (1=Active, 2=Disabled,
  // 3=Unsettled, 7=Pending Risk Review, 9=In Grace Period, 100=Pending Closure,
  // 101=Closed, 102=Pending Settlement, 201=Any Active, 202=Any Closed),
  // disable_reason.
  const fields = 'id,name,currency,account_status,disable_reason,timezone_name,business';
  const raw = await _gPaginate(token, '/me/adaccounts', { fields, limit: 100 }, 5);
  return raw.map(a => ({
    id: String(a.id || ''),                      // act_XXXXX
    name: String(a.name || '(unnamed)'),
    currency: String(a.currency || 'USD'),
    statusCode: Number(a.account_status) || 0,
    statusDesc: _statusDesc(a.account_status),
    isRestricted: _isRestricted(a.account_status),
    disableReason: a.disable_reason || null,
    timezone: a.timezone_name || null,
    businessId: a.business?.id || null,
    businessName: a.business?.name || null,
  })).slice(0, MAX_ACCOUNTS);
}

function _statusDesc(code) {
  const map = {
    1: 'Active', 2: 'Disabled', 3: 'Unsettled', 7: 'Pending Risk Review',
    8: 'In Review', 9: 'In Grace Period', 100: 'Pending Closure',
    101: 'Closed', 102: 'Pending Settlement', 201: 'Any Active', 202: 'Any Closed',
  };
  return map[Number(code)] || ('Unknown (' + code + ')');
}

function _isRestricted(code) {
  // Per Meta docs — these statuses mean ads are NOT delivering.
  return [2, 3, 7, 9, 100, 101, 102].includes(Number(code));
}

// ---------- Pull insights per account ----------
async function _fetchInsights(token, accountId, daysBack) {
  // Time range — last N days (Meta's "time_range" is YYYY-MM-DD inclusive).
  const today = new Date();
  const end = _fmtDate(today);
  const start = _fmtDate(new Date(today.getTime() - daysBack * 86400 * 1000));
  // Daily breakdown via time_increment=1 (1 day per row).
  const params = {
    level: 'account',                             // aggregate across campaigns
    fields: 'spend,clicks,impressions,actions,date_start',
    time_range: JSON.stringify({ since: start, until: end }),
    time_increment: '1',
    limit: 100,
  };
  let raw;
  try {
    raw = await _gPaginate(token, `/${accountId}/insights`, params, 5);
  } catch (e) {
    // Restricted/closed accounts often error on insights. Return empty
    // rather than crash the whole sync — UI will mark account «error».
    logger.warn(`[meta-ads-sync] ${accountId} insights failed: ${e.message}`);
    return { daily: [], error: e.message };
  }
  const daily = [];
  for (const row of raw) {
    const cost = Number(row.spend) || 0;
    const clicks = Number(row.clicks) || 0;
    const impressions = Number(row.impressions) || 0;
    // Meta «conversions» live in actions[] under various action_types.
    // We sum lead-related types: lead, onsite_conversion.lead_grouped,
    // submit_application, etc. — the operator-side intent is «form fills».
    let conversions = 0;
    if (Array.isArray(row.actions)) {
      for (const a of row.actions) {
        const t = String(a.action_type || '');
        if (/lead|submit_application|complete_registration/.test(t)) {
          conversions += Number(a.value) || 0;
        }
      }
    }
    daily.push({
      date: row.date_start,
      cost, clicks, impressions, conversions,
    });
  }
  return { daily: daily.slice(0, MAX_DAILY_ROWS_PER_ACCT), error: null };
}

function _fmtDate(d) {
  return d.getFullYear() + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}

// ---------- Main sync ----------
async function _runSync() {
  const token = META_ACCESS_TOKEN.value();
  if (!token) throw new Error('META_ACCESS_TOKEN secret not bound');

  const t0 = Date.now();
  const settings = await _readSettings();
  const filterIds = Array.isArray(settings.metaAdAccountIds) && settings.metaAdAccountIds.length > 0
    ? new Set(settings.metaAdAccountIds.map(s => String(s)))
    : null;

  // 1. Discover all accounts
  const allAccounts = await _fetchAccounts(token);
  logger.info(`[meta-ads-sync] discovered ${allAccounts.length} accounts`);

  // 2. Filter to enabled (per Settings) or all
  const targetAccounts = filterIds
    ? allAccounts.filter(a => filterIds.has(a.id))
    : allAccounts;
  logger.info(`[meta-ads-sync] syncing ${targetAccounts.length} accounts (filter active: ${!!filterIds})`);

  // 3. Pull insights per account (sequential to respect rate limits)
  const accounts = [];
  let totalCost = 0, totalClicks = 0, totalImpressions = 0, totalConversions = 0;
  let totalDailyRows = 0;
  for (const acct of targetAccounts) {
    if (acct.isRestricted) {
      // Restricted accounts often 400 on insights — still include in
      // payload with restriction flag so the UI shows them but doesn't
      // try to compute spend.
      accounts.push({ ...acct, daily: [], totals: { cost: 0, clicks: 0, impressions: 0, conversions: 0 }, error: 'restricted: ' + acct.statusDesc });
      continue;
    }
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

  // 4. Write to Firestore (consolidated under sources.meta)
  const ingestedAt = new Date().toISOString();
  const mRef = db.doc(`workspaces/${WORKSPACE_ID}/data/marketing`);
  const sourcePayload = {
    source: 'meta',
    fetchedAt: ingestedAt,
    ingestedAt,
    daysBack: DAYS_BACK,
    // JSON-stringify the heavy per-account daily breakdown to stay under
    // Firestore's 40K index-entries cap (FIXES_LOG Entry 31 pattern).
    accountsJson: JSON.stringify(accounts),
    accountCount: accounts.length,
    discoveredAccountCount: allAccounts.length,
    dailyRowCount: totalDailyRows,
    totals: {
      cost: totalCost,
      clicks: totalClicks,
      impressions: totalImpressions,
      conversions: totalConversions,
    },
    // Empty meta-level campaigns array (campaigns live inside accounts).
    // SpendSection ignores Meta's campaigns and surfaces accounts instead.
    campaignsJson: '[]',
    campaignCount: 0,
  };
  await mRef.set({
    updatedAt: ingestedAt,
    sources: { meta: sourcePayload },
    // Also persist the full discovered list (for the Settings UI to show
    // accounts that aren't currently being pulled).
    metaDiscoveredAccountsJson: JSON.stringify(allAccounts),
  }, { merge: true });

  // 5. Audit row
  try {
    await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
      action: 'marketing.meta-sync',
      ts: Date.now(),
      actor: 'system:meta-ads-sync',
      note: `Meta sync: ${accounts.length}/${allAccounts.length} accounts, $${totalCost.toFixed(2)} spend, ${totalClicks} clicks, ${totalConversions} conversions across ${totalDailyRows} daily rows`,
      counts: { accounts: accounts.length, discovered: allAccounts.length, dailyRows: totalDailyRows },
      totals: { cost: totalCost, clicks: totalClicks, conversions: totalConversions },
    });
  } catch (e) {
    logger.warn('[meta-ads-sync] audit-write failed: ' + e.message);
  }

  const durMs = Date.now() - t0;
  logger.info(`[meta-ads-sync] DONE in ${durMs}ms: ${accounts.length} accts, $${totalCost.toFixed(2)} spend, ${totalDailyRows} daily rows`);
  return {
    accounts: accounts.length,
    discovered: allAccounts.length,
    totalCost,
    totalClicks,
    totalConversions,
    dailyRows: totalDailyRows,
    durMs,
  };
}

// ---------- Public exports ----------
exports.metaAdsSync = onSchedule(
  {
    schedule: 'every 60 minutes',
    timeZone: 'UTC',
    timeoutSeconds: 540,  // accounts × insights can be slow
    memory: '256MiB',
    secrets: [META_ACCESS_TOKEN],
  },
  async () => {
    try {
      const counts = await _runSync();
      logger.info('[meta-ads-sync] scheduled OK', counts);
    } catch (e) {
      logger.error('[meta-ads-sync] scheduled FAIL: ' + e.message, e);
      throw e;
    }
  }
);

exports.metaAdsSyncNow = onCall(
  { secrets: [META_ACCESS_TOKEN], timeoutSeconds: 540 },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    const counts = await _runSync();
    return { ok: true, counts };
  }
);

// Settings — read/write which Meta ad accounts to pull. Tony controls
// this from the Marketing Settings panel in Pulse.
exports.metaSettingsSet = onCall(
  { timeoutSeconds: 30 },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    const ids = Array.isArray(request.data?.metaAdAccountIds)
      ? request.data.metaAdAccountIds.map(s => String(s)).slice(0, 50)
      : [];
    const notes = request.data?.metaAccountNotes && typeof request.data.metaAccountNotes === 'object'
      ? request.data.metaAccountNotes
      : {};
    await db.doc(`workspaces/${WORKSPACE_ID}/data/marketing-settings`).set({
      metaAdAccountIds: ids,
      metaAccountNotes: notes,
      updatedAt: new Date().toISOString(),
      updatedBy: email,
    }, { merge: true });
    return { ok: true, count: ids.length };
  }
);
