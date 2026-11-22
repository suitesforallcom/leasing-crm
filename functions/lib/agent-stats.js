// =========================================================================
// functions/lib/agent-stats.js — чистые функции статистики для agent gateway
// (AGENT_API_PLAN.md § 3.5, Этап 1). Без Firestore, без сети, без часов:
// всё приходит аргументами (snapshot, модуль money, opts) — тестируется голым
// node (tests/agent-stats.test.cjs).
//
// Канон денег — ТОЛЬКО functions/lib/money.mjs (≡ m/lib/money.js, байт-в-байт,
// tests/money-sync.test.cjs). Модуль передаётся параметром `money` (ESM-namespace,
// который gateway грузит через core.money()). Здесь нет ни одного `status==='paid'`
// на денежном пути (CLAUDE.md § 0.2.2); единственное сознательное наложение —
// Entry 70 «$0-paid shell» (см. classifyMonth).
//
// Что зеркалится из floor-map-editor.html и где сознательные отличия:
//   • get_overdue  → buildAgingRows :147871 (гейты юнита, lease-start gate, окно
//     12 месяцев) + фильтр «Past-due only» = _isUnitOverdue :90242 =
//     _computeUnitMoneyImpl.unpaidMonths>0 → у нас monthStatus(head, ym)==='overdue'
//     (money.js — тот же порт _computeUnitMoneyImpl). Due-date — как _monthBilling
//     (месяц въезда: старт + grace; остальные: 1-е + grace); aging берёт 1-е + grace
//     и для месяца въезда — разъезд самого клиента, зеркалим ДЕНЬГИ.
//   • get_unit_ledger → _buildTenantLedger :148263 (локальный леджер + счёт месяца),
//     но помесячно от текущего месяца назад, без Stripe-строк без ym.
//   • search_units → buildRentRollRows :140290 (колонки спецификаций) +
//     _vacancyCollect :144979 (пропуск неактивных sub-room'ов).
//   • list_invoices → правило Entry 88 / AGENT_API_PLAN § 4.2: строка без
//     buildingId принимается только если её unitId есть в доступном здании.
// =========================================================================
'use strict';

