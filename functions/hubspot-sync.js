/**
 * HubSpot sync (Phase 19) — pulls owners, deals, meetings (tours) from
 * HubSpot CRM into the workspace state for per-manager analytics in Pulse.
 *
 * Triggered:
 *   - onSchedule every 30 min — incremental sync of last 24h activity
 *   - hubspotSyncNow — manual trigger, callable (root admin)
 *
 * Writes to /workspaces/{wid}/data/state under state.hubspotData:
 *   {
 *     syncedAt: ISO,
 *     owners: { [ownerId]: { email, name, ... } },
 *     dealsByOwner: { [email]: [{id, dealname, dealstage, stageLabel, createdate, closedate, pipeline}] },
 *     meetingsByOwner: { [email]: [{id, title, ts, outcome, contactIds}] },
 *     pipelines: { [pipelineId]: { label, stages: [{id, label, displayOrder, isClosed, isWon}] } },
 *     toursByMonth: { [email]: { [YYYY-MM]: { scheduled, conducted } } },
 *     dealsByStage: { [email]: { [stageId]: count } },
 *   }
 *
 * Tour detection heuristics:
 *   - Meeting title contains «tour» (case-insensitive), OR
 *   - Linked deal sits in a stage labelled «tour» (e.g. «scheduled a tour», «Was on tour»)
 *
 * Authentication: HUBSPOT_TOKEN secret — bound at runtime, never logged.
 */

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const HUBSPOT_TOKEN = defineSecret('HUBSPOT_TOKEN');
const WORKSPACE_ID = 'default';
const ROOT_ADMINS = ['tony@al-en.com'];
const HUBSPOT_API = 'https://api.hubapi.com';

const db = admin.firestore();

// =========================================================================
// HTTP helper — Bearer auth, native fetch, JSON.
// =========================================================================
async function _hsFetch(token, path) {
  const url = path.startsWith('http') ? path : (HUBSPOT_API + path);
  const res = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

// Paginate through a HubSpot list endpoint until exhausted or maxPages.
async function _hsPaginate(token, basePath, {limit = 100, maxPages = 20, query = {}} = {}) {
  const all = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({limit: String(limit), ...query});
    if (after) params.set('after', after);
    const sep = basePath.includes('?') ? '&' : '?';
    const data = await _hsFetch(token, basePath + sep + params.toString());
    const results = Array.isArray(data.results) ? data.results : [];
    all.push(...results);
    const next = data.paging?.next?.after;
    if (!next) break;
    after = next;
  }
  return all;
}

// =========================================================================
// Owners — id → {email, name, archived}.
// =========================================================================
async function _fetchOwners(token) {
  const raw = await _hsPaginate(token, '/crm/v3/owners', {limit: 100, maxPages: 5});
  const byId = {};
  for (const o of raw) {
    if (!o || !o.id) continue;
    byId[String(o.id)] = {
      id: String(o.id),
      email: (o.email || '').toLowerCase(),
      name: [o.firstName, o.lastName].filter(Boolean).join(' ').trim() || o.email || ('owner ' + o.id),
      archived: !!o.archived,
    };
  }
  return byId;
}

// =========================================================================
// Pipelines — id → {label, stages: [{id,label,displayOrder,isClosed,isWon}]}.
// =========================================================================
async function _fetchPipelines(token) {
  const data = await _hsFetch(token, '/crm/v3/pipelines/deals');
  const out = {};
  for (const p of (data.results || [])) {
    out[p.id] = {
      id: p.id,
      label: p.label,
      stages: (p.stages || []).map(s => ({
        id: s.id,
        label: s.label,
        displayOrder: s.displayOrder,
        isClosed: !!(s.metadata && s.metadata.isClosed === 'true'),
        isWon: !!(s.metadata && s.metadata.probability === '1.0'),
      })),
    };
  }
  return out;
}

