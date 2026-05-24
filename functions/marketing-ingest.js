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

      // Trim + sanitize campaign records (drop unknown fields, coerce types)
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
      const totals = body.totals && typeof body.totals === 'object' ? {
        cost: Number(body.totals.cost) || 0,
        clicks: Number(body.totals.clicks) || 0,
        impressions: Number(body.totals.impressions) || 0,
        conversions: Number(body.totals.conversions) || 0,
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
        totals,
        // Serialize campaigns to JSON string to stay under Firestore's
        // 40K index-entries cap (same trick as hubspot doc — see Entry 31
        // in FIXES_LOG). At 200 campaigns × 9 fields = 1800 entries; we'd
        // survive uncompressed, but stringifying lets us comfortably fit
        // multiple sources in one doc.
        campaignsJson: JSON.stringify(trimmed),
        campaignCount: trimmed.length,
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
    // Inflate campaignsJson back into objects for client consumption
    const inflated = {};
    for (const [key, payload] of Object.entries(sources)) {
      if (payload && payload.campaignsJson) {
        try {
          inflated[key] = { ...payload, campaigns: JSON.parse(payload.campaignsJson) };
          delete inflated[key].campaignsJson;
        } catch (e) {
          inflated[key] = { ...payload, campaigns: [], _parseError: e.message };
        }
      } else {
        inflated[key] = payload;
      }
    }
    return {
      marketingData: {
        updatedAt: raw.updatedAt,
        sources: inflated,
      },
    };
  }
);
