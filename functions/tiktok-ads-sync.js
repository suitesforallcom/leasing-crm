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
const shared = require('./marketing-ads-shared');

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

// ============================================================
// AD-LEVEL SYNC (Phase D draft, scope-gated)
// ============================================================
// Pulls campaign → adgroup → ad → creative tree for every authorized
// advertiser and writes one UnifiedAd doc per ad into the
// `marketing_ads` subcollection (see marketing-ads-shared.js).
//
// Requires the access token to carry these scopes (in addition to
// existing Ad Account Management + Reporting):
//   - Ads Management        — for /campaign/get/, /adgroup/get/, /ad/get/
//   - Creative Management   — for /file/video/ad/info/, /file/image/ad/info/
//
// Until the token has those scopes, this whole section is unreachable —
// the public callable below early-exits with a clear error message.
// ============================================================

// How many ad-level daily rows per ad we keep. 90 days + buffer.
const MAX_DAILY_ROWS_PER_AD = 100;
// Cap per advertiser. Defensive — Top-Ads UI will show the heaviest spenders
// first; long-tail can be paged later if Tony asks.
const MAX_ADS_PER_ADVERTISER = 200;
// Per-page caps. TikTok max is 1000 for list endpoints but 200 keeps response
// payloads small and stable.
const TT_LIST_PAGE_SIZE = 200;

// ---------- Pagination helper ----------
// TikTok list endpoints return { page_info: { page, page_size, total_number,
// total_page }, list: [...] }. Walk all pages up to maxPages.
async function _ttPaginate(token, path, params, maxPages = 10) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await _tt(token, path, { ...params, page, page_size: TT_LIST_PAGE_SIZE });
    const items = Array.isArray(data.list) ? data.list : [];
    out.push(...items);
    const totalPages = Number(data.page_info?.total_page || 1);
    if (page >= totalPages || items.length === 0) break;
  }
  return out;
}

// ---------- Campaigns ----------
async function _fetchCampaigns(token, advertiserId) {
  // 2026-05-26: TikTok API v1.3 убрал поле 'status' — теперь
  // 'operation_status' (включён/выключен оператором) + 'secondary_status'
  // (живой статус с учётом review/delivery). Downstream код мапит
  // operation_status в общий .status (строки 628/633/638).
  const fields = JSON.stringify([
    'campaign_id', 'campaign_name', 'objective_type',
    'operation_status', 'secondary_status',
    'budget', 'budget_mode', 'create_time', 'modify_time',
  ]);
  const list = await _ttPaginate(token, '/campaign/get/', {
    advertiser_id: advertiserId,
    fields,
  });
  // Index by id for join.
  const byId = new Map();
  for (const c of list) byId.set(String(c.campaign_id), c);
  return byId;
}

// ---------- Ad groups ----------
async function _fetchAdgroups(token, advertiserId) {
  // См. комментарий в _fetchCampaigns — поле 'status' удалено в v1.3.
  const fields = JSON.stringify([
    'adgroup_id', 'adgroup_name', 'campaign_id',
    'operation_status', 'secondary_status',
    'budget', 'optimization_goal', 'placement_type',
    'create_time', 'modify_time',
  ]);
  const list = await _ttPaginate(token, '/adgroup/get/', {
    advertiser_id: advertiserId,
    fields,
  });
  const byId = new Map();
  for (const a of list) byId.set(String(a.adgroup_id), a);
  return byId;
}

// ---------- Ads ----------
async function _fetchAds(token, advertiserId) {
  // См. комментарий в _fetchCampaigns — поле 'status' удалено в v1.3.
  // Остальные поля сверены с whitelist который TikTok возвращает в
  // ошибке 40002 (логи 2026-05-26).
  const fields = JSON.stringify([
    'ad_id', 'ad_name', 'adgroup_id', 'campaign_id',
    'operation_status', 'secondary_status',
    'ad_format', 'ad_text', 'call_to_action',
    'landing_page_url', 'display_name', 'video_id', 'image_ids',
    'identity_id', 'identity_type', 'create_time', 'modify_time',
  ]);
  const list = await _ttPaginate(token, '/ad/get/', {
    advertiser_id: advertiserId,
    fields,
  });
  return list;
}

