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

const shared = require('./marketing-ads-shared');

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
// Ad-level constants. Soft caps to prevent runaway accounts from eating
// entire Firestore quota. Spend-sorted before cap — least-important drops.
const MAX_ADS_PER_ACCOUNT = 200;
const MAX_DAILY_ROWS_PER_AD = 100;

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
    // 2026-05-24 fix: don't skip restricted accounts. Status 3 (Unsettled,
    // i.e. unpaid invoice) and others still expose historical insights
    // even though ads aren't currently delivering. Previously we returned
    // empty payload here, which hid 70%+ of Tony's Meta spend (his
    // main Suitesforall account was Unsettled). Now: always TRY insights;
    // _fetchInsights catches any 400 and returns empty + error so the UI
    // marks the row with «error» but other accounts still aggregate.
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

// =============================================================================
// AD-LEVEL SYNC (Phase G, 2026-05-25)
// =============================================================================
// Pulls per-ad metadata + creative + daily insights from Meta Graph API,
// builds UnifiedAd objects (see marketing-ads-shared.js), upserts to
// workspaces/default/marketing_ads subcollection. Powers Pulse Top-Ads tab
// alongside TikTok and (future) Google Ads.
//
// Endpoints:
//   GET /{act_X}/ads        — list ads with embedded creative + campaign + adset
//   GET /{act_X}/insights   — per-ad daily metrics (level=ad)
//   GET /{video_id}         — enrich VIDEO creatives with source URL + poster
//
// Reuses _g(), _gPaginate(), _fetchAccounts(), _readSettings(), _fmtDate()
// from the account-level sync above — no duplication.
// =============================================================================

// ---------- Ads list (with creative field-expansion) ----------
async function _fetchAdsList(token, accountId) {
  // Field expansion: `field{subfield1,subfield2}` syntax embeds joined
  // entities in one request. Cheaper than separate /campaigns + /adsets calls.
  const fields = [
    'id', 'name', 'effective_status', 'status', 'created_time', 'updated_time',
    'campaign{id,name,objective,effective_status}',
    'adset{id,name,optimization_goal,effective_status}',
    'creative{id,name,thumbnail_url,video_id,image_url,image_hash,body,title,' +
      'call_to_action_type,link_url,object_url,object_story_spec,' +
      'instagram_permalink_url,asset_feed_spec}',
  ].join(',');
  const raw = await _gPaginate(token, `/${accountId}/ads`, { fields, limit: 100 }, 20);
  return raw;
}

// ---------- Per-ad daily insights ----------
async function _fetchAdLevelInsights(token, accountId, daysBack) {
  const today = new Date();
  const end = _fmtDate(today);
  const start = _fmtDate(new Date(today.getTime() - daysBack * 86400 * 1000));
  // Meta video_* arrays come as [{action_type, value}] — we sum across.
  const params = {
    level: 'ad',
    fields: [
      'ad_id', 'ad_name', 'campaign_id', 'adset_id',
      'spend', 'clicks', 'impressions', 'reach', 'frequency',
      'actions',
      'video_play_actions',
      'video_p25_watched_actions', 'video_p50_watched_actions',
      'video_p75_watched_actions', 'video_p100_watched_actions',
      'video_avg_time_watched_actions',
      'date_start',
    ].join(','),
    time_range: JSON.stringify({ since: start, until: end }),
    time_increment: '1',
    limit: 500,
  };
  let raw;
  try {
    raw = await _gPaginate(token, `/${accountId}/insights`, params, 20);
  } catch (e) {
    logger.warn(`[meta-ads-sync] ad-level insights ${accountId} failed: ${e.message}`);
    return { byAdId: new Map(), error: e.message };
  }
  const sumActionsArray = (arr) => {
    if (!Array.isArray(arr)) return 0;
    return arr.reduce((s, a) => s + (Number(a.value) || 0), 0);
  };
  const avgActionsArray = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    const total = arr.reduce((s, a) => s + (Number(a.value) || 0), 0);
    return total / arr.length;
  };
  const byAdId = new Map();
  for (const row of raw) {
    const adId = String(row.ad_id || '');
    if (!adId) continue;
    if (!byAdId.has(adId)) byAdId.set(adId, []);
    let conversions = 0;
    if (Array.isArray(row.actions)) {
      for (const a of row.actions) {
        const t = String(a.action_type || '');
        // Same lead-detection regex as account-level sync — keeps the
        // «conversions» definition consistent across both views.
        if (/lead|submit_application|complete_registration/.test(t)) {
          conversions += Number(a.value) || 0;
        }
      }
    }
    byAdId.get(adId).push({
      date: String(row.date_start || ''),
      spend: Number(row.spend) || 0,
      clicks: Number(row.clicks) || 0,
      impressions: Number(row.impressions) || 0,
      conversions,
      videoViews: sumActionsArray(row.video_play_actions),
      _videoViewsP25: sumActionsArray(row.video_p25_watched_actions),
      _videoViewsP50: sumActionsArray(row.video_p50_watched_actions),
      _videoViewsP75: sumActionsArray(row.video_p75_watched_actions),
      _videoViewsP100: sumActionsArray(row.video_p100_watched_actions),
      _avgVideoPlay: avgActionsArray(row.video_avg_time_watched_actions),
      _reach: Number(row.reach) || 0,
      _frequency: Number(row.frequency) || 0,
    });
  }
  for (const [adId, daily] of byAdId.entries()) {
    byAdId.set(adId,
      daily.sort((a, b) => a.date.localeCompare(b.date)).slice(0, MAX_DAILY_ROWS_PER_AD)
    );
  }
  return { byAdId, error: null };
}

