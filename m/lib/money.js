// m/lib/money.js — canonical money verdicts for the mobile client.
//
// ПОРТ 1:1 из floor-map-editor.html. Ни одна формула не «улучшена»: мобильный клиент
// обязан отвечать ровно то же, что десктоп, на вопрос «оплачен ли месяц». Источники:
// _isMonthSettled :94935 (КАНОН) · _rentPaidRowFromCache :94972 · _stampPointsToDeposit
// :94952 (Entry 34) · _lookupInvoiceBucket :95132 · _stripePaidAmountForYm :95074 ·
// _monthBilling :88157 · _computeProrate :88138 · _computeUnitMoneyImpl :80432 ·
// _unitLeaseHead :76390 · _isFinanceShadow :76398 · _isInactiveSubRoom :62031 ·
// _isMonthToMonth :137229 · _leaseEndFromStartTerm :125620 · _escalatedMonthlyRent
// :80364 · _unitProrationCredit :155998 · payments KPI :157849
//
// ТРИ СОЗНАТЕЛЬНЫХ ОТЛИЧИЯ (всё остальное байт-в-байт):
//  1. ЧИСТОТА — десктопные _isDepositPaid/_unitDepositStatus мутируют юнит и пишут
//     localStorage прямо из read-path (whole-object-swap капкан). Здесь всё read-only;
//     вердикт тот же — записи лишь добавляли уже вычисленный 'paid'.
//  2. GRACE = WORKSPACE — задокументированный разъезд: _computeUnitMoneyImpl (деньги,
//     красная плитка) берёт settings.lateFee.graceDays ?? 5, а _bvDeriveTenantStatus
//     (ярлык) — каскад getLateFeeConfig. Зеркалим ДЕНЬГИ, осознанно.
//  3. ЯКОРЬ = ym — десктопный payment-fill при провале в lease-палитру красит
//     СЕГОДНЯШНИМ состоянием («SELECTED MONTH VS TODAY» wart). monthStatus() привязан
//     к запрошенному ym, как _computeUnitMoneyImpl — денежная правда.
//
// Зависимостей нет (тестируется голым node): часы и localStorage инжектируются через
// snap.now / snap.invoiceBuckets.

export const STATUS_LABELS = Object.freeze({
  paid: 'Paid', free: 'Waived', due: 'Due', overdue: 'Overdue', upcoming: 'Upcoming',
  ended: 'Lease ended', vacant: 'Vacant', reserved: 'Reserved', no_lease: 'No lease',
});
// Статусы «деньги не получены» — ровно те, что _computeUnitMoneyImpl кладёт в outstanding.
export const UNPAID = new Set(['due', 'overdue']);

const DISK_KEY = 'sfa_inv_buckets_v1';

// ── Snapshot-scoped indexes (замена _invIndexEnsure/_invRowsForUnit/_unitsInGroup).
// Новый снапшот === новый объект === новый индекс: семантика _invoicesCacheEpoch.
const EMPTY_IX = { byId: new Map(), byUnit: new Map(), groups: new Map(), floorOf: new Map(), bldOf: new Map() };
const _ixCache = new WeakMap();

function _ix(snap) {
  if (!snap || typeof snap !== 'object') return EMPTY_IX;
  const hit = _ixCache.get(snap);
  if (hit) return hit;
  const ix = { byId: new Map(), byUnit: new Map(), groups: new Map(), floorOf: new Map(), bldOf: new Map() };
  for (const r of (Array.isArray(snap.invoices) ? snap.invoices : [])) {
    if (!r) continue;
    if (r.id) ix.byId.set(r.id, r);
    // Пустой ключ сохраняем НАМЕРЕННО: строки без unitId ложатся под '' и матчатся
    // с юнитами без id — поведение исходных .filter-предикатов.
    const k = String(r.unitId || (r.metadata && r.metadata.unitId) || '');
    let arr = ix.byUnit.get(k);
    if (!arr) { arr = []; ix.byUnit.set(k, arr); }
    arr.push(r);
  }
  for (const b of (Array.isArray(snap.buildings) ? snap.buildings : [])) {
    for (const f of ((b && b.floors) || [])) {
      for (const u of ((f && f.units) || [])) {
        if (!u) continue;
        ix.floorOf.set(u, f);
        ix.bldOf.set(u, b);      // нужно, чтобы не путать одинаковые номера сьютов между зданиями
        if (!u.groupId) continue;
        let g = ix.groups.get(u.groupId);
        if (!g) { g = []; ix.groups.set(u.groupId, g); }
        g.push(u);
      }
    }
  }
  _ixCache.set(snap, ix);
  return ix;
}

