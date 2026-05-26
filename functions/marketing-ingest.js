/**
 * Marketing data ingest endpoint (Phase 2 — Google Ads via Scripts).
 *
 * Receives POST from external sources (Google Ads Scripts, manual curl
 * uploads, future Meta/TikTok bridges) and stores into
 *   /workspaces/default/data/marketing
 *
 * Auth: shared secret in `X-Shared-Secret` HTTP header. Token lives in
 * Firebase Secret Manager (MARKETING_INGEST_SECRET). Plain `https.onRequest`
 * — NOT a Firebase callable — so Google Ads Scripts can POST without
 * Firebase SDK.
 *
 * Body shape (JSON):
 *   {
 *     source: 'google-ads' | 'meta' | 'tiktok' | 'ga4',
 *     accountId: '215-096-1449',     // ad-platform-side account id
 *     fetchedAt: ISO,                 // when the script ran
 *     dateRange: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' },
 *     campaigns: [
 *       { id, name, status, cost, clicks, impressions, conversions, ctr, avgCpc },
 *       ...
 *     ],
 *     totals: { cost, clicks, impressions, conversions }
 *   }
 *
 * Storage (Firestore doc):
 *   workspaces/default/data/marketing
 *     {
 *       updatedAt: ISO,
 *       sources: {
 *         'google-ads': { ...payload, ingestedAt: ISO },
 *         'meta': {...},
 *         'tiktok': {...},
 *         'ga4': {...},
 *       }
 *     }
 *
 * Pulse data-shim reads this doc alongside hubspotData and joins by
 * channel (PAID_SEARCH+google → 'google-ads', PAID_SOCIAL+facebook → 'meta',
 * etc.) to compute CPL/CPT/CAC/ROAS per channel in the Marketing page.
 */

const {onRequest, onCall, HttpsError} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');
const shared = require('./marketing-ads-shared');

const MARKETING_INGEST_SECRET = defineSecret('MARKETING_INGEST_SECRET');
const WORKSPACE_ID = 'default';
const ALLOWED_SOURCES = ['google-ads', 'meta', 'tiktok', 'ga4', 'manual'];
const MAX_CAMPAIGNS_PER_SOURCE = 200;  // trim to stay under Firestore 1MB cap
// Ad-level (Phase H) — soft cap per ingest call. Sorted by spend desc
// server-side before cap, so least-important drop first.
const MAX_ADS_PER_INGEST = 500;

const db = admin.firestore();