// ---------- Video enrichment (per video_id → source URL + poster) ----------
// Graph API video endpoint is cheap (~50ms per call). Run sequentially
// rather than fan-out because rate limits are tighter than ad endpoints.
async function _fetchVideoEnrichment(token, ads) {
  const videoIds = new Set();
  for (const ad of ads) {
    const vid = ad.creative?.video_id;
    if (vid) videoIds.add(String(vid));
  }
  const out = new Map();
  for (const vid of videoIds) {
    try {
      const data = await _g(token, `/${vid}`, {
        fields: 'picture,source,length,format,permalink_url',
      });
      out.set(vid, {
        url: data.source || null,
        posterUrl: data.picture || null,
        durationSec: Number(data.length) || 0,
        permalink: data.permalink_url || null,
      });
    } catch (e) {
      // Video deleted / perm error — skip, ad keeps thumbnail from creative.
      logger.warn(`[meta-ads-sync] video ${vid} enrichment failed: ${e.message}`);
    }
  }
  return out;
}

// ---------- Status mapping (Meta effective_status → canonical) ----------
function _mapMetaStatus(effectiveStatus, status) {
  const s = String(effectiveStatus || status || '').toUpperCase();
  if (s === 'ACTIVE' || s === 'WITH_ISSUES') return 'ACTIVE';
  if (s === 'DELETED' || s === 'ARCHIVED') return 'DELETED';
  if (/PAUSED/.test(s)) return 'PAUSED'; // PAUSED, CAMPAIGN_PAUSED, ADSET_PAUSED
  if (s === 'DISAPPROVED' || s === 'REJECTED') return 'REJECTED';
  if (/PENDING|REVIEW|IN_PROCESS|PREAPPROVED/.test(s)) return 'PENDING_REVIEW';
  return s || 'UNKNOWN';
}

// ---------- Creative shape ----------
function _buildMetaCreative(creative, videoEnrichment) {
  if (!creative) return { type: 'IMAGE' };
  const videoId = creative.video_id ? String(creative.video_id) : null;
  const linkData = creative.object_story_spec?.link_data || null;
  const videoData = creative.object_story_spec?.video_data || null;
  const childAttachments = linkData?.child_attachments || null;
  const out = {
    type: 'IMAGE',
    primaryText: creative.body || linkData?.message || videoData?.message || null,
    callToAction: creative.call_to_action_type
      || linkData?.call_to_action?.type
      || videoData?.call_to_action?.type
      || null,
    landingUrl: creative.link_url || linkData?.link || null,
    displayUrl: creative.object_url || null,
    headlines: creative.title ? [creative.title] : null,
    posterUrl: creative.thumbnail_url || null,
  };
  if (videoId) {
    out.type = 'VIDEO';
    out.videoId = videoId;
    const v = videoEnrichment?.get(videoId);
    if (v) {
      out.videoUrl = v.url;
      if (!out.posterUrl) out.posterUrl = v.posterUrl;
      out.videoDurationSec = v.durationSec || null;
    }
  } else if (Array.isArray(childAttachments) && childAttachments.length > 1) {
    out.type = 'CAROUSEL';
    out.imageUrls = childAttachments
      .map(c => c.picture || c.image_url)
      .filter(Boolean);
  } else if (creative.image_url) {
    out.type = 'IMAGE';
    out.imageUrl = creative.image_url;
  }
  return out;
}