// ---------- Per-ad daily reports ----------
// Same 30-day chunking pattern as advertiser-level _fetchInsights but
// scoped to data_level=AUCTION_AD with video + engagement metrics.
async function _fetchAdReports(token, advertiserId, daysBack) {
  const CHUNK_DAYS = 30;
  const today = new Date();
  const reportsByAdId = new Map();  // ad_id -> Map<date, dailyRow>
  let lastError = null;
  for (let offset = 0; offset < daysBack; offset += CHUNK_DAYS) {
    const endOffset = offset;
    const startOffset = Math.min(offset + CHUNK_DAYS - 1, daysBack - 1);
    const end = _fmtDate(new Date(today.getTime() - endOffset * 86400 * 1000));
    const start = _fmtDate(new Date(today.getTime() - startOffset * 86400 * 1000));
    // Iterate report pages — single advertiser can have thousands of (ad×day)
    // rows. TikTok returns page_info; we cap at 25 pages × 1000 = 25K rows.
    let page = 1;
    while (page <= 25) {
      const params = {
        advertiser_id: advertiserId,
        report_type: 'BASIC',
        data_level: 'AUCTION_AD',
        dimensions: JSON.stringify(['ad_id', 'stat_time_day']),
        metrics: JSON.stringify([
          'spend', 'clicks', 'impressions', 'conversion',
          'video_play_actions',
          'video_views_p25', 'video_views_p50', 'video_views_p75', 'video_views_p100',
          'average_video_play',
          'likes', 'shares', 'comments', 'follows', 'profile_visits',
        ]),
        start_date: start,
        end_date: end,
        page,
        page_size: 1000,
      };
      let data;
      try {
        data = await _tt(token, '/report/integrated/get/', params);
      } catch (e) {
        logger.warn(`[tiktok-ads-sync] ad-level ${advertiserId} chunk ${start}..${end} p${page} failed: ${e.message}`);
        lastError = e.message;
        break;
      }
      const rows = Array.isArray(data.list) ? data.list : [];
      for (const row of rows) {
        const dim = row.dimensions || {};
        const m = row.metrics || {};
        const adId = String(dim.ad_id || '');
        const date = String(dim.stat_time_day || '').slice(0, 10);
        if (!adId || !date) continue;
        if (!reportsByAdId.has(adId)) reportsByAdId.set(adId, new Map());
        const dayMap = reportsByAdId.get(adId);
        // Don't overwrite — first write wins (dedup overlapping chunk borders).
        if (dayMap.has(date)) continue;
        dayMap.set(date, {
          date,
          spend: Number(m.spend) || 0,
          clicks: Number(m.clicks) || 0,
          impressions: Number(m.impressions) || 0,
          conversions: Number(m.conversion) || 0,
          videoViews: Number(m.video_play_actions) || 0,
          // Extras kept on the daily row for richer per-day charts later.
          _videoViewsP25: Number(m.video_views_p25) || 0,
          _videoViewsP50: Number(m.video_views_p50) || 0,
          _videoViewsP75: Number(m.video_views_p75) || 0,
          _videoViewsP100: Number(m.video_views_p100) || 0,
          _likes: Number(m.likes) || 0,
          _shares: Number(m.shares) || 0,
          _comments: Number(m.comments) || 0,
          _follows: Number(m.follows) || 0,
          _profileVisits: Number(m.profile_visits) || 0,
          _avgVideoPlay: Number(m.average_video_play) || 0,
        });
      }
      const totalPages = Number(data.page_info?.total_page || 1);
      if (page >= totalPages || rows.length === 0) break;
      page++;
    }
  }
  // Convert per-ad day-maps → sorted arrays + cap.
  const finalByAdId = new Map();
  for (const [adId, dayMap] of reportsByAdId.entries()) {
    const daily = Array.from(dayMap.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, MAX_DAILY_ROWS_PER_AD);
    finalByAdId.set(adId, daily);
  }
  return { reportsByAdId: finalByAdId, error: lastError };
}

