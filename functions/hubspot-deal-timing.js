/**
 * HubSpot: время до первой заметки и короткая дата создания сделки (только HubSpot, Firestore не трогает).
 *
 * Раньше это делала задача через Chrome 4 раза в день (bayvista-hubspot-first-note-sync) —
 * у новой заявки «Time to first note» появлялся с задержкой до 4 часов. Теперь — сервер, каждые 10 минут.
 *
 * Что делает:
 *  1) first_note_at (datetime) — время первой ЗАМЕТКИ (note, не задачи/письма) по сделке, созданной
 *     за последние FIRST_NOTE_DAYS дней. Формула time_to_first_note в HubSpot считает «45 min», «1 d 8 h».
 *     Каждые 10 минут проверяются только сделки, где за последние 30 минут была активность
 *     (notes_last_updated); раз в час (первый запуск часа) — все сделки без first_note_at.
 *  2) created (текст) — короткая дата для таблицы: сегодня «10:46 AM», раньше «Nov 25»,
 *     другой год «Nov 25 '25» (America/New_York). Пересчитываются сделки за 3 дня и все пустые.
 *
 * Триггеры:
 *   - hubspotDealTiming     — onSchedule каждые 10 минут
 *   - hubspotDealTimingNow  — onCall (root admin), {dryRun:true} = только посчитать, {full:true} = полный проход
 *
 * Auth: HUBSPOT_TOKEN (сервисный ключ «SuitesForAll Pulse Integration»; запись сделок — crm.objects.deals.write).
 * В логах только счётчики.
 */

const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