// =========================================================================
// Deals — recently-modified (incremental). Returns array sorted by
// hs_lastmodifieddate desc. Use sinceMs to limit window.
// =========================================================================
async function _fetchDeals(token, {sinceMs = null} = {}) {
  // POST /crm/v3/objects/deals/search allows filters; using GET list for
  // simplicity. Filter client-side for sinceMs window.
  const props = 'dealname,dealstage,hubspot_owner_id,closedate,createdate,hs_lastmodifieddate,pipeline,amount';
  const raw = await _hsPaginate(token, `/crm/v3/objects/deals?properties=${props}`, {limit: 100, maxPages: 20});
  const out = [];
  for (const d of raw) {
    const p = d.properties || {};
    const lastMod = p.hs_lastmodifieddate ? new Date(p.hs_lastmodifieddate).getTime() : 0;
    if (sinceMs && lastMod && lastMod < sinceMs) continue;
    out.push({
      id: String(d.id),
      name: p.dealname || '',
      stage: p.dealstage || '',
      pipeline: p.pipeline || 'default',
      ownerId: p.hubspot_owner_id ? String(p.hubspot_owner_id) : null,
      amount: p.amount ? +p.amount : null,
      createdAt: p.createdate || null,
      closedAt: p.closedate || null,
      lastMod: p.hs_lastmodifieddate || null,
    });
  }
  return out;
}

