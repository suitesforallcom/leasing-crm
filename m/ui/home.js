/* m/ui/home.js — экран Home: «что сделать», а не сводка.
   Контракт: render(ctx) -> HTML-строка, handle(act, el, ctx) -> true|false.
   Данные берём ТОЛЬКО из ctx (ctx.snap / ctx.money / ctx.fmt / ctx.S).
   Единственное исключение — два ключа localStorage, которые по ТЗ живут
   на устройстве: 'sfa_m_lastvisit' (база сравнения «с прошлого захода»)
   и 'sfa_m_recent' (недавно открытые юниты). Firebase здесь не трогаем. */

const LS_VISIT = 'sfa_m_lastvisit';
const LS_RECENT = 'sfa_m_recent';
const RECENT_SHOWN = 3;
const RECENT_MAX = 12;

/* Короткий перезаход (перезагрузка страницы) не должен съесть базу
   сравнения: новый штамп пишем только если сессия живёт дольше грейса. */
const STAMP_GRACE_MS = 45000;
const STAMP_EVERY_MS = 30000;

const I = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 3 2 20h20L12 3z"/><line x1="12" y1="9" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/></svg>',
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/></svg>',
  caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
};

/* CSS знает ровно эти семь состояний (.astat[data-s=…]). Всё остальное,
   что может вернуть money.verdict, нормализуем — иначе плашка останется
   без фона и вердикт перестанет читаться. */
const STATUS_ICON = {
  paid: I.check, invoiced: I.mail, due: I.clock, overdue: I.alert,
  idle: I.dash, vacant: I.dash, reserved: I.doc,
};
const STATUS_ALIAS = {
  free: 'paid', waived: 'paid', 'stripe-paid': 'paid', settled: 'paid',
  past_due: 'overdue', late: 'overdue',
  open: 'invoiced', sent: 'invoiced', pending: 'invoiced', unpaid: 'invoiced',
  none: 'idle', not_billed: 'idle', notbilled: 'idle', empty: 'vacant',
};
const SOURCE_LABEL = {
  stripe: 'Stripe invoice', 'stripe-paid': 'Stripe invoice', invoice: 'Stripe invoice',
  manual: 'Manual entry', local: 'Manual entry', ledger: 'Manual entry',
  operator: 'Manual entry', free: 'Waived', waiver: 'Waived', waived: 'Waived',
};

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = n => (Number.isFinite(+n) ? +n : 0);

function todayYm() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
const ymOf = ctx => (/^\d{4}-\d{2}$/.test(ctx && ctx.S && ctx.S.ym) ? ctx.S.ym : todayYm());

function monthName(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return '';
  return new Date(+m[1], +m[2] - 1, 1).toLocaleString('en-US', { month: 'long' });
}

const floorsOf = b => (Array.isArray(b && b.floors) ? b.floors
  : (b && b.doc && Array.isArray(b.doc.floors) ? b.doc.floors : []));

/* Деньги по юниту — правило десктопа: contractRent (что платит ЭТОТ
   арендатор) выигрывает у rent (проформа). Никогда не суммируем rent. */
const effRent = u => (+((u && u.contractRent) || 0) || +((u && u.rent) || 0) || 0);

/* ---------------- scope ---------------- */

/* Источник правды по scope — S.scope (его пишет switcher). S.buildingId
   читаем как запасной вариант: payments опирается на него, и Home не
   должен показывать «All buildings», пока сосед уже в конкретном здании. */
function resolveScope(ctx) {
  const S = ctx.S || {};
  const list = Array.isArray(ctx.snap && ctx.snap.buildings) ? ctx.snap.buildings.filter(Boolean) : [];
  const key = String(S.scope || S.buildingId || 'all');
  if (key !== 'all') {
    const b = list.find(x => String(x.id) === key);
    // Здание пропало из выборки (сменилась роль / удалено) — честно
    // показываем портфель целиком, а не пустой экран.
    if (b) return { key, building: b, buildings: [b], name: b.name || b.id };
  }
  return { key: 'all', building: null, buildings: list, name: 'All buildings' };
}

/* ---------------- stats ---------------- */

