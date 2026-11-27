/**
 * FPM → HubSpot: подписанные договоры и оплаты (Phase: lease-status sync).
 *
 * Что делает: раз в час читает здания и платежи из Firestore (ТОЛЬКО ЧТЕНИЕ —
 * ничего в workspace не пишет) и для договоров, подписанных или впервые
 * оплаченных за последние LOOKBACK_DAYS дней, находит в HubSpot контакт
 * арендатора (по почте или телефону) и его сделку в Buyers pipeline,
 * созданную ДО подписания (самую позднюю). У сделки ставит:
 *   - dealstage  = Contract signed (1852043966, closed won)
 *   - closedate  = дата подписания (u.signed)
 *   - payment_received = дата первой оплаты (rec.status === 'paid', не раньше signed − 15 дней)
 * Сделки, созданные после подписания, не трогает. Повторный запуск идемпотентен:
 * уже проставленные значения не перезаписываются.
 *
 * Триггеры:
 *   - fpmHubspotLeaseSync     — onSchedule каждый час
 *   - fpmHubspotLeaseSyncNow  — onCall (root admin), {dryRun:true} = только посчитать
 *
 * Контакт ищется локально: функция один раз за запуск читает все контакты HubSpot
 * (email, phone, mobilephone, hs_whatsapp_phone_number) и сравнивает почту и последние
 * 10 цифр телефона. Почта/телефон арендатора никуда не отправляются и никогда не пишутся
 * в логи — в логах только счётчики.
 *
 * Auth: HUBSPOT_TOKEN (тот же секрет, что у hubspot-sync.js). Для записи нужен
 * scope crm.objects.deals.write у сервисного ключа HubSpot.
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
const LOOKBACK_DAYS = 90;
const BUYERS_PIPELINE = 'default';
const STAGE_CONTRACT_SIGNED = '1852043966';

const db = admin.firestore();

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Нормализация даты: 'YYYY-MM-DD…' как есть, иначе Date.parse (бывает «Mar 17, 2026»).
function _isoDate(s) {
  if (!s) return '';
  s = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}
function _email(e) { return String(e || '').trim().toLowerCase(); }
function _phone10(p) { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }
function _minusDays(iso, n) { return new Date(new Date(iso + 'T12:00:00Z').getTime() - n * 864e5).toISOString().slice(0, 10); }

// Первая оплата по договору: самая ранняя paid-запись не раньше signed − 15 дней.
function _firstPaid(payments, signed) {
  if (!payments || typeof payments !== 'object') return '';
  const min = _minusDays(signed, 15);
  let best = '';
  for (const k of Object.keys(payments)) {
    const v = payments[k];
    if (!v || v.status !== 'paid') continue;
    const d = _isoDate(v.bankPaidAt || v.date || v.recordedAt);
    if (d && d >= min && (!best || d < best)) best = d;
  }
  return best;
}

// Здания: под strip — коллекция workspaces/{ws}/buildings (_schema v2: здание лежит в поле `doc`),
// иначе монолит state (здания в state.state.buildings).
async function _loadBuildings() {
  const snap = await db.collection(`workspaces/${WORKSPACE_ID}/buildings`).get();
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    const b = (x.doc && typeof x.doc === 'object') ? x.doc : x;
    if (b && Array.isArray(b.floors)) list.push(Object.assign({}, b, {id: x.buildingId || b.id || d.id}));
  });
  if (list.length) return list;
  const st = await db.doc(`workspaces/${WORKSPACE_ID}/data/state`).get();
  const data = st.exists ? st.data() : null;
  const s = data && data.state && typeof data.state === 'object' ? data.state : data;
  return (s && Array.isArray(s.buildings)) ? s.buildings : [];
}

// Платежи текущих арендаторов: коллекция payments (_schema v2) → { 'bid|uid': {ym: rec} }.
async function _loadPaymentsByUnit() {
  const snap = await db.collection(`workspaces/${WORKSPACE_ID}/payments`).get();
  const byUnit = {};
  snap.forEach(d => {
    const x = d.data();
    if (!x || x._schema !== 'v2' || !x.unitId || !x.ym) return;
    const k = (x.buildingId || '') + '|' + x.unitId;
    (byUnit[k] = byUnit[k] || {})[x.ym] = x.rec || {};
  });
  return byUnit;
}

// Договоры из FPM: текущие арендаторы + история (tenantHistory).
async function _collectLeases() {
  const [buildings, payByUnit] = await Promise.all([_loadBuildings(), _loadPaymentsByUnit()]);
  const cutoff = _minusDays(new Date().toISOString().slice(0, 10), LOOKBACK_DAYS);
  const leases = [];
  const push = (o, payments) => {
    const signed = _isoDate(o.signed);
    if (!signed) return;
    const email = _email(o.email), phone = _phone10(o.tel);
    if (!email && !phone) return;
    const paid = _firstPaid(payments, signed);
    if (signed < cutoff && (!paid || paid < cutoff)) return;
    leases.push({email, phone, signed, paid});
  };
  for (const b of buildings) {
    for (const f of (b.floors || [])) {
      for (const u of (f.units || [])) {
        if (u.tenant) {
          const fromCol = payByUnit[(b.id || '') + '|' + u.id];
          push(u, fromCol || u.payments);
        }
        for (const h of (u.tenantHistory || [])) push(h, h.payments);
      }
    }
  }
  // Общая почта (одна почта у >2 разных телефонов) — по ней не сопоставляем.
  const phonesByEmail = {};
  for (const l of leases) if (l.email) (phonesByEmail[l.email] = phonesByEmail[l.email] || new Set()).add(l.phone || Math.random());
  for (const l of leases) if (l.email && phonesByEmail[l.email].size > 2) l.email = '';
  // Дубли и порядок: раньше подписанные первыми (каждая сделка — первому договору после неё).
  const seen = new Set();
  return leases
    .filter(l => (l.email || l.phone) && !seen.has(l.email + l.phone + l.signed + l.paid) && seen.add(l.email + l.phone + l.signed + l.paid))
    .sort((a, b) => (a.signed < b.signed ? -1 : 1));
}

async function _hs(token, method, path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(HUBSPOT_API + path, {
      method,
      headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { await _sleep(1500 * (attempt + 1)); continue; }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HubSpot ${res.status}: ${t.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }
  throw new Error('HubSpot 429: rate limited');
}

// Все контакты HubSpot один раз за запуск → индексы по почте и по телефону (последние 10 цифр
// из phone / mobilephone / hs_whatsapp_phone_number). Поиск HubSpot по телефону ненадёжен
// (hs_searchable_calculated_* заполнено не у всех), поэтому сравниваем у себя, как браузерный скрипт.
async function _loadContactIndex(token) {
  const byEmail = new Map(), byPhone = new Map();
  const add = (m, k, id) => { if (!k) return; const a = m.get(k) || []; if (!a.includes(id)) a.push(id); m.set(k, a); };
  let after = '';
  for (let page = 0; page < 1000; page++) {
    const q = '/crm/v3/objects/contacts?limit=100&archived=false&properties=email,phone,mobilephone,hs_whatsapp_phone_number' + (after ? '&after=' + encodeURIComponent(after) : '');
    const r = await _hs(token, 'GET', q);
    for (const x of (r.results || [])) {
      const p = x.properties || {};
      add(byEmail, _email(p.email), x.id);
      for (const k of ['phone', 'mobilephone', 'hs_whatsapp_phone_number']) add(byPhone, _phone10(p[k]), x.id);
    }
    after = r.paging && r.paging.next && r.paging.next.after;
    if (!after) break;
  }
  return {byEmail, byPhone};
}

function _findContactIds(idx, l) {
  const ids = new Set([...(l.email && idx.byEmail.get(l.email) || []), ...(l.phone && idx.byPhone.get(l.phone) || [])]);
  return [...ids];
}

async function _findDeals(token, contactId) {
  const r = await _hs(token, 'POST', '/crm/v3/objects/deals/search', {
    filterGroups: [{filters: [
      {propertyName: 'associations.contact', operator: 'EQ', value: String(contactId)},
      {propertyName: 'pipeline', operator: 'EQ', value: BUYERS_PIPELINE},
    ]}],
    properties: ['dealstage', 'createdate', 'payment_received'],
    limit: 50,
  });
  return (r.results || []).map(x => ({
    id: x.id,
    stage: x.properties.dealstage,
    created: Date.parse(x.properties.createdate),
    paid: x.properties.payment_received || '',
  }));
}

async function _runLeaseSync(token, {dryRun = false} = {}) {
  const leases = await _collectLeases();
  const idx = await _loadContactIndex(token);
  const used = new Set();
  const out = {leases: leases.length, contactsIndexed: idx.byEmail.size + idx.byPhone.size, toUpdate: 0, updated: 0, alreadyUpToDate: 0, noContact: 0, noDealBeforeSigning: 0, failed: 0, dryRun};
  for (const l of leases) {
    try {
      const cids = _findContactIds(idx, l);
      if (!cids.length) { out.noContact++; continue; }
      const byId = new Map();
      for (const cid of cids) { for (const d of await _findDeals(token, cid)) byId.set(d.id, d); await _sleep(120); }
      const signedMs = Date.parse(l.signed + 'T12:00:00Z');
      const cand = [...byId.values()].filter(d => d.created <= signedMs + 3 * 864e5 && !used.has(d.id)).sort((a, b) => b.created - a.created);
      if (!cand.length) { out.noDealBeforeSigning++; continue; }
      const d = cand[0];
      used.add(d.id);
      const props = {};
      if (d.stage !== STAGE_CONTRACT_SIGNED) { props.dealstage = STAGE_CONTRACT_SIGNED; props.closedate = l.signed + 'T17:00:00.000Z'; }
      if (l.paid && !d.paid) props.payment_received = l.paid;
      if (!Object.keys(props).length) { out.alreadyUpToDate++; continue; }
      out.toUpdate++;
      if (dryRun) continue;
      await _hs(token, 'PATCH', `/crm/v3/objects/deals/${d.id}`, {properties: props});
      out.updated++;
      await _sleep(120);
    } catch (e) {
      out.failed++;
      logger.warn(`[fpm-hubspot-lease-sync] ${String((e && e.message) || e).slice(0, 200)}`);
    }
  }
  return out;
}

exports.fpmHubspotLeaseSync = onSchedule(
  {schedule: 'every 60 minutes', timeZone: 'America/New_York', secrets: [HUBSPOT_TOKEN], timeoutSeconds: 540, memory: '512MiB'},
  async () => {
    const token = HUBSPOT_TOKEN.value();
    if (!token) throw new Error('HUBSPOT_TOKEN secret not bound');
    const out = await _runLeaseSync(token);
    logger.info('[fpm-hubspot-lease-sync] ' + JSON.stringify(out));
  }
);

exports.fpmHubspotLeaseSyncNow = onCall(
  {secrets: [HUBSPOT_TOKEN], timeoutSeconds: 540, memory: '512MiB'},
  async (req) => {
    const email = req.auth && req.auth.token && req.auth.token.email;
    if (!email || !ROOT_ADMINS.includes(String(email).toLowerCase())) throw new HttpsError('permission-denied', 'root admin only');
    const token = HUBSPOT_TOKEN.value();
    if (!token) throw new HttpsError('failed-precondition', 'HUBSPOT_TOKEN secret not bound');
    return _runLeaseSync(token, {dryRun: !!(req.data && req.data.dryRun)});
  }
);