// ---------- UnifiedAd builder ----------
function _buildMetaUnifiedAd(account, ad, dailyRows, videoEnrichment, daysBack, ingestedAt, insightsError) {
  const creative = _buildMetaCreative(ad.creative, videoEnrichment);
  const baseTotals = shared.rollupDaily(dailyRows);
  let videoViewsP25 = 0, videoViewsP50 = 0, videoViewsP75 = 0, videoViewsP100 = 0;
  let avgVideoPlaySum = 0, avgVideoPlayDays = 0;
  for (const d of dailyRows) {
    videoViewsP25 += Number(d._videoViewsP25) || 0;
    videoViewsP50 += Number(d._videoViewsP50) || 0;
    videoViewsP75 += Number(d._videoViewsP75) || 0;
    videoViewsP100 += Number(d._videoViewsP100) || 0;
    if (Number(d._avgVideoPlay) > 0) {
      avgVideoPlaySum += Number(d._avgVideoPlay);
      avgVideoPlayDays++;
    }
  }
  const totals = shared.computeDerivedMetrics({
    ...baseTotals,
    videoViewsP25, videoViewsP50, videoViewsP75, videoViewsP100,
    avgVideoPlaySec: avgVideoPlayDays > 0 ? avgVideoPlaySum / avgVideoPlayDays : 0,
    // Meta doesn't expose per-ad engagement directly (likes/shares/comments
    // are organic-side, not in ad insights). Leave engagement omitted.
  });
  return {
    id: shared.adDocId('meta', ad.id),
    platform: 'meta',
    externalId: String(ad.id),
    account: {
      id: account.id,
      name: account.name,
      currency: account.currency,
    },
    campaign: {
      id: String(ad.campaign?.id || ''),
      name: ad.campaign?.name || '(unknown campaign)',
      objective: ad.campaign?.objective || null,
      status: ad.campaign?.effective_status || null,
    },
    adgroup: {
      id: String(ad.adset?.id || ''),
      name: ad.adset?.name || '(unknown ad set)',
      status: ad.adset?.effective_status || null,
    },
    ad: {
      id: String(ad.id),
      name: ad.name || '(unnamed ad)',
      status: _mapMetaStatus(ad.effective_status, ad.status),
      type: creative.type || null,
      createdAt: ad.created_time || null,
      modifiedAt: ad.updated_time || null,
    },
    creative,
    totals,
    daily: dailyRows,
    daysBack,
    fetchedAt: ingestedAt,
    ingestedAt,
    error: insightsError || null,
    platformExtras: {
      effectiveStatusRaw: ad.effective_status || null,
      instagramPermalink: ad.creative?.instagram_permalink_url || null,
    },
  };
}