function normStats(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const src = (s.n && typeof s.n === 'object') ? s.n : (s.counts && typeof s.counts === 'object' ? s.counts : {});
  const n = {
    paid: num(src.paid), invoiced: num(src.invoiced), due: num(src.due), overdue: num(src.overdue),
    idle: num(src.idle), vacant: num(src.vacant), reserved: num(src.reserved),
  };
  const out = {
    collected: num(s.collected), awaiting: num(s.awaiting != null ? s.awaiting : s.pending),
    overdue: num(s.overdue), n, units: num(s.units != null ? s.units : s.total),
  };
  out.billed = num(s.billed) > 0 ? num(s.billed) : (out.collected + out.awaiting + out.overdue);
  out.pct = Number.isFinite(+s.pct)
    ? Math.max(0, Math.min(100, Math.round(+s.pct)))
    : (out.billed > 0 ? Math.round(out.collected / out.billed * 100) : 0);
  if (!out.units) out.units = Object.keys(n).reduce((a, k) => a + n[k], 0);
  return out;
}

function statsFor(ctx, buildings, ym) {
  const acc = normStats(null);
  for (const b of buildings) {
    let raw = null;
    try { raw = ctx.money.buildingStats(b, ym, ctx.snap); } catch (err) { raw = null; }
    const s = normStats(raw);
    acc.collected += s.collected; acc.awaiting += s.awaiting; acc.overdue += s.overdue;
    acc.units += s.units;
    for (const k of Object.keys(acc.n)) acc.n[k] += s.n[k];
  }
  acc.billed = acc.collected + acc.awaiting + acc.overdue;
  acc.pct = acc.billed > 0 ? Math.round(acc.collected / acc.billed * 100) : 0;
  return acc;
}

/* ---------------- localStorage ---------------- */

function readJSON(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
  catch (err) { return null; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* приватный режим / квота */ }
}

const _sessionStart = Date.now();
let _baseline, _baselineRead = false, _lastStamp = 0;

/* Базу сравнения читаем ОДИН раз за сессию: иначе первый же штамп текущего
   визита обнулил бы блок «с прошлого захода» прямо на глазах у оператора. */
function baseline() {
  if (!_baselineRead) { _baseline = readJSON(LS_VISIT); _baselineRead = true; }
  return _baseline;
}

function stampVisit(scopeKey, ym, st, hasData) {
  if (!hasData) return;                       // холодный пустой снимок штамповать нельзя
  const now = Date.now();
  const base = baseline();
  const known = !!(base && base.scopes && base.scopes[scopeKey]);
  if (known && now - _sessionStart < STAMP_GRACE_MS) return;
  if (now - _lastStamp < STAMP_EVERY_MS) return;
  _lastStamp = now;
  const rec = readJSON(LS_VISIT) || {};
  const scopes = (rec.scopes && typeof rec.scopes === 'object') ? Object.assign({}, rec.scopes) : {};
  scopes[scopeKey] = {
    at: now, ym, collected: Math.round(st.collected),
    overdue: Math.round(st.overdue), overdueCount: st.n.overdue,
  };
  writeJSON(LS_VISIT, { v: 1, at: now, ym, scopes });
}

function readRecent() {
  const raw = readJSON(LS_RECENT);
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const it of raw) {
    let bid = '', uid = '';
    if (typeof it === 'string') { const p = it.split('__'); bid = p[0] || ''; uid = p[1] || ''; }
    else if (it && typeof it === 'object') {
      bid = String(it.buildingId || it.bid || it.b || '');
      uid = String(it.unitId || it.uid || it.u || '');
    }
    if (!uid) continue;
    if (out.some(x => x.buildingId === bid && x.unitId === uid)) continue;
    out.push({ buildingId: bid, unitId: uid });
    if (out.length >= RECENT_MAX) break;
  }
  return out;
}

/** Запомнить открытый юнит. Экспортируется, чтобы payments/unit могли
    писать в тот же список (у Home нет монополии на открытие юнита). */
export function rememberRecent(buildingId, unitId) {
  const uid = String(unitId || '');
  if (!uid) return;
  const bid = String(buildingId || '');
  const list = readRecent().filter(x => !(x.buildingId === bid && x.unitId === uid));
  list.unshift({ buildingId: bid, unitId: uid });
  writeJSON(LS_RECENT, list.slice(0, RECENT_MAX));
}

/* ---------------- unit lookup ---------------- */

function fromIndex(snap, bid, uid) {
  const ix = snap && snap.unitsIndex;
  if (!ix) return null;
  for (const k of [bid + '__' + uid, bid + '|' + uid, uid]) {
    let hit = null;
    try { hit = (typeof ix.get === 'function') ? ix.get(k) : ix[k]; } catch (err) { hit = null; }
    if (hit) return hit;
  }
  return null;
}

/** -> { unit, building, floor } | null. Ищем сначала в индексе, потом
    обходом. Ключ ВСЕГДА building+unit: номера сьютов повторяются между
    зданиями — это была первопричина утечки платежей между корпусами. */
