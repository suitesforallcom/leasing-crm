/**
 * Unit mail — привязка тредов к юнитам (UNIT_EMAIL_PLAN.md § 4.4).
 *
 *   auto   — по ТОЧНОМУ адресу участника треда (никогда по домену): u.email,
 *            u.emailCc, u.tenantEmail (legacy), u.prospects[].email,
 *            u.tenantHistory[].email (via:'history', бейдж «former tenant»);
 *   manual — mailLinkThread({action:'link'}) оператором (via:'manual');
 *   reject — «Not this unit»: ключ в rejected[], ночной/ручной пересчёт его не вернёт;
 *   via thread — все письма треда наследуют unitKeys треда (денормализация в mailMessages).
 *
 * Индекс адресов строится strip-aware (Entry 45): под syncBuildingsStrip здания
 * читаются из коллекции workspaces/default/buildings (v2), иначе из монолита.
 * unitKey = buildingId__unitId (Entry 88). Руками состояние юнита не трогаем.
 */
'use strict';

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const shared = require('./mail-shared');
const access = require('./mail-access');

const INDEX_TTL_MS = 60 * 1000;
const FIELD_RANK = { email: 0, emailCc: 1, prospect: 2, tenantHistory: 3 };
const MAX_LINKS_PER_THREAD = 20;
let _indexCache = { data: null, at: 0 };

// ----------------------------------------------------------- buildings ---

async function loadBuildings() {
  const db = shared.db();
  const stateSnap = await db.doc(shared.col('data/state')).get();
  const raw = stateSnap.exists ? (stateSnap.data() || {}) : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : raw;
  const stripOn = !!(state.settings && state.settings.syncBuildingsStrip);
  const mono = Array.isArray(state.buildings) ? state.buildings : [];
  if (!stripOn && mono.length) return mono;
  const colSnap = await db.collection(shared.col('buildings')).get();
  const out = [];
  colSnap.forEach((d) => { const x = d.data(); if (x && x._schema === 'v2' && x.doc) out.push(x.doc); });
  return out.length ? out : mono;
}

/**
 * Чистая функция: здания → индекс адресов.
 * @returns {{byEmail: Map<string, Array<object>>, units: number, addresses: number}}
 */
function buildUnitsIndex(buildings) {
  const byEmail = new Map();
  let units = 0;
  const add = (email, entry) => {
    const e = shared.normalizeEmail(email);
    if (!shared.isValidEmail(e)) return;
    const arr = byEmail.get(e) || [];
    if (arr.some((x) => x.unitKey === entry.unitKey && x.field === entry.field)) return;
    arr.push(Object.assign({ value: e }, entry));
    byEmail.set(e, arr);
  };
  for (const b of (Array.isArray(buildings) ? buildings : [])) {
    if (!b || !b.id || b.archivedAt) continue;
    for (const f of (b.floors || [])) {
      if (!f) continue;
      for (const u of (f.units || [])) {
        if (!u || u.id == null || u.deletedAt) continue;
        units++;
        const base = { unitKey: shared.unitKeyOf(b.id, u.id), buildingId: String(b.id), unitId: String(u.id), floorId: f.id != null ? String(f.id) : '', label: String(u.tenant || u.company || '').slice(0, 120) };
        if (u.email) add(u.email, Object.assign({ field: 'email' }, base));
        if (u.tenantEmail) add(u.tenantEmail, Object.assign({ field: 'email' }, base));
        if (u.emailCc) add(u.emailCc, Object.assign({ field: 'emailCc' }, base));
        for (const p of (Array.isArray(u.prospects) ? u.prospects : [])) {
          if (p && p.email) add(p.email, Object.assign({ field: 'prospect' }, base, { label: String(p.name || p.company || '').slice(0, 120) }));
        }
        for (const h of (Array.isArray(u.tenantHistory) ? u.tenantHistory : [])) {
          if (h && h.email) add(h.email, Object.assign({ field: 'tenantHistory' }, base, { label: String(h.tenant || h.company || '').slice(0, 120) }));
        }
      }
    }
  }
  return { byEmail, units, addresses: byEmail.size };
}

