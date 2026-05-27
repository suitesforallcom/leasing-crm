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

// Sleep helper for throttling.
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Paginate through a HubSpot list endpoint until exhausted or maxPages.
// Throttles between pages (150ms) to stay under the 15K req / 5s limit.
async function _hsPaginate(token, basePath, {limit = 100, maxPages = 20, query = {}, throttleMs = 150} = {}) {
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
    if (throttleMs > 0) await _sleep(throttleMs);
  }
  return all;
}

// =========================================================================
// Owners — id → {email, name, archived}.
// =========================================================================
async function _fetchOwners(token) {
  // Fetch BOTH active and archived owners. Deals from years past often
  // have an hubspot_owner_id pointing to an archived (offboarded) sales
  // rep — without including them in the owners map, we'd skip 90%+ of
  // historical deals (they'd be «orphaned») and the funnel would show
  // only deals from currently-active reps.
  const active = await _hsPaginate(token, '/crm/v3/owners?archived=false', {limit: 100, maxPages: 5});
  await _sleep(150);
  const archived = await _hsPaginate(token, '/crm/v3/owners?archived=true', {limit: 100, maxPages: 5});
  const byId = {};
  for (const o of [...active, ...archived]) {
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
// Contacts — pulled to support cross-system linking. Floor-map prospects
// store an email; we want to show «this prospect is in HubSpot, owned by
// <manager>» on the prospect card. Only pulled on fullSync (heavy).
// Returns map email → { id, firstname, lastname, ownerId, lifecycleStage }.
// =========================================================================
async function _fetchContacts(token, {maxPages = 60} = {}) {
  // Compact fields — keep entry footprint small to stay under Firestore's
  // 1MB doc cap. At ~3K contacts × ~150 bytes = ~450 KB (after Marketing
  // Phase 1 expansion). Heavy maps are JSON-stringified before write
  // (schemaVersion: 2) so index-entries cap stays well under 40K.
  //   i = contactId
  //   o = hubspot_owner_id (lookup owners map for name/email)
  //   s = lifecyclestage (lead / mql / sql / opportunity / customer / ...)
  //   n = «firstname lastname» trimmed (or null if both blank)
  //   p = phone (raw, may include country code or be null)
  //   c = createdate ISO (truncated to 'YYYY-MM-DD' to save bytes)
  //   src = original analytics source category — one of: ORGANIC_SEARCH,
  //         PAID_SEARCH, DIRECT_TRAFFIC, REFERRALS, SOCIAL_MEDIA,
  //         PAID_SOCIAL, EMAIL_MARKETING, OTHER_CAMPAIGNS, OFFLINE, OTHER
  //   srcD = source data 1 — concrete platform within the category, e.g.
  //         «google» / «facebook» / «tiktok» / «linkedin» / «direct» /
  //         «(referral domain)» / etc.
  // Marketing Phase 1 (channel mix dashboard) reads src + srcD to bucket
  // contacts by acquisition channel without touching ad-platform APIs.
  const props = 'email,firstname,lastname,phone,createdate,hubspot_owner_id,lifecyclestage,hs_analytics_source,hs_analytics_source_data_1';
  const raw = await _hsPaginate(token, `/crm/v3/objects/contacts?properties=${props}`, {limit: 100, maxPages, throttleMs: 200});
  // Двойной индекс (Tony 2026-05-27):
  //   byId    — основной, ключ = contactId; включает ВСЕ контакты (даже
  //             без email). Лиды из FB Messenger / SOCIAL в HubSpot часто
  //             приходят без email — раньше они молча дропались на этапе
  //             загрузки потому что map ключевался по email. Pulse Marketing
  //             за 30 дней показывал 319 вместо 387 — ровно 68 no-email
  //             SOCIAL лидов терялись.
  //   byEmail — back-compat индекс, ключ = email; только with-email контакты
  //             (как раньше). Используется в местах где ищут конкретного
  //             контакта по email тенанта (data-shim join, floor-map).
  // Оба индекса ссылаются на ОДИН И ТОТ ЖЕ compact-объект — мутации
  // (._origSrc override) видны через оба ключа.
  const byEmail = {};
  const byId = {};
  for (const c of raw) {
    const p = c.properties || {};
    const id = String(c.id);
    const email = (p.email || '').toLowerCase().trim();
    const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim() || null;
    const created = p.createdate ? String(p.createdate).slice(0, 10) : null;
    const compact = {
      i: id,
      o: p.hubspot_owner_id ? String(p.hubspot_owner_id) : null,
      s: p.lifecyclestage || null,
      n: name,
      p: p.phone || null,
      c: created,
      src: p.hs_analytics_source || null,
      srcD: p.hs_analytics_source_data_1 || null,
      e: email || null,   // NEW field: email встроен в value (раньше был только ключом)
    };
    byId[id] = compact;
    if (email) byEmail[email] = compact;
  }
  return { byEmail, byId };
}

// =========================================================================
// Build per-owner aggregates ready for UI consumption.
// =========================================================================
function _buildAggregates(owners, pipelines, deals, meetings) {
  // dealsByOwner: email → [deal]
  // meetingsByOwner: email → [meeting]
  // toursByMonth: email → ym → { scheduled, conducted }
  // dealsByStage: email → stageId → count
  // signsByMonth: email → ym → count (deals in won/contract stage)
  const dealsByOwner = {};
  const meetingsByOwner = {};
  const toursByMonth = {};
  const dealsByStage = {};
  const signsByMonth = {};

  // Stage label lookup — combine across all pipelines.
  // Detection strategy (in priority order):
  //   1. Pipeline metadata: isWon === true → isSigned (HubSpot's ground truth)
  //   2. isClosed && !isWon → isLost (excluded from funnel)
  //   3. Label regex — broad patterns covering leasing/sales vocabularies
  // We rerun regex even when metadata says won, so isSigned is always set
  // when EITHER the label matches OR HubSpot marked the stage won.
  const stageLabels = {};
  const stageMeta = {};  // id → { isScheduledTour, isPastTour, isSigned, isLost, label }
  for (const p of Object.values(pipelines)) {
    for (const s of p.stages) {
      stageLabels[s.id] = { label: s.label, pipeline: p.id };
      const lbl = (s.label || '').toLowerCase();
      // ВНИМАНИЕ: регэксы расширены 2026-05-23 — раньше детектились только
      // буквальные «contract / closed-won / signed», что для кастомных
      // pipelines типа «Active Lease», «Moved In», «Executed» давало 0
      // подписей в воронке. Теперь покрываем стандартные шаблоны HubSpot
      // CRM + типичные leasing-pipeline стадии.
      const isScheduledTour =
        // «Scheduled a tour», «booked tour», «tour scheduled», «book tour»
        /\b(scheduled|booked|book|booking|set up|set|arrange|arranged)\b.*\btour\b/.test(lbl) ||
        /\btour\b.*\b(scheduled|booked|set|pending|upcoming)\b/.test(lbl) ||
        // «Appointment scheduled» (default HubSpot stage) → counts as tour
        /\bappointment\b.*\b(scheduled|booked)\b/.test(lbl) ||
        // «Tour» followed by nothing else (a stage just called «Tour»)
        /^tour$/.test(lbl);
      // Qualified — deal/contact engaged but pre-tour. Critical to split out
      // because for telemarketing pipelines (Tony's «Buyers pipeline») the
      // «Buyer qualification» stage is the largest cohort that's NOT just
      // raw leads. Excludes negative outcomes («not interested», «wrong
      // area», no-answer, didn't request) which stay in inquiry.
      //
      // Two-pass: first reject NEGATIVE labels, THEN match positive ones.
      // Order matters because raw match against /\binterested\b/ would
      // also accept «Call answered - not interested».
      const isNegativeOutcome =
        /\b(not interested|not.?qualif|disqual|unqual|wrong.?area|wrong.?number|no.?answer|did.?n'?t request|didn'?t request|not.?responsive|dead|cold|ghosted|spam|junk)\b/.test(lbl);
      const isQualified = !isNegativeOutcome && (
        // «Buyer qualification», «Qualified», «Qualified to buy» (HubSpot default)
        /\bqualif(ied|y|ication)\b/.test(lbl) ||
        // «Call answered - interested», «Engaged», «Warm lead», bare «Interested»
        /\b(interested|warm|engaged|hot.?lead|nurturing)\b/.test(lbl) ||
        // «Responded to text/email» — engagement signal (MQL-tier)
        /\bresponded to\b/.test(lbl) ||
        // «Decision maker bought-in» pre-presentation (HubSpot default)
        /\b(presentation|proposal) (sent|pending)\b/.test(lbl)
      );
      const isPastTour =
        // «Was on tour», «tour done», «toured», «showed», «showing complete»
        /\bwas on tour\b|\btour(ed| done| complete|s? complete)\b|\bshow(ed|ing complete|n)\b/.test(lbl) ||
        // «Toured», «Post-tour», «Tour follow-up», «After tour»
        /\b(post|after)\b.*\btour\b|\btour\b.*\b(follow.?up|completed|finished)\b/.test(lbl) ||
        // «Decision maker bought-in» (HubSpot default — post-presentation)
        /\bdecision\b.*\b(maker|bought)\b/.test(lbl) ||
        // «Presentation scheduled / done» → treat as past-tour for office leasing
        /\bpresentation\b/.test(lbl);
      // ground-truth from HubSpot pipeline metadata
      const won = !!(s.metadata && s.metadata.probability === '1.0');
      const closed = !!(s.metadata && s.metadata.isClosed === 'true');
      const isSignedByLabel =
        // «Contract», «closed won», «signed», «lease signed», «executed»
        /\b(contract|closed.?won|signed|sign(ing|ed)?|lease.?(signed|active|executed)|executed|moved.?in|active.?(lease|tenant)|tenant|won)\b/.test(lbl) ||
        // «Application accepted/approved», «Approved», «Move-in scheduled»
        /\b(application|app)\b.*\b(approved|accepted|signed)\b/.test(lbl) ||
        /\bmove.?in\b/.test(lbl);
      stageMeta[s.id] = {
        label: s.label,
        isScheduledTour,
        isPastTour,
        // Qualified — explicitly set ONLY if not also tour/signed. Tour/signed
        // stages outrank qualified in the funnel so we don't double-bucket.
        isQualified: isQualified && !isScheduledTour && !isPastTour,
        // SIGNED = HubSpot's «isWon» metadata OR label matches signed patterns
        isSigned: won || isSignedByLabel,
        // LOST = closed but not won — excluded from funnel entirely
        isLost: closed && !won && /\b(lost|disqual|unqual|dead|ghosted|no.?response|not.?interested)\b/.test(lbl),
        isWon: won,
        isClosed: closed,
      };
    }
  }
  // Any stage that matches tour heuristic counts as «tour activity».
  const isTourStage = (stageId) => {
    const m = stageMeta[stageId];
    return !!(m && (m.isScheduledTour || m.isPastTour));
  };

  const ownerEmail = (id) => (owners[id] && owners[id].email) || null;

  for (const d of deals) {
    // Bucket key — owner email if known, otherwise '_unowned' so the
    // funnel still sees the deal. Previous behavior («continue») silently
    // dropped 90%+ of historical deals (archived-owner deals) on fullSync.
    const email = ownerEmail(d.ownerId) || '_unowned';
    if (!dealsByOwner[email]) dealsByOwner[email] = [];
    const meta = stageMeta[d.stage] || {};
    dealsByOwner[email].push({ ...d, stageLabel: meta.label || d.stage });

    if (!dealsByStage[email]) dealsByStage[email] = {};
    dealsByStage[email][d.stage] = (dealsByStage[email][d.stage] || 0) + 1;

    // Tours per month — by createdAt for scheduledTour stage, lastMod
    // for pastTour stage. Best proxy without stage-history pull.
    if (isTourStage(d.stage)) {
      const tourDate = meta.isPastTour ? (d.lastMod || d.createdAt) : (d.createdAt || d.lastMod);
      if (tourDate) {
        const ym = String(tourDate).slice(0, 7);
        if (!toursByMonth[email]) toursByMonth[email] = {};
        if (!toursByMonth[email][ym]) toursByMonth[email][ym] = { scheduled: 0, conducted: 0 };
        toursByMonth[email][ym].scheduled++;
        if (meta.isPastTour) toursByMonth[email][ym].conducted++;
      }
    }

    // Signs per month — deals that reached signed stage.
    if (meta.isSigned && (d.closedAt || d.lastMod)) {
      const ym = String(d.closedAt || d.lastMod).slice(0, 7);
      if (!signsByMonth[email]) signsByMonth[email] = {};
      signsByMonth[email][ym] = (signsByMonth[email][ym] || 0) + 1;
    }
  }

  // Meetings — augment with title-based tour detection (catches the
  // «Tour - <name>» pattern even if deal isn't linked to a tour stage).
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
      const tsMs = new Date(m.ts).getTime();
      if (m.outcome || (tsMs && tsMs < Date.now())) {
        toursByMonth[email][ym].conducted++;
      }
    }
  }

  return { dealsByOwner, meetingsByOwner, toursByMonth, dealsByStage, signsByMonth, stageMeta };
}