function lookupUnit(snap, bid, uid) {
  const list = Array.isArray(snap && snap.buildings) ? snap.buildings : [];
  const raw = fromIndex(snap, bid, uid);
  const unit = raw && (raw.unit || (raw.id != null ? raw : null));
  if (unit) {
    const building = (raw.building
      || list.find(b => b && String(b.id) === String(raw.buildingId || bid))) || null;
    // Из индекса берём только если здание совпало: сьют 431 есть в
    // нескольких корпусах, и чужой юнит здесь = чужие деньги на экране.
    if (!bid || !building || String(building.id) === String(bid)) {
      return { unit, building, floor: raw.floor || null };
    }
  }
  for (const b of list) {
    if (bid && String(b && b.id) !== String(bid)) continue;
    for (const f of floorsOf(b)) {
      const units = Array.isArray(f && f.units) ? f.units : [];
      const u = units.find(x => x && String(x.id) === String(uid));
      if (u) return { unit: u, building: b, floor: f };
    }
  }
  return null;
}

/* ---------------- answer row ---------------- */

function safeVerdict(ctx, unit, ym) {
  try {
    const v = ctx.money.verdict(unit, ym, ctx.snap);
    if (v && typeof v === 'object') return v;
  } catch (err) { /* один битый юнит не должен уронить экран */ }
  return { status: 'idle', label: 'Unknown', detail: 'No data yet', source: '' };
}

const normStatus = s => {
  const k = String(s || '').toLowerCase();
  const a = STATUS_ALIAS[k] || k;
  return STATUS_ICON[a] ? a : 'idle';
};

function sourceLabel(src) {
  const k = String(src == null ? '' : src).trim();
  if (!k) return '';
  return SOURCE_LABEL[k.toLowerCase()] || (k.charAt(0).toUpperCase() + k.slice(1));
}

function floorLabel(hit) {
  const f = hit.floor;
  if (!f) return '';
  const name = f.name || f.label || f.id;
  if (name == null || name === '') return '';
  return /^\d+$/.test(String(name)) ? 'Floor ' + name : String(name);
}

/* Та же разметка, что у строк ответа в Payments (.arow/.astat/.averdict).
   Провенанс (Stripe / вручную) обязателен для оплаченного вердикта —
   оператор должен видеть, откуда взялось «Paid». */
function answerRow(ctx, hit, scopeKey, ym) {
  const u = hit.unit;
  const b = hit.building;
  const v = safeVerdict(ctx, u, ym);
  const s = normStatus(v.status);
  const name = u.tenant || u.company || (s === 'vacant' ? 'Vacant' : 'Suite ' + (u.id || ''));
  const bid = String((b && b.id) || '');
  const inScope = scopeKey !== 'all' && bid === scopeKey;
  const place = inScope ? (floorLabel(hit) || (b && b.name) || '') : ((b && b.name) || bid);
  const prov = (s === 'paid') ? sourceLabel(v.source) : '';
  const where = ['Suite ' + esc(u.id), place ? esc(place) : '', prov ? esc(prov) : '']
    .filter(Boolean).join(' · ');
  const detail = v.detail || v.label || '';
  const fid = String((hit.floor && hit.floor.id) || '');
  // data-b/data-f/data-u — общий контракт строк ответа с Payments. floorId
  // обязателен: без него unit-лист не сможет позвать CF (dsSendEnvelope и
  // createStripeInvoice требуют buildingId+floorId+unitId).
  return '<button class="arow" data-act="unit" data-b="' + esc(bid) + '" data-f="' + esc(fid)
    + '" data-u="' + esc(u.id) + '" data-id="' + esc(bid + '__' + u.id) + '">'
    + '<span class="astat" data-s="' + s + '">' + STATUS_ICON[s] + '</span>'
    + '<span class="amain"><span class="aname">' + esc(name) + '</span>'
    + '<span class="await">' + where + '</span></span>'
    + '<span class="aright"><span class="aamt">' + ctx.fmt.money(effRent(u)) + '</span>'
    + '<span class="averdict" data-s="' + s + '">' + esc(detail) + '</span></span></button>';
}

/* ---------------- blocks ---------------- */

/* Честная строка синхронизации. Улучшение №1: холодный старт рисует
   кэш мгновенно и НЕ притворяется свежим — «synced 6 min ago · refreshing…». */