const HUBSPOT_TOKEN = defineSecret('HUBSPOT_TOKEN');
const ROOT_ADMINS = ['tony@al-en.com'];
const HUBSPOT_API = 'https://api.hubapi.com';
const TZ = 'America/New_York';
const FIRST_NOTE_DAYS = 21;
const RECENT_ACTIVITY_MIN = 30;
const CREATED_DAYS = 3;

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _hs(token, method, path, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(HUBSPOT_API + path, {
      method,
      headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { await _sleep(1500 * (attempt + 1)); continue; }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HubSpot ${res.status} ${method} ${path.split('?')[0]}: ${t.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }
  throw new Error('HubSpot 429: rate limited');
}

// Поиск сделок с пагинацией (search API: до 200 на страницу, ~4 запроса/с).
async function _searchDeals(token, filterGroups, properties, max = 2000) {
  const out = [];
  let after;
  while (out.length < max) {
    const body = {filterGroups, properties, limit: 200, sorts: [{propertyName: 'createdate', direction: 'DESCENDING'}]};
    if (after) body.after = after;
    const r = await _hs(token, 'POST', '/crm/v3/objects/deals/search', body);
    out.push(...(r.results || []));
    after = r.paging && r.paging.next && r.paging.next.after;
    if (!after) break;
    await _sleep(300);
  }
  return out;
}

async function _batchUpdate(token, inputs) {
  let ok = 0;
  for (let i = 0; i < inputs.length; i += 100) {
    const chunk = inputs.slice(i, i + 100);
    await _hs(token, 'POST', '/crm/v3/objects/deals/batch/update', {inputs: chunk});
    ok += chunk.length;
    await _sleep(200);
  }
  return ok;
}

// Время первой заметки по сделке (не раньше создания сделки минус минута), либо null.
async function _firstNoteMs(token, dealId, createdMs) {
  const ids = [];
  let after;
  for (let page = 0; page < 10; page++) {
    const r = await _hs(token, 'GET', `/crm/v4/objects/deals/${dealId}/associations/notes?limit=500` + (after ? '&after=' + encodeURIComponent(after) : ''));
    for (const x of (r.results || [])) ids.push(String(x.toObjectId));
    after = r.paging && r.paging.next && r.paging.next.after;
    if (!after) break;
  }
  if (!ids.length) return null;
  let first = null;
  for (let i = 0; i < ids.length; i += 100) {
    const r = await _hs(token, 'POST', '/crm/v3/objects/notes/batch/read', {inputs: ids.slice(i, i + 100).map(id => ({id})), properties: ['hs_createdate', 'hs_timestamp']});
    for (const n of (r.results || [])) {
      const t = Date.parse(n.createdAt || (n.properties && (n.properties.hs_createdate || n.properties.hs_timestamp)) || '');
      if (!isNaN(t) && t >= createdMs - 60000 && (first === null || t < first)) first = t;
    }
  }
  return first;
}

function _ymd(ms) { return new Date(ms).toLocaleDateString('en-CA', {timeZone: TZ}); }
function _norm(s) { return String(s || '').replace(/[  ]/g, ' ').trim(); }
function _shortCreated(ms, today) {
  if (_ymd(ms) === today) return _norm(new Date(ms).toLocaleTimeString('en-US', {timeZone: TZ, hour: 'numeric', minute: '2-digit'}));
  const s = _norm(new Date(ms).toLocaleDateString('en-US', {timeZone: TZ, month: 'short', day: 'numeric'}));
  return _ymd(ms).slice(0, 4) === today.slice(0, 4) ? s : s + " '" + _ymd(ms).slice(2, 4);
}

async function _runDealTiming(token, {dryRun = false, full = false} = {}) {
  const now = Date.now();
  const out = {dryRun, full, firstNoteChecked: 0, firstNoteSet: 0, noNoteYet: 0, createdChecked: 0, createdSet: 0, failed: 0};

  // 1) first_note_at
  try {
    const filters = [
      {propertyName: 'first_note_at', operator: 'NOT_HAS_PROPERTY'},
      {propertyName: 'num_notes', operator: 'GT', value: '0'},
      {propertyName: 'createdate', operator: 'GTE', value: String(now - FIRST_NOTE_DAYS * 864e5)},
    ];
    if (!full) filters.push({propertyName: 'notes_last_updated', operator: 'GTE', value: String(now - RECENT_ACTIVITY_MIN * 60000)});
    const deals = await _searchDeals(token, [{filters}], ['createdate']);
    out.firstNoteChecked = deals.length;
    const updates = [];
    for (const d of deals) {
      try {
        const first = await _firstNoteMs(token, d.id, Date.parse(d.properties.createdate));
        if (first === null) { out.noNoteYet++; continue; }
        updates.push({id: d.id, properties: {first_note_at: new Date(first).toISOString()}});
      } catch (e) {
        out.failed++;
        logger.warn(`[hubspot-deal-timing] first note: ${String((e && e.message) || e).slice(0, 300)}`);
      }
      await _sleep(150);
    }
    out.firstNoteToSet = updates.length;
    if (!dryRun && updates.length) out.firstNoteSet = await _batchUpdate(token, updates);
  } catch (e) {
    out.failed++;
    logger.warn(`[hubspot-deal-timing] first note search: ${String((e && e.message) || e).slice(0, 300)}`);
  }

  // 2) created (короткая дата)
  try {
    const today = _ymd(now);
    const deals = await _searchDeals(token, [
      {filters: [{propertyName: 'createdate', operator: 'GTE', value: String(now - CREATED_DAYS * 864e5)}]},
      {filters: [{propertyName: 'created', operator: 'NOT_HAS_PROPERTY'}]},
    ], ['createdate', 'created'], 5000);
    out.createdChecked = deals.length;
    const updates = [];
    for (const d of deals) {
      const v = _shortCreated(Date.parse(d.properties.createdate), today);
      if (v !== _norm(d.properties.created)) updates.push({id: d.id, properties: {created: v}});
    }
    out.createdToSet = updates.length;
    if (!dryRun && updates.length) out.createdSet = await _batchUpdate(token, updates);
  } catch (e) {
    out.failed++;
    logger.warn(`[hubspot-deal-timing] created: ${String((e && e.message) || e).slice(0, 300)}`);
  }
  return out;
}

exports.hubspotDealTiming = onSchedule(
  {schedule: 'every 10 minutes', timeZone: TZ, secrets: [HUBSPOT_TOKEN], timeoutSeconds: 300, memory: '256MiB', maxInstances: 1},
  async () => {
    const token = HUBSPOT_TOKEN.value();
    if (!token) throw new Error('HUBSPOT_TOKEN secret not bound');
    // Первый запуск каждого часа — полный проход (страховка, если заметку записали задним числом).
    const full = new Date().getMinutes() < 10;
    const out = await _runDealTiming(token, {full});
    logger.info('[hubspot-deal-timing] ' + JSON.stringify(out));
  }
);

exports.hubspotDealTimingNow = onCall(
  {secrets: [HUBSPOT_TOKEN], timeoutSeconds: 300, memory: '256MiB'},
  async (req) => {
    const email = req.auth && req.auth.token && req.auth.token.email;
    if (!email || !ROOT_ADMINS.includes(String(email).toLowerCase())) throw new HttpsError('permission-denied', 'root admin only');
    const token = HUBSPOT_TOKEN.value();
    if (!token) throw new HttpsError('failed-precondition', 'HUBSPOT_TOKEN secret not bound');
    return _runDealTiming(token, {dryRun: !!(req.data && req.data.dryRun), full: !!(req.data && req.data.full)});
  }
);