async function loadUnitsIndex(opts) {
  const fresh = !!(opts && opts.fresh);
  if (!fresh && _indexCache.data && Date.now() - _indexCache.at < INDEX_TTL_MS) return _indexCache.data;
  const buildings = await loadBuildings();
  const idx = buildUnitsIndex(buildings);
  _indexCache = { data: idx, at: Date.now() };
  return idx;
}

// --------------------------------------------------------------- links ---

/** Авто-ссылки по участникам (чистая функция). */
function computeAutoLinks(participants, index) {
  const out = [];
  const seen = new Map(); // unitKey → rank
  for (const raw of (participants || [])) {
    const email = shared.normalizeEmail(raw);
    const entries = index && index.byEmail ? index.byEmail.get(email) : null;
    if (!entries) continue;
    for (const e of entries) {
      const rank = FIELD_RANK[e.field] != null ? FIELD_RANK[e.field] : 9;
      const prev = seen.get(e.unitKey);
      if (prev != null && prev <= rank) continue;
      seen.set(e.unitKey, rank);
      const existingIdx = out.findIndex((x) => x.unitKey === e.unitKey);
      const linkRow = { unitKey: e.unitKey, buildingId: e.buildingId, unitId: e.unitId, floorId: e.floorId, via: e.field === 'tenantHistory' ? 'history' : 'address', field: e.field, value: e.value, label: e.label || '' };
      if (existingIdx >= 0) out[existingIdx] = linkRow; else out.push(linkRow);
    }
  }
  return out.slice(0, MAX_LINKS_PER_THREAD);
}

/**
 * Слить ручные ссылки/отказы существующего треда с авто-ссылками (чистая функция).
 * @returns {{links:Array, rejected:Array, unitKeys:string[], buildingIds:string[], linked:boolean}}
 */
function mergeLinks(existing, autoLinks) {
  const ex = existing && typeof existing === 'object' ? existing : {};
  const rejected = (Array.isArray(ex.rejected) ? ex.rejected : []).filter((r) => r && r.unitKey);
  const rejectedKeys = new Set(rejected.map((r) => r.unitKey));
  const manual = (Array.isArray(ex.links) ? ex.links : []).filter((l) => l && l.via === 'manual' && l.unitKey && !rejectedKeys.has(l.unitKey));
  const manualKeys = new Set(manual.map((l) => l.unitKey));
  const auto = (autoLinks || []).filter((l) => l && l.unitKey && !rejectedKeys.has(l.unitKey) && !manualKeys.has(l.unitKey));
  const links = manual.concat(auto).slice(0, MAX_LINKS_PER_THREAD);
  const unitKeys = Array.from(new Set(links.map((l) => l.unitKey)));
  const buildingIds = Array.from(new Set(links.map((l) => String(l.buildingId)).filter(Boolean)));
  return { links, rejected, unitKeys, buildingIds, linked: unitKeys.length > 0 };
}

function sameKeys(a, b) {
  const x = Array.isArray(a) ? a.slice().sort() : [];
  const y = Array.isArray(b) ? b.slice().sort() : [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// Денормализация unitKeys/buildingIds на письма треда («via thread»).
async function syncKeysToMessages(mailboxId, gmailThreadId, unitKeys, buildingIds) {
  const db = shared.db();
  const snap = await db.collection(shared.col('mailMessages'))
    .where('mailboxId', '==', mailboxId)
    .where('gmailThreadId', '==', gmailThreadId)
    .get();
  const docs = (snap.docs || []).filter((d) => { const x = d.data() || {}; return !sameKeys(x.unitKeys, unitKeys) || !sameKeys(x.buildingIds, buildingIds); });
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + 400)) batch.update(d.ref, { unitKeys, buildingIds });
    await batch.commit();
  }
  return docs.length;
}

/**
 * Пересчитать ссылки треда по индексу и записать, если изменились.
 * Возвращает merged + changed. Используется sync'ом и relink'ом.
 */