// ---------- Main ad-level sync ----------
async function _runAdLevelSync() {
  const token = META_ACCESS_TOKEN.value();
  if (!token) throw new Error('META_ACCESS_TOKEN secret not bound');
  const t0 = Date.now();
  const ingestedAt = new Date().toISOString();
  const settings = await _readSettings();
  const filterIds = Array.isArray(settings.metaAdAccountIds) && settings.metaAdAccountIds.length > 0
    ? new Set(settings.metaAdAccountIds.map(s => String(s)))
    : null;

  const allAccounts = await _fetchAccounts(token);
  const targetAccounts = filterIds
    ? allAccounts.filter(a => filterIds.has(a.id))
    : allAccounts;
  logger.info(`[meta-ads-sync] ad-level: ${targetAccounts.length} accounts, ${DAYS_BACK} days back`);

  let totalAdsFetched = 0;
  let totalAdsWritten = 0;
  let totalSpend = 0;
  const presentIds = new Set();
  const perAccountErrors = [];

  for (const account of targetAccounts) {
    try {
      const [ads, insightsRes] = await Promise.all([
        _fetchAdsList(token, account.id),
        _fetchAdLevelInsights(token, account.id, DAYS_BACK),
      ]);
      totalAdsFetched += ads.length;
      const videoEnrichment = await _fetchVideoEnrichment(token, ads);
      const unifiedAds = ads
        .map(ad => _buildMetaUnifiedAd(
          account, ad,
          insightsRes.byAdId.get(String(ad.id)) || [],
          videoEnrichment,
          DAYS_BACK, ingestedAt, insightsRes.error
        ))
        .sort((a, b) => (b.totals.spend || 0) - (a.totals.spend || 0))
        .slice(0, MAX_ADS_PER_ACCOUNT);
      for (const u of unifiedAds) {
        presentIds.add(u.id);
        totalSpend += u.totals.spend || 0;
      }
      const writeRes = await shared.upsertAdsBatch(unifiedAds);
      totalAdsWritten += writeRes.written;
      if (writeRes.errors.length) {
        perAccountErrors.push({ accountId: account.id, batchErrors: writeRes.errors });
      }
      logger.info(`[meta-ads-sync] ${account.id}: ${ads.length} ads → ${writeRes.written} written`);
    } catch (e) {
      logger.error(`[meta-ads-sync] ad-level ${account.id} failed: ${e.message}`);
      perAccountErrors.push({ accountId: account.id, error: e.message });
    }
  }

  let pruned = 0;
  try {
    pruned = await shared.pruneStaleAds('meta', presentIds);
  } catch (e) {
    logger.warn(`[meta-ads-sync] prune failed: ${e.message}`);
  }

  try {
    await db.doc(`workspaces/${WORKSPACE_ID}/data/marketing`).set({
      sources: {
        meta: {
          adLevelLastSyncedAt: ingestedAt,
          adLevelTotalAds: totalAdsWritten,
          adLevelTotalSpend: totalSpend,
          adLevelPruned: pruned,
          adLevelErrors: perAccountErrors,
        },
      },
    }, { merge: true });
    await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
      action: 'marketing.meta-adlevel-sync',
      ts: Date.now(),
      actor: 'system:meta-ads-sync',
      note: `Meta ad-level: ${totalAdsWritten} ads written, $${totalSpend.toFixed(2)} spend, ${pruned} pruned, ${perAccountErrors.length} accounts had errors`,
      counts: { fetched: totalAdsFetched, written: totalAdsWritten, pruned },
      totals: { spend: totalSpend },
    });
  } catch (e) {
    logger.warn(`[meta-ads-sync] adlevel audit failed: ${e.message}`);
  }

  const durMs = Date.now() - t0;
  logger.info(`[meta-ads-sync] ad-level DONE in ${durMs}ms: ${totalAdsWritten} ads, $${totalSpend.toFixed(2)} spend`);
  return {
    accounts: targetAccounts.length,
    adsFetched: totalAdsFetched,
    adsWritten: totalAdsWritten,
    pruned,
    totalSpend,
    errors: perAccountErrors,
    durMs,
  };
}

exports.metaAdsAdLevelSyncNow = onCall(
  { secrets: [META_ACCESS_TOKEN], timeoutSeconds: 540, memory: '512MiB' },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    return _runAdLevelSync();
  }
);

// Scheduled cron — раз в час дёргает _runAdLevelSync() автоматически,
// чтобы Top Ads табу всегда была свежей без ручного клика «Sync ads».
// Кадр 60 минут совпадает с metaAdsSync (account-level rollup) — оба
// бьют в Meta Graph API, но против разных endpoints, так что rate limits
// независимы.
exports.metaAdsAdLevelSync = onSchedule(
  {
    schedule: 'every 60 minutes',
    timeZone: 'UTC',
    timeoutSeconds: 540,
    memory: '512MiB',
    secrets: [META_ACCESS_TOKEN],
  },
  async () => {
    try {
      const result = await _runAdLevelSync();
      logger.info('[meta-ads-adlevel-sync] scheduled OK', result.counts || {});
    } catch (e) {
      logger.error('[meta-ads-adlevel-sync] scheduled FAIL: ' + e.message, e);
      throw e;
    }
  }
);