exports.marketingIngest = onRequest(
  {
    secrets: [MARKETING_INGEST_SECRET],
    cors: false, // not a browser-side endpoint; Google Ads Scripts run server-side
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (req, res) => {
    try {
      // Method check
      if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'POST only' });
        return;
      }

      // Auth — shared secret in header. Constant-time compare not strictly
      // needed (it's a long random token, brute-force is impractical), but
      // we still reject mismatches without revealing length.
      const got = req.get('x-shared-secret') || req.get('X-Shared-Secret') || '';
      const expected = MARKETING_INGEST_SECRET.value();
      if (!expected) {
        logger.error('[marketing-ingest] MARKETING_INGEST_SECRET not bound');
        res.status(500).json({ ok: false, error: 'server misconfigured' });
        return;
      }
      if (got !== expected) {
        logger.warn(`[marketing-ingest] auth fail (ip=${req.ip})`);
        res.status(401).json({ ok: false, error: 'unauthorized' });
        return;
      }

      // Parse + validate body
      const body = req.body || {};
      const source = String(body.source || '').toLowerCase();
      if (!ALLOWED_SOURCES.includes(source)) {
        res.status(400).json({ ok: false, error: `source must be one of ${ALLOWED_SOURCES.join(',')}` });
        return;
      }
      const campaigns = Array.isArray(body.campaigns) ? body.campaigns : [];
      if (campaigns.length > MAX_CAMPAIGNS_PER_SOURCE) {
        logger.warn(`[marketing-ingest] ${source}: ${campaigns.length} campaigns, trimming to ${MAX_CAMPAIGNS_PER_SOURCE}`);
      }

      // Trim + sanitize campaign records (drop unknown fields, coerce types).
      // Two shapes are accepted:
      //   1. AGGREGATE (legacy v1) — campaigns[].cost/clicks/etc already
      //      rolled up over the window. No daily breakdown.
      //   2. DAILY (v2, Pulse-Marketing-2026-05-24) — campaigns[] is just
      //      {id,name,status} meta; daily[] has {id,date,cost,clicks,...}
      //      rows per-campaign-per-day. Pulse aggregates client-side
      //      across whatever date range the operator selects.
      // v2 is detected by presence of body.daily[]. Both shapes write to
      // the same Firestore doc — the read-side helper figures it out.
      const trimmed = campaigns.slice(0, MAX_CAMPAIGNS_PER_SOURCE).map(c => ({
        id: String(c.id || ''),
        name: String(c.name || '(unnamed)'),
        status: String(c.status || ''),
        cost: Number(c.cost) || 0,
        clicks: Number(c.clicks) || 0,
        impressions: Number(c.impressions) || 0,
        conversions: Number(c.conversions) || 0,
        ctr: Number(c.ctr) || 0,
        avgCpc: Number(c.avgCpc) || 0,
      }));
      // Daily rows (v2). No cap — 30 campaigns × 90 days = 2700 rows
      // serialized ≈ 200 KB, well under Firestore 1MB doc cap with
      // JSON-string trick below.
      const daily = Array.isArray(body.daily) ? body.daily.map(d => ({
        id: String(d.id || ''),
        date: String(d.date || ''),
        cost: Number(d.cost) || 0,
        clicks: Number(d.clicks) || 0,
        impressions: Number(d.impressions) || 0,
        conversions: Number(d.conversions) || 0,
      })) : [];
      const totals = body.totals && typeof body.totals === 'object' ? {
        cost: Number(body.totals.cost) || 0,
        clicks: Number(body.totals.clicks) || 0,
        impressions: Number(body.totals.impressions) || 0,
        conversions: Number(body.totals.conversions) || 0,
      } : daily.length > 0 ? {
        cost: daily.reduce((s, d) => s + d.cost, 0),
        clicks: daily.reduce((s, d) => s + d.clicks, 0),
        impressions: daily.reduce((s, d) => s + d.impressions, 0),
        conversions: daily.reduce((s, d) => s + d.conversions, 0),
      } : {
        cost: trimmed.reduce((s, c) => s + c.cost, 0),
        clicks: trimmed.reduce((s, c) => s + c.clicks, 0),
        impressions: trimmed.reduce((s, c) => s + c.impressions, 0),
        conversions: trimmed.reduce((s, c) => s + c.conversions, 0),
      };

      const ingestedAt = new Date().toISOString();
      const sourcePayload = {
        source,
        accountId: String(body.accountId || ''),
        fetchedAt: body.fetchedAt || ingestedAt,
        ingestedAt,
        dateRange: body.dateRange || null,
        daysBack: Number(body.daysBack) || null,
        totals,
        // Serialize campaigns + daily to JSON strings to stay under
        // Firestore's 40K index-entries cap (same trick as hubspot doc
        // — see FIXES_LOG Entry 31). campaignsJson = meta only (~200
        // entries × few fields = small), dailyJson = per-day breakdown
        // (2700 rows × 6 fields ≈ 200 KB stringified = 1 index entry).
        campaignsJson: JSON.stringify(trimmed),
        campaignCount: trimmed.length,
        dailyJson: daily.length > 0 ? JSON.stringify(daily) : null,
        dailyRowCount: daily.length,
      };

      // Merge-write into the marketing doc, scoped to the specific source.
      const mRef = db.doc(`workspaces/${WORKSPACE_ID}/data/marketing`);
      await mRef.set({
        updatedAt: ingestedAt,
        sources: {
          [source]: sourcePayload,
        },
      }, { merge: true });

      // Audit row so Activity log shows ingest events.
      try {
        await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
          action: 'marketing.ingest',
          ts: Date.now(),
          actor: `external:${source}`,
          note: `${source} ingest: ${trimmed.length} campaigns, $${totals.cost.toFixed(2)} cost, ${totals.clicks} clicks, ${totals.conversions} conversions`,
          source,
          accountId: sourcePayload.accountId,
          totals,
        });
      } catch (e) {
        logger.warn('[marketing-ingest] audit-write failed: ' + e.message);
      }

      logger.info(`[marketing-ingest] OK: ${source} ${trimmed.length} campaigns $${totals.cost.toFixed(2)}`);
      res.status(200).json({
        ok: true,
        source,
        campaigns: trimmed.length,
        totals,
        ingestedAt,
      });
    } catch (e) {
      logger.error('[marketing-ingest] crash: ' + e.message, e);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

/**
 * Read endpoint — returns the marketing doc inflated. Used by Pulse
 * data-shim alongside hubspotGetData. Anonymous auth allowed (same
 * pattern as hubspotGetData) since data is operational, not financial PII.
 */
exports.marketingGetData = require('firebase-functions/v2/https').onCall(
  { timeoutSeconds: 30 },
  async () => {
    const snap = await db.doc(`workspaces/${WORKSPACE_ID}/data/marketing`).get();
    if (!snap.exists) return { marketingData: null };
    const raw = snap.data();
    const sources = raw.sources || {};
    // Inflate campaignsJson + dailyJson + accountsJson back into objects
    // for client consumption. All are JSON-stringified server-side to
    // avoid Firestore's index-entries cap. Plus per-source-doc top-level
    // metaDiscoveredAccountsJson for the Settings UI list.
    const inflated = {};
    for (const [key, payload] of Object.entries(sources)) {
      if (!payload) { inflated[key] = payload; continue; }
      const out = { ...payload };
      if (payload.campaignsJson) {
        try { out.campaigns = JSON.parse(payload.campaignsJson); }
        catch (e) { out.campaigns = []; out._parseError = e.message; }
        delete out.campaignsJson;
      }
      if (payload.dailyJson) {
        try { out.daily = JSON.parse(payload.dailyJson); }
        catch (e) { out.daily = []; out._dailyParseError = e.message; }
        delete out.dailyJson;
      }
      if (payload.accountsJson) {
        try { out.accounts = JSON.parse(payload.accountsJson); }
        catch (e) { out.accounts = []; out._accountsParseError = e.message; }
        delete out.accountsJson;
      }
      // GA4 extra fields — inflate all _Json suffixed payloads.
      for (const k of Object.keys(payload)) {
        if (!k.endsWith('Json')) continue;
        if (k === 'campaignsJson' || k === 'dailyJson' || k === 'accountsJson') continue; // already handled
        const targetKey = k.slice(0, -4); // strip 'Json' suffix
        try { out[targetKey] = JSON.parse(payload[k]); }
        catch (e) { out[targetKey] = []; }
        delete out[k];
      }
      inflated[key] = out;
    }
    let metaDiscoveredAccounts = null;
    if (raw.metaDiscoveredAccountsJson) {
      try { metaDiscoveredAccounts = JSON.parse(raw.metaDiscoveredAccountsJson); }
      catch (e) { /* ignore */ }
    }
    // 2026-05-24 — TikTok mirror of metaDiscoveredAccounts. Same pattern,
    // separate JSON-stringified blob to keep doc size predictable.
    let tiktokDiscoveredAccounts = null;
    if (raw.tiktokDiscoveredAccountsJson) {
      try { tiktokDiscoveredAccounts = JSON.parse(raw.tiktokDiscoveredAccountsJson); }
      catch (e) { /* ignore */ }
    }
    // Also surface marketing-settings (so the UI knows which accounts
    // are enabled). Separate doc, so a second small read.
    let settings = {};
    try {
      const sSnap = await db.doc(`workspaces/${WORKSPACE_ID}/data/marketing-settings`).get();
      if (sSnap.exists) settings = sSnap.data() || {};
    } catch (e) { /* non-fatal */ }
    return {
      marketingData: {
        updatedAt: raw.updatedAt,
        sources: inflated,
        metaDiscoveredAccounts,
        tiktokDiscoveredAccounts,
        settings,
      },
    };
  }
);

// =============================================================================
// AD-LEVEL INGEST (Phase H, 2026-05-25)
// =============================================================================
// External-source POST endpoint for ad-level data. Currently fed by Google
// Ads Scripts (scripts/google-ads-script.js does a second GAQL pass over
// ad_group_ad and POSTs here). Same shared-secret auth as marketingIngest.
//
// Payload shape:
//   {
//     source: 'google-ads',           // (only google-ads for now; future Bing/etc)
//     customerId: '215-096-1449',
//     customerName: 'SuitesForAll',
//     currency: 'USD',
//     fetchedAt: ISO,
//     dateRange: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' },
//     daysBack: 90,
//     ads: [
//       {
//         adId: '123', adName: '...', adType: 'RESPONSIVE_SEARCH_AD',
//         adStatus: 'ENABLED',
//         finalUrls: ['https://...'],
//         headlines: [...], descriptions: [...],   // for RSA
//         imageUrl: '...',                          // for IMAGE_AD
//         youtubeVideoId: '...',                    // for VIDEO_AD
//         campaignId, campaignName, campaignType, campaignStatus,
//         adGroupId, adGroupName, adGroupStatus,
//         daily: [
//           { date, spend, clicks, impressions, conversions,
//             videoViews, p25, p50, p75, p100 }
//         ]
//       },
//       ...
//     ],
//     totals: { spend, clicks, impressions, conversions }
//   }
//
// Server: builds UnifiedAd per ad, sorts by spend desc, caps, upserts
// to marketing_ads subcollection, soft-deletes ads missing from this run.
// =============================================================================

const ALLOWED_ADLEVEL_SOURCES = ['google-ads'];

function _mapGoogleAdStatus(s) {
  const u = String(s || '').toUpperCase();
  if (u === 'ENABLED') return 'ACTIVE';
  if (u === 'PAUSED') return 'PAUSED';
  if (u === 'REMOVED') return 'DELETED';
  return u || 'UNKNOWN';
}

function _googleCreativeType(adType) {
  const t = String(adType || '').toUpperCase();
  if (/VIDEO/.test(t)) return 'VIDEO';
  if (/RESPONSIVE_SEARCH|RSA/.test(t)) return 'RSA';
  if (/RESPONSIVE_DISPLAY|RDA|UPLOADED_AD|MULTI_ASSET/.test(t)) return 'CAROUSEL';
  if (/IMAGE/.test(t)) return 'IMAGE';
  return 'IMAGE';
}

function _buildGoogleUnifiedAd(payload, adRaw, ingestedAt) {
  const externalId = String(adRaw.adId || '');
  if (!externalId) return null;
  // Normalize daily rows (script-side keys may vary slightly).
  const daily = (Array.isArray(adRaw.daily) ? adRaw.daily : [])
    .map(d => ({
      date: String(d.date || ''),
      spend: Number(d.spend || d.cost) || 0,
      clicks: Number(d.clicks) || 0,
      impressions: Number(d.impressions) || 0,
      conversions: Number(d.conversions) || 0,
      videoViews: Number(d.videoViews) || 0,
      // Google Ads quartile metrics are RATES, not counts. Script-side
      // should multiply by impressions BEFORE sending; we accept either
      // form here defensively (if <= 1 treat as rate, else as count).
      _videoViewsP25: _coerceCount(d.p25 ?? d._videoViewsP25, d.impressions),
      _videoViewsP50: _coerceCount(d.p50 ?? d._videoViewsP50, d.impressions),
      _videoViewsP75: _coerceCount(d.p75 ?? d._videoViewsP75, d.impressions),
      _videoViewsP100: _coerceCount(d.p100 ?? d._videoViewsP100, d.impressions),
    }))
    .filter(d => d.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  const baseTotals = shared.rollupDaily(daily);
  let p25 = 0, p50 = 0, p75 = 0, p100 = 0;
  for (const d of daily) {
    p25 += Number(d._videoViewsP25) || 0;
    p50 += Number(d._videoViewsP50) || 0;
    p75 += Number(d._videoViewsP75) || 0;
    p100 += Number(d._videoViewsP100) || 0;
  }
  const totals = shared.computeDerivedMetrics({
    ...baseTotals,
    videoViewsP25: p25, videoViewsP50: p50, videoViewsP75: p75, videoViewsP100: p100,
  });
  const creativeType = _googleCreativeType(adRaw.adType);
  const creative = {
    type: creativeType,
    primaryText: null,
    callToAction: null,
    landingUrl: Array.isArray(adRaw.finalUrls) && adRaw.finalUrls.length > 0
      ? _gaText(adRaw.finalUrls[0]) || null : null,
    displayUrl: null,
    // RSA headlines/descriptions могут приходить либо строками, либо
    // AdTextAsset-объектами {asset, text, pinned_field} — зависит от
    // версии google-ads-script.js. Всегда нормализуем до string-массива
    // и фильтруем пустые / «[object Object]» (мусор от первого ingest
    // pass до того как _splitGaqlArray начал извлекать .text).
    headlines: _gaCleanList(adRaw.headlines),
    descriptions: _gaCleanList(adRaw.descriptions),
    posterUrl: null,
  };
  if (creativeType === 'VIDEO' && adRaw.youtubeVideoId) {
    creative.videoId = String(adRaw.youtubeVideoId);
    // YouTube embed + thumbnail — universal URLs, no auth needed.
    creative.videoUrl = `https://www.youtube.com/embed/${creative.videoId}`;
    creative.posterUrl = `https://i.ytimg.com/vi/${creative.videoId}/hqdefault.jpg`;
  } else if (creativeType === 'IMAGE' && adRaw.imageUrl) {
    creative.imageUrl = String(adRaw.imageUrl);
  }
  return {
    id: shared.adDocId('google', externalId),
    platform: 'google',
    externalId,
    account: {
      id: String(payload.customerId || ''),
      name: String(payload.customerName || '(unknown customer)'),
      currency: String(payload.currency || 'USD'),
    },
    campaign: {
      id: String(adRaw.campaignId || ''),
      name: String(adRaw.campaignName || '(unknown campaign)'),
      objective: String(adRaw.campaignType || '') || null,
      status: String(adRaw.campaignStatus || '') || null,
    },
    adgroup: {
      id: String(adRaw.adGroupId || ''),
      name: String(adRaw.adGroupName || '(unknown ad group)'),
      status: String(adRaw.adGroupStatus || '') || null,
    },
    ad: {
      id: externalId,
      // Google RSA / DSA часто без display name — оставляем null, чтобы
      // клиент мог сделать fallback на campaign · adgroup. Литерал
      // «(unnamed ad)» здесь ставить НЕЛЬЗЯ: он перекрывает fallback.
      name: adRaw.adName && String(adRaw.adName).trim()
            ? String(adRaw.adName).trim()
            : null,
      status: _mapGoogleAdStatus(adRaw.adStatus),
      type: String(adRaw.adType || '') || null,
      createdAt: null,
      modifiedAt: null,
    },
    creative,
    totals,
    daily,
    daysBack: Number(payload.daysBack) || 90,
    fetchedAt: String(payload.fetchedAt || ingestedAt),
    ingestedAt,
    error: null,
    platformExtras: {
      adType: String(adRaw.adType || '') || null,
      finalUrls: _gaCleanList(adRaw.finalUrls),
    },
  };
}

// Helper — if raw is rate (≤ 1) AND impressions known, return rate × impressions.
// Otherwise treat as already-count.
function _coerceCount(raw, impressions) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n <= 1 && Number(impressions) > 0) return Math.round(n * Number(impressions));
  return Math.round(n);
}