function syncLine(ctx) {
  const snap = ctx.snap || {};
  const S = ctx.S || {};
  const online = snap.online !== false;
  const refreshing = !!(snap.refreshing || snap.syncing || S.refreshing || S.loading);
  const when = snap.syncedAt ? ctx.fmt.rel(snap.syncedAt) : '';
  let dot = 'var(--ok)', text;
  if (!snap.syncedAt) {
    dot = refreshing ? 'var(--info)' : 'var(--idle)';
    text = online ? 'loading…' : 'offline · no data yet';
  } else if (!online) {
    dot = 'var(--bad)';
    text = 'offline · synced ' + when;
  } else if (refreshing) {
    dot = 'var(--info)';
    text = 'synced ' + when + ' · refreshing…';
  } else {
    text = 'synced ' + when + ' · ' + ctx.fmt.dateShort(Date.now());
  }
  // Инлайн-стиля здесь быть не должно: он бил правило button.sync в m.html
  // своим padding:0, и кнопка обновления оставалась 17px высотой — мимо пальца.
  return '<button class="sync" data-act="sync" aria-label="Refresh data">'
    + '<i style="background:' + dot + '"></i>' + esc(text) + '</button>';
}

function moneyLine(ctx, sc, st, ym) {
  const w = v => (st.billed > 0 ? Math.max(v > 0 ? 3 : 0, v / st.billed * 100) : 0);
  // Пока зданий в снимке нет, «$0 · Paid $0 · Overdue $0» читается как ОТВЕТ
  // про деньги оператора, хотя это «мы ещё не знаем». Молчание честнее нуля.
  const known = !!(ctx.snap && Array.isArray(ctx.snap.buildings) && ctx.snap.buildings.length);
  if (!known) {
    return '<button class="moneyline" data-act="job" data-k="payments">'
      + '<span class="ml-top"><span class="ml-k">' + esc(monthName(ym)) + '</span>'
      + '<span class="ml-go">Details ›</span></span>'
      + '<span class="ml-num" style="color:var(--ink-3)">—</span>'
      + '<span class="ml-legend"><span>' + (ctx.snap && ctx.snap.online === false
        ? 'Offline — showing nothing rather than a wrong number.'
        : 'Still loading the buildings…') + '</span></span></button>';
  }
  return '<button class="moneyline" data-act="job" data-k="payments">'
    + '<span class="ml-top"><span class="ml-k">' + esc(monthName(ym)) + ' · ' + esc(sc.name) + '</span>'
    + '<span class="ml-go">Details ›</span></span>'
    + '<span class="ml-num">' + ctx.fmt.money(st.collected) + '</span>'
    + '<span class="ml-bar"><span style="width:' + w(st.collected) + '%;background:var(--ok)"></span>'
    + '<span style="width:' + w(st.awaiting) + '%;background:var(--info)"></span>'
    + '<span style="width:' + w(st.overdue) + '%;background:var(--bad)"></span></span>'
    + '<span class="ml-legend"><span><i style="background:var(--ok)"></i>Paid <b>' + ctx.fmt.kmoney(st.collected) + '</b></span>'
    + '<span><i style="background:var(--info)"></i>Awaiting <b>' + ctx.fmt.kmoney(st.awaiting) + '</b></span>'
    + '<span><i style="background:var(--bad)"></i>Overdue <b>' + ctx.fmt.kmoney(st.overdue) + '</b></span></span></button>';
}

const job = (k, ico, t, s) =>
  '<button class="job" data-act="job" data-k="' + k + '"><span class="job-ico">' + ico + '</span>'
  + '<span class="job-main"><span class="job-t">' + t + '</span><span class="job-s">' + s + '</span></span>'
  + '<span class="job-go">' + I.caret + '</span></button>';

const sinceNow = st =>
  '<div class="since-row">'
  + '<div class="since-i"><b>' + st.pct + '%</b>collected</div>'
  + '<div class="since-i' + (st.n.overdue ? ' bad' : '') + '"><b>' + st.n.overdue + '</b>late right now</div>'
  + '</div>';