const NY_TZ = 'America/New_York';
const DAY_MS = 86400000;
const LOOKBACK_MONTHS = 12;            // окно aging / _computeUnitMoneyImpl: i < 12 (текущий + 11 назад)
const YM_RE = /^\d{4}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Утилиты дат ────────────────────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }
function isoOf(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function ymOf(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }
function round2(n) { return Math.round((+n || 0) * 100) / 100; }

/** Порт toIsoDate :137247 (тот же, что money.toIsoDate) — локальная копия, чтобы модуль не зависел от money для чистых дат. */
function toIso(s) {
  if (!s) return '';
  const str = String(s);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const m = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    return `${y}-${pad2(+m[1])}-${pad2(+m[2])}`;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? '' : isoOf(d);
}

/**
 * NY wall-clock: Date, чьи ЛОКАЛЬНЫЕ компоненты равны нью-йоркским. money.js читает
 * snap.now локальными геттерами (так же, как браузер оператора в NY); на сервере
 * Cloud Functions (UTC) без этого сдвига месяц и due-date переключались бы на 4–5
 * часов раньше нью-йоркских. На машине в NY — тождественно.
 */
function nyWallClock(d) {
  const src = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
  if (isNaN(src.getTime())) return nyWallClock(new Date());
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(src).map((x) => [x.type, x.value]));
  return new Date(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
}
/** 'YYYY-MM-DD' в NY для миллисекунд (dueDate/created Stripe-строк). */
function nyIsoDate(ms) {
  if (ms == null || !Number.isFinite(+ms)) return null;
  return isoOf(nyWallClock(new Date(+ms)));
}
function isoTs(ms) {
  if (ms == null || !Number.isFinite(+ms)) return null;
  const d = new Date(+ms);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function addMonths(ym, n) {
  const [y, m] = String(ym).split('-').map(Number);
  return ymOf(new Date(y, m - 1 + (+n || 0), 1));
}
/** Месяцы от fromYm до toYm включительно, по возрастанию. */
function monthsBetween(fromYm, toYm) {
  const out = [];
  if (!YM_RE.test(String(fromYm)) || !YM_RE.test(String(toYm))) return out;
  let cur = fromYm;
  let guard = 0;
  while (cur <= toYm && guard++ < 600) { out.push(cur); cur = addMonths(cur, 1); }
  return out;
}
/**
 * Due-date месяца — зеркало _monthBilling :88157 (ЕДИНСТВЕННЫЙ источник правды по
 * due-date в клиенте): месяц въезда → старт лизы + grace; остальные → 1-е + grace.
 * (buildAgingRows :147912 берёт 1-е + grace и для месяца въезда — разъезд клиента,
 * зеркалим денежную правду, чтобы «overdue» здесь совпадал с красной плиткой.)
 */
function dueDateFor(ym, graceDays, leaseStartIso) {
  const g = Number.isFinite(+graceDays) ? +graceDays : 0;
  if (leaseStartIso && ISO_RE.test(leaseStartIso) && leaseStartIso.slice(0, 7) === ym) {
    const d = new Date(leaseStartIso + 'T00:00:00');
    if (!isNaN(d.getTime())) { d.setDate(d.getDate() + g); return isoOf(d); }
  }
  const [y, m] = String(ym).split('-').map(Number);
  return isoOf(new Date(y, m - 1, 1 + g));
}
/** Дней просрочки — формула aging :147933: floor((сейчас − полночь due) / сутки); < 0 = ещё не наступил. */
function daysPastDue(dueIso, now) {
  const due = new Date(String(dueIso) + 'T00:00:00');
  const n = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  if (isNaN(due.getTime()) || isNaN(n.getTime())) return 0;
  return Math.floor((n.getTime() - due.getTime()) / DAY_MS);
}
/** Ведро aging по дням просрочки (пороги <=30/<=60/<=90 как в buildAgingRows). */
function bucketFor(days) {
  const d = +days || 0;
  return d <= 30 ? 'd1_30' : d <= 60 ? 'd31_60' : d <= 90 ? 'd61_90' : 'd90plus';
}
/** Grace — тот же источник, что у money.js (_computeUnitMoneyImpl): settings.lateFee.graceDays ?? 5. */
function graceDaysOf(settings) {
  const lf = settings && settings.lateFee;
  const g = lf && lf.graceDays != null ? +lf.graceDays : 5;
  return Number.isFinite(g) ? g : 5;
}

// ─── Текст арендаторов — данные, не инструкции ─────────────────────────────
// Та же обрезка, что core.util.clampText в gateway (HTML / управляющие символы /
// длина). Gateway передаёт свою через opts.clamp — тогда поведение одно.
function clampText(s, max) {
  if (s == null) return '';
  let t = String(s).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length > (max || 500)) t = t.slice(0, max || 500) + '…';
  return t;
}
function fieldsOf(opts) {
  const f = (opts && opts.fields) || {};
  return {
    contacts: f.contacts === true,
    finance: f.finance === true,
    notes: f.notes === true,                 // как contacts/finance: по умолчанию ЗАКРЫТО (fail-closed)
    clamp: typeof f.clamp === 'function' ? f.clamp : (typeof (opts && opts.clamp) === 'function' ? opts.clamp : clampText),
  };
}

// ─── Юниты ──────────────────────────────────────────────────────────────────
function effectiveRent(u) { return +u.contractRent || +u.rent || 0; }   // EQ-1: contractRent первым
function leaseStartIso(u) {
  if (!u) return '';
  const iso = toIso(u.leaseStart || u.signed || '');
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d.getTime()) ? '' : iso;
}
function leaseEndIso(u) { return u ? toIso(u.until || u.leaseEnd || '') : ''; }
function isArchivedUnit(u) { return !!(u && (u.deletedAt || u.archivedAt)); }   // isArchived :30744 + archivedAt (DATA_MODEL)
function isArchivedFloor(f) { return !!(f && (f.deletedAt || f.archivedAt)); }
function isRentableUnit(u, money) { return !!u && u.rentable !== false && money.isRentableType(u.type); }
/** Неактивный sub-room (порт-эквивалент _isInactiveSubRoom через isFinanceShadow минус member-ветка). */
function isInactiveSubRoom(u, snap, money) {
  if (!u || !u.parentId) return false;
  if (u.groupId && u.groupRole !== 'primary') return false;   // member — считается членом группы, не sub-room'ом
  return money.isFinanceShadow(u, snap);
}
/** Гейт «кого вообще биллим» — buildAgingRows :147880-147891 + _isFinanceShadow. */
function isBillableTenant(u, snap, money) {
  if (!u || isArchivedUnit(u)) return false;
  if (!isRentableUnit(u, money)) return false;
  if (money.isFinanceShadow(u, snap)) return false;
  if (u.status !== 'occupied') return false;
  if (!u.tenant && !u.company) return false;
  return effectiveRent(u) > 0;
}
function* walkUnits(snap) {
  for (const b of (snap.buildings || [])) {
    if (!b || !b.id) continue;
    for (const f of (b.floors || [])) {
      if (!f || isArchivedFloor(f)) continue;
      for (const u of (f.units || [])) { if (u) yield { b, f, u }; }
    }
  }
}
function findUnit(snap, buildingId, unitId) {
  const bid = String(buildingId || ''), uid = String(unitId || '');
  for (const hit of walkUnits(snap)) {
    if (String(hit.b.id) === bid && String(hit.u.id) === uid) return hit;
  }
  return null;
}
function floorOfUnit(snap, unit) {
  for (const hit of walkUnits(snap)) if (hit.u === unit) return hit;
  return null;
}
function unitIdsByBuilding(snap) {
  const map = new Map();
  for (const { b, u } of walkUnits(snap)) {
    if (!map.has(b.id)) map.set(b.id, new Set());
    map.get(b.id).add(String(u.id));
  }
  return map;
}
function sortKey(s) { return String(s == null ? '' : s); }
function cmpNatural(a, b) { return sortKey(a).localeCompare(sortKey(b), 'en', { numeric: true, sensitivity: 'base' }); }

// ─── Снимок для money.js ────────────────────────────────────────────────────
/**
 * {settings, buildings, invoices, now} из core.getSnapshot. Здания — ВСЕ доступные
 * ключу (multi-suite группы резолвятся индексом снимка). invoiceBuckets:{} —
 * диск-тир (localStorage) на сервере не существует; инжектируем пустой, чтобы
 * money.js никогда его не искал.
 */
function buildMoneySnap(snapshot) {
  const s = snapshot || {};
  return {
    settings: s.settings || (s.state && s.state.settings) || {},
    buildings: Array.isArray(s.buildings) ? s.buildings : [],
    invoices: Array.isArray(s.invoices) ? s.invoices : [],
    invoiceBuckets: {},
    now: nyWallClock(s.now),
  };
}