function _settings(snap) { return (snap && snap.settings) || {}; }
function _now(snap) {
  const n = snap && snap.now;
  if (n instanceof Date) return n;
  if (typeof n === 'number' && isFinite(n)) return new Date(n);
  return new Date();
}
function _ymOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function _isoOf(d) { return `${_ymOf(d)}-${String(d.getDate()).padStart(2, '0')}`; }

/** Порт toIsoDate :137247. */
export function toIsoDate(s) {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = String(s).match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    return `${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : _isoOf(d);
}

// Порт _leaseEndFromStartTerm :125620. Конвенция (не трогать — от неё зависят unit-панель,
// Add Unit, Add Document, Quick Add Tenant, termination_date):
//   старт НЕ 1-го → последний день месяца (start + N):     27 авг 2026 +12 → 31 авг 2027
//   старт 1-го    → последний день месяца (start + N − 1):  1 окт 2026 +12 → 30 сен 2027
// setDate(1) ПЕРЕД setMonth обязателен: иначе 31 авг + 6 переполняло в 3 марта.
export function leaseEndFromStartTerm(startIso, months) {
  const n = +months;
  if (!startIso || !Number.isFinite(n) || n <= 0) return '';
  const d = new Date((toIsoDate(startIso) || String(startIso)).slice(0, 10) + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  const startsOn1st = d.getDate() === 1;
  d.setDate(1);
  d.setMonth(d.getMonth() + n - (startsOn1st ? 1 : 0));
  d.setDate(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate());
  return _isoOf(d);
}

/** Порт _isMonthToMonth :137229. ЗЕРКАЛО в functions/index.js — правь обе копии. */
export function isMonthToMonth(u) {
  if (!u) return false;
  const t = String(u.leaseTerm || '').trim().toLowerCase();
  if (t === 'mtm' || t === 'm2m' || t === '1') return true;
  const s = toIsoDate(u.leaseStart || u.signed || '');
  const e = toIsoDate(u.until || u.leaseEnd || '');
  return !!(s && e && e < s);
}

// Порт _unitLeaseHead :76390 + _groupPrimary :76257. ОБЯЗАТЕЛЕН первым шагом в каждом
// денежном предикате: у member-сьюта денежные поля пустые.
export function leaseHead(u, snap) {
  if (!u || !u.groupId) return u;
  const g = _ix(snap).groups.get(u.groupId);
  if (!g || !g.length) return u;
  return g.find(x => x && x.groupRole === 'primary') || g[0] || u;
}

/**
 * Все сьюты одной лизы. Нужен интерфейсу, а не расчёту: у member-сьюта
 * денежные поля пустые, и вердикт для него считается по head'у — то есть на
 * сьюте 133 честно печатается сумма ВСЕЙ лизы (в проде это, например,
 * $13,318.33 на шесть сьютов сразу). Без явной оговорки оператор прочитает её
 * как цену одного сьюта. Пустой массив = одиночная лиза, говорить нечего.
 */
export function leaseGroup(u, snap) {
  if (!u || !u.groupId) return [];
  const g = _ix(snap).groups.get(u.groupId);
  return (g && g.length > 1) ? g.slice() : [];
}

// Порт _isInactiveSubRoom :62031 — identity-match этажа, не currentFloor().
function _isInactiveSubRoom(u, snap) {
  if (!u || !u.parentId) return false;
  const f = _ix(snap).floorOf.get(u);
  const parent = f && (f.units || []).find(x => x && x.id === u.parentId);
  if (!parent) return false;
  return !!((parent.tenant || parent.company) && parent.status === 'occupied') || !!parent.groupId;
}

/** Порт _isFinanceShadow :76398 — skip-фильтр для ЛЮБОЙ агрегации по юнитам. */
export function isFinanceShadow(u, snap) {
  if (!u) return false;
  if (_isInactiveSubRoom(u, snap)) return true;
  return !!(u.groupId && u.groupRole !== 'primary');
}

// ── Invoice cache tier — _lookupInvoiceBucket :95132 / _invRowsForUnit :95114 ──
let _diskMemo = null;
function _diskBuckets(snap) {
  const inj = snap && snap.invoiceBuckets;
  if (inj && typeof inj === 'object') return inj;
  if (_diskMemo) return _diskMemo;
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(DISK_KEY) : null;
    _diskMemo = raw ? JSON.parse(raw) : {};
  } catch { _diskMemo = {}; }
  return _diskMemo;
}
/**
 * Счета юнита. Номер сьюта уникален только внутри здания (MONO:80445): в проде
 * 208 номеров из 815 встречаются в нескольких зданиях, и 2 из них заняты
 * одновременно в разных — там счёт чужого здания попадал бы в этот юнит, красил
 * бы карту и подставлялся в кнопку «Remind».
 *
 * Правило: строку с ЧУЖИМ buildingId отбрасываем всегда; строку без buildingId
 * (старые счета, до того как CF начал его писать — functions/index.js:1475)
 * принимаем как раньше, иначе потеряли бы историю.
 *
 * unit передаём объектом: по нему находим здание через индекс снимка.
 */
function _rowsForUnit(unit, snap) {
  const uid = String((unit && unit.id != null) ? unit.id : (unit || ''));
  const rows = _ix(snap).byUnit.get(uid) || [];
  const b = (unit && typeof unit === 'object') ? _ix(snap).bldOf.get(unit) : null;
  const bid = b && b.id != null ? String(b.id) : '';
  if (!bid) return rows;
  return rows.filter((r) => {
    const rb = String((r && (r.buildingId || (r.metadata && r.metadata.buildingId))) || '');
    return !rb || rb === bid;
  });
}
function _lookupInvoiceRow(id, snap) { return id ? (_ix(snap).byId.get(id) || null) : null; }

// Двухуровневый: память → терминальный localStorage-штамп. Мобильный клиент на том же
// origin, что монолит, поэтому диск-тир реально населён.
function _lookupInvoiceBucket(id, snap) {
  if (!id) return null;
  const ix = _ix(snap);
  if (ix.byId.size > 0) {
    const row = ix.byId.get(id);
    if (row) return row.bucket || row.status || null;
  }
  return _diskBuckets(snap)[id] || null;
}

// Порт _stampPointsToDeposit :94952 (Entry 34). Штампы — голые указатели; если один
// смотрит на депозит-инвойс, bucket вернёт статус ДЕПОЗИТА и UI объявит ренту
// оплаченной при реально past_due счёте.
function _stampPointsToDeposit(u, invoiceId, snap) {
  if (!u || !invoiceId) return false;
  if (u.stripe && u.stripe.depositInvoice && u.stripe.depositInvoice.invoiceId === invoiceId) return true;
  const row = _lookupInvoiceRow(invoiceId, snap);
  if (row && row.metadata && row.metadata.purpose === 'deposit') return true;
  return !!(row && /\bdeposit\b/.test(String(row.description || '').toLowerCase()));
}

/**
 * Штамп lastInvoiceId проверяем строже остальных.
 * Ревью 2026-08-15 (класс FIXES_LOG Entry 34): CF пишет lastInvoiceId для ЛЮБОГО
 * назначения счёта, а lastInvoiceYm — только для ренты. Поэтому оплаченный
 * ДЕПОЗИТ может перезаписать lastInvoiceId, пока lastInvoiceYm всё ещё указывает
 * на месяц ренты. Распознать подмену можно только по строке инвойса из кэша —
 * а он бывает пустым (роль без доступа к Stripe, урезанный офлайн-снимок).
 * Нет строки в кэше → штампу не верим. Направление безопасное: телефон скажет
 * «не оплачено» там, где не уверен, вместо ложного «оплачено» по просроченной ренте.
 * moveInRent такой проблемы не имеет — он пишется только для ренты.
 */
function _lastStampTrustworthy(u, invoiceId, snap) {
  if (_stampPointsToDeposit(u, invoiceId, snap)) return false;
  return !!_lookupInvoiceRow(invoiceId, snap);
}

// Порт _rentPaidRowFromCache :94972. STRICT: purpose='rent', точный ym без created-date
// фолбэка, скоуп по customerId/email ТЕКУЩЕГО тенанта.
function _rentPaidRowFromCache(u, ym, snap) {
  if (!u || !u.id || !ym) return null;
  const rows = _rowsForUnit(u, snap);
  if (!rows.length) return null;
  const custId = (u.stripe && u.stripe.customerId) || null;
  const email = String(u.email || '').trim().toLowerCase();
  if (!custId && !email) return null;
  for (const r of rows) {
    if (!r || r.bucket !== 'paid') continue;
    if (((r.metadata && r.metadata.purpose) || r.purpose || '') !== 'rent') continue;
    if ((r.ym || (r.metadata && r.metadata.ym) || null) !== ym) continue;
    const rowCust = r.customerId || null;
    const rowEmail = String(r.customerEmail || '').trim().toLowerCase();
    if ((custId && rowCust && rowCust === custId) || (email && rowEmail && rowEmail === email)) return r;
  }
  return null;
}

// ── THE VERDICT — порт _isMonthSettled :94935 ────────────────────────────────
// {v, id, via}: v = 'paid'|'free'|'stripe-paid'|null. via/id нужны ТОЛЬКО verdict()
// для поля source; сам вердикт от них не зависит.
function _settle(u0, ym, snap) {
  if (!u0 || !ym) return { v: null, id: null, via: 'none' };
  const u = leaseHead(u0, snap);
  const p = u && u.payments && u.payments[ym];
  if (p && p.status === 'paid') return { v: 'paid', id: null, via: 'local' };
  if (p && p.status === 'free') return { v: 'free', id: null, via: 'waiver' };

  const mi = u && u.stripe && u.stripe.moveInRent;
  if (mi && mi.ym === ym && mi.invoiceId
      && !_stampPointsToDeposit(u, mi.invoiceId, snap)
      && _lookupInvoiceBucket(mi.invoiceId, snap) === 'paid') {
    return { v: 'stripe-paid', id: mi.invoiceId, via: 'stamp-movein' };
  }
  const st = (u && u.stripe) || {};
  if (st.lastInvoiceYm === ym && st.lastInvoiceId
      && _lastStampTrustworthy(u, st.lastInvoiceId, snap)
      && _lookupInvoiceBucket(st.lastInvoiceId, snap) === 'paid') {
    return { v: 'stripe-paid', id: st.lastInvoiceId, via: 'stamp-last' };
  }
  // Штампы стираются building-свапом (~30с rev-шторм) — скан от них не зависит.
  const row = _rentPaidRowFromCache(u, ym, snap);
  return row ? { v: 'stripe-paid', id: row.id || null, via: 'cache' } : { v: null, id: null, via: 'none' };
}

/** Канонический вердикт: 'paid' | 'free' | 'stripe-paid' | null (truthy = settled). */
export function isMonthSettled(unit, ym, snap) { return _settle(unit, ym, snap).v; }

// Порт _stripePaidAmountForYm :95074. amountPaid сильнее total: после кредит-ноты
// total остаётся полным, а собрано именно amount_paid.
function _stripePaidAmount(u0, ym, snap) {
  const s = _settle(u0, ym, snap);
  const row = (s.v === 'stripe-paid' && s.id) ? _lookupInvoiceRow(s.id, snap) : null;
  if (!row) return null;
  if (+row.amountPaid > 0) return +row.amountPaid;
  if (+row.total > 0) return +row.total;
  return null;
}

// ── Rent amount math — _computeProrate :88138, _monthBilling :88157 ──────────
function _computeProrate(rent, leaseStartIso) {
  if (!leaseStartIso || !rent || rent <= 0) return null;
  const start = new Date(leaseStartIso + 'T00:00:00');
  if (isNaN(start.getTime())) return null;
  const day = start.getDate();
  if (day === 1) return null;
  const dim = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  return { prorated: Math.round((rent / dim) * (dim - day + 1) * 100) / 100, ym: _ymOf(start) };
}

// Порт _mpmComputeWaiverCoverage :155874 + _unitProrationCredit :155998 — доля месяца,
// покрытая waiver-окнами (spillover-вейверы кредитуют соседние месяцы).
function _prorationCredit(u, ym) {
  if (!u || !u.payments) return 0;
  let total = 0;
  for (const k of Object.keys(u.payments)) {
    const p = u.payments[k];
    if (!p || p.status !== 'free' || !p.waiverStart || !p.waiverEnd) continue;
    if (p.waiverStart >= p.waiverEnd) continue;
    const start = new Date(p.waiverStart + 'T12:00:00');
    const end = new Date(p.waiverEnd + 'T12:00:00');
    let cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur < end) {
      const y = cur.getFullYear(), m = cur.getMonth();
      if (_ymOf(cur) === ym) {
        const mS = new Date(y, m, 1), mE = new Date(y, m + 1, 1);
        const days = Math.max(0, Math.round(((end < mE ? end : mE) - (start > mS ? start : mS)) / 86400000));
        if (days > 0) total += days / new Date(y, m + 1, 0).getDate();
      }
      cur = new Date(y, m + 1, 1);
    }
  }
  return Math.max(0, Math.min(1, total));
}

// Порт _rentPeriodBounds :80336 + _rentScheduleRowForYm :80349 + _escalatedMonthlyRent
// :80364. DORMANT: гейт settings.escalationBilling; выключен → плоская контрактная рента.
function _escalatedRent(u, ym, snap) {
  const flat = +u.contractRent || +u.rent || 0;
  const sched = Array.isArray(u && u.rentSchedule) ? u.rentSchedule : [];
  if (!_settings(snap).escalationBilling || !sched.length || !/^\d{4}-\d{2}$/.test(ym)) return flat;
  const [y, mo] = ym.split('-').map(Number);
  const first = new Date(y, mo - 1, 1);
  const parse = (s) => {
    const mm = String(s).match(/(\d+)\/(\d+)\/(\d+)/); if (!mm) return null;
    const d = new Date((+mm[3] < 100 ? 2000 + +mm[3] : +mm[3]), (+mm[1]) - 1, (+mm[2]));
    return isNaN(d.getTime()) ? null : d;
  };
  for (const r of sched) {
    const m = String((r && r.period) || '').match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[–\-—to]+\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/);
    const a = m && parse(m[1]), b = m && parse(m[2]);
    if (a && b && first >= a && first <= b) {
      const v = +r.monthly_rent;
      return (isFinite(v) && v >= 0) ? v : flat;
    }
  }
  return flat;
}

// Порт _monthBilling :88157 — ЕДИНСТВЕННЫЙ источник правды по due-date. Месяц въезда:
// грейс от даты старта. Остальные месяцы: от 1-го числа.
function _monthBilling(rent, ym, leaseStartIso, graceDays, now, unit) {
  const startDate = leaseStartIso ? new Date(leaseStartIso + 'T00:00:00') : null;
  const startValid = startDate && !isNaN(startDate.getTime());
  const leaseStartYm = startValid ? _ymOf(startDate) : null;
  const pro = startValid ? _computeProrate(rent, leaseStartIso) : null;
  let monthRent = (pro && pro.ym === ym) ? pro.prorated : (+rent || 0);
  if (unit && monthRent > 0) {
    const credit = _prorationCredit(unit, ym);
    if (credit > 0) monthRent *= (1 - credit);
  }
  let dueDate;
  if (ym === leaseStartYm && startValid) {
    dueDate = new Date(startDate.getTime());
    dueDate.setDate(dueDate.getDate() + (+graceDays || 0));
  } else {
    const [yy, mm] = String(ym).split('-').map(Number);
    dueDate = new Date(yy, mm - 1, 1 + (+graceDays || 0));
  }
  return { monthRent, dueDate, isOverdueByDate: now > dueDate };
}

/**
 * Дата для ГЛАЗ оператора: «Aug 6», «Aug 6, 2025» если год не текущий.
 * Модель отдаёт готовые строки вердикта, поэтому формат живёт здесь — иначе в
 * интерфейс попадает ISO («due 2026-08-06»), который на телефоне читается как
 * технический мусор рядом с «December 31, 2026» в соседней ячейке.
 */
const _MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function _human(iso, snap) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  if (!(mo >= 0 && mo < 12)) return String(iso);
  const nowY = new Date(_now(snap)).getFullYear();
  return _MON[mo] + ' ' + d + (y === nowY ? '' : ', ' + y);
}

function _usd(n) {
  const v = Math.round((+n || 0) * 100) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

/**
 * Как назвать счёт оператору. Человеческий номер («R-CEN-301-2026-08») если он
 * есть; иначе — сырой id Stripe, но обрезанный: полные 27 символов на телефоне
 * переносятся и выглядят как сломанная вёрстка, а целиком они всё равно нужны
 * только в полной версии.
 */
function _invLabel(row) {
  if (!row) return '';
  const n = String(row.number || row.invoiceNumber || '').trim();
  if (n) return n;
  const id = String(row.id || '').trim();
  return id.length > 14 ? id.slice(0, 11) + '…' : id;
}

// Живой (не void/uncollectible) счёт за ym — ТОЛЬКО для source/detail. НИКОГДА не
// участвует в вердикте (десктопные finders — тоже display-only).
function _liveInvoiceForYm(u, ym, snap) {
  let best = null;
  for (const r of _rowsForUnit(u, snap)) {
    if (!r || r.bucket === 'void' || r.bucket === 'uncollectible' || r.status === 'void') continue;
    if (((r.metadata && r.metadata.purpose) || r.purpose || 'rent') === 'deposit') continue;
    if ((r.ym || (r.metadata && r.metadata.ym) || null) !== ym) continue;
    if (!best || r.bucket === 'past_due') best = r;
  }
  return best;
}

/**
 * Живой счёт заданного назначения — для ЭКРАНОВ, не для вердикта.
 * Нужен экрану заселения: «депозит уже выставлен?», «первая рента ушла?».
 * Правила те же, что у дедупа в листе счёта: void/uncollectible/draft — слот
 * свободен; депозит дедупится БЕЗ месяца (один на юнит), остальное — по ym.
 * purpose: 'rent' | 'deposit' | 'late_fee' | 'custom'. ym нужен всем, кроме депозита.
 */
export function liveInvoiceFor(unit, purpose, ym, snap) {
  const want = String(purpose || 'rent');
  let best = null;
  for (const r of _rowsForUnit(unit, snap)) {
    if (!r) continue;
    const b = r.bucket || r.status;
    if (b === 'void' || b === 'uncollectible' || b === 'refunded' || b === 'draft') continue;
    if (((r.metadata && r.metadata.purpose) || r.purpose || 'rent') !== want) continue;
    if (want !== 'deposit') {
      if ((r.ym || (r.metadata && r.metadata.ym) || null) !== ym) continue;
    }
    if (!best || b === 'past_due') best = r;
  }
  return best;
}

// ── Per-month classification — зеркало _computeUnitMoneyImpl :80432 (по ym) ──
function _classify(u0, ym, snap) {
  const out = { status: 'vacant', amount: 0, settle: { v: null, via: 'none', id: null },
                unit: u0, dueIso: '', startIso: '', endIso: '' };
  if (!u0 || !ym) return out;
  const u = leaseHead(u0, snap);
  out.unit = u;

  // 1. SETTLED выигрывает у всего: оплаченная история остаётся оплаченной, даже
  //    если юнит сейчас vacant.
  const s = _settle(u, ym, snap);
  out.settle = s;
  if (s.v === 'paid' || s.v === 'stripe-paid') { out.status = 'paid'; return out; }
  if (s.v === 'free') { out.status = 'free'; return out; }

  // 2. Occupancy gate — тот же, что в _isUnitOverdue :88373.
  if (u.status === 'reserved') { out.status = 'reserved'; return out; }
  if (u.status !== 'occupied' || (!u.tenant && !u.company)) { out.status = 'vacant'; return out; }

  // 3. Анти-фантом lease-start gate (Entry 1): без старта долга нет.
  const startIso = toIsoDate(u.leaseStart || u.signed || '');
  out.startIso = startIso;
  const startDate = startIso ? new Date(startIso + 'T00:00:00') : null;
  if (!startDate || isNaN(startDate.getTime())) { out.status = 'no_lease'; return out; }

  // 4. Месяц полностью до старта лизы → ничего не должен.
  if (ym < startIso.slice(0, 7)) { out.status = 'upcoming'; return out; }

  const today = _ymOf(_now(snap));
  const endIso = toIsoDate(u.until || u.leaseEnd || '');
  out.endIso = endIso;

  // 5. БУДУЩИЙ месяц. Порядок load-bearing: выставленный авансом счёт остаётся «due»,
  //    и только потом Upcoming/ended (иначе предоплатные sibling-месяцы схлопывались
  //    в Upcoming — FIXES_LOG Entry 30).
  if (ym > today) {
    if (_liveInvoiceForYm(u, ym, snap)) {
      out.status = 'due';
      out.amount = _monthBilling(_escalatedRent(u, ym, snap), ym, startIso, 0, _now(snap), u).monthRent;
      return out;
    }
    if (!isMonthToMonth(u) && endIso && endIso.slice(0, 7) < ym) { out.status = 'ended'; return out; }
    out.status = 'upcoming';
    return out;
  }

  // 6. Текущий/прошлый месяц — денежная правда. Grace = WORKSPACE (см. шапку).
  const lf = _settings(snap).lateFee;
  const grace = (lf && lf.graceDays != null) ? lf.graceDays : 5;
  const mb = _monthBilling(_escalatedRent(u, ym, snap), ym, startIso, grace, _now(snap), u);
  out.amount = mb.monthRent;
  out.dueIso = _isoOf(mb.dueDate);
  if (!(mb.monthRent > 0)) { out.status = 'free'; return out; }   // waiver-прората до нуля
  // Прошлый месяц просрочен безусловно (i>0 в свипе), текущий — по грейсу.
  out.status = (ym < today || mb.isOverdueByDate) ? 'overdue' : 'due';
  return out;
}

/** Статус месяца: paid|free|due|overdue|upcoming|ended|vacant|reserved|no_lease. */
export function monthStatus(unit, ym, snap) { return _classify(unit, ym, snap).status; }

/** Сумма, которую юнит должен за этот месяц (0 если не должен). */
export function monthAmount(unit, ym, snap) {
  const c = _classify(unit, ym, snap);
  return UNPAID.has(c.status) ? c.amount : 0;
}

/**
 * verdict(unit, ym, snap) -> {status, label, detail, source}
 * `source` объясняет ОТКУДА мы это знаем — продуктовое требование: оператор должен
 * видеть, вердикт пришёл из ручной отметки, штампа или скана кэша.
 */
export function verdict(unit, ym, snap) {
  const c = _classify(unit, ym, snap);
  const u = c.unit;
  const p = (u && u.payments && u.payments[ym]) || null;
  let detail = '', source = '';

  if (c.status === 'paid' && c.settle.via === 'local') {
    detail = (p && +p.amount > 0) ? `${_usd(p.amount)} received` : 'Recorded as paid';
    source = ['marked manually', p && p.paidVia, p && p.date].filter(Boolean).join(' · ');
  } else if (c.status === 'paid') {
    const amt = _stripePaidAmount(u, ym, snap);
    detail = amt != null ? `${_usd(amt)} received` : 'Paid on Stripe';
    const how = c.settle.via === 'cache' ? ' (matched by tenant + month)'
      : c.settle.via === 'stamp-movein' ? ' (move-in stamp)' : ' (last-invoice stamp)';
    source = `Stripe invoice ${_invLabel(_lookupInvoiceRow(c.settle.id, snap)) || '—'} · paid${how}`;
  } else if (c.status === 'free') {
    detail = (p && p.waiverStart && p.waiverEnd)
      ? `Waived ${_human(p.waiverStart, snap)} → ${_human(p.waiverEnd, snap)}` : 'No rent owed';
    source = c.settle.v === 'free'
      ? 'waived by operator' + (p && p.waiverReason ? ` · ${p.waiverReason}` : '')
      : 'fully credited by an overlapping waiver';
  } else if (c.status === 'due' || c.status === 'overdue') {
    detail = c.amount > 0 ? `${_usd(c.amount)} ${c.status === 'overdue' ? 'past due' : 'owed'}` : '';
    if (c.dueIso) detail += `${detail ? ' · ' : ''}due ${_human(c.dueIso, snap)}`;
    const live = _liveInvoiceForYm(u, ym, snap);
    source = live ? `Stripe invoice ${_invLabel(live)} · ${live.bucket || live.status || 'open'}`
                  : 'no invoice on record';
  } else if (c.status === 'upcoming') {
    detail = (c.startIso && ym < c.startIso.slice(0, 7)) ? `Lease starts ${_human(c.startIso, snap)}` : 'Not billed yet';
    source = 'no invoice on record';
  } else if (c.status === 'ended') {
    detail = c.endIso ? `Lease ended ${_human(c.endIso, snap)}` : 'Lease ended'; source = 'lease end date on file';
  } else if (c.status === 'reserved') {
    detail = 'Held, not yet leased'; source = 'unit status is reserved';
  } else if (c.status === 'no_lease') {
    detail = 'No lease start on file — nothing billable'; source = 'lease start missing on the unit';
  } else {
    detail = 'No tenant for this month';
    source = (u && u.status) ? `unit status is ${u.status}` : 'no unit';
  }
  // amount — сколько реально должен за месяц (учитывает прорасчёт и вейверы);
  // без него карточки показывали полную ренту. ui — статус словами легенды.
  return { status: c.status, ui: uiStatus(unit, ym, snap), label: STATUS_LABELS[c.status] || c.status,
           amount: UNPAID.has(c.status) ? (c.amount || 0) : 0, detail, source };
}

// ── buildingStats — зеркало payments-KPI :157849 ─────────────────────────────
// expected/collected берут ПЛОСКУЮ контрактную ренту (как десктопный KPI), а не
// эскалированную — это разъезд десктопа, зеркалим как есть.
export function buildingStats(building, ym, snap) {
  const out = { ym, expected: 0, collected: 0, waived: 0, outstanding: 0, deposits: 0,
    collectionRate: null, units: 0, occupied: 0, vacant: 0,
    lateTenants: 0, paidUnits: 0, dueUnits: 0, overdueUnits: 0 };
  if (!building || !ym) return out;
  for (const f of (building.floors || [])) {
    for (const u of ((f && f.units) || [])) {
      // deletedAt — архивация десктопа (MONO:30443); archivedAt в базе нет.
      if (!u || u.deletedAt || u.archivedAt || u.rentable === false) continue;
      if (u.type && u.type !== 'office') continue;
      if (isFinanceShadow(u, snap)) continue;          // каждый лиз считаем один раз
      out.units++;
      if (u.status === 'occupied') out.occupied++;
      else if (u.status === 'vacant') out.vacant++;

      const rent = +u.contractRent || +u.rent || 0;
      if (u.status === 'occupied') out.expected += rent;
      const p = u.payments && u.payments[ym];
      const s = isMonthSettled(u, ym, snap);
      if (s === 'paid') { out.collected += (p && +p.amount) || rent; out.paidUnits++; }
      else if (s === 'stripe-paid') {
        const amt = _stripePaidAmount(u, ym, snap);
        out.collected += (amt != null ? amt : rent);
        out.paidUnits++;
      } else if (s === 'free') { out.waived += rent; }
      else if (u.status === 'occupied') {
        out.outstanding += rent;
        if (p && p.status === 'late') out.lateTenants++;
      }
      out.deposits += +u.deposit || 0;

      const st = monthStatus(u, ym, snap);
      if (st === 'overdue') out.overdueUnits++;
      else if (st === 'due') out.dueUnits++;
    }
  }
  out.collectionRate = out.expected > 0
    ? Math.round(((out.collected + out.waived) / out.expected) * 100) : null;

  // ── Контракт для UI (app.js / home.js / switcher.js / payments.js) ─────────
  // Ревью 2026-08-15: потребители читают billed/awaiting/overdue/pct/n, и без
  // этих полей каждый экран показывал «100% collected · 0 late». Считаем их
  // здесь, из тех же чисел — один источник правды.
  out.n = { paid: 0, invoiced: 0, due: 0, overdue: 0, idle: 0, vacant: 0, reserved: 0 };
  let awaiting = 0, overdueMoney = 0;
  for (const f of (building.floors || [])) {
    for (const u of ((f && f.units) || [])) {
      // deletedAt — архивация десктопа (MONO:30443); archivedAt в базе нет.
      if (!u || u.deletedAt || u.archivedAt || u.rentable === false) continue;
      if (u.type && u.type !== 'office') continue;
      if (isFinanceShadow(u, snap)) continue;
      const st = uiStatus(u, ym, snap);
      if (out.n[st] === undefined) out.n[st] = 0;
      out.n[st]++;
      const owed = monthAmount(u, ym, snap) || 0;
      if (st === 'overdue') overdueMoney += owed;
      else if (st === 'invoiced' || st === 'due') awaiting += owed;
    }
  }
  out.awaiting = awaiting;
  out.overdue = overdueMoney;
  out.billed = out.collected + awaiting + overdueMoney;
  out.pct = out.billed > 0 ? Math.round((out.collected / out.billed) * 100) : 0;
  out.late = out.n.overdue;
  out.lateCount = out.n.overdue;
  return out;
}

/**
 * uiStatus — статус в словаре интерфейса (paid|invoiced|due|overdue|idle|vacant|reserved).
 * monthStatus говорит на языке денежной модели (free/upcoming/ended/no_lease);
 * экраны знают только семь значений легенды плана этажа. Одна точка перевода.
 */
/**
 * Заливка КАРТЫ — отдельно от денежной правды. Это сознательное разделение.
 *
 * Десктоп красит «счёт выставлен» синим РАНЬШЕ, чем проверяет просрочку
 * (floor-map-editor.html:31960 против :32024, там же комментарий «ПОРЯДОК
 * КРИТИЧЕН… не поднимать выше blue-проверки»). Но его же денежная модель
 * считает такой юнит просроченным — то есть синий на карте МАСКИРУЕТ долг.
 *
 * Решение оператора (2026-08-16): цвет как на десктопе, но просрочку не
 * терять — отдаём её отдельным флагом, и карта рисует пометку поверх заливки.
 *
 * ВАЖНО: uiStatus НЕ меняется. Он кормит денежные счётчики (buildingStats,
 * «Overdue $13k» на главной), и подмена там превратила бы долг в «счёт
 * выставлен» — ровно та потеря сигнала, которой мы избегаем.
 */
export function mapStatus(unit, ym, snap) {
  const base = uiStatus(unit, ym, snap);
  const overdue = base === 'overdue';
  // Синий выигрывает только у просрочки. Оплаченное, свободное, зарезервированное
  // и «аренда впереди» остаются собой.
  if (overdue && _hasOpenInvoice(leaseHead(unit, snap) || unit, ym, snap)) {
    return { status: 'invoiced', overdue: true };
  }
  return { status: base, overdue };
}

export function uiStatus(unit, ym, snap) {
  if (!unit) return 'vacant';
  if (unit.status === 'reserved') return 'reserved';
  const st = monthStatus(unit, ym, snap);
  if (st === 'paid' || st === 'free') return 'paid';
  if (st === 'overdue') return 'overdue';
  if (st === 'due') {
    // «Счёт выставлен» отличаем от «просто должен» по наличию живого инвойса.
    return _hasOpenInvoice(unit, ym, snap) ? 'invoiced' : 'due';
  }
  if (st === 'upcoming') return 'idle';
  if (st === 'vacant' || st === 'no_lease' || st === 'ended') return 'vacant';
  return 'idle';
}
function _hasOpenInvoice(unit, ym, snap) {
  const rows = (snap && snap.invoices) || [];
  const uid = String(unit.id || '');
  for (const r of rows) {
    if (!r) continue;
    const m = r.metadata || r;
    if (String(m.unitId || r.unitId || '') !== uid) continue;
    if ((m.ym || r.ym) !== ym) continue;
    const b = r.bucket || r.status;
    if (b === 'open' || b === 'sent' || b === 'past_due') return true;
  }
  const st = unit.stripe || {};
  if (st.lastInvoiceYm === ym && st.lastInvoiceId) return true;
  if (st.moveInRent && st.moveInRent.ym === ym && st.moveInRent.invoiceId) return true;
  return false;
}
