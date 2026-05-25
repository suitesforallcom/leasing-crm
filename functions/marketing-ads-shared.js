/**
 * Cross-platform marketing-ads shared layer — unified ad shape + Firestore
 * subcollection helpers used by tiktok-ads-sync, meta-ads-sync, and the
 * future google-ads ad-level sync.
 *
 * Why a subcollection (not one consolidated doc per platform):
 * — Tony confirmed «<100 ads now but growing significantly» (2026-05-25).
 * — Firestore doc cap = 1 MB. Each ad with 90 daily rows ≈ 5–10 KB.
 *   1000 ads × 8 KB = 8 MB — would blow the cap if consolidated.
 * — Top-Ads UI needs server-side sort + pagination (`.orderBy().limit()`),
 *   which only subcollection layout supports.
 * — Single-ad detail pages can `.get()` one doc instead of parsing a
 *   stringified JSON of all ads.
 *
 * Collection path:
 *   workspaces/{wid}/marketing_ads/{platform}_{externalAdId}
 *
 * Composite doc-id (`<platform>_<ad_id>`) guarantees uniqueness across
 * platforms and makes ownership obvious at a glance.
 *
 * Per-ad doc shape — see UnifiedAd typedef below. All optional fields are
 * documented inline; platform-specific extras live under `platformExtras`
 * to keep the canonical shape clean.
 *
 * @typedef {Object} UnifiedAd
 *
 * @property {string}  id                — `<platform>_<externalId>`, composite key
 * @property {('tiktok'|'meta'|'google')} platform
 * @property {string}  externalId        — platform-native ad id
 *
 * @property {Object}  account
 * @property {string}    account.id      — advertiser_id / act_X / customer_id
 * @property {string}    account.name
 * @property {string}    account.currency
 *
 * @property {Object}  campaign
 * @property {string}    campaign.id
 * @property {string}    campaign.name
 * @property {?string}   campaign.objective    — TRAFFIC|CONVERSIONS|LEADS|REACH|...
 * @property {?string}   campaign.status       — ENABLED|PAUSED|...
 *
 * @property {Object}  adgroup
 * @property {string}    adgroup.id
 * @property {string}    adgroup.name
 * @property {?string}   adgroup.status
 *
 * @property {Object}  ad
 * @property {string}    ad.id
 * @property {string}    ad.name
 * @property {string}    ad.status         — ACTIVE|PAUSED|DISABLED|PENDING_REVIEW|REJECTED|DELETED
 * @property {?string}   ad.type           — VIDEO|IMAGE|CAROUSEL|RSA (responsive search)
 * @property {?string}   ad.createdAt      — ISO timestamp
 * @property {?string}   ad.modifiedAt     — ISO timestamp
 *
 * @property {Object}  creative
 * @property {('VIDEO'|'IMAGE'|'CAROUSEL'|'RSA')} creative.type
 * // Video
 * @property {?string}   creative.videoId
 * @property {?string}   creative.videoUrl       — playable (may be CDN-signed, expires; refresh on access)
 * @property {?number}   creative.videoDurationSec
 * @property {?string}   creative.videoAspectRatio   — '9:16' | '1:1' | '16:9'
 * @property {?string}   creative.posterUrl          — thumbnail / first frame
 * // Image / carousel
 * @property {?string}   creative.imageUrl           — single image
 * @property {?Array<string>} creative.imageUrls     — carousel cards
 * // Text — arrays to fit RSA (Google) which has multiple headlines
 * @property {?Array<string>} creative.headlines
 * @property {?Array<string>} creative.descriptions
 * @property {?string}   creative.primaryText        — Meta primary text / TikTok caption
 * @property {?string}   creative.callToAction       — LEARN_MORE|SIGN_UP|GET_QUOTE|...
 * // Landing
 * @property {?string}   creative.landingUrl
 * @property {?string}   creative.displayUrl
 *
 * @property {Object}  totals          — aggregate over `daysBack` window
 * @property {number}    totals.spend
 * @property {number}    totals.impressions
 * @property {number}    totals.clicks
 * @property {number}    totals.conversions
 * @property {?number}   totals.ctr               — % (clicks/impressions × 100)
 * @property {?number}   totals.cpc               — spend/clicks
 * @property {?number}   totals.cpm               — spend/impressions × 1000
 * @property {?number}   totals.videoViews        — TikTok video_play_actions / Meta video_view
 * @property {?number}   totals.videoViewsP25
 * @property {?number}   totals.videoViewsP50
 * @property {?number}   totals.videoViewsP75
 * @property {?number}   totals.videoViewsP100
 * @property {?number}   totals.avgVideoPlaySec
 * @property {?Object}   totals.engagement
 * @property {?number}     totals.engagement.likes
 * @property {?number}     totals.engagement.shares
 * @property {?number}     totals.engagement.comments
 * @property {?number}     totals.engagement.follows
 * @property {?number}     totals.engagement.profileVisits
 *
 * @property {Array<DailyRow>} daily   — last `daysBack` days, ascending
 *
 * @property {number}  daysBack
 * @property {string}  fetchedAt        — ISO timestamp of last source pull
 * @property {string}  ingestedAt       — ISO timestamp of last Firestore write
 * @property {?string} error            — non-null if this ad's data was partial
 *
 * @property {Object}  platformExtras   — platform-specific raw bits, opaque
 *                                        to the unified UI. Empty {} for ads
 *                                        with no extras worth exposing.
 *
 * @typedef {Object} DailyRow
 * @property {string} date                 — YYYY-MM-DD
 * @property {number} spend
 * @property {number} impressions
 * @property {number} clicks
 * @property {number} conversions
 * @property {?number} videoViews
 */

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');