// ─── Инвойсы ────────────────────────────────────────────────────────────────
function invBuildingId(r) { return String((r && (r.buildingId || (r.metadata && r.metadata.buildingId))) || ''); }
function invUnitId(r) { return String((r && (r.unitId || (r.metadata && r.metadata.unitId))) || ''); }
function invPurpose(r) { return String((r && ((r.metadata && r.metadata.purpose) || r.purpose)) || ''); }
function invYm(r) { return String((r && (r.ym || (r.metadata && r.metadata.ym))) || ''); }
function invBucket(r) { return String((r && (r.bucket || r.status)) || ''); }
/**
 * Строки счётов юнита — те же правила, что _rowsForUnit в money.js: чужое здание
 * отбрасываем всегда, строку без buildingId (старые счета) принимаем.
 */
function invoicesForUnit(snap, building, unit) {
  const uid = String(unit && unit.id != null ? unit.id : '');
  const bid = String(building && building.id != null ? building.id : '');
  const out = [];
  for (const r of (snap.invoices || [])) {
    if (!r || invUnitId(r) !== uid) continue;
    const rb = invBuildingId(r);
    if (bid && rb && rb !== bid) continue;
    out.push(r);
  }
  return out;
}
/** Доказательство, что счёт без buildingId принадлежит этому юниту: тот же Stripe-клиент или штамп. */
function invoiceProvenForUnit(r, u) {
  const st = (u && u.stripe) || {};
  if (st.customerId && r.customerId === st.customerId) return true;
  return !!(r.id && (st.lastInvoiceId === r.id || (st.moveInRent && st.moveInRent.invoiceId === r.id)
    || (st.depositInvoice && (st.depositInvoice.invoiceId || st.depositInvoice.id) === r.id)));
}
function invoiceById(snap, id) {
  if (!id) return null;
  for (const r of (snap.invoices || [])) if (r && r.id === id) return r;
  return null;
}
function invoiceDto(r, fields) {
  const f = fields || {};
  const dto = {
    id: r.id || null,
    number: r.number || r.id || null,
    bucket: invBucket(r) || null,
    status: r.status || null,
    purpose: invPurpose(r) || null,
    ym: invYm(r) || null,
    unitId: invUnitId(r) || null,
    buildingId: invBuildingId(r) || null,
    amountUsd: round2(r.total),
    amountPaidUsd: round2(r.amountPaid),
    amountRemainingUsd: round2(r.amountRemaining),
    dueDate: nyIsoDate(r.dueDate),
    created: isoTs(r.created),
    hostedUrl: r.hostedUrl || null,
  };
  if (f.contacts) dto.customerEmail = r.customerEmail || null;
  return dto;
}
function invoiceBrief(r) {
  if (!r) return null;
  return {
    id: r.id || null, number: r.number || r.id || null, bucket: invBucket(r) || null,
    purpose: invPurpose(r) || null, ym: invYm(r) || null,
    amountUsd: round2(r.total), amountRemainingUsd: round2(r.amountRemaining),
    dueDate: nyIsoDate(r.dueDate), hostedUrl: r.hostedUrl || null,
  };
}
function isOpenBucket(b) { return b === 'open' || b === 'past_due' || b === 'sent'; }

// ─── Месяц: вердикт + Entry 70 ──────────────────────────────────────────────
/**
 * Entry 70 / RECONCILE_PLAN: запись {status:'paid', amount:0} — артефакт $0-бага,
 * «месяц НЕ закрыт» (functions/index.js — _monthSettled требует paid И amount>0).
 * Канонический _isMonthSettled / money.isMonthSettled такую запись считает 'paid'
 * (сумму не смотрит) — это задокументированный разъезд клиента; здесь шелл
 * игнорируется, и месяц идёт по остальным ярусам вердикта (штампы Stripe, кэш).
 * Узко: только явный числовой ноль; отсутствующая сумма — не шелл
 * (_computeUnitMoneyImpl трактует её как полную ренту).
 */
function isZeroPaidShell(p) {
  return !!(p && p.status === 'paid' && p.amount != null && p.amount !== '' && Number.isFinite(+p.amount) && +p.amount === 0);
}
// Клон head'а без шелл-записи и без groupId: money.leaseHead() вернёт сам клон, а
// остальные ярусы (_settle: штампы/кэш; _classify: due/overdue, прорейт, вейверы)
// отработают на тех же данных.
function probeWithoutShell(head, ym) {
  const payments = Object.assign({}, head.payments || {});
  delete payments[ym];
  const probe = Object.assign({}, head, { payments });
  delete probe.groupId; delete probe.groupRole;
  return probe;
}
/**
 * Классификация месяца для head'а лизы: {status, amountUsd, settledVia, zeroShell}.
 * status — money.monthStatus (paid|free|due|overdue|upcoming|ended|vacant|reserved|no_lease),
 * amountUsd — money.monthAmount (0, если не должен), settledVia — money.isMonthSettled
 * ('paid'|'free'|'stripe-paid'|null).
 */
function classifyMonth(head, ym, snap, money) {
  const p = head && head.payments && head.payments[ym];
  let subject = head;
  let zeroShell = false;
  if (isZeroPaidShell(p)) { subject = probeWithoutShell(head, ym); zeroShell = true; }
  const settledVia = money.isMonthSettled(subject, ym, snap) || null;
  const status = money.monthStatus(subject, ym, snap);
  const amountUsd = round2(money.monthAmount(subject, ym, snap));
  return { status, amountUsd, settledVia, zeroShell };
}
/**
 * Сколько реально получено за закрытый месяц (для totals леджера) — как paidYtd в
 * _computeUnitMoneyImpl ((+p.amount) || рента) и _stripePaidAmount (amountPaid > total).
 */