// Достаёт строковое значение из AdTextAsset-подобного объекта или
// пропускает уже-строку. Возвращает '' для null/undefined/мусора.
function _gaText(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'object') {
    return String(x.text || x.asset || x.value || x.label || '');
  }
  return String(x);
}

// Нормализует массив RSA assets к чистому массиву строк, отфильтровывая
// пустые элементы и строки-мусор «[object Object]» (артефакт раннего
// .map(String) поверх объектов до того как ввёлся _gaText).
function _gaCleanList(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const out = arr
    .map(_gaText)
    .map(s => String(s).trim())
    .filter(s => s.length > 0 && s.indexOf('[object Object]') < 0);
  return out.length > 0 ? out : null;
}

exports.marketingAdsIngest = onRequest(
  {
    secrets: [MARKETING_INGEST_SECRET],
    cors: false,
    timeoutSeconds: 120,
    memory: '512MiB',
  },
  async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'POST only' });
        return;
      }
      const got = req.get('x-shared-secret') || req.get('X-Shared-Secret') || '';
      const expected = MARKETING_INGEST_SECRET.value();
      if (!expected) {
        res.status(500).json({ ok: false, error: 'server misconfigured' });
        return;
      }
      if (got !== expected) {
        logger.warn(`[marketing-ads-ingest] auth fail (ip=${req.ip})`);
        res.status(401).json({ ok: false, error: 'unauthorized' });
        return;
      }
      const body = req.body || {};
      const source = String(body.source || '').toLowerCase();
      if (!ALLOWED_ADLEVEL_SOURCES.includes(source)) {
        res.status(400).json({
          ok: false,
          error: `source must be one of ${ALLOWED_ADLEVEL_SOURCES.join(',')}`,
        });
        return;
      }
      const adsRaw = Array.isArray(body.ads) ? body.ads : [];
      if (adsRaw.length === 0) {
        res.status(400).json({ ok: false, error: 'ads[] must be non-empty' });
        return;
      }
      const ingestedAt = new Date().toISOString();
      // Build UnifiedAds, drop invalid, sort by spend desc, cap.
      const platform = source === 'google-ads' ? 'google' : source;
      const built = [];
      for (const a of adsRaw) {
        const u = _buildGoogleUnifiedAd(body, a, ingestedAt);
        if (u) built.push(u);
      }
      built.sort((a, b) => (b.totals.spend || 0) - (a.totals.spend || 0));
      const capped = built.slice(0, MAX_ADS_PER_INGEST);
      const presentIds = new Set(capped.map(u => u.id));
      const totalSpend = capped.reduce((s, u) => s + (u.totals.spend || 0), 0);
      // Write
      const writeRes = await shared.upsertAdsBatch(capped);
      // Prune: any google ad in DB not in this run gets soft-deleted.
      let pruned = 0;
      try {
        pruned = await shared.pruneStaleAds(platform, presentIds);
      } catch (e) {
        logger.warn(`[marketing-ads-ingest] prune failed: ${e.message}`);
      }
      // Summary doc — mirror what TikTok/Meta ad-level syncs write.
      try {
        await db.doc(`workspaces/${WORKSPACE_ID}/data/marketing`).set({
          sources: {
            [source]: {
              adLevelLastSyncedAt: ingestedAt,
              adLevelTotalAds: writeRes.written,
              adLevelTotalSpend: totalSpend,
              adLevelPruned: pruned,
              adLevelErrors: writeRes.errors,
              adLevelCustomerId: String(body.customerId || ''),
            },
          },
        }, { merge: true });
        await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
          action: `marketing.${platform}-adlevel-ingest`,
          ts: Date.now(),
          actor: `external:${source}`,
          note: `${source} ad-level: ${writeRes.written} ads written, $${totalSpend.toFixed(2)} spend, ${pruned} pruned`,
          counts: { received: adsRaw.length, written: writeRes.written, pruned },
          totals: { spend: totalSpend },
          customerId: String(body.customerId || ''),
        });
      } catch (e) {
        logger.warn(`[marketing-ads-ingest] summary/audit failed: ${e.message}`);
      }
      logger.info(`[marketing-ads-ingest] OK: ${source} ${writeRes.written}/${adsRaw.length} ads $${totalSpend.toFixed(2)}`);
      res.status(200).json({
        ok: true,
        source,
        received: adsRaw.length,
        written: writeRes.written,
        skipped: writeRes.skipped,
        pruned,
        totals: { spend: totalSpend },
        errors: writeRes.errors,
        ingestedAt,
      });
    } catch (e) {
      logger.error(`[marketing-ads-ingest] crash: ${e.message}`, e);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// =============================================================================
// DIMENSION INGEST (Phase I, 2026-05-26) — keywords / search-terms / geo / device
// =============================================================================
// Unified endpoint для всех «не-ad» Google Ads dimension'ов. Google Ads
// Script делает 4 дополнительных POST'а сюда (по одному на dimension),
// сервер строит документы в нужной subcollection.
//
// Payload shape:
//   {
//     source: 'google-ads-keywords'      // determines kind + collection
//           | 'google-ads-search-terms'
//           | 'google-ads-geo'
//           | 'google-ads-devices',
//     customerId, customerName, currency,
//     fetchedAt: ISO, dateRange: {start,end}, daysBack,
//     rows: [
//       // KEYWORDS — { criterionId, text, matchType, status, qualityScore,
//       //              campaignId, campaignName, adGroupId, adGroupName,
//       //              daily: [{date,cost,clicks,impressions,conversions}] }
//       // SEARCH_TERMS — { text, matchType, status,
//       //              campaignId, campaignName, adGroupId, adGroupName,
//       //              daily: [...] }
//       // GEO — { locationId, country, region, city, resolution,
//       //              campaignId, campaignName, daily: [...] }
//       // DEVICES — { device,    // MOBILE|DESKTOP|TABLET|CONNECTED_TV|OTHER
//       //              campaignId, campaignName, daily: [...] }
//     ],
//     totals: { cost, clicks, impressions, conversions }
//   }
//
// Storage: workspaces/default/<collection>/<docId>
//   marketing_keywords      google_kw_<criterionId>
//   marketing_search_terms  google_st_<adGroupId>_<sha1(text):16>
//   marketing_geo           google_geo_<locationId>
//   marketing_devices       google_dev_<device>
// =============================================================================

const DIMENSION_KIND_MAP = {
  'google-ads-keywords':     { kind: 'keyword',    collection: 'marketing_keywords',     prefix: 'google_kw_'  },
  'google-ads-search-terms': { kind: 'searchTerm', collection: 'marketing_search_terms', prefix: 'google_st_'  },
  'google-ads-geo':          { kind: 'geo',        collection: 'marketing_geo',          prefix: 'google_geo_' },
  'google-ads-devices':      { kind: 'device',     collection: 'marketing_devices',      prefix: 'google_dev_' },
};
const ALLOWED_DIMENSION_SOURCES = Object.keys(DIMENSION_KIND_MAP);
const MAX_ROWS_PER_DIMENSION_INGEST = 2000;

function _sha1Short(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 16);
}