function sinceBlock(ctx, sc, st, ym) {
  const base = baseline();
  const prev = base && base.scopes ? base.scopes[sc.key] : null;
  const at = prev && (prev.at || base.at);
  let head = '', body;
  if (!prev || !at) {
    body = '<div class="since-t">First visit on this device — next time this shows what changed.</div>'
      + sinceNow(st);
  } else if ((prev.ym || base.ym) !== ym) {
    head = ctx.fmt.dateShort(at);
    body = '<div class="since-t">New month since your last visit — <b>' + esc(monthName(ym))
      + '</b> starts fresh. Where it stands now:</div>' + sinceNow(st);
  } else {
    const dMoney = st.collected - num(prev.collected);
    const dLate = st.n.overdue - num(prev.overdueCount);
    const moneyCell = dMoney > 0
      ? '<div class="since-i ok"><b>+' + ctx.fmt.kmoney(dMoney) + '</b>collected</div>'
      : '<div class="since-i"><b>' + ctx.fmt.kmoney(dMoney) + '</b>collected</div>';
    const lateCell = dLate > 0
      ? '<div class="since-i bad"><b>' + dLate + '</b>new overdue</div>'
      : dLate < 0
        ? '<div class="since-i ok"><b>' + Math.abs(dLate) + '</b>cleared</div>'
        : '<div class="since-i"><b>0</b>new overdue</div>';
    head = ctx.fmt.dateShort(at);
    body = '<div class="since-t">You were last here <b>' + esc(ctx.fmt.rel(at))
      + '</b>. What changed in ' + esc(sc.name) + ':</div>'
      + '<div class="since-row">' + moneyCell + lateCell
      + '<div class="since-i"><b>' + st.pct + '%</b>collected now</div></div>';
  }
  return '<div class="sec-h"><h2>Since your last visit</h2>'
    + (head ? '<span class="sec-sub">' + esc(head) + '</span>' : '') + '</div>'
    + '<div class="since">' + body + '</div>';
}

function recentBlock(ctx, sc, ym) {
  const rows = [];
  for (const r of readRecent()) {
    const hit = lookupUnit(ctx.snap, r.buildingId, r.unitId);
    if (!hit) continue;                        // юнит удалён — молча пропускаем
    rows.push(answerRow(ctx, hit, sc.key, ym));
    if (rows.length >= RECENT_SHOWN) break;
  }
  const body = rows.length ? rows.join('')
    : '<div class="empty">Nothing yet. Open a tenant from Payments and it lands here.</div>';
  return '<div class="sec-h"><h2>Recently opened</h2></div><div class="card">' + body + '</div>';
}

/* ---------------- render ---------------- */

export function render(ctx) {
  const ym = ymOf(ctx);
  const sc = resolveScope(ctx);
  const st = statsFor(ctx, sc.buildings, ym);
  const hasData = !!(sc.buildings.length && ctx.snap && ctx.snap.syncedAt);

  let h = '<div class="topbar"><div class="tb-row">'
    + '<div style="flex:1 1 auto;min-width:0">'
    + '<div class="tb-title">SuitesForAll</div>' + syncLine(ctx) + '</div>'
    + '<button class="icon-btn" data-act="account" aria-label="Account">' + I.user + '</button>'
    + '</div></div>';

  h += moneyLine(ctx, sc, st, ym);

  // Роль без права отправки видит только проверку оплаты: предлагать «отправить»
  // тому, кому сервер откажет, — обещание, которое приложение не выполнит.
  const maySend = (typeof ctx.canSend !== 'function') || ctx.canSend();
  h += '<div class="jobs">'
    + job('payments', I.search, 'Check a payment', 'Search a tenant, suite or phone')
    + (maySend ? job('lease', I.doc, 'Send a lease', 'Pick a unit — the template fills itself') : '')
    + (maySend ? job('invoice', I.money, 'Send an invoice', 'Rent, deposit, late fee or custom') : '')
    + '</div>';
  if (!maySend) {
    h += '<div class="whatnext" style="margin:0 16px 12px">' + I.alert
      + '<span>Your role can look at payments but not send leases or invoices. Ask an admin to change it.</span></div>';
  }

  h += sinceBlock(ctx, sc, st, ym);
  h += recentBlock(ctx, sc, ym);
  h += '<div style="height:10px"></div>';

  stampVisit(sc.key, ym, st, hasData);
  return h;
}

export function handle(act, el, ctx) {
  if (act === 'job') {
    const k = el.getAttribute('data-k');
    if (k === 'payments') { ctx.go('payments'); return true; }
    if (k === 'lease') { ctx.openSheet('lease'); return true; }
    if (k === 'invoice') { ctx.openSheet('invoice'); return true; }
    return false;
  }
  if (act === 'unit') {
    const buildingId = el.getAttribute('data-b') || '';
    const unitId = el.getAttribute('data-u') || '';
    if (!unitId) return false;
    // floorId берём из разметки, а если её нет — доразрешаем по снимку:
    // unit-лист без floorId не сможет отправить ни счёт, ни договор.
    let floorId = el.getAttribute('data-f') || '';
    if (!floorId) {
      const hit = lookupUnit(ctx.snap, buildingId, unitId);
      floorId = String((hit && hit.floor && hit.floor.id) || '');
    }
    rememberRecent(buildingId, unitId);
    ctx.openSheet('unit', { buildingId, floorId, unitId, from: 'home' });
    return true;
  }
  if (act === 'sync') { ctx.refresh(); return true; }
  if (act === 'account') { ctx.go('more'); return true; }
  return false;
}