function paidAmountFor(head, ym, snap, building, cls) {
  const p = head.payments && head.payments[ym];
  if (cls.settledVia === 'paid') return round2((p && +p.amount) || effectiveRent(head));
  if (cls.settledVia === 'stripe-paid') {
    const st = head.stripe || {};
    const stamped = [];
    if (st.moveInRent && st.moveInRent.ym === ym && st.moveInRent.invoiceId) stamped.push(st.moveInRent.invoiceId);
    if (st.lastInvoiceYm === ym && st.lastInvoiceId) stamped.push(st.lastInvoiceId);
    let row = null;
    for (const id of stamped) { const r = invoiceById(snap, id); if (r && invBucket(r) === 'paid' && invPurpose(r) !== 'deposit') { row = r; break; } }
    if (!row) {
      const custId = st.customerId || null;
      const email = String(head.email || '').trim().toLowerCase();
      for (const r of invoicesForUnit(snap, building, head)) {
        if (invBucket(r) !== 'paid' || invPurpose(r) !== 'rent' || invYm(r) !== ym) continue;
        const rowEmail = String(r.customerEmail || '').trim().toLowerCase();
        if ((custId && r.customerId && r.customerId === custId) || (email && rowEmail && rowEmail === email)) { row = r; break; }
      }
    }
    if (row) { if (+row.amountPaid > 0) return round2(row.amountPaid); if (+row.total > 0) return round2(row.total); }
    return round2(effectiveRent(head));
  }
  return 0;
}
/** Первый открытый (open/past_due) rent-счёт по неоплаченным месяцам, старший месяц первым. */
function openRentInvoiceFor(head, yms, snap, money) {
  for (const ym of yms) {
    const r = money.liveInvoiceFor(head, 'rent', ym, snap);
    if (r && isOpenBucket(invBucket(r))) return r;
  }
  return null;
}
function lastReminderAt(u) {
  let best = null;
  for (const o of (Array.isArray(u && u.outreach) ? u.outreach : [])) {
    if (!o || (o.kind || o.type) !== 'reminder' || !o.ts) continue;
    if (!best || String(o.ts) > String(best)) best = o.ts;
  }
  return best;
}
function paymentDto(p, clamp) {
  if (!p) return null;
  const dto = {
    status: p.status ? clamp(p.status, 24) : null,
    amount: p.amount == null || p.amount === '' ? null : round2(p.amount),
    date: p.date ? clamp(p.date, 32) : null,
    paidVia: p.paidVia ? clamp(p.paidVia, 60) : null,
    paidMethod: p.paidMethod ? clamp(p.paidMethod, 60) : null,
    ref: (p.ref || p.paidReference) ? clamp(p.ref || p.paidReference, 80) : null,
    memo: clamp(p.memo, 120),
    recordedBy: (p.recordedBy || p.paidBy) ? clamp(p.recordedBy || p.paidBy, 120) : null,
    recordedAt: (p.recordedAt || p.paidAtIso) ? clamp(p.recordedAt || p.paidAtIso, 40) : null,
  };
  const bank = p.bankTxnId || (p.bank && p.bank.txnId) || (p.bankMatch && p.bankMatch.txnId);
  if (bank) dto.bankTxnId = bank;
  const sInv = p.stripeInvoiceId || (p.stripe && p.stripe.invoiceId);
  if (sInv) dto.stripeInvoiceId = sInv;
  if (p.status === 'free') {
    dto.waiverReason = p.waiverReason ? clamp(p.waiverReason, 160) : null;
    dto.waiverStart = p.waiverStart ? clamp(p.waiverStart, 32) : null;
    dto.waiverEnd = p.waiverEnd ? clamp(p.waiverEnd, 32) : null;
  }
  return dto;
}
/**
 * Статус депозита — чистый порт _unitDepositStatus :130209 / _isDepositPaid :96804
 * (без мутаций и localStorage): 'paid' | 'open' | 'overdue' | 'none' | null (нет арендатора).
 */
function depositState(head, snap, building) {
  if (!head || head.status !== 'occupied' || (!head.tenant && !head.company)) return null;
  const dp = head.payments && head.payments.deposit;
  if (dp && (dp.status === 'paid' || dp.status === 'free')) return 'paid';
  const di = head.stripe && head.stripe.depositInvoice;
  const diId = di && (di.invoiceId || di.id);
  if (di && di.status === 'paid') return 'paid';
  if (diId) {
    const row = invoiceById(snap, diId);
    const b = row ? invBucket(row) : '';
    if (b === 'paid') return 'paid';
    if (b === 'past_due' || b === 'uncollectible') return 'overdue';
    if (b === 'void') return 'none';
    return 'open';
  }
  // Штампов нет — скан кэша по клиенту текущего арендатора (_depositPaidFromCache).
  const custId = (head.stripe && head.stripe.customerId) || null;
  const email = String(head.email || '').trim().toLowerCase();
  for (const r of invoicesForUnit(snap, building, head)) {
    if (invPurpose(r) !== 'deposit' || invBucket(r) !== 'paid') continue;
    const rowEmail = String(r.customerEmail || '').trim().toLowerCase();
    if ((custId && r.customerId && r.customerId === custId) || (email && rowEmail && rowEmail === email)) return 'paid';
  }
  return 'none';
}