function _normalizeDaily(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map(d => ({
      date: String(d.date || ''),
      spend: Number(d.spend || d.cost) || 0,
      clicks: Number(d.clicks) || 0,
      impressions: Number(d.impressions) || 0,
      conversions: Number(d.conversions) || 0,
    }))
    .filter(d => d.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function _buildDimensionDoc(payload, raw, ingestedAt, source) {
  const cfg = DIMENSION_KIND_MAP[source];
  if (!cfg) return null;
  const daily = _normalizeDaily(raw.daily);
  const baseTotals = shared.rollupDaily(daily);
  const totals = shared.computeDerivedMetrics(baseTotals);

  let externalId = '';
  let dimensionFields = {};
  let displayLabel = '';

  if (cfg.kind === 'keyword') {
    externalId = String(raw.criterionId || raw.id || '');
    if (!externalId) return null;
    dimensionFields.keyword = {
      text: String(raw.text || ''),
      matchType: String(raw.matchType || '').toUpperCase() || null,
      status: String(raw.status || '').toUpperCase() || null,
      qualityScore: raw.qualityScore != null ? Number(raw.qualityScore) : null,
    };
    displayLabel = dimensionFields.keyword.text || externalId;
  } else if (cfg.kind === 'searchTerm') {
    const text = String(raw.text || '').trim();
    if (!text) return null;
    const adGroupId = String(raw.adGroupId || '');
    externalId = `${adGroupId}_${_sha1Short(text.toLowerCase())}`;
    dimensionFields.searchTerm = {
      text,
      matchType: String(raw.matchType || '').toUpperCase() || null,
      status: String(raw.status || '').toUpperCase() || null,
    };
    displayLabel = text;
  } else if (cfg.kind === 'geo') {
    externalId = String(raw.locationId || raw.id || '');
    if (!externalId) {
      // fallback — composite key if locationId missing
      externalId = _sha1Short([raw.country, raw.region, raw.city].filter(Boolean).join('|'));
    }
    dimensionFields.geo = {
      country: String(raw.country || '') || null,
      region: String(raw.region || '') || null,
      city: String(raw.city || '') || null,
      locationId: String(raw.locationId || '') || null,
      resolution: String(raw.resolution || '') || null,
    };
    displayLabel = [dimensionFields.geo.city, dimensionFields.geo.region, dimensionFields.geo.country]
      .filter(Boolean).join(', ') || externalId;
  } else if (cfg.kind === 'device') {
    const device = String(raw.device || '').toUpperCase();
    if (!device) return null;
    externalId = device;
    dimensionFields.device = { type: device };
    displayLabel = device;
  }

  const docId = cfg.prefix + externalId.replace(/[^A-Za-z0-9_-]/g, '_');

  return {
    id: docId,
    platform: 'google',
    kind: cfg.kind,
    externalId,
    label: displayLabel,
    account: {
      id: String(payload.customerId || ''),
      name: String(payload.customerName || '(unknown customer)'),
      currency: String(payload.currency || 'USD'),
    },
    campaign: raw.campaignId ? {
      id: String(raw.campaignId || ''),
      name: String(raw.campaignName || '(unknown campaign)'),
      status: String(raw.campaignStatus || '') || null,
    } : null,
    adgroup: raw.adGroupId ? {
      id: String(raw.adGroupId || ''),
      name: String(raw.adGroupName || '(unknown ad group)'),
      status: String(raw.adGroupStatus || '') || null,
    } : null,
    ...dimensionFields,
    totals,
    daily,
    daysBack: Number(payload.daysBack) || 90,
    fetchedAt: String(payload.fetchedAt || ingestedAt),
    ingestedAt,
  };
}

async function _upsertDimensionBatch(collection, docs) {
  let written = 0;
  let skipped = 0;
  const errors = [];
  // Firestore batch limit = 500 writes; split if needed
  const CHUNK = 400;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = db.batch();
    const slice = docs.slice(i, i + CHUNK);
    for (const d of slice) {
      try {
        const ref = db.doc(`workspaces/${WORKSPACE_ID}/${collection}/${d.id}`);
        batch.set(ref, d, { merge: false });
        written++;
      } catch (e) {
        errors.push({ id: d.id, error: e.message });
        skipped++;
      }
    }
    await batch.commit();
  }
  return { written, skipped, errors };
}

async function _pruneStaleDimensionDocs(collection, presentIds) {
  const snap = await db.collection(`workspaces/${WORKSPACE_ID}/${collection}`).get();
  const stale = [];
  snap.forEach(doc => { if (!presentIds.has(doc.id)) stale.push(doc.ref); });
  if (stale.length === 0) return 0;
  const CHUNK = 400;
  for (let i = 0; i < stale.length; i += CHUNK) {
    const batch = db.batch();
    stale.slice(i, i + CHUNK).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
  return stale.length;
}

exports.marketingDimensionIngest = onRequest(
  {
    secrets: [MARKETING_INGEST_SECRET],
    cors: false,
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'POST only' });
        return;
      }
      const got = req.get('x-shared-secret') || req.get('X-Shared-Secret') || '';
      const expected = MARKETING_INGEST_SECRET.value();
      if (!expected) {
        res.status(500).json({ ok: false, error: 'server misconfigured' });
        return;
      }
      if (got !== expected) {
        logger.warn(`[marketing-dim-ingest] auth fail (ip=${req.ip})`);
        res.status(401).json({ ok: false, error: 'unauthorized' });
        return;
      }
      const body = req.body || {};
      const source = String(body.source || '').toLowerCase();
      if (!ALLOWED_DIMENSION_SOURCES.includes(source)) {
        res.status(400).json({
          ok: false,
          error: `source must be one of ${ALLOWED_DIMENSION_SOURCES.join(',')}`,
        });
        return;
      }
      const cfg = DIMENSION_KIND_MAP[source];
      const rowsRaw = Array.isArray(body.rows) ? body.rows : [];
      if (rowsRaw.length === 0) {
        res.status(400).json({ ok: false, error: 'rows[] must be non-empty' });
        return;
      }
      const ingestedAt = new Date().toISOString();
      const built = [];
      for (const r of rowsRaw) {
        const doc = _buildDimensionDoc(body, r, ingestedAt, source);
        if (doc) built.push(doc);
      }
      built.sort((a, b) => (b.totals.spend || 0) - (a.totals.spend || 0));
      const capped = built.slice(0, MAX_ROWS_PER_DIMENSION_INGEST);
      const presentIds = new Set(capped.map(d => d.id));
      const totalSpend = capped.reduce((s, d) => s + (d.totals.spend || 0), 0);

      const writeRes = await _upsertDimensionBatch(cfg.collection, capped);
      let pruned = 0;
      try {
        pruned = await _pruneStaleDimensionDocs(cfg.collection, presentIds);
      } catch (e) {
        logger.warn(`[marketing-dim-ingest] prune ${cfg.collection} failed: ${e.message}`);
      }
      try {
        await db.doc(`workspaces/${WORKSPACE_ID}/data/marketing`).set({
          sources: {
            [source]: {
              dimensionLastSyncedAt: ingestedAt,
              dimensionTotalRows: writeRes.written,
              dimensionTotalSpend: totalSpend,
              dimensionPruned: pruned,
              dimensionCustomerId: String(body.customerId || ''),
            },
          },
        }, { merge: true });
        await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
          action: `marketing.${cfg.kind}-ingest`,
          ts: Date.now(),
          actor: `external:${source}`,
          note: `${source}: ${writeRes.written} rows written, $${totalSpend.toFixed(2)} spend, ${pruned} pruned`,
          counts: { received: rowsRaw.length, written: writeRes.written, pruned },
          totals: { spend: totalSpend },
        });
      } catch (e) {
        logger.warn(`[marketing-dim-ingest] summary/audit failed: ${e.message}`);
      }
      logger.info(`[marketing-dim-ingest] OK: ${source} ${writeRes.written}/${rowsRaw.length} rows $${totalSpend.toFixed(2)}`);
      res.status(200).json({
        ok: true,
        source,
        kind: cfg.kind,
        collection: cfg.collection,
        received: rowsRaw.length,
        written: writeRes.written,
        skipped: writeRes.skipped,
        pruned,
        totals: { spend: totalSpend },
        errors: writeRes.errors,
        ingestedAt,
      });
    } catch (e) {
      logger.error(`[marketing-dim-ingest] crash: ${e.message}`, e);
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// =============================================================================
// DIMENSION LIST (callable) — generic reader for Pulse pages.
// =============================================================================
// Auth: same root-admin gate as marketingAdsList (auth.token.root === true).
// Args: { kind: 'keyword'|'searchTerm'|'geo'|'device', limit, cursor, sort? }
// Returns: { rows: [...], nextCursor: docId|null }
//
// Sort: server-side по totals.spend DESC. Cursor — последний docId предыдущей
// страницы (Firestore startAfter). Limit капается в [1, 200].
// =============================================================================

const KIND_TO_COLLECTION = {
  keyword:    'marketing_keywords',
  searchTerm: 'marketing_search_terms',
  geo:        'marketing_geo',
  device:     'marketing_devices',
};

// ROOT_ADMINS — single source of truth in marketing-ads-shared.js. Re-import
// here so dimension callable share's the gate с marketingAdsList. Если в
// будущем нужно расширить — менять там, а не здесь.
const _DIM_ROOT_ADMINS = ['tony@al-en.com'];

exports.marketingDimensionList = onCall(
  { cors: true, timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!_DIM_ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    const data = request.data || {};
    const kind = String(data.kind || '');
    const collection = KIND_TO_COLLECTION[kind];
    if (!collection) {
      throw new HttpsError('invalid-argument', `kind must be one of ${Object.keys(KIND_TO_COLLECTION).join(',')}`);
    }
    const limit = Math.max(1, Math.min(200, Number(data.limit) || 50));
    const cursorId = data.cursor ? String(data.cursor) : null;

    let q = db.collection(`workspaces/${WORKSPACE_ID}/${collection}`)
      .orderBy('totals.spend', 'desc')
      .limit(limit + 1);
    if (cursorId) {
      const cursorDoc = await db.doc(`workspaces/${WORKSPACE_ID}/${collection}/${cursorId}`).get();
      if (cursorDoc.exists) q = q.startAfter(cursorDoc);
    }
    const snap = await q.get();
    const docs = [];
    snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
    const hasMore = docs.length > limit;
    const rows = hasMore ? docs.slice(0, limit) : docs;
    const nextCursor = hasMore ? rows[rows.length - 1].id : null;
    return { rows, nextCursor, kind, collection };
  }
);