async function relinkThreadDoc(threadRef, threadData, index) {
  const auto = computeAutoLinks(threadData.participants || [], index);
  const merged = mergeLinks(threadData, auto);
  const changed = !sameKeys(merged.unitKeys, threadData.unitKeys) || !sameKeys(merged.buildingIds, threadData.buildingIds)
    || JSON.stringify(merged.links) !== JSON.stringify(threadData.links || []);
  if (changed) {
    await threadRef.set({ links: merged.links, rejected: merged.rejected, unitKeys: merged.unitKeys, buildingIds: merged.buildingIds, linked: merged.linked, updatedAt: shared.serverTs() }, { merge: true });
    await syncKeysToMessages(threadData.mailboxId, threadData.gmailThreadId, merged.unitKeys, merged.buildingIds);
  }
  return Object.assign({ changed }, merged);
}

// ----------------------------------------------------------- callables ---

const ACTIONS = ['link', 'unlink', 'reject', 'unreject'];

/**
 * mailLinkThread({threadDocId, unitKey, action, reason?})
 *   link     — ручная привязка (via:'manual'); снимает reject для этого ключа
 *   unlink   — снять ручную ссылку; если осталась авто-ссылка — reject
 *   reject   — «Not this unit»
 *   unreject — вернуть ключ (пересчёт по индексу)
 */
exports.mailLinkThread = onCall({ memory: '512MiB', timeoutSeconds: 60 }, async (req) => {
  const a = access.assertMailReader(await access.accessFor(req.auth));
  const d = req.data || {};
  const threadDocId = String(d.threadDocId || '').slice(0, 200);
  const action = String(d.action || '');
  const parsed = shared.parseUnitKey(d.unitKey);
  if (!threadDocId || !parsed || !ACTIONS.includes(action)) throw new HttpsError('invalid-argument', 'threadDocId, unitKey and action are required');
  access.assertCanReadBuilding(a, parsed.buildingId);

  const db = shared.db();
  const ref = db.doc(shared.col(`mailThreads/${threadDocId}`));
  const snap = await ref.get();
  if (!snap.exists) throw access.denied();
  const thread = snap.data() || {};
  if (!a.canReadThread(thread) && !(action === 'link' && (a.seeUnlinked || a.isAdmin))) throw access.denied();

  const index = await loadUnitsIndex();
  const unitKey = shared.unitKeyOf(parsed.buildingId, parsed.unitId);
  const floorId = (() => {
    for (const arr of index.byEmail.values()) for (const e of arr) if (e.unitKey === unitKey) return e.floorId;
    return '';
  })();
  const now = shared.nowIso();
  const links = (Array.isArray(thread.links) ? thread.links : []).filter((l) => l && l.unitKey);
  let rejected = (Array.isArray(thread.rejected) ? thread.rejected : []).filter((r) => r && r.unitKey);
  let next = { links, rejected };

  if (action === 'link') {
    rejected = rejected.filter((r) => r.unitKey !== unitKey);
    const withoutManual = links.filter((l) => !(l.via === 'manual' && l.unitKey === unitKey));
    withoutManual.unshift({ unitKey, buildingId: parsed.buildingId, unitId: parsed.unitId, floorId, via: 'manual', field: 'manual', value: '', label: '', by: a.email, byUid: a.uid, at: now });
    next = { links: withoutManual, rejected };
  } else if (action === 'unlink' || action === 'reject') {
    const withoutManual = links.filter((l) => !(l.via === 'manual' && l.unitKey === unitKey));
    const hasAuto = withoutManual.some((l) => l.unitKey === unitKey) || computeAutoLinks(thread.participants || [], index).some((l) => l.unitKey === unitKey);
    if (action === 'reject' || hasAuto) {
      if (!rejected.some((r) => r.unitKey === unitKey)) rejected = rejected.concat([{ unitKey, by: a.email, byUid: a.uid, at: now, reason: String(d.reason || '').slice(0, 200) }]);
    }
    next = { links: withoutManual, rejected };
  } else if (action === 'unreject') {
    next = { links, rejected: rejected.filter((r) => r.unitKey !== unitKey) };
  }

  const merged = mergeLinks(Object.assign({}, thread, next), computeAutoLinks(thread.participants || [], index));
  await ref.set({ links: merged.links, rejected: merged.rejected, unitKeys: merged.unitKeys, buildingIds: merged.buildingIds, linked: merged.linked, updatedAt: shared.serverTs() }, { merge: true });
  await syncKeysToMessages(thread.mailboxId, thread.gmailThreadId, merged.unitKeys, merged.buildingIds);
  await shared.writeAudit({
    actor: a.email, actorUid: a.uid, action: 'mail.' + action,
    unitId: parsed.unitId, buildingId: parsed.buildingId, floorId,
    mailThreadId: threadDocId, traceId: d._traceId,
    note: `${action} ${unitKey} — ${String(thread.subject || '(no subject)').slice(0, 120)}`,
  });
  return { ok: true, unitKeys: merged.unitKeys, buildingIds: merged.buildingIds, links: merged.links, rejected: merged.rejected };
});