// ---------- Creative file info ----------
async function _fetchVideoInfo(token, advertiserId, videoIds) {
  if (!videoIds || videoIds.length === 0) return new Map();
  const out = new Map();
  // Endpoint accepts ≤60 ids per call.
  for (let i = 0; i < videoIds.length; i += 60) {
    const chunk = videoIds.slice(i, i + 60);
    let data;
    try {
      data = await _tt(token, '/file/video/ad/info/', {
        advertiser_id: advertiserId,
        video_ids: JSON.stringify(chunk),
      });
    } catch (e) {
      logger.warn(`[tiktok-ads-sync] video info chunk ${i} failed: ${e.message}`);
      continue;
    }
    const list = Array.isArray(data.list) ? data.list : (Array.isArray(data) ? data : []);
    for (const v of list) {
      if (!v.video_id) continue;
      out.set(String(v.video_id), {
        url: v.url || v.preview_url || null,
        posterUrl: v.poster_url || v.preview_url || null,
        durationSec: Number(v.duration) || 0,
        width: Number(v.width) || 0,
        height: Number(v.height) || 0,
      });
    }
  }
  return out;
}

async function _fetchImageInfo(token, advertiserId, imageIds) {
  if (!imageIds || imageIds.length === 0) return new Map();
  const out = new Map();
  for (let i = 0; i < imageIds.length; i += 60) {
    const chunk = imageIds.slice(i, i + 60);
    let data;
    try {
      data = await _tt(token, '/file/image/ad/info/', {
        advertiser_id: advertiserId,
        image_ids: JSON.stringify(chunk),
      });
    } catch (e) {
      logger.warn(`[tiktok-ads-sync] image info chunk ${i} failed: ${e.message}`);
      continue;
    }
    const list = Array.isArray(data.list) ? data.list : (Array.isArray(data) ? data : []);
    for (const im of list) {
      if (!im.image_id) continue;
      out.set(String(im.image_id), {
        url: im.url || null,
        width: Number(im.width) || 0,
        height: Number(im.height) || 0,
      });
    }
  }
  return out;
}

// ---------- Join into UnifiedAd shape ----------
function _aspectRatio(w, h) {
  if (!w || !h) return null;
  const r = w / h;
  if (Math.abs(r - 9 / 16) < 0.05) return '9:16';
  if (Math.abs(r - 1) < 0.05) return '1:1';
  if (Math.abs(r - 16 / 9) < 0.05) return '16:9';
  if (Math.abs(r - 4 / 5) < 0.05) return '4:5';
  return `${w}x${h}`;
}

function _buildCreative(ad, videoMap, imageMap) {
  const videoId = ad.video_id ? String(ad.video_id) : null;
  const imageIds = Array.isArray(ad.image_ids)
    ? ad.image_ids.map(String).filter(Boolean)
    : [];
  // ad_format from TikTok: SINGLE_VIDEO, SINGLE_IMAGE, CAROUSEL_ADS, etc.
  let type = 'IMAGE';
  if (videoId) type = 'VIDEO';
  else if (imageIds.length > 1) type = 'CAROUSEL';
  else if (imageIds.length === 1) type = 'IMAGE';

  const creative = {
    type,
    primaryText: ad.ad_text || null,
    callToAction: ad.call_to_action || null,
    landingUrl: ad.landing_page_url || null,
    displayUrl: ad.display_name || null,
  };
  if (videoId && videoMap.has(videoId)) {
    const v = videoMap.get(videoId);
    creative.videoId = videoId;
    creative.videoUrl = v.url;
    creative.posterUrl = v.posterUrl;
    creative.videoDurationSec = v.durationSec;
    creative.videoAspectRatio = _aspectRatio(v.width, v.height);
  }
  if (imageIds.length === 1 && imageMap.has(imageIds[0])) {
    creative.imageUrl = imageMap.get(imageIds[0]).url;
  } else if (imageIds.length > 1) {
    creative.imageUrls = imageIds
      .map(id => imageMap.get(id)?.url)
      .filter(Boolean);
  }
  return creative;
}