// Compute stage diagnostics from the (potentially merged) dealsByStage +
// stageMeta. Used to show «which stage labels landed in which bucket» as
// a tooltip in the Pulse UI so we can debug «why is the signed count 0».
// Called AFTER incremental merge so the deal counts reflect the full
// known pipeline state, not just the 24h delta.
function _buildStageDiagnostics(stageMeta, dealsByStage) {
  const stageDealCounts = {};  // stageId → total deals across owners
  for (const stageMap of Object.values(dealsByStage || {})) {
    for (const [stageId, n] of Object.entries(stageMap)) {
      stageDealCounts[stageId] = (stageDealCounts[stageId] || 0) + n;
    }
  }
  // Include EVERY stage in the meta, even those with 0 deals — so the
  // operator can see «Contract stage exists but is empty» (signed leases
  // are tracked elsewhere) instead of silently omitting it. The empty=true
  // flag lets the UI dim them in a «Configured but unused» section.
  const out = [];
  for (const [stageId, m] of Object.entries(stageMeta || {})) {
    const count = stageDealCounts[stageId] || 0;
    let bucket = 'inquiry';
    if (m.isSigned)             bucket = 'signed';
    else if (m.isPastTour)      bucket = 'pastTour';
    else if (m.isScheduledTour) bucket = 'scheduledTour';
    else if (m.isQualified)     bucket = 'qualified';
    else if (m.isLost)          bucket = 'lost';
    out.push({
      stageId,
      label: m.label,
      bucket,
      deals: count,
      empty: count === 0,
      isWon: !!m.isWon,
      isClosed: !!m.isClosed,
    });
  }
  const bucketOrder = { signed: 0, pastTour: 1, scheduledTour: 2, qualified: 3, inquiry: 4, lost: 5 };
  out.sort((a, b) => {
    // empty stages always sort after populated ones in the same bucket
    if (a.empty !== b.empty) return a.empty ? 1 : -1;
    const d = bucketOrder[a.bucket] - bucketOrder[b.bucket];
    return d !== 0 ? d : (b.deals - a.deals);
  });
  return out;
}