const ROOT_ADMINS = ['tony@al-en.com'];

const WORKSPACE_ID = 'default';
// Каждая платформа имеет soft cap, чтобы один runaway-аккаунт не съел всю
// квоту Firestore. Tony может поднять, когда натурально перерастёт.
const MAX_ADS_PER_PLATFORM = 500;
// Чанк для batched writes — Firestore allows max 500 ops/batch.
const FIRESTORE_BATCH_CAP = 450;

const db = () => admin.firestore();

// ---------- Doc-id helper ----------
// Composite: `<platform>_<externalId>`. Slashes/spaces in externalId
// are extremely rare but would break Firestore paths — sanitize defensively.
function adDocId(platform, externalId) {
  const safe = String(externalId).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${platform}_${safe}`;
}

// ---------- Write helpers ----------
// Idempotent upsert of a single UnifiedAd. Merge mode preserves any fields
// future writers add without coordinating with sync code.
async function upsertAd(unifiedAd) {
  if (!unifiedAd || !unifiedAd.id) throw new Error('upsertAd: missing id');
  const ref = db().doc(`workspaces/${WORKSPACE_ID}/marketing_ads/${unifiedAd.id}`);
  await ref.set(unifiedAd, { merge: true });
}

// Batched bulk-upsert. Splits into FIRESTORE_BATCH_CAP-size chunks.
// Returns { written, skipped, errors[] }.
async function upsertAdsBatch(unifiedAds) {
  const result = { written: 0, skipped: 0, errors: [] };
  if (!Array.isArray(unifiedAds) || unifiedAds.length === 0) return result;
  // Cap to MAX_ADS_PER_PLATFORM (per call). Sync logic is responsible for
  // sorting by spend desc BEFORE passing in, so the cap drops least-important.
  const list = unifiedAds.slice(0, MAX_ADS_PER_PLATFORM);
  for (let i = 0; i < list.length; i += FIRESTORE_BATCH_CAP) {
    const chunk = list.slice(i, i + FIRESTORE_BATCH_CAP);
    const batch = db().batch();
    for (const ad of chunk) {
      if (!ad || !ad.id) { result.skipped++; continue; }
      const ref = db().doc(`workspaces/${WORKSPACE_ID}/marketing_ads/${ad.id}`);
      batch.set(ref, ad, { merge: true });
    }
    try {
      await batch.commit();
      result.written += chunk.length;
    } catch (e) {
      logger.error(`[marketing-ads-shared] batch ${i}..${i + chunk.length} failed: ${e.message}`);
      result.errors.push({ start: i, end: i + chunk.length, error: e.message });
    }
  }
  return result;
}

// Soft-delete ads no longer returned by the platform. Marks status='DELETED'
// + adds deletedAt timestamp; preserves history rather than hard-removing.
// platformPresentIds = Set of `<platform>_<externalId>` we just synced.
async function pruneStaleAds(platform, platformPresentIds) {
  const now = new Date().toISOString();
  const snap = await db().collection(`workspaces/${WORKSPACE_ID}/marketing_ads`)
    .where('platform', '==', platform)
    .where('ad.status', '!=', 'DELETED')
    .get();
  const stale = snap.docs.filter(d => !platformPresentIds.has(d.id));
  let pruned = 0;
  for (let i = 0; i < stale.length; i += FIRESTORE_BATCH_CAP) {
    const chunk = stale.slice(i, i + FIRESTORE_BATCH_CAP);
    const batch = db().batch();
    for (const d of chunk) {
      batch.set(d.ref, {
        'ad.status': 'DELETED',
        deletedAt: now,
        ingestedAt: now,
      }, { merge: true });
    }
    try {
      await batch.commit();
      pruned += chunk.length;
    } catch (e) {
      logger.warn(`[marketing-ads-shared] prune chunk ${i} failed: ${e.message}`);
    }
  }
  return pruned;
}

// ---------- Read helpers (used by Top-Ads tab callables) ----------
// Sorted-by-spend pagination cursor.
// Returns { ads: UnifiedAd[], nextCursor: string|null }.
// `cursor` is the doc.id of the last ad from the previous page; pass null
// for the first page. Limit capped at 50 to keep client bundles snappy.
async function listTopAds(opts = {}) {
  const {
    platform = null,        // 'tiktok' | 'meta' | 'google' | null (all)
    limit = 50,
    cursor = null,
    excludeDeleted = true,
  } = opts;
  const capped = Math.min(Math.max(1, Number(limit) || 50), 100);
  let q = db().collection(`workspaces/${WORKSPACE_ID}/marketing_ads`);
  if (platform) q = q.where('platform', '==', platform);
  if (excludeDeleted) q = q.where('ad.status', '!=', 'DELETED');
  // orderBy must come AFTER inequality filter on the same field for Firestore.
  // Order by spend desc, with ad.status as the inequality tiebreaker.
  q = q.orderBy('ad.status').orderBy('totals.spend', 'desc').limit(capped);
  if (cursor) {
    const cursorSnap = await db().doc(`workspaces/${WORKSPACE_ID}/marketing_ads/${cursor}`).get();
    if (cursorSnap.exists) q = q.startAfter(cursorSnap);
  }
  const snap = await q.get();
  const ads = snap.docs.map(d => d.data());
  const nextCursor = snap.docs.length === capped ? snap.docs[snap.docs.length - 1].id : null;
  return { ads, nextCursor };
}

// One-ad detail fetch (used by ad detail pane).
async function getAd(adDocIdStr) {
  const snap = await db().doc(`workspaces/${WORKSPACE_ID}/marketing_ads/${adDocIdStr}`).get();
  return snap.exists ? snap.data() : null;
}

// ---------- Derived-metric helpers ----------
// Centralized so all 3 platforms compute identically. Pass `totals` slice.
function computeDerivedMetrics(t) {
  const out = { ...t };
  out.ctr = t.impressions > 0 ? (t.clicks / t.impressions) * 100 : 0;
  out.cpc = t.clicks > 0 ? t.spend / t.clicks : 0;
  out.cpm = t.impressions > 0 ? (t.spend / t.impressions) * 1000 : 0;
  out.cpa = t.conversions > 0 ? t.spend / t.conversions : 0;
  return out;
}

// ---------- Daily roll-up ----------
// Aggregate daily rows to totals. Idempotent; safe to call before write.
function rollupDaily(daily) {
  const acc = { spend: 0, impressions: 0, clicks: 0, conversions: 0, videoViews: 0 };
  for (const d of daily || []) {
    acc.spend += Number(d.spend) || 0;
    acc.impressions += Number(d.impressions) || 0;
    acc.clicks += Number(d.clicks) || 0;
    acc.conversions += Number(d.conversions) || 0;
    acc.videoViews += Number(d.videoViews) || 0;
  }
  return acc;
}

// ---------- Public callables (consumed by Pulse Top-Ads UI) ----------
// Single cross-platform read endpoint. Returns sorted-by-spend page.
// Request: { platform?, limit?, cursor?, excludeDeleted? }
// Response: { ok, ads, nextCursor }
const marketingAdsList = onCall(
  { timeoutSeconds: 30 },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    const data = request.data || {};
    const platform = ['tiktok', 'meta', 'google'].includes(data.platform) ? data.platform : null;
    const limit = Number(data.limit) || 50;
    const cursor = typeof data.cursor === 'string' ? data.cursor : null;
    const excludeDeleted = data.excludeDeleted !== false;
    const res = await listTopAds({ platform, limit, cursor, excludeDeleted });
    return { ok: true, ...res };
  }
);

// Single-ad detail. Used by the Top-Ads detail pane / video preview modal.
// Request: { id }  (full doc id, e.g. "tiktok_1234567890")
const marketingAdGet = onCall(
  { timeoutSeconds: 15 },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    const id = String(request.data?.id || '');
    if (!id) throw new HttpsError('invalid-argument', 'id is required');
    const ad = await getAd(id);
    return { ok: true, ad };
  }
);

module.exports = {
  adDocId,
  upsertAd,
  upsertAdsBatch,
  pruneStaleAds,
  listTopAds,
  getAd,
  computeDerivedMetrics,
  rollupDaily,
  MAX_ADS_PER_PLATFORM,
  WORKSPACE_ID,
  marketingAdsList,
  marketingAdGet,
};
