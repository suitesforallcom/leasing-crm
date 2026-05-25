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

const {onRequest} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const MARKETING_INGEST_SECRET = defineSecret('MARKETING_INGEST_SECRET');
const WORKSPACE_ID = 'default';
const ALLOWED_SOURCES = ['google-ads', 'meta', 'tiktok', 'ga4', 'manual'];
const MAX_CAMPAIGNS_PER_SOURCE = 200;  // trim to stay under Firestore 1MB cap

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