function _buildUnifiedAd(advertiser, ad, campaignsById, adgroupsById, dailyRows, videoMap, imageMap, daysBack, ingestedAt, adReportError) {
  const campaign = campaignsById.get(String(ad.campaign_id)) || {};
  const adgroup = adgroupsById.get(String(ad.adgroup_id)) || {};
  const daily = dailyRows || [];
  const baseTotals = shared.rollupDaily(daily);
  // Sum engagement extras from per-day rows (kept on daily under _-prefix).
  const engagement = { likes: 0, shares: 0, comments: 0, follows: 0, profileVisits: 0 };
  let videoViewsP25 = 0, videoViewsP50 = 0, videoViewsP75 = 0, videoViewsP100 = 0;
  let avgVideoPlaySum = 0, avgVideoPlayDays = 0;
  for (const d of daily) {
    engagement.likes += Number(d._likes) || 0;
    engagement.shares += Number(d._shares) || 0;
    engagement.comments += Number(d._comments) || 0;
    engagement.follows += Number(d._follows) || 0;
    engagement.profileVisits += Number(d._profileVisits) || 0;
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
    engagement,
  });
  return {
    id: shared.adDocId('tiktok', ad.ad_id),
    platform: 'tiktok',
    externalId: String(ad.ad_id),
    account: {
      id: advertiser.id,
      name: advertiser.name,
      currency: advertiser.currency,
    },
    campaign: {
      id: String(ad.campaign_id || ''),
      name: campaign.campaign_name || '(unknown campaign)',
      objective: campaign.objective_type || null,
      status: campaign.operation_status || campaign.status || null,
    },
    adgroup: {
      id: String(ad.adgroup_id || ''),
      name: adgroup.adgroup_name || '(unknown ad group)',
      status: adgroup.operation_status || adgroup.status || null,
    },
    ad: {
      id: String(ad.ad_id || ''),
      name: ad.ad_name || '(unnamed ad)',
      status: ad.operation_status || ad.status || 'UNKNOWN',
      type: ad.ad_format || null,
      createdAt: ad.create_time || null,
      modifiedAt: ad.modify_time || null,
    },
    creative: _buildCreative(ad, videoMap, imageMap),
    totals,
    daily,
    daysBack,
    fetchedAt: ingestedAt,
    ingestedAt,
    error: adReportError || null,
    platformExtras: {
      identityId: ad.identity_id || null,
      identityType: ad.identity_type || null,
    },
  };
}