// ─── get_overdue ────────────────────────────────────────────────────────────
/**
 * overdueRows(snapshot, money, opts) → {asOf, currentYm, graceDays, totals, rows}
 * opts: {buildingId?, minAmountUsd?, limit?, includeContacts?, fields?}
 * Один ряд = одна лиза (head); месяц попадает в rows, когда monthStatus==='overdue'
 * (= _isUnitOverdue / красная плитка), сумма — monthAmount (прорейт месяца въезда,
 * вейвер-кредиты). Lease-start gate: без старта лизы арендатор в отчёт не идёт.
 */
function overdueRows(snapshot, money, opts) {
  const o = opts || {};
  const F = fieldsOf(o);
  const clamp = F.clamp;
  const snap = buildMoneySnap(snapshot);
  const now = snap.now;
  const today = isoOf(now);
  const curYm = ymOf(now);
  const grace = graceDaysOf(snap.settings);
  const windowFrom = addMonths(curYm, -(LOOKBACK_MONTHS - 1));
  const includeContacts = o.includeContacts !== false && F.contacts;
  const rows = [];
  for (const { b, f, u } of walkUnits(snap)) {
    if (o.buildingId && String(b.id) !== String(o.buildingId)) continue;
    if (!isBillableTenant(u, snap, money)) continue;
    const head = money.leaseHead(u, snap) || u;
    const startIso = leaseStartIso(head);
    if (!startIso) continue;                              // PAYMENTS_AND_FINANCE_RULES «Lease-start gate»
    const startYm = startIso.slice(0, 7);
    const fromYm = startYm > windowFrom ? startYm : windowFrom;
    const months = [];
    for (const ym of monthsBetween(fromYm, curYm)) {
      const c = classifyMonth(head, ym, snap, money);
      if (c.status !== 'overdue') continue;
      const dueIso = dueDateFor(ym, grace, startIso);
      const m = { ym, amountUsd: c.amountUsd, dueDate: dueIso, daysPastDue: Math.max(0, daysPastDue(dueIso, now)), status: c.status };
      if (c.zeroShell) m.note = 'paid record with $0 amount ignored (Entry 70)';
      months.push(m);
    }
    if (!months.length) continue;
    const total = round2(months.reduce((s, m) => s + m.amountUsd, 0));
    if (o.minAmountUsd != null && total < +o.minAmountUsd) continue;
    const maxDays = months[0].daysPastDue;                // старший месяц — первый
    const group = money.leaseGroup(head, snap);
    const st = head.stripe || {};
    const row = {
      buildingId: b.id, buildingName: clamp(b.name, 80), buildingCode: clamp(b.code, 16),
      floorId: f.id, unitId: head.id, suite: head.id,
      tenant: clamp(head.tenant, 120), company: clamp(head.company, 120),
    };
    if (includeContacts) { row.email = clamp(head.email, 120); row.phone = clamp(head.tel || head.phone, 40); }
    Object.assign(row, {
      leaseHeadUnitId: head.id,
      groupUnitIds: group.map((x) => x.id),
      leaseStart: startIso, leaseEnd: leaseEndIso(head), isMonthToMonth: money.isMonthToMonth(head),
      monthlyRentUsd: round2(effectiveRent(head)),
      months, totalOwedUsd: total, oldestDueDate: months[0].dueDate, maxDaysPastDue: maxDays, bucket: bucketFor(maxDays),
      collectionStatus: head.collectionStatus || '',
      lastReminderAt: lastReminderAt(head),
      stripe: {
        customerId: st.customerId || null, lastInvoiceId: st.lastInvoiceId || null, lastInvoiceYm: st.lastInvoiceYm || null,
        openInvoice: invoiceBrief(openRentInvoiceFor(head, months.map((m) => m.ym), snap, money)),
      },
    });
    rows.push(row);
  }
  rows.sort((a, b) => b.totalOwedUsd - a.totalOwedUsd || cmpNatural(a.buildingName, b.buildingName) || cmpNatural(a.unitId, b.unitId));
  const totalAmount = round2(rows.reduce((s, r) => s + r.totalOwedUsd, 0));
  const limit = Math.max(1, Math.min(+o.limit || 100, 200));
  const out = rows.slice(0, limit);
  return {
    asOf: today, currentYm: curYm, graceDays: grace,
    totals: { rows: rows.length, amountUsd: totalAmount, returned: out.length, truncated: out.length < rows.length },
    rows: out,
  };
}

// ─── search_units ───────────────────────────────────────────────────────────
/**
 * searchUnits(snapshot, money, opts) → {total, rows}
 * opts: {buildingId?, status?, floorId?, q?, sink?, shampoo?, window?, minSqft?, maxSqft?,
 *        rentableOnly? (default true), limit?, fields}
 * Пропускаем архивные и неактивные sub-room'ы (_vacancyCollect); member'ы групп
 * остаются (с groupRole), чтобы агент видел, что сьют занят лизой head'а.
 */