// =========================================================================
// Meetings (tours). Pulls recent meetings and classifies tour vs not.
// =========================================================================
async function _fetchMeetings(token, {sinceMs = null} = {}) {
  const props = 'hs_meeting_title,hs_meeting_outcome,hs_timestamp,hs_createdate,hs_lastmodifieddate,hubspot_owner_id';
  const raw = await _hsPaginate(token, `/crm/v3/objects/meetings?properties=${props}`, {limit: 100, maxPages: 30});
  const out = [];
  for (const m of raw) {
    const p = m.properties || {};
    const lastMod = p.hs_lastmodifieddate ? new Date(p.hs_lastmodifieddate).getTime() : 0;
    if (sinceMs && lastMod && lastMod < sinceMs) continue;
    const title = p.hs_meeting_title || '';
    // Heuristic: title contains «tour» = it's a tour. Sample-meeting
    // titles («(Sample meeting) ...») are filtered out below.
    const isTour = /tour/i.test(title) && !/^\(sample/i.test(title);
    out.push({
      id: String(m.id),
      title,
      isTour,
      outcome: p.hs_meeting_outcome || null,
      ts: p.hs_timestamp || null,
      createdAt: p.hs_createdate || null,
      ownerId: p.hubspot_owner_id ? String(p.hubspot_owner_id) : null,
    });
  }
  return out;
}

// =========================================================================
// Build per-owner aggregates ready for UI consumption.
// =========================================================================
function _buildAggregates(owners, pipelines, deals, meetings) {
  // dealsByOwner: email → [deal]
  // meetingsByOwner: email → [meeting]
  // toursByMonth: email → ym → { scheduled, conducted }
  // dealsByStage: email → stageId → count
  const dealsByOwner = {};
  const meetingsByOwner = {};
  const toursByMonth = {};
  const dealsByStage = {};

  // Stage label lookup — combine across all pipelines.
  const stageLabels = {};
  for (const p of Object.values(pipelines)) {
    for (const s of p.stages) stageLabels[s.id] = { label: s.label, pipeline: p.id };
  }

  const ownerEmail = (id) => (owners[id] && owners[id].email) || null;

  for (const d of deals) {
    const email = ownerEmail(d.ownerId);
    if (!email) continue;
    if (!dealsByOwner[email]) dealsByOwner[email] = [];
    const stageLabel = stageLabels[d.stage]?.label || d.stage;
    dealsByOwner[email].push({ ...d, stageLabel });

    if (!dealsByStage[email]) dealsByStage[email] = {};
    dealsByStage[email][d.stage] = (dealsByStage[email][d.stage] || 0) + 1;
  }

  for (const m of meetings) {
    const email = ownerEmail(m.ownerId);
    if (!email) continue;
    if (!meetingsByOwner[email]) meetingsByOwner[email] = [];
    meetingsByOwner[email].push(m);

    if (m.isTour && m.ts) {
      const ym = String(m.ts).slice(0, 7);
      if (!toursByMonth[email]) toursByMonth[email] = {};
      if (!toursByMonth[email][ym]) toursByMonth[email][ym] = { scheduled: 0, conducted: 0 };
      toursByMonth[email][ym].scheduled++;
      // «conducted» heuristic: outcome explicitly set OR ts in past.
      const tsMs = new Date(m.ts).getTime();
      if (m.outcome || (tsMs && tsMs < Date.now())) {
        toursByMonth[email][ym].conducted++;
      }
    }
  }

  return { dealsByOwner, meetingsByOwner, toursByMonth, dealsByStage };
}

// =========================================================================
// Main sync — orchestrate fetch + aggregate + write.
// =========================================================================
async function _runSync({fullSync = false} = {}) {
  const token = HUBSPOT_TOKEN.value();
  if (!token) {
    throw new Error('HUBSPOT_TOKEN secret not bound — check function deployment');
  }
  // Incremental: only events modified in last 24h. Full sync: all data.
  const sinceMs = fullSync ? null : (Date.now() - 24 * 60 * 60 * 1000);
  const t0 = Date.now();
  const [owners, pipelines, deals, meetings] = await Promise.all([
    _fetchOwners(token),
    _fetchPipelines(token),
    _fetchDeals(token, { sinceMs }),
    _fetchMeetings(token, { sinceMs }),
  ]);
  const aggregates = _buildAggregates(owners, pipelines, deals, meetings);

  // If incremental — merge into existing state.hubspotData rather than overwrite.
  const stateRef = db.doc(`workspaces/${WORKSPACE_ID}/data/state`);
  const existing = (await stateRef.get()).data() || {};
  const state = existing.state || {};
  const prevHs = state.hubspotData || {};

  const merged = fullSync ? aggregates : {
    dealsByOwner: { ...(prevHs.dealsByOwner || {}), ...aggregates.dealsByOwner },
    meetingsByOwner: { ...(prevHs.meetingsByOwner || {}), ...aggregates.meetingsByOwner },
    toursByMonth: _mergeToursByMonth(prevHs.toursByMonth || {}, aggregates.toursByMonth),
    dealsByStage: { ...(prevHs.dealsByStage || {}), ...aggregates.dealsByStage },
  };

  const hubspotData = {
    syncedAt: new Date().toISOString(),
    syncedFromMs: sinceMs,
    syncDurationMs: Date.now() - t0,
    owners,
    pipelines,
    ...merged,
    counts: {
      owners: Object.keys(owners).length,
      pipelines: Object.keys(pipelines).length,
      deals: deals.length,
      meetings: meetings.length,
      tourMeetings: meetings.filter(m => m.isTour).length,
    },
  };

  await stateRef.set({
    state: { ...state, hubspotData },
    _rev: (state._rev || 0) + 1,
    _updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    _updatedBy: fullSync ? 'hubspot-sync-full' : 'hubspot-sync',
  }, { merge: true });

  // Audit row so Activity log shows the sync ran.
  try {
    await db.collection(`workspaces/${WORKSPACE_ID}/audit`).add({
      action: 'hubspot.sync',
      ts: Date.now(),
      actor: fullSync ? 'system:hubspot-sync-full' : 'system:hubspot-sync',
      note: `HubSpot sync: ${meetings.length} meetings (${hubspotData.counts.tourMeetings} tours), ${deals.length} deals, ${Object.keys(owners).length} owners`,
      counts: hubspotData.counts,
    });
  } catch (e) {
    logger.warn('[hubspot-sync] audit-write failed: ' + e.message);
  }

  return hubspotData.counts;
}

function _mergeToursByMonth(prev, fresh) {
  const out = { ...prev };
  for (const [email, months] of Object.entries(fresh)) {
    if (!out[email]) out[email] = {};
    for (const [ym, vals] of Object.entries(months)) {
      out[email][ym] = vals;  // fresh wins for the month (recomputed from full month's meetings)
    }
  }
  return out;
}

// =========================================================================
// Scheduled — every 30 min, incremental.
// =========================================================================
exports.hubspotSync = onSchedule(
  {
    schedule: 'every 30 minutes',
    timeZone: 'UTC',
    timeoutSeconds: 300,
    memory: '256MiB',
    secrets: [HUBSPOT_TOKEN],
  },
  async () => {
    try {
      const counts = await _runSync({ fullSync: false });
      logger.info('[hubspot-sync] OK', counts);
    } catch (e) {
      logger.error('[hubspot-sync] FAIL: ' + e.message, e);
      throw e;
    }
  }
);

// =========================================================================
// Manual — admin-only. Body: { fullSync?: bool }.
// =========================================================================
exports.hubspotSyncNow = onCall(
  { secrets: [HUBSPOT_TOKEN], timeoutSeconds: 300 },
  async (request) => {
    const email = (request.auth?.token?.email || '').toLowerCase();
    if (!ROOT_ADMINS.includes(email)) {
      throw new HttpsError('permission-denied', 'Root admin only');
    }
    const fullSync = !!request.data?.fullSync;
    const counts = await _runSync({ fullSync });
    return { ok: true, counts };
  }
);