/**
 * mailRelinkUnit({unitKey}) — пересчёт авто-ссылок для одного юнита:
 * находит все треды с адресами этого юнита и пересобирает ссылки по индексу.
 */
exports.mailRelinkUnit = onCall({ memory: '512MiB', timeoutSeconds: 120 }, async (req) => {
  const a = access.assertMailReader(await access.accessFor(req.auth));
  const d = req.data || {};
  const parsed = shared.parseUnitKey(d.unitKey);
  if (!parsed) throw new HttpsError('invalid-argument', 'unitKey is required');
  access.assertCanReadBuilding(a, parsed.buildingId);
  const result = await relinkUnit(shared.unitKeyOf(parsed.buildingId, parsed.unitId));
  await shared.writeAudit({ actor: a.email, actorUid: a.uid, action: 'mail.relink', unitId: parsed.unitId, buildingId: parsed.buildingId, traceId: d._traceId, note: `relink ${result.addresses} addr → ${result.threadsChecked} threads, ${result.threadsUpdated} updated` });
  return result;
});

async function relinkUnit(unitKey) {
  const index = await loadUnitsIndex({ fresh: true });
  const addresses = [];
  for (const [email, arr] of index.byEmail.entries()) if (arr.some((e) => e.unitKey === unitKey)) addresses.push(email);
  const db = shared.db();
  const seen = new Set();
  let threadsChecked = 0;
  let threadsUpdated = 0;
  for (let i = 0; i < addresses.length; i += 10) {
    const chunk = addresses.slice(i, i + 10);
    const snap = await db.collection(shared.col('mailThreads')).where('participants', 'array-contains-any', chunk).get();
    for (const docSnap of (snap.docs || [])) {
      if (seen.has(docSnap.id)) continue;
      seen.add(docSnap.id);
      threadsChecked++;
      const r = await relinkThreadDoc(docSnap.ref, docSnap.data() || {}, index);
      if (r.changed) threadsUpdated++;
    }
  }
  // Треды, уже привязанные к юниту вручную/ранее, но чьи адреса из индекса ушли — тоже пересчитать.
  const linkedSnap = await db.collection(shared.col('mailThreads')).where('unitKeys', 'array-contains', unitKey).get();
  for (const docSnap of (linkedSnap.docs || [])) {
    if (seen.has(docSnap.id)) continue;
    seen.add(docSnap.id);
    threadsChecked++;
    const r = await relinkThreadDoc(docSnap.ref, docSnap.data() || {}, index);
    if (r.changed) threadsUpdated++;
  }
  logger.info('[mail-link] relink', { unitKey, addresses: addresses.length, threadsChecked, threadsUpdated });
  return { ok: true, unitKey, addresses: addresses.length, threadsChecked, threadsUpdated };
}

module.exports.loadBuildings = loadBuildings;
module.exports.buildUnitsIndex = buildUnitsIndex;
module.exports.loadUnitsIndex = loadUnitsIndex;
module.exports.computeAutoLinks = computeAutoLinks;
module.exports.mergeLinks = mergeLinks;
module.exports.relinkThreadDoc = relinkThreadDoc;
module.exports.relinkUnit = relinkUnit;
module.exports.syncKeysToMessages = syncKeysToMessages;
module.exports._resetCachesForTests = () => { _indexCache = { data: null, at: 0 }; };