function searchUnits(snapshot, money, opts) {
  const o = opts || {};
  const F = fieldsOf(o);
  const clamp = F.clamp;
  const snap = buildMoneySnap(snapshot);
  const q = o.q ? String(o.q).toLowerCase().trim() : '';
  const rentableOnly = o.rentableOnly !== false;
  const rows = [];
  for (const { b, f, u } of walkUnits(snap)) {
    if (o.buildingId && String(b.id) !== String(o.buildingId)) continue;
    if (o.floorId && String(f.id) !== String(o.floorId)) continue;
    if (isArchivedUnit(u)) continue;
    if (rentableOnly && !isRentableUnit(u, money)) continue;
    if (isInactiveSubRoom(u, snap, money)) continue;
    const status = u.status || 'vacant';
    if (o.status && status !== o.status) continue;
    if (o.sink != null && !!u.sink !== !!o.sink) continue;
    if (o.shampoo != null && !!u.shampoo !== !!o.shampoo) continue;
    if (o.window != null && !!u.window !== !!o.window) continue;
    const sqft = +u.sqft || 0;
    if (o.minSqft != null && sqft < +o.minSqft) continue;
    if (o.maxSqft != null && sqft > +o.maxSqft) continue;
    if (q) {
      const hay = [u.id, u.tenant, u.company].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) continue;
    }
    const head = money.leaseHead(u, snap) || u;
    const row = {
      buildingId: b.id, buildingName: clamp(b.name, 80), floorId: f.id, floorName: clamp(f.name, 60),
      unitId: u.id, type: u.type || 'office', status, rentable: u.rentable !== false,
      sqft, cap: +u.cap || 0,
    };
    if (F.finance) { row.rentUsd = round2(u.rent); row.contractRentUsd = round2(+u.contractRent || 0); }
    row.tenant = clamp(u.tenant || (u.groupId ? head.tenant : ''), 120);
    row.company = clamp(u.company || (u.groupId ? head.company : ''), 120);
    if (F.contacts) { row.email = clamp(u.email || head.email, 120); row.phone = clamp(u.tel || u.phone || head.tel || head.phone, 40); }
    Object.assign(row, {
      window: !!u.window, sink: !!u.sink, shampoo: !!u.shampoo,
      leaseStart: leaseStartIso(head), leaseEnd: toIso(head.leaseEnd || ''), until: toIso(head.until || ''),
      groupId: u.groupId || null, groupRole: u.groupId ? (u.groupRole || 'member') : null,
      leaseHeadUnitId: head.id, parentId: u.parentId || null,
    });
    if (F.notes) row.note = clamp(u.note, 200);
    rows.push(row);
  }
  rows.sort((a, b) => cmpNatural(a.buildingName, b.buildingName) || cmpNatural(a.floorName, b.floorName) || cmpNatural(a.unitId, b.unitId));
  const limit = Math.max(1, Math.min(+o.limit || 100, 300));
  const out = rows.slice(0, limit);
  return { total: rows.length, returned: out.length, truncated: out.length < rows.length, rows: out };
}

// ─── get_unit ───────────────────────────────────────────────────────────────
/**
 * unitCard(snapshot, money, {buildingId, unitId, ym?, fields}) → карточка | null (нет юнита).
 * Денежный блок считается по head'у лизы (money.leaseHead — ОБЯЗАТЕЛЬНО первым).
 */