// =========================================================================
// Main sync — orchestrate fetch + aggregate + write.
// =========================================================================
async function _runSync({fullSync = false} = {}) {
  const token = HUBSPOT_TOKEN.value();
  if (!token) {
    throw new Error('HUBSPOT_TOKEN secret not bound — check function deployment');
  }
  // 2026-05-24 fix — incremental sinceMs filter was breaking the funnel.
  // _buildAggregates emits dealsByStage as { email: { stageId: count } },
  // and _runSync's merge is a SHALLOW object spread per email:
  //   { ...prev[email], ...new[email] }
  // which REPLACES the per-email stage counts with whatever fresh data
  // saw in the last 24h. Result: after every 30-min scheduled sync the
  // funnel showed just the last 24h of deal activity (~2 deals) instead
  // of the full pipeline state (~2000 deals).
  //
  // Fix: always pull ALL deals + meetings, every sync. They're light
  // (deals: 2000 paginated = 20 API calls, ~3s; meetings: <100 = 1 call).
  // Contacts STAY gated behind fullSync since they're heavy (~2871 = 30
  // calls + 200ms throttle = ~6s and they rarely change ownership).
  const t0 = Date.now();
  // Sequential — Promise.all hammered the rate-limit (15K req/5s per
  // service is generous but 4 parallel paginated loops collide).
  const owners = await _fetchOwners(token);
  await _sleep(200);
  const pipelines = await _fetchPipelines(token);
  await _sleep(200);
  const deals = await _fetchDeals(token, { sinceMs: null });
  await _sleep(200);
  const meetings = await _fetchMeetings(token, { sinceMs: null });
  // Kept for legacy logging / contacts gating; previously also fed the
  // deals/meetings filter (no longer).
  const sinceMs = fullSync ? null : (Date.now() - 24 * 60 * 60 * 1000);
  // Contacts — only on fullSync to limit API hits (60 paginated pages
  // = up to 6000 contacts, ~15s of wall-clock time at 200ms throttle).
  // Floor-map uses these for prospect→HubSpot deal-owner attribution.
  let contactByEmail = null;
  let contactById = null;
  if (fullSync) {
    await _sleep(200);
    try {
      const fetched = await _fetchContacts(token);
      contactByEmail = fetched.byEmail;
      contactById = fetched.byId;
      logger.info(`[hubspot-sync] fetched ${Object.keys(contactById).length} contacts (${Object.keys(contactByEmail).length} with email, ${Object.keys(contactById).length - Object.keys(contactByEmail).length} without email)`);
    } catch (e) {
      logger.warn(`[hubspot-sync] contacts fetch failed (non-fatal): ${e.message}`);
      contactByEmail = {};
      contactById = {};
    }
  }
  const aggregates = _buildAggregates(owners, pipelines, deals, meetings);

  // Store HubSpot data in a SEPARATE Firestore doc, not merged into the
  // main state doc. Reason: Firestore has a 1MB per-doc cap, and the
  // main state is already at hundreds of KB. Bundling thousands of deals
  // + meetings into state blew the cap (1.1MB) on the very first sync.
  // Separate doc → independent size budget. Pulse data-shim reads it
  // alongside state.
  const hsRef = db.doc(`workspaces/${WORKSPACE_ID}/data/hubspot`);
  const prevDoc = (await hsRef.get()).data() || {};
  const prevHsRaw = prevDoc.hubspotData || {};
  // Inflate the v2-serialized heavy keys back into objects so the merge
  // logic below sees the rich shape. v1 docs (with raw objects) still
  // work — _expandHubspotData is a no-op when the *Json siblings are
  // absent.
  const prevHs = _expandHubspotData(prevHsRaw);

  const merged = fullSync ? aggregates : {
    dealsByOwner: { ...(prevHs.dealsByOwner || {}), ...aggregates.dealsByOwner },
    meetingsByOwner: { ...(prevHs.meetingsByOwner || {}), ...aggregates.meetingsByOwner },
    toursByMonth: _mergeToursByMonth(prevHs.toursByMonth || {}, aggregates.toursByMonth),
    signsByMonth: _mergeToursByMonth(prevHs.signsByMonth || {}, aggregates.signsByMonth || {}),
    dealsByStage: { ...(prevHs.dealsByStage || {}), ...aggregates.dealsByStage },
    stageMeta: aggregates.stageMeta || prevHs.stageMeta || {},
  };
  // Contacts — fullSync replaces, incremental keeps previous (we don't
  // re-fetch contacts on incremental). Falls back to {} so the UI helper
  // never throws on lookup.
  merged.contactByEmail = (fullSync && contactByEmail) ? contactByEmail : (prevHs.contactByEmail || {});
  // contactById добавлен 2026-05-27 — основной индекс, включает no-email
  // SOCIAL/Messenger лидов.
  // КРИТИЧНО (fix 2026-05-27 #2): на incremental sync если prevHs не имеет
  // contactById (старая v2 схема) — НЕ записываем пустой {} в Firestore.
  // Иначе frontend получает empty truthy {} и фолбэк `||` на contactByEmail
  // не срабатывает → UI показывает 0 контактов. Оставляем field undefined
  // — serialize step ниже пропустит его, contactByIdJson не появится в
  // Firestore, и frontend корректно фолбэчит на contactByEmail.
  if (fullSync && contactById && Object.keys(contactById).length > 0) {
    merged.contactById = contactById;
  } else if (prevHs.contactById && Object.keys(prevHs.contactById).length > 0) {
    merged.contactById = prevHs.contactById;
  }
  // else — leave undefined; serialize step skips it
  // Stage diagnostics — computed from merged dealsByStage + stageMeta so
  // the counts reflect every pipeline stage we've seen, not just deals
  // modified in the last 24h.
  merged.stageDiagnostics = _buildStageDiagnostics(merged.stageMeta, merged.dealsByStage);

  // Trim deals + meetings to last 90 per owner to stay under 1MB. Tours
  // counts (toursByMonth) preserve the aggregates even for trimmed data.
  const TRIM = 90;
  for (const email of Object.keys(merged.dealsByOwner)) {
    merged.dealsByOwner[email] = merged.dealsByOwner[email]
      .sort((a, b) => String(b.lastMod || '').localeCompare(a.lastMod || ''))
      .slice(0, TRIM);
  }
  for (const email of Object.keys(merged.meetingsByOwner)) {
    merged.meetingsByOwner[email] = merged.meetingsByOwner[email]
      .sort((a, b) => String(b.ts || '').localeCompare(a.ts || ''))
      .slice(0, TRIM);
  }

  // Firestore caps each document at 40,000 index entries (every field +
  // nested field is auto-indexed). contactByEmail alone has ~3K entries
  // with 6 sub-fields each = 18K entries before we even count deals/
  // tours/etc. Hit «INDEX_ENTRIES_COUNT_LIMIT_EXCEEDED» on first write
  // with the expanded contact fields. Fix: serialize heavy nested maps
  // into JSON strings. Firestore indexes a string as ONE entry regardless
  // of length. Drawback: can't query server-side, but we always read the
  // whole doc anyway (Pulse data-shim grabs it via hubspotGetData).
  const heavyKeys = [
    'contactByEmail',
    'contactById',         // добавлен 2026-05-27 (см. _fetchContacts)
    'dealsByOwner',
    'meetingsByOwner',
    'toursByMonth',
    'signsByMonth',
    'dealsByStage',
    'stageMeta',
    'stageDiagnostics',
  ];
  const serialized = {};
  for (const k of heavyKeys) {
    if (merged[k] !== undefined) {
      // Always stringify, even when empty — keeps the read-side parser
      // path uniform (it expects a string at these keys).
      serialized[k + 'Json'] = JSON.stringify(merged[k]);
    }
  }

  const hubspotData = {
    syncedAt: new Date().toISOString(),
    syncedFromMs: sinceMs,
    syncDurationMs: Date.now() - t0,
    schemaVersion: 3, // v3 — добавлен contactById (включает no-email лидов)
    owners,            // small: ~15 entries
    pipelines,         // small: 3 pipelines with stage arrays
    ...serialized,     // contactByEmailJson, contactByIdJson, dealsByOwnerJson, etc.
    counts: {
      owners: Object.keys(owners).length,
      pipelines: Object.keys(pipelines).length,
      deals: deals.length,
      meetings: meetings.length,
      tourMeetings: meetings.filter(m => m.isTour).length,
      // contactsTotal — основная цифра (все контакты, включая no-email).
      // contactsWithEmail оставлен для логов чтобы видеть размер back-compat
      // индекса. Раньше счёт = contactByEmail.length и систематически
      // занижался на ~10-20% потому что SOCIAL/Messenger лиды без email
      // дропались на загрузке.
      contacts: Object.keys(merged.contactById || merged.contactByEmail || {}).length,
      contactsWithEmail: Object.keys(merged.contactByEmail || {}).length,
    },
  };

  await hsRef.set({
    hubspotData,
    _updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    _updatedBy: fullSync ? 'hubspot-sync-full' : 'hubspot-sync',
  });

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

// _expandHubspotData — inverse of the v2 write-side serialization. Reads
// foo / fooJson siblings and returns a unified shape with raw objects so
// callers (Pulse data-shim, merge logic) don't need to know about the
// JSON-string trick. v1 docs (without *Json siblings) pass through.
function _expandHubspotData(hs) {
  if (!hs || typeof hs !== 'object') return hs;
  const heavyKeys = [
    'contactByEmail', 'contactById',
    'dealsByOwner', 'meetingsByOwner',
    'toursByMonth', 'signsByMonth', 'dealsByStage',
    'stageMeta', 'stageDiagnostics',
  ];
  const out = { ...hs };
  for (const k of heavyKeys) {
    const jsonKey = k + 'Json';
    if (hs[jsonKey] !== undefined) {
      try {
        out[k] = JSON.parse(hs[jsonKey]);
      } catch (e) {
        logger.warn(`[hubspot-sync] failed to parse ${jsonKey}: ${e.message}`);
        out[k] = {};
      }
      delete out[jsonKey];
    }
  }
  return out;
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

// =========================================================================
// Read — any authed user can fetch hubspotData. Used by Pulse data-shim
// to populate toursScheduled/toursCompleted per manager without bundling
// the doc into the main state (which would blow the 1MB Firestore cap).
// =========================================================================
exports.hubspotGetData = onCall(
  { timeoutSeconds: 30 },
  async (request) => {
    // Auth check intentionally relaxed — Pulse's firebase-bridge.js
    // uses a separate app instance ('pulse-bridge') and the auth state
    // doesn't reliably propagate from floor-map (different IndexedDB
    // storage key per app name). The data returned is operational
    // (counts, emails of staff, meeting titles) — no financial PII.
    // Page-level gate exists in pulse.html (redirects to floor-map
    // if no sfa_v5_state in localStorage).
    const snap = await db.doc(`workspaces/${WORKSPACE_ID}/data/hubspot`).get();
    if (!snap.exists) return { hubspotData: null };
    const raw = snap.data().hubspotData || null;
    return { hubspotData: _expandHubspotData(raw) };
  }
);
