/* m/ui/unit.js — карточка юнита: вердикт, факты, полгода истории, действия.
   Чистый UI-модуль: денежные вердикты только из ctx.money, никакого Firebase.
   Юнит НЕ кэшируем между рендерами — резолвим по id из свежего ctx.snap:
   listener зданий подменяет объект целиком, ссылка протухает молча.
   Контракт: render(ctx) -> HTML, foot(ctx) -> HTML, handle(act, el, ctx) -> bool. */

const I = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 3 2 20h20L12 3z"/><line x1="12" y1="9" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M2.5 10h19"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
};

const STATUS_ICON = {
  paid: I.check, free: I.check, invoiced: I.mail, due: I.clock,
  overdue: I.alert, idle: I.dash, vacant: I.dash, reserved: I.doc,
};
const FALLBACK_LABELS = {
  paid: 'Paid', free: 'Waived', invoiced: 'Invoice sent', due: 'Due',
  overdue: 'Not paid', idle: 'Not billed', vacant: 'Vacant', reserved: 'Reserved',
};
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/* Писать деньги может только editor (CF требует requireEditor). Незнакомую
   или ещё не подъехавшую роль НЕ блокируем — иначе админ на холодном старте
   останется без кнопок; сервер всё равно последняя инстанция. */
const KNOWN_ROLES = { admin: 1, manager: 1, mapeditor: 1, teamviewer: 1, viewer: 1 };
const EDITOR_ROLES = { admin: 1, manager: 1 };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function m$(ctx, n) {
  // Точный формат: карточка одного юнита, а не сводка. Рядом стоит вердикт из
  // money.js с центами — округление здесь давало расхождение в те же центы.
  try { return ctx.fmt.money2 ? ctx.fmt.money2(n) : ctx.fmt.money(n); }
  catch (_) { return '$' + Math.round(+n || 0).toLocaleString('en-US'); }
}
/**
 * Аренда, которую надо ПОКАЗАТЬ. У member-сьюта мульти-сьютовой лизы свои
 * денежные поля пустые (в проде буквально rent = 0), поэтому карточка писала
 * «Rent $0/mo» и «August rent $0» рядом с «$13,318.33 past due». Берём ставку
 * лизы с её head'а — ровно так же, как её берёт вердикт.
 */
function rentShown(ctx, u) { return fromLeaseHead(ctx, u, rentOf); }
/**
 * Значение с ГОЛОВЫ лизы, если на самом юните его нет.
 * У мульти-сьютовой лизы (National University — 6 сьютов под одним договором)
 * деньги лежат только на главном сьюте, у остальных 0. Аренда это уже
 * учитывала, а депозит читался как +u.deposit и показывал члену лизы $0.
 */