function unitCard(snapshot, money, opts) {
  const o = opts || {};
  const F = fieldsOf(o);
  const clamp = F.clamp;
  const snap = buildMoneySnap(snapshot);
  const hit = findUnit(snap, o.buildingId, o.unitId);
  if (!hit) return null;
  const { b, f, u } = hit;
  const now = snap.now;
  const curYm = ymOf(now);
  const ym = (o.ym && YM_RE.test(String(o.ym))) ? String(o.ym) : curYm;
  const head = money.leaseHead(u, snap) || u;
  const headHit = head === u ? hit : (floorOfUnit(snap, head) || hit);
  const group = money.leaseGroup(u, snap);
  const card = {
    buildingId: b.id, buildingName: clamp(b.name, 80), buildingCode: clamp(b.code, 16),
    floorId: f.id, floorName: clamp(f.name, 60), unitId: u.id, suite: u.id,
    type: u.type || 'office', status: u.status || 'vacant', rentable: u.rentable !== false, archived: isArchivedUnit(u),
    sqft: +u.sqft || 0, cap: +u.cap || 0,
    window: !!u.window, windowSide: u.windowSide || null, sink: !!u.sink, shampoo: !!u.shampoo,
    parentId: u.parentId || null, groupId: u.groupId || null, groupRole: u.groupId ? (u.groupRole || 'member') : null,
    leaseHeadUnitId: head.id, groupUnitIds: group.map((x) => x.id),
    isFinanceShadow: money.isFinanceShadow(u, snap),
  };
  if (F.notes) card.note = clamp(u.note, 500);
  card.tenant = { tenant: clamp(u.tenant || head.tenant, 120), company: clamp(u.company || head.company, 120) };
  if (F.contacts) { card.tenant.email = clamp(u.email || head.email, 120); card.tenant.phone = clamp(u.tel || u.phone || head.tel || head.phone, 40); }
  card.lease = {
    leaseStart: leaseStartIso(head), leaseEnd: toIso(head.leaseEnd || ''), until: toIso(head.until || ''),
    leaseTerm: head.leaseTerm != null ? String(head.leaseTerm) : '', signed: toIso(head.signed || ''),
    isMonthToMonth: money.isMonthToMonth(head),
  };
  if (F.finance) {
    card.lease.contractRentUsd = round2(+head.contractRent || 0);
    card.lease.rentUsd = round2(u.rent);
    card.lease.deposit = round2(head.deposit);
    card.lease.depositStatus = depositState(head, snap, headHit.b);
    // Денежный блок — по head'у; владение месяцами как в get_overdue.
    const cls = classifyMonth(head, ym, snap, money);
    const v = money.verdict(head, ym, snap);
    const grace = graceDaysOf(snap.settings);
    const startIso = leaseStartIso(head);
    const unpaid = [];
    let owed = 0, outstanding = 0;
    if (startIso) {
      const windowFrom = addMonths(curYm, -(LOOKBACK_MONTHS - 1));
      const startYm = startIso.slice(0, 7);
      const fromYm = startYm > windowFrom ? startYm : windowFrom;
      for (const m of monthsBetween(fromYm, curYm)) {
        const c = classifyMonth(head, m, snap, money);
        if (!money.UNPAID.has(c.status)) continue;
        outstanding += c.amountUsd;
        if (c.status !== 'overdue') continue;
        owed += c.amountUsd;
        const dueIso = dueDateFor(m, grace, startIso);
        const row = { ym: m, amountUsd: c.amountUsd, dueDate: dueIso, daysPastDue: Math.max(0, daysPastDue(dueIso, now)), status: c.status };
        if (c.zeroShell) row.note = 'paid record with $0 amount ignored (Entry 70)';
        unpaid.push(row);
      }
    }
    card.money = {
      currentYm: ym, currentMonthStatus: cls.status, currentMonthAmountUsd: cls.amountUsd, settledVia: cls.settledVia,
      detail: clamp(v.detail, 200), source: clamp(v.source, 200),   // source несёт waiverReason / paidVia — данные оператора
      owedUsd: round2(owed), outstandingUsd: round2(outstanding), unpaidMonths: unpaid,
      leaseStartGate: startIso ? 'ok' : 'lease start not set — no money computed',
    };
    const st = head.stripe || {};
    // Список со ссылками на оплату: старый счёт без buildingId показываем только с
    // доказательством (тот же Stripe-клиент или штамп на юните) — иначе в карточке
    // оказался бы счёт одноимённого сьюта другого здания (Entry 88 / 102).
    const open = invoicesForUnit(snap, headHit.b, head).filter((r) => isOpenBucket(invBucket(r)) && (invBuildingId(r) || invoiceProvenForUnit(r, head)))
      .sort((x, y) => (+y.created || 0) - (+x.created || 0)).map(invoiceBrief);
    card.stripe = {
      customerId: st.customerId || null, lastInvoiceId: st.lastInvoiceId || null, lastInvoiceYm: st.lastInvoiceYm || null,
      autoSentYm: st.autoSentYm || null, openInvoices: open,
    };
  }
  if (F.notes) {
    const envs = Array.isArray(head.leaseEnvelopes) ? head.leaseEnvelopes : [];
    card.docusign = {
      currentLeaseEnvelopeId: head.currentLeaseEnvelopeId || null,
      envelopes: envs.filter(Boolean).map((e) => ({ envelopeId: e.envelopeId || e.id || null, status: e.status || null, sentAt: e.sentAt || null, completedAt: e.completedAt || null })),
    };
    card.collectionStatus = head.collectionStatus || '';
    card.outreach = (Array.isArray(head.outreach) ? head.outreach : []).filter(Boolean).slice(-5).reverse()
      .map((x) => ({ ts: x.ts || null, kind: x.kind || x.type || null, note: clamp(x.note || x.text, 160), by: clamp(x.by, 80) }));
  }
  if (F.contacts) {
    const ps = Array.isArray(u.prospects) ? u.prospects.filter(Boolean) : [];
    const stages = {};
    for (const p of ps) { const s = String(p.stage || 'unknown'); stages[s] = (stages[s] || 0) + 1; }
    card.prospects = {
      count: ps.length, stages,
      items: ps.slice(-10).map((p) => ({ id: p.id || null, name: clamp(p.name, 80), company: clamp(p.company, 80), stage: p.stage || null, updatedAt: p.lastTouchedAt || p.lastUpdate || p.createdAt || null })),
    };
  }
  return card;
}

// ─── get_unit_ledger ────────────────────────────────────────────────────────
/**
 * ledgerRows(snapshot, money, {buildingId, unitId, months? (≤24, default 12), fields}) → леджер | null.
 * Месяцы от текущего назад, никогда раньше старта лизы; без старта — пустой леджер + note.
 */