// ---------- Main ad-level sync (per advertiser, then global) ----------
async function _runAdLevelSync() {
  const token = TIKTOK_ACCESS_TOKEN.value();
  if (!token) throw new Error('TIKTOK_ACCESS_TOKEN secret not bound');
  const t0 = Date.now();
  const ingestedAt = new Date().toISOString();
  const settings = await _readSettings();
  const filterIds = Array.isArray(settings.tiktokAdvertiserIds) && settings.tiktokAdvertiserIds.length > 0
    ? new Set(settings.tiktokAdvertiserIds.map(s => String(s)))
    : null;

  const allAdvertisers = await _fetchAdvertisers(token);
  const targetAdvertisers = filterIds
    ? allAdvertisers.filter(a => filterIds.has(a.id))
    : allAdvertisers;
  logger.info(`[tiktok-ads-sync] ad-level: ${targetAdvertisers.length} advertisers, ${DAYS_BACK} days back`);

  let totalAdsFetched = 0;
  let totalAdsWritten = 0;
  let totalSpend = 0;
  const presentIds = new Set();
  const perAdvertiserErrors = [];

  for (const advertiser of targetAdvertisers) {
    try {
      const [campaignsById, adgroupsById, ads, reportRes] = await Promise.all([
        _fetchCampaigns(token, advertiser.id),
        _fetchAdgroups(token, advertiser.id),
        _fetchAds(token, advertiser.id),
        _fetchAdReports(token, advertiser.id, DAYS_BACK),
      ]);
      totalAdsFetched += ads.length;
      // Resolve creative files in parallel for THIS advertiser.
      const videoIds = ads.map(a => a.video_id).filter(Boolean).map(String);
      const imageIds = [];
      for (const a of ads) {
        if (Array.isArray(a.image_ids)) imageIds.push(...a.image_ids.map(String));
      }
      const [videoMap, imageMap] = await Promise.all([
        _fetchVideoInfo(token, advertiser.id, [...new Set(videoIds)]),
        _fetchImageInfo(token, advertiser.id, [...new Set(imageIds)]),
      ]);
      // Build unified ads + sort by spend desc + cap.
      const unifiedAds = ads
        .map(ad => _buildUnifiedAd(
          advertiser, ad, campaignsById, adgroupsById,
          reportRes.reportsByAdId.get(String(ad.ad_id)) || [],
          videoMap, imageMap, DAYS_BACK, ingestedAt, reportRes.error
        ))
        .sort((a, b) => (b.totals.spend || 0) - (a.totals.spend || 0))
        .slice(0, MAX_ADS_PER_ADVERTISER);
      for (const u of unifiedAds) {
        presentIds.add(u.id);
        totalSpend += u.totals.spend || 0;
      }
      const writeRes = await shared.upsertAdsBatch(unifiedAds);
      totalAdsWritten += writeRes.written;
      if (writeRes.errors.length) {
        perAdvertiserErrors.push({ advertiserId: advertiser.id, batchErrors: writeRes.errors });
      }
      logger.info(`[tiktok-ads-sync] ${advertiser.id}: ${ads.length} ads → ${writeRes.written} written`);
    } catch (e) {
      logger.error(`[tiktok-ads-sync] ad-level ${advertiser.id} failed: ${e.message}`);
      perAdvertiserErrors.push({ advertiserId: advertiser.id, error: e.message });
    }
  }

  // Prune ads that have disappeared from TikTok since the last run.
  let pruned = 0;
  try {
    pruned = await shared.pruneStaleAds('tiktok', presentIds);
  } catch (e) {
    logger.warn(`[tiktok-ads-sync] prune failed: ${e.message}`);
  }

  // Audit + summary doc (one consolidated record on the marketing doc so the
  // UI shows when ad-level was last synced).
  try {
    await db.doc(`workspaces/${WORKSPACE_ID}/data/marketing`).set({
      sources: {
        tiktok: {
          adLevelLastSyncedAt: ingestedAt,
          adLevelTotalAds: totalAdsWritten,
          adLevelTotalSpend: totalSpend,
          adLevelPruned: pruned,
          adLevelErrors: perAdvertiserErrors,
        },
      },
    }, { merge: true });
    await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
      action: 'marketing.tiktok-adlevel-sync',
      ts: Date.now(),
      actor: 'system:tiktok-ads-sync',
      note: `TikTok ad-level: ${totalAdsWritten} ads written, $${totalSpend.toFixed(2)} spend, ${pruned} pruned, ${perAdvertiserErrors.length} advertisers had errors`,
      counts: { fetched: totalAdsFetched, written: totalAdsWritten, pruned },
      totals: { spend: totalSpend },
    });
  } catch (e) {
    logger.warn(`[tiktok-ads-sync] adlevel audit failed: ${e.message}`);
  }

  const durMs = Date.now() - t0;
  logger.info(`[tiktok-ads-sync] ad-level DONE in ${durMs}ms: ${totalAdsWritten} ads, $${totalSpend.toFixed(2)} spend`);
  return {
    advertisers: targetAdvertisers.length,
    adsFetched: totalAdsFetched,
    adsWritten: totalAdsWritten,
    pruned,
    totalSpend,
    errors: perAdvertiserErrors,
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

// Ad-level sync — separate callable to isolate scope-expansion risk.
// Once verified with the broader-scope token, can be wired into the
// scheduled `tiktokAdsSync` (or kept on its own cron, e.g. every 6h).
exports.tiktokAdsAdLevelSyncNow = onCall(
  { secrets: [TIKTOK_ACCESS_TOKEN, TIKTOK_APP_SECRET], timeoutSeconds: 540, memory: '512MiB' },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    const counts = await _runAdLevelSync();
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