function fromLeaseHead(ctx, u, pick) {
  const own = pick(u);
  if (own > 0) return own;
  try {
    const head = ctx.money && typeof ctx.money.leaseHead === 'function' ? ctx.money.leaseHead(u, ctx.snap) : null;
    if (head && head !== u) return pick(head);
  } catch (_) { /* деньги молчат */ }
  return own;
}
const depositShown = (ctx, u) => fromLeaseHead(ctx, u, x => (+(x && x.deposit) || 0));
function dLong(ctx, iso) {
  try { return ctx.fmt.dateLong(iso) || ''; } catch (_) { return String(iso || ''); }
}
function todayYm() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function addMonths(ym, delta) {
  const y = +String(ym).slice(0, 4), mo = +String(ym).slice(5, 7);
  const d = new Date(y, mo - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
const monthShort = ym => MONTHS_SHORT[(+String(ym).slice(5, 7) || 1) - 1] || '';
const monthLong = ym => MONTHS_LONG[(+String(ym).slice(5, 7) || 1) - 1] || '';
const digits = s => String(s == null ? '' : s).replace(/\D+/g, '');
const rentOf = u => (+(u && u.contractRent) || +(u && u.rent) || 0);
const isSettled = st => st === 'paid' || st === 'free';


/* Жилой ли юнит (apt_*). Канон — ctx.money.isAptType; локальный фолбэк на случай
   старого закэшированного money.js без экспорта (fail-safe: ведём себя как офис
   не будем — просто прочитаем префикс сами, как esc/todayYm-копии). */
function isAptUnit(ctx, u) {
  try {
    if (ctx && ctx.money && typeof ctx.money.isAptType === 'function') return !!ctx.money.isAptType(u && u.type);
  } catch (_) { /* деньги молчат */ }
  return String((u && u.type) || '').slice(0, 4) === 'apt_';
}

function canSend(snap) {
  const r = snap && snap.role;
  if (!r || !KNOWN_ROLES[r]) return true;
  return !!EDITOR_ROLES[r];
}

/* ---------- резолв юнита ----------
   Сначала строго внутри своего здания: id сьютов повторяются между зданиями,
   и глобальный поиск по unitId — ровно тот баг, из-за которого платежи
   утекали между домами. Глобальный проход только если здание не нашлось. */
function resolve(ctx) {
  const S = ctx.S || {};
  const snap = ctx.snap || {};
  const blds = Array.isArray(snap.buildings) ? snap.buildings : [];
  const ref = S.unit || S.payload || S.sheetPayload || (S.sheet && S.sheet.payload) || null;
  if (!ref || !blds.length) return null;

  const isStr = typeof ref === 'string';
  const uid = isStr ? ref : String(ref.unitId || ref.id || '');
  const bid = isStr ? (S.buildingId || S.scope || '') : String(ref.buildingId || ref.bid || S.buildingId || '');
  const fid = isStr ? '' : String(ref.floorId || ref.fid || '');
  if (!uid) return null;

  const pick = (b) => {
    const floors = Array.isArray(b.floors) ? b.floors : [];
    for (const f of floors) {
      if (fid && String(f.id) !== fid) continue;
      const u = (Array.isArray(f.units) ? f.units : []).find(x => x && String(x.id) === uid);
      if (u) return { u, f, b };
    }
    if (fid) {
      for (const f of floors) {
        const u = (Array.isArray(f.units) ? f.units : []).find(x => x && String(x.id) === uid);
        if (u) return { u, f, b };
      }
    }
    if (!floors.length && Array.isArray(b.units)) {
      const u = b.units.find(x => x && String(x.id) === uid);
      if (u) return { u, f: null, b };
    }
    return null;
  };

  const home = bid && blds.find(b => b && (String(b.id) === bid || b.code === bid));
  if (home) return pick(home);
  for (const b of blds) { const hit = pick(b); if (hit) return hit; }
  return null;
}

function stOf(ctx, u, ym) {
  try {
    const raw = ctx.money.monthStatus(u, ym, ctx.snap);
    return typeof raw === 'string' ? raw : (raw && (raw.status || raw.state)) || 'idle';
  } catch (_) { return 'idle'; }
}
function verdictOf(ctx, u, ym) {
  try {
    const v = ctx.money.verdict(u, ym, ctx.snap);
    if (v && typeof v === 'object') return v;
  } catch (_) { /* деньги молчат */ }
  const st = stOf(ctx, u, ym);
  return { status: st, label: FALLBACK_LABELS[st] || st, detail: '', source: '' };
}
function labelOf(ctx, st) {
  const L = ctx.money && ctx.money.STATUS_LABELS;
  return FALLBACK_LABELS[st] || (L && L[st]) || st || '';
}

/* Провенанс (улучшение 2): «оплачено» без источника — это не ответ. */
const SOURCE_TEXT = {
  stripe: 'Stripe invoice', 'stripe-paid': 'Stripe invoice', invoice: 'Stripe invoice',
  manual: 'Manual entry', local: 'Manual entry', ledger: 'Manual entry', paid: 'Manual entry',
  free: 'Waived by operator', waiver: 'Waived by operator', waived: 'Waived by operator',
};
function provenance(v) {
  const raw = String((v && v.source) || '');
  if (!raw) return '';
  // В нижний регистр приводим ТОЛЬКО ключ поиска. Печатали lowercase-версию, и
  // номер счёта R-CEN-301-2026-08 превращался в r-cen-301-2026-08 — оператор не
  // нашёл бы его ни в Stripe, ни в таблице счетов полной версии.
  const key = raw.toLowerCase();
  return SOURCE_TEXT[key] || (raw.charAt(0).toUpperCase() + raw.slice(1));
}

/* Живой (не оплаченный и не убитый) счёт за этот месяц — есть ли что напоминать.
   ym матчим ТОЧНО, без created-date фолбэка, и скоупим по клиенту текущего
   арендатора: id сьютов повторяются между зданиями. */
/**
 * Живой счёт за месяц — ТОЛЬКО из денежной модели.
 *
 * Здесь была своя реализация, и она расходилась с моделью по трём пунктам:
 * не звала leaseHead (у члена мульти-сьютовой лизы счёт лежит на главном
 * сьюте), требовала совпадения customerId/почты (юнит без них не видел
 * СВОЕГО счёта) и знала только bucket open|past_due. Из-за этого карточка и
 * экран Payments показывали разное про один и тот же счёт, а «Remind»
 * пропадала там, где он есть.
 */
function openInvoice(ctx, u, ym) {
  try {
    const head = (ctx.money && ctx.money.leaseHead) ? ctx.money.leaseHead(u, ctx.snap) : u;
    const r = (ctx.money && ctx.money.liveInvoiceFor)
      ? ctx.money.liveInvoiceFor(head, 'rent', ym, ctx.snap) : null;
    if (!r) return null;
    const b = r.bucket || r.status;
    return (b === 'paid') ? null : r;      // напоминать об оплаченном нечего
  } catch (e) { return null; }
}

/* Открытая лиза: 'mtm'/'m2m'/'1', пустой конец, или конец раньше старта.
   Зеркало десктопного _isMonthToMonth — здесь только для подписи «Lease ends». */
function isMonthToMonth(u) {
  const t = String((u && u.leaseTerm) || '').trim().toLowerCase();
  if (t === 'mtm' || t === 'm2m' || t === '1') return true;
  const s = String((u && (u.leaseStart || u.signed)) || '').slice(0, 10);
  const e = String((u && (u.until || u.leaseEnd)) || '').slice(0, 10);
  return !!(s && e && e < s);
}
function leaseEnd(ctx, u) {
  const direct = String((u && (u.until || u.leaseEnd)) || '').slice(0, 10);
  if (direct) return direct;
  const start = String((u && (u.leaseStart || u.signed)) || '').slice(0, 10);
  const term = +(u && u.leaseTerm);
  if (start && Number.isFinite(term) && term > 1) {
    try { return ctx.money.leaseEndFromStartTerm(start, term) || ''; } catch (_) { return ''; }
  }
  return '';
}

/* Какое ОДНО действие имеет смысл прямо сейчас (улучшение 3). */
function plan(ctx, hit, v, ym) {
  const u = hit.u;
  // v.ui — словарь ИНТЕРФЕЙСА (money.uiStatus), в нём есть «invoiced».
  // v.status — словарь денежной модели, где такого значения НЕТ ВООБЩЕ: ветка
  // ниже была недостижима, и при живом счёте в грейс-периоде карточка
  // предлагала выставить ВТОРОЙ счёт за тот же месяц.
  const st = v.ui || v.status;
  const occupied = u.status === 'occupied' || !!(u.tenant || u.company);
  if (!occupied || st === 'vacant') return { kind: 'lease' };
  if (isSettled(st)) return { kind: 'quiet' };
  // Месяц ДО начала аренды (или после её конца) выставлять не за что: главной
  // кнопкой был «Send invoice», и одно касание открывало счёт за август
  // арендатору, который въезжает 1 сентября. Счёт остаётся доступен, но тихо.
  if (['upcoming', 'ended', 'no_lease', 'reserved'].includes(v.status)) return { kind: 'quiet' };
  const inv = openInvoice(ctx, u, ym);
  /* Напоминать можно только о существующем счёте — «Remind» без счёта
     это письмо в никуда, поэтому просроченный без счёта идёт на выставление. */
  if (st === 'invoiced' || (st === 'overdue' && inv)) return { kind: 'remind', inv };
  return { kind: 'invoice' };
}

/* ---------- render ---------- */
/* Десктоп архивирует полем deletedAt (MONO:30443); archivedAt проверяем на
   всякий случай — так же, как payments/lease/app. Карточка этого НЕ проверяла:
   архивный сьют открывался как живой, с балансом и кнопкой отправки счёта. */
const isArchived = u => !!(u && (u.deletedAt || u.archivedAt));

/** Сколько дней назад, по часам снимка (в тестах время задаётся, а не берётся). */
function daysSince(ctx, iso) {
  const t = Date.parse(String(iso || '').slice(0, 10));
  if (!Number.isFinite(t)) return 0;
  const now = (ctx && ctx.snap && Number.isFinite(ctx.snap.now)) ? ctx.snap.now : Date.now();
  return Math.max(0, Math.floor((now - t) / 86400000));
}

function archivedCard(u, b, close) {
  const where = String((b && (b.name || b.id)) || '').trim();
  return '<div class="sheet-h"><div><h3>Suite ' + esc(String(u.id || '')) + ' is archived</h3>'
    + '<p>' + esc(['This suite was removed from the building', where].filter(Boolean).join(' · '))
    + '. Nothing can be billed or leased here.</p></div>' + close + '</div>'
    + '<div class="empty">Restore it on the desktop first if this is wrong.</div>';
}

export function render(ctx) {
  const hit = resolve(ctx);
  const close = '<button class="x-btn" data-act="close" aria-label="Close">✕</button>';
  if (!hit) {
    return '<div class="sheet-h"><div><h3>Unit not found</h3>'
      + '<p>It is not in the current snapshot — it may have been archived.</p></div>' + close + '</div>'
      + '<button class="act-row" data-act="refresh">' + I.ext
      + '<span><span class="t">Refresh</span><span class="s">pull the latest data</span></span></button>';
  }
  const { u, f, b } = hit;
  if (isArchived(u)) return archivedCard(u, b, close);
  const S = ctx.S || {};
  const ym = S.ym || todayYm();
  const v = verdictOf(ctx, u, ym);
  const st = v.status || 'idle';
  // Тип юнита сильнее флага здания (жилые apt_*); флаг остаётся запасным
  // вариантом для целиком жилого корпуса.
  const apt = isAptUnit(ctx, u) || !!(b && (b.apt || b.residential || b.kind === 'residential'));
  const suite = (apt ? 'Apt ' : 'Suite ') + String(u.id || '');
  const name = u.tenant || u.company || 'Vacant unit';
  const rent = rentShown(ctx, u);
  const amount = (v.amount != null) ? +v.amount : rent;

  const sub = [suite, (b && (b.name || b.id)) || '', u.sqft ? (+u.sqft).toLocaleString('en-US') + ' ft²' : '']
    .filter(Boolean).join(' · ');
  let h = '<div class="sheet-h"><div><h3>' + esc(name) + '</h3>'
    + '<p>' + esc(sub) + '</p></div>' + close + '</div>';

  /* --- вердикт: слово, деталь, происхождение --- */
  // Ренту за месяц дописываем ТОЛЬКО когда она за этот месяц причитается.
  // У сьютов 201 и 204 аренда начинается 1 сентября, а карточка за август
  // писала «August rent $4,000» рядом с балансом $0 — оператор читает это
  // как долг, которого нет.
  const owes = !['upcoming', 'ended', 'reserved', 'no_lease', 'vacant'].includes(v.status);
  const detail = [v.detail || labelOf(ctx, st), owes ? monthLong(ym) + ' rent ' + m$(ctx, rent) : '']
    .filter(Boolean).join(' · ');
  const prov = provenance(v) || (isSettled(st) ? 'Source not recorded' : '');
  h += '<div class="verdict" data-s="' + esc(st) + '"><span class="vi">' + (STATUS_ICON[st] || I.dash) + '</span>'
    + '<span><span class="vt">' + esc(v.label || labelOf(ctx, st)) + '</span>'
    + '<span class="vs">' + esc(detail) + '</span>'
    + (prov ? '<span class="vs" style="margin-top:3px;font-size:11.5px;color:var(--ink-3)">' + esc(prov) + '</span>' : '')
    + '</span></div>';

  /* --- мульти-сьютовая лиза: сумма относится ко ВСЕЙ лизе, а не к этому сьюту.
     В проде такое есть (одна лиза на шесть сьютов, $13,318.33). Без этой строки
     оператор прочитает сумму как цену одного сьюта и назовёт арендатору не то
     число. Ту же оговорку делает лист счёта. --- */
  h += groupNote(ctx, u);
  h += pendingLeases(ctx, u);

  /* --- факты --- */
  const balance = isSettled(st) ? 0 : amount;
  const endIso = leaseEnd(ctx, u);
  const endTxt = isMonthToMonth(u) || !endIso ? 'Month-to-month' : dLong(ctx, endIso);
  h += '<div class="facts">'
    + '<div class="fact"><div class="k">Balance</div><div class="v"'
    + (st === 'overdue' ? ' style="color:var(--bad)"' : '') + '>' + m$(ctx, balance) + '</div></div>'
    + '<div class="fact"><div class="k">Rent</div><div class="v">' + m$(ctx, rent) + '/mo</div></div>'
    + '<div class="fact"><div class="k">Deposit</div><div class="v">' + m$(ctx, depositShown(ctx, u)) + '</div></div>'
    + '<div class="fact"><div class="k">Lease ends</div><div class="v sm">' + esc(endTxt) + '</div></div>'
    + '</div>';

  /* --- полгода истории --- */
  h += '<div style="font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);font-weight:700;margin-bottom:7px">Last 6 months</div>';
  h += '<div class="hist">' + [5, 4, 3, 2, 1, 0].map(back => {
    const mym = addMonths(ym, -back);
    const ms = back === 0 ? st : stOf(ctx, u, mym);
    const bar = isSettled(ms) ? 'paid'
      : ms === 'overdue' ? 'overdue'
        : ms === 'invoiced' ? 'invoiced'
          : ms === 'due' ? 'due' : 'none';
    /* display:block обязателен: .hm-b в CSS — span без display, а высота
       на инлайновом элементе игнорируется, и столбик рисуется 0x0 (невидимо). */
    return '<span class="hm" data-s="' + bar + '" title="' + esc(monthShort(mym) + ' — ' + labelOf(ctx, ms)) + '">'
      + '<span class="hm-b" style="display:block"></span>'
      + '<span class="hm-m">' + esc(monthShort(mym)) + '</span></span>';
  }).join('') + '</div>';

  /* --- второстепенные действия: звонок, почта, ручная отметка --- */
  const tel = digits(u.tel || u.phone);
  const email = String(u.email || '').trim();
  const linkStyle = ' style="text-decoration:none;color:inherit"';
  h += '<div class="acts">'
    + (tel
      ? '<a class="act" href="tel:' + esc(tel) + '"' + linkStyle + '>' + I.phone + 'Call</a>'
      : '<button class="act" data-act="nophone" style="opacity:.55">' + I.phone + 'Call</button>')
    + (/@/.test(email)
      ? '<a class="act" href="mailto:' + esc(email) + '"' + linkStyle + '>' + I.mail + 'Email</a>'
      : '<button class="act" data-act="noemail" style="opacity:.55">' + I.mail + 'Email</button>')
    /* Третьим действием стояла «Mark paid», которая открывала несуществующий
       лист — тупик. Запись оплаты с телефона в V1 не делаем сознательно: она
       пишет весь объект здания целиком и конфликтует с записями Cloud Functions
       (та самая ловушка whole-object-swap). Вместо неё — SMS: оператор стоит в
       офисе арендатора, и это ровно то, что там нужно. */
    + (tel
      ? '<a class="act" href="sms:' + esc(tel) + '?&body=' + encodeURIComponent(smsBody(u, ctx)) + '"' + linkStyle + '>' + I.send + 'Text</a>'
      : '<button class="act" data-act="nophone" style="opacity:.55">' + I.send + 'Text</button>')
    + '</div>';

  // ?desktop=1 обязателен: полная версия сама уводит телефоны на /m, и без
  // метки эта ссылка открыла бы новую вкладку, которая тут же вернётся сюда.
  h += '<a class="act-row" href="/floor-map-editor.html?desktop=1" target="_blank" rel="noopener"' + linkStyle + '>' + I.ext
    + '<span><span class="t">Open in full version</span>'
    + '<span class="s">floor plan, documents, ledger</span></span></a>';

  /* Подпись под действиями — на телефоне полезно видеть, кого именно звать. */
  if (tel || email) {
    h += '<div style="font-size:11.5px;color:var(--ink-3);margin-top:2px">'
      + esc([u.tel || u.phone || '', email].filter(Boolean).join(' · ')) + '</div>';
  }
  return h;
}

/* ---------- sticky footer: ОДНО главное действие по состоянию ---------- */
export function foot(ctx) {
  const hit = resolve(ctx);
  if (!hit || isArchived(hit.u)) return '';
  const ym = (ctx.S && ctx.S.ym) || todayYm();
  const v = verdictOf(ctx, hit.u, ym);
  const p = plan(ctx, hit, v, ym);

  if (!canSend(ctx.snap)) {
    return '<button class="big-btn ghost" data-act="noedit" style="flex:1 1 auto">Your role cannot send money</button>';
  }
  if (p.kind === 'quiet') {
    /* Заплачено — ничего не навязываем: тихая вторичная кнопка. */
    return '<button class="big-btn ghost" data-act="sendinvoice" style="flex:1 1 auto">' + I.money + 'Send invoice</button>';
  }
  if (p.kind === 'lease') {
    return '<button class="big-btn" data-act="startlease">' + I.doc + 'Send a lease</button>';
  }
  if (p.kind === 'remind') {
    return '<button class="big-btn" data-act="remind"'
      + (p.inv && p.inv.id ? ' data-inv="' + esc(p.inv.id) + '"' : '') + '>' + I.bell + 'Remind</button>'
      + '<button class="big-btn ghost" data-act="sendinvoice">' + I.money + 'Invoice</button>';
  }
  return '<button class="big-btn" data-act="sendinvoice">' + I.send + 'Send invoice</button>';
}

/* ---------- handle ----------
   Наружу отдаём только id-ы: ссылку на объект юнита через await держать нельзя. */
/** Заготовка SMS: короткая и без сумм — оператор допишет сам, а лишние цифры
    в чужой переписке ни к чему. Тело кодируется на месте вставки. */
function smsBody(u, ctx) {
  const who = String((u && (u.tenantContact || u.contact)) || '').trim().split(/\s+/)[0] || '';
  const suite = String((u && (u.label || u.name || u.id)) || '').trim();
  return 'Hi' + (who ? ' ' + who : '') + ', this is ' + orgName(ctx) + (suite ? ' about ' + (isAptUnit(ctx, u) ? 'Apt ' : 'Suite ') + suite : '') + '. ';
}
function orgName(ctx) {
  const st = (ctx && ctx.snap && ctx.snap.settings) || {};
  return String(st.companyName || st.landlordName || 'SuitesForAll').trim() || 'SuitesForAll';
}

/**
 * Неподписанные конверты договора на этом юните — и кнопка отмены.
 * Показываем только живые: отменять завершённый конверт нечего.
 *
 * timedout — это ИСТЁКШИЙ конверт (у DocuSign есть такой статус envelope,
 * по умолчанию срок 120 дней). Его тут не было: истёкший договор висел как
 * «Lease awaiting signature» с кнопкой Cancel, которая ничего бы не отменила.
 */
function pendingLeases(ctx, u) {
  const list = Array.isArray(u && u.leaseEnvelopes) ? u.leaseEnvelopes : [];
  const dead = { completed: 1, voided: 1, declined: 1, timedout: 1, 'timed out': 1, expired: 1, deleted: 1 };
  const open = list.filter(e => e && e.envelopeId && !dead[String(e.status || '').toLowerCase()]);
  if (!open.length) return '';
  const maySend = (typeof ctx.canSend !== 'function') || ctx.canSend();
  return open.map((e) => {
    const who = e.recipientEmail || e.recipientName || 'the tenant';
    const when = e.sentAt ? dLong(ctx, String(e.sentAt).slice(0, 10)) : '';
    // Конверт, который висит месяцами, выглядел так же, как отправленный вчера.
    // У DocuSign он истечёт молча — оператор должен видеть это заранее.
    const days = daysSince(ctx, e.sentAt);
    const stale = days >= 30;
    return '<div class="arow-wrap"><span class="arow" style="cursor:default">'
      + '<span class="astat" data-s="' + (stale ? 'overdue' : 'invoiced') + '">' + I.doc + '</span>'
      + '<span class="amain"><span class="aname">Lease awaiting signature'
      + (stale ? ' · ' + days + ' days' : '') + '</span>'
      + '<span class="await">' + esc([who, String(e.status || 'sent'), when].filter(Boolean).join(' · ')) + '</span></span></span>'
      + (maySend
        ? '<button class="arow-act" data-act="voidenv" data-env="' + esc(e.envelopeId) + '"'
          + ' data-who="' + esc(who) + '">Cancel</button>'
        : '') + '</div>';
  }).join('');
}

/** Строка «одна лиза на N сьютов» — только когда сьютов действительно больше одного. */
function groupNote(ctx, u) {
  let g = [];
  try { g = (ctx.money && typeof ctx.money.leaseGroup === 'function') ? ctx.money.leaseGroup(u, ctx.snap) : []; }
  catch (e) { g = []; }
  if (!g || g.length < 2) return '';
  const head = g.find(x => x && x.groupRole === 'primary') || g[0];
  const ids = g.map(x => String((x && x.id) || '')).filter(Boolean).sort();
  const shown = ids.slice(0, 6).join(', ') + (ids.length > 6 ? ' +' + (ids.length - 6) + ' more' : '');
  const billed = head && String(head.id) !== String(u.id) ? ' Billed on Suite ' + String(head.id) + '.' : '';
  return '<div class="hintline" style="margin:-8px 0 12px;color:var(--ink-2)">'
    + 'One lease covers ' + ids.length + ' suites (' + esc(shown) + ') — the amount above is for the whole lease, '
    + 'not this suite alone.' + esc(billed) + '</div>';
}

/**
 * Напоминание об уже выставленном счёте (stripeResendInvoice). Ни одна ветка
 * здесь не может выставить НОВЫЙ счёт — это принципиально.
 */
async function remindNow(ctx, el) {
  const id = el && el.getAttribute('data-inv');
  if (!id) { ctx.toast('No open invoice to remind about'); return; }
  if (typeof ctx.callCF !== 'function') { ctx.toast('Not connected to the server yet'); return; }
  const S = ctx.S || {};
  S.reminded = S.reminded || {};
  if (S.reminded['inv:' + id]) { ctx.toast('Already reminded in this session'); return; }
  el.setAttribute('disabled', ''); el.textContent = 'Sending…';
  try {
    await ctx.callCF('stripeResendInvoice', { invoiceId: id }, { timeoutMs: 30000 });
    S.reminded['inv:' + id] = 'sent';
    ctx.toast('Reminder emailed');
  } catch (e) {
    const m = String((e && (e.message || e.code)) || 'failed');
    ctx.toast(/permission|denied|editor/i.test(m) ? 'Your role cannot send reminders' : 'Reminder failed — ' + m);
  }
  el.removeAttribute('disabled');
  if (typeof ctx.refresh === 'function') { try { ctx.refresh(); } catch (_) { /* сеть */ } }
}

/**
 * Отмена неподписанного конверта DocuSign (dsVoid).
 * Действие необратимое и видимое арендатору (DocuSign шлёт письмо об отзыве),
 * поэтому спрашиваем подтверждение с НАЗВАНИЕМ адресата — «вы уверены?» без
 * имени слишком легко подтвердить не глядя.
 */
async function voidEnvelope(ctx, el) {
  const id = el && el.getAttribute('data-env');
  const who = (el && el.getAttribute('data-who')) || 'the tenant';
  if (!id) return;
  if (typeof ctx.callCF !== 'function') { ctx.toast('Not connected to the server yet'); return; }
  const ok = confirm('Cancel the lease sent to ' + who + '?\n\nDocuSign will tell them it was withdrawn, '
    + 'and the link will stop working. This cannot be undone.');
  if (!ok) return;
  el.setAttribute('disabled', ''); el.textContent = 'Cancelling…';
  try {
    await ctx.callCF('dsVoid', { envelopeId: id, reason: 'Cancelled from the phone by the operator' }, { timeoutMs: 30000 });
    ctx.toast('Lease cancelled');
  } catch (e) {
    const m = String((e && (e.message || e.code)) || 'failed');
    ctx.toast(/permission|denied/i.test(m) ? 'Your role cannot cancel leases' : 'Could not cancel — ' + m);
    el.removeAttribute('disabled'); el.textContent = 'Cancel';
    return;
  }
  if (typeof ctx.refresh === 'function') { try { ctx.refresh(); } catch (_) { /* сеть */ } }
}

export function handle(act, el, ctx) {
  const hit = resolve(ctx);
  const ids = hit ? {
    buildingId: (hit.b && hit.b.id) || null,
    floorId: (hit.f && hit.f.id) || null,
    unitId: (hit.u && hit.u.id) || null,
  } : null;

  if (act === 'sendinvoice') {
    if (!ids) return true;
    ctx.openSheet('invoice', ids);
    return true;
  }
  if (act === 'remind') {
    // Повтор существующего счёта, НЕ новый. Прежде эта кнопка открывала лист
    // счёта с mode:'remind', которого в листе никогда не было — то есть вела
    // к форме нового счёта. Второй счёт за тот же месяц — реальный инцидент.
    remindNow(ctx, el);
    return true;
  }
  if (act === 'voidenv') { voidEnvelope(ctx, el); return true; }
  if (act === 'startlease') {
    if (!ids) return true;
    ctx.openSheet('lease', ids);
    return true;
  }
  if (act === 'nophone') { ctx.toast('No phone number on file for this unit'); return true; }
  if (act === 'noemail') { ctx.toast('No email on file — add one in the full version'); return true; }
  if (act === 'noedit') { ctx.toast('Your role can view money but not send it'); return true; }
  if (act === 'refresh') { ctx.refresh(); return true; }
  return false;
}