function ledgerRows(snapshot, money, opts) {
  const o = opts || {};
  const F = fieldsOf(o);
  const clamp = F.clamp;
  const snap = buildMoneySnap(snapshot);
  const hit = findUnit(snap, o.buildingId, o.unitId);
  if (!hit) return null;
  const { u } = hit;
  const head = money.leaseHead(u, snap) || u;
  const headHit = head === u ? hit : (floorOfUnit(snap, head) || hit);
  const nMonths = Math.max(1, Math.min(Math.round(+o.months || 12), 24));
  const curYm = ymOf(snap.now);
  const startIso = leaseStartIso(head);
  const out = {
    buildingId: hit.b.id, unitId: u.id, leaseHeadUnitId: head.id, groupUnitIds: money.leaseGroup(u, snap).map((x) => x.id),
    tenant: clamp(u.tenant || head.tenant, 120), company: clamp(u.company || head.company, 120),
    currentYm: curYm, leaseStart: startIso, monthlyRentUsd: round2(effectiveRent(head)),
    months: [], deposit: null, totals: { paidUsd: 0, owedUsd: 0, outstandingUsd: 0 },
  };
  const dp = head.payments && head.payments.deposit;
  if (dp) out.deposit = { status: dp.status ? clamp(dp.status, 24) : null, amountUsd: round2(+dp.amount || +head.deposit || 0), date: dp.date ? clamp(dp.date, 32) : null };
  else if (head.stripe && head.stripe.depositInvoice) {
    const di = head.stripe.depositInvoice;
    out.deposit = { status: di.status ? clamp(di.status, 24) : null, amountUsd: round2(di.amount), date: di.paidAt ? clamp(di.paidAt, 40) : null, invoiceId: di.invoiceId || di.id || null };
  }
  if (!startIso) { out.note = 'lease start not set'; return out; }
  const startYm = startIso.slice(0, 7);
  let paid = 0, owed = 0, outstanding = 0;
  for (let i = 0; i < nMonths; i++) {
    const ym = addMonths(curYm, -i);
    if (ym < startYm) break;
    const c = classifyMonth(head, ym, snap, money);
    const p = head.payments && head.payments[ym];
    const inv = money.liveInvoiceFor(head, 'rent', ym, snap);
    const row = { ym, status: c.status, amountUsd: c.amountUsd, settledVia: c.settledVia, payment: paymentDto(p, clamp), invoice: invoiceBrief(inv) };
    if (c.zeroShell) row.note = 'paid record with $0 amount ignored (Entry 70)';
    if (c.status === 'paid') paid += paidAmountFor(head, ym, snap, headHit.b, c);
    if (money.UNPAID.has(c.status)) outstanding += c.amountUsd;
    if (c.status === 'overdue') owed += c.amountUsd;
    out.months.push(row);
  }
  out.totals = { paidUsd: round2(paid), owedUsd: round2(owed), outstandingUsd: round2(outstanding) };
  return out;
}

// ─── list_invoices ──────────────────────────────────────────────────────────
/**
 * filterInvoices(snapshot, money, {buildingId?, unitId?, bucket?, purpose?, ym?, limit?, fields}) → {total, rows}
 * Доступ: строка с buildingId — только доступное здание; без buildingId — только если
 * unitId есть в доступном здании (номера сьютов повторяются между зданиями, § 4.2).
 */
function filterInvoices(snapshot, money, opts) {
  const o = opts || {};
  const F = fieldsOf(o);
  const snap = buildMoneySnap(snapshot);
  const unitsBy = unitIdsByBuilding(snap);
  const accessible = new Set(snap.buildings.map((b) => String(b.id)));
  const anyHas = (uid) => { for (const set of unitsBy.values()) if (set.has(uid)) return true; return false; };
  // Entry 88 / 102: номер сьюта уникален только внутри здания. Старый счёт без buildingId
  // с номером, который встречается в НЕСКОЛЬКИХ зданиях workspace (включая недоступные
  // ключу), показываем только с доказательством принадлежности доступному юниту: тот же
  // Stripe-клиент или id, проштампованный на юните. Иначе ключ здания A увидел бы счёт
  // одноимённого сьюта здания B.
  const allBy = unitIdsByBuilding({ buildings: Array.isArray((snapshot || {}).allBuildings) ? snapshot.allBuildings : snap.buildings });
  const buildingsWith = (uid) => { let n = 0; for (const set of allBy.values()) if (set.has(uid)) n++; return n; };
  const provenFor = (r, uid) => {
    for (const { u } of walkUnits(snap)) {
      if (String(u.id) !== uid) continue;
      if (invoiceProvenForUnit(r, u)) return true;
    }
    return false;
  };
  const rows = [];
  for (const r of (snap.invoices || [])) {
    if (!r) continue;
    const bid = invBuildingId(r), uid = invUnitId(r);
    if (bid) { if (!accessible.has(bid)) continue; }
    else if (!uid || !anyHas(uid)) continue;
    else if (buildingsWith(uid) > 1 && !provenFor(r, uid)) continue;
    if (o.buildingId) {
      const want = String(o.buildingId);
      if (bid ? bid !== want : !(unitsBy.get(want) && unitsBy.get(want).has(uid))) continue;
    }
    if (o.unitId && uid !== String(o.unitId)) continue;
    if (o.bucket && invBucket(r) !== String(o.bucket)) continue;
    if (o.purpose && invPurpose(r) !== String(o.purpose)) continue;
    if (o.ym && invYm(r) !== String(o.ym)) continue;
    rows.push(r);
  }
  rows.sort((a, b) => (+b.created || 0) - (+a.created || 0));
  const limit = Math.max(1, Math.min(+o.limit || 100, 200));
  const out = rows.slice(0, limit).map((r) => invoiceDto(r, F));
  return {
    total: rows.length, returned: out.length, truncated: out.length < rows.length,
    totals: {
      amountUsd: round2(rows.reduce((s, r) => s + (+r.total || 0), 0)),
      amountRemainingUsd: round2(rows.reduce((s, r) => s + (+r.amountRemaining || 0), 0)),
    },
    rows: out,
  };
}

module.exports = {
  // снимок / классификация
  buildMoneySnap, classifyMonth, isZeroPaidShell, depositState, paidAmountFor,
  // отчёты
  overdueRows, searchUnits, unitCard, ledgerRows, filterInvoices,
  // хелперы
  effectiveRent, leaseStartIso, leaseEndIso, monthsBetween, addMonths, dueDateFor, daysPastDue, bucketFor, graceDaysOf,
  nyWallClock, nyIsoDate, toIso, clampText, isBillableTenant, isInactiveSubRoom, findUnit, invoicesForUnit, invoiceDto, invoiceBrief,
  LOOKBACK_MONTHS,
};
