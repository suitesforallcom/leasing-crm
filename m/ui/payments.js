/* m/ui/payments.js — вкладка Payments: сначала ПОИСК, потом здание целиком.
   Чистый UI-модуль: никакого Firebase, ни одного собственного денежного
   предиката. Вердикт месяца берём ТОЛЬКО у ctx.money — иначе мобильный
   клиент начнёт расходиться с десктопом на деньгах.
   Контракт: render(ctx) -> HTML, handle(act, el, ctx) -> true|false. */

const PAGE = 25;

const I = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 3 2 20h20L12 3z"/><line x1="12" y1="9" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>',
};

const STATUS_ICON = {
  paid: I.check, free: I.check, invoiced: I.mail, due: I.clock,
  overdue: I.alert, idle: I.dash, vacant: I.dash, reserved: I.doc,
};
const FALLBACK_LABELS = {
  paid: 'Paid', free: 'Waived', invoiced: 'Invoice sent', due: 'Due',
  overdue: 'Overdue', idle: 'Not billed', vacant: 'Vacant', reserved: 'Reserved',
};
/* Порядок «что горит первым». Оплаченное и пустое — в самом низу. */
const URGENCY = { overdue: 0, due: 1, invoiced: 2, idle: 3, reserved: 4, paid: 5, free: 5, vacant: 6 };

/* ---------- мелкие утилиты (escape держим свой: он не имеет права упасть) ---------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function m$(ctx, n) {
  try { return ctx.fmt.money(n); } catch (_) { return '$' + Math.round(+n || 0).toLocaleString('en-US'); }
}
function todayYm() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function prevYm(ym) {
  const y = +String(ym).slice(0, 4), mo = +String(ym).slice(5, 7);
  const d = new Date(y, mo - 2, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
const digits = s => String(s == null ? '' : s).replace(/\D+/g, '');
const stripZeros = s => String(s == null ? '' : s).replace(/^0+(?=[0-9])/, '');

/* Одна правка (вставка / удаление / замена). Транспозиция сюда НЕ входит —
   это ровно Левенштейн <= 1, как договорились. Без DP-таблицы: один проход. */
function within1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < la && j < lb) {
    if (a.charCodeAt(i) === b.charCodeAt(j)) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
  }
  return diff + (la - i) + (lb - j) <= 1;
}

/* ---------- выборка юнитов ---------- */
/* Виден на экране: не архивный, арендуемый, не общая зона.
   type может отсутствовать в старых записях — тогда считаем офисом. */
function isVisible(u) {
  return !!(u && u.id) && !u.archivedAt && u.rentable !== false && (!u.type || u.type === 'office');
}
/* Финансовая тень мульти-сьютовой лизы: вся касса живёт на groupRole==='primary'.
   Из СУММ и счётчиков такие юниты исключаем (иначе двойной счёт), но из поиска
   и из плитки этажа — нет: оператор ищет сьют, а не лизу. */
function isShadow(u) { return !!(u && u.groupId && u.groupRole !== 'primary'); }

/**
 * Считать ли этот сьют отдельной позицией.
 * Мульти-сьютовая лиза (в проде — 6 сьютов National University) физически это
 * шесть помещений, но ОДИН долг. Клетки полосы рисуем для каждого помещения,
 * а любые СЧЁТЧИКИ обязаны считать лизы — иначе «5 open» рядом со списком из
 * трёх строк, и оператор думает, что должников больше, чем есть.
 * Правило то же, что в money.buildingStats (isFinanceShadow).
 */
function countable(ctx, r) {
  // money.isFinanceShadow — канон: он ловит и member'а группы, и неактивную
  // под-комнату (сьют внутри занятого сьюта). Локальный isShadow знает только
  // первый случай и служит запасным вариантом, если деньги недоступны.
  try { return !ctx.money.isFinanceShadow(r.u, ctx.snap); } catch (_) { return !isShadow(r.u); }
}
const countableOf = (ctx, list) => list.filter(r => countable(ctx, r));

function collect(blds) {
  const out = [];
  for (const b of blds) {
    if (!b) continue;
    const floors = Array.isArray(b.floors) ? b.floors : [];
    for (const f of floors) {
      for (const u of (Array.isArray(f.units) ? f.units : [])) {
        if (isVisible(u)) out.push({ u, f, b });
      }
    }
    if (!floors.length && Array.isArray(b.units)) {
      for (const u of b.units) if (isVisible(u)) out.push({ u, f: null, b });
    }
  }
  return out;
}

/* Статус месяца — только через ctx.money. Терпим обе формы ответа
   (строка или {status}), чтобы не сломаться о деталь реализации money.js. */
function stOf(ctx, r, ym) {
  if (r._st != null) return r._st;
  let v = 'idle';
  try {
    const raw = ctx.money.monthStatus(r.u, ym, ctx.snap);
    v = typeof raw === 'string' ? raw : (raw && (raw.status || raw.state)) || 'idle';
  } catch (_) { v = 'idle'; }
  r._st = v;
  return v;
}
function verdictOf(ctx, u, ym) {
  try {
    const v = ctx.money.verdict(u, ym, ctx.snap);
    if (v && typeof v === 'object') return v;
  } catch (_) { /* деньги молчат — покажем то, что знаем */ }
  return null;
}
/* MONEY RULE: договорная ставка бьёт проформу. Никогда не суммируем u.rent. */
const rentOf = u => (+(u && u.contractRent) || +(u && u.rent) || 0);

function isUnpaid(ctx, st) {
  const U = ctx.money && ctx.money.UNPAID;
  if (U && typeof U.has === 'function') return U.has(st);
  if (Array.isArray(U)) return U.indexOf(st) > -1;
  return st === 'overdue' || st === 'invoiced' || st === 'due';
}
function labelOf(ctx, st) {
  const L = ctx.money && ctx.money.STATUS_LABELS;
  return (L && L[st]) || FALLBACK_LABELS[st] || st || '';
}

function currentBuilding(ctx, blds) {
  const S = ctx.S || {};
  // S.scope — канон (его пишет оболочка); S.buildingId оставлен как зеркало.
  const key = S.scope != null ? S.scope : (S.buildingId != null ? S.buildingId : S.building);
  if (key === 'all' || key === '*') return null;          // «All buildings together»
  if (key == null || key === '') return blds[0] || null;  // ещё не выбрали — живём в первом
  return blds.find(b => b && (b.id === key || b.code === key)) || blds[0] || null;
}
function suiteLabel(b, u) {
  const apt = !!(b && (b.apt || b.residential || b.kind === 'residential'));
  return (apt ? 'Apt ' : 'Suite ') + String((u && u.id) || '');
}
function floorLabel(f, idx) {
  if (!f) return '';
  const n = String(f.name == null ? '' : f.name).trim();
  // Этажи в базе часто названы просто «3». Без слова «Floor» подпись сливалась
  // со счётчиком справа и читалась как «3 1/4 paid» — то есть как число, а не
  // как этаж. Имя-слово («Mezzanine», «Ground») оставляем как есть.
  if (n) return /^\d{1,3}[A-Za-z]?$/.test(n) ? 'Floor ' + n : n;
  return 'Floor ' + (f.level != null ? f.level : idx + 1);
}

/* Провенанс оплаты (улучшение 2): откуда мы знаем, что заплачено. */
const SOURCE_TEXT = {
  stripe: 'Stripe', 'stripe-paid': 'Stripe', invoice: 'Stripe',
  manual: 'Manual', local: 'Manual', ledger: 'Manual', paid: 'Manual',
  free: 'Waived', waiver: 'Waived', waived: 'Waived',
};
function provShort(v) {
  const raw = String((v && v.source) || '');
  if (!raw) return '';
  // Регистр гасим только для поиска по словарю: в source приходит номер счёта
  // (R-CEN-301-2026-08), и напечатанный в нижнем регистре он перестаёт совпадать
  // с тем, что оператор видит в Stripe.
  return SOURCE_TEXT[raw.toLowerCase()] || (raw.charAt(0).toUpperCase() + raw.slice(1));
}

/* ---------- поиск ---------- */
/* Прощаем: регистр, ведущие нули в сьюте, форматирование телефона,
   компанию вместо человека, одну опечатку в слове от 4 букв. */
function matchScore(r, q, qd, toks) {
  const u = r.u;
  const tenant = String(u.tenant || '').toLowerCase();
  const company = String(u.company || '').toLowerCase();
  const suite = String(u.id || '').toLowerCase();
  const bname = String((r.b && (r.b.name || r.b.id)) || '').toLowerCase();
  const tel = digits(u.tel || u.phone);
  let s = 0;

  const qz = stripZeros(q), sz = stripZeros(suite);
  if (suite === q || sz === qz) s = 100;
  else if (suite.indexOf(q) === 0 || sz.indexOf(qz) === 0) s = 80;
  else if (suite.indexOf(q) > -1) s = 55;

  if (qd.length >= 3 && tel && tel.indexOf(qd) > -1) s = Math.max(s, 90);

  if (q.length >= 2) {
    if (tenant.indexOf(q) === 0 || company.indexOf(q) === 0) s = Math.max(s, 85);
    else if (tenant.indexOf(q) > -1 || company.indexOf(q) > -1) s = Math.max(s, 70);
    else if (bname.indexOf(q) > -1) s = Math.max(s, 40);
  }

  if (!s && toks.length) {
    const words = (tenant + ' ' + company).split(/[^a-z0-9']+/).filter(w => w.length >= 2);
    const ok = toks.every(t => words.some(w => (
      w.indexOf(t) > -1 || (t.length >= 4 && w.length >= 4 && within1(w, t))
    )));
    if (ok) s = 30;
  }
  return s;
}

/* ---------- строка-ответ ---------- */
function answerRow(ctx, r, ym, showBuilding, fIdx) {
  const u = r.u;
  const v = verdictOf(ctx, u, ym);
  const st = (v && v.status) || stOf(ctx, r, ym);
  const amt = (v && v.amount != null) ? v.amount : rentOf(u);
  const name = u.tenant || u.company || 'Vacant';
  const where = showBuilding ? ((r.b && (r.b.name || r.b.id)) || '') : floorLabel(r.f, fIdx);
  const prov = (st === 'paid' || st === 'free') ? provShort(v) : '';
  const sub = [suiteLabel(r.b, u), where, prov].filter(Boolean).join(' · ');
  const verdictTxt = (v && (v.detail || v.label)) || labelOf(ctx, st);
  /* Имена атрибутов — как в оболочке (app.js builtin: d.id / d.b / d.floor),
     чтобы клик отработал одинаково и через наш handle, и через встроенный. */
  return '<button class="arow" data-act="unit" data-b="' + esc(r.b && r.b.id) + '"'
    + ' data-floor="' + esc(r.f && r.f.id) + '" data-id="' + esc(u.id) + '">'
    + '<span class="astat" data-s="' + esc(st) + '">' + (STATUS_ICON[st] || I.dash) + '</span>'
    + '<span class="amain"><span class="aname">' + esc(name) + '</span>'
    + '<span class="await">' + esc(sub) + '</span></span>'
    + '<span class="aright"><span class="aamt">' + m$(ctx, amt) + '</span>'
    + '<span class="averdict" data-s="' + esc(st) + '">' + esc(verdictTxt) + '</span></span></button>';
}

/* ---------- здание целиком ---------- */
/* Глубина просрочки = возраст долга: если предыдущий месяц тоже не закрыт,
   красим тёмным. Лиза, начавшаяся позже, прошлого долга иметь не может. */
function overdueDepth(ctx, u, ym) {
  const p = prevYm(ym);
  const ls = String(u.leaseStart || u.signed || '').slice(0, 7);
  if (ls && ls > p) return 1;
  try { return ctx.money.isMonthSettled(u, p, ctx.snap) ? 1 : 2; } catch (_) { return 1; }
}

function glance(ctx, b, rows, ym, agg) {
  const S = ctx.S || {};
  const floors = Array.isArray(b.floors) ? b.floors : [];
  const sel = S.floor == null ? 'all' : String(S.floor);
  let h = '';

  if (floors.length > 1) {
    h += '<div class="chips"><button class="fchip" data-act="floor" data-f="all" aria-pressed="'
      + (sel === 'all') + '">All floors</button>'
      + floors.map((f, i) => {
        const fr = countableOf(ctx, rows.filter(r => r.f === f));
        const fp = fr.filter(r => { const s = stOf(ctx, r, ym); return s === 'paid' || s === 'free'; }).length;
        return '<button class="fchip" data-act="floor" data-f="' + esc(f.id) + '" aria-pressed="'
          + (sel === String(f.id)) + '">' + esc(floorLabel(f, i))
          + ' <span style="opacity:.6">' + fp + '/' + fr.length + '</span></button>';
      }).join('') + '</div>';
  }

  const shown = floors.length ? floors.filter((f, i) => sel === 'all' || sel === String(f.id)) : [null];
  h += '<div class="card"><div class="card-h"><h3>'
    + (sel === 'all' || !floors.length ? 'Every unit' : esc(floorLabel(shown[0], floors.indexOf(shown[0]))))
    + '</h3><span class="ch-sub">' + agg.n.paid + ' paid · ' + agg.n.overdue + ' late</span></div>';

  for (const f of shown) {
    const fr = rows.filter(r => r.f === f);
    if (!fr.length) continue;
    const fc = countableOf(ctx, fr);                 // счётчик — по лизам, клетки ниже — по сьютам
    const fp = fc.filter(r => { const s = stOf(ctx, r, ym); return s === 'paid' || s === 'free'; }).length;
    const fo = fc.filter(r => isUnpaid(ctx, stOf(ctx, r, ym))).length;
    h += '<div class="floor"><div class="floor-lbl">'
      + esc(f ? floorLabel(f, floors.indexOf(f)) : 'Units') + ' <span>' + fp + '/' + fc.length + ' paid'
      + (fo ? ' · ' + fo + ' open' : '') + '</span></div><div class="strip">'
      + fr.map(r => {
        const s = stOf(ctx, r, ym);
        const age = s === 'overdue' ? overdueDepth(ctx, r.u, ym) : 1;
        return '<button class="cell" data-s="' + esc(s) + '" data-age="' + age + '"'
          + ' data-act="unit" data-b="' + esc(b.id) + '" data-floor="' + esc(f && f.id) + '"'
          + ' data-id="' + esc(r.u.id) + '" aria-label="' + esc(suiteLabel(b, r.u) + ' — ' + labelOf(ctx, s)) + '"></button>';
      }).join('') + '</div></div>';
  }

  h += '<div class="legend">'
    + '<span><i style="background:var(--ok)"></i>Paid</span><span><i style="background:var(--info)"></i>Invoice sent</span>'
    + '<span><i style="background:var(--warn)"></i>Due</span><span><i style="background:var(--bad)"></i>Overdue</span>'
    + '<span><i style="background:var(--bad-deep)"></i>2+ months</span>'
    + '<span><i style="background:var(--idle-soft);border:1px solid var(--line-2)"></i>Not billed</span>'
    + '<span><i style="border:1px dashed var(--line-2)"></i>Vacant</span></div></div>';
  return h;
}

/* ---------- render ---------- */
export function render(ctx) {
  const S = ctx.S || {};
  const snap = ctx.snap || {};
  const ym = S.ym || todayYm();
  const blds = Array.isArray(snap.buildings) ? snap.buildings : [];
  const b = currentBuilding(ctx, blds);
  const scopeName = b ? (b.name || b.id) : 'All buildings';
  const q = String(S.q == null ? '' : S.q).trim().toLowerCase();
  const searchAll = !!S.searchAll;

  const scopeRows = collect(b ? [b] : blds);

  /* Честная шапка: что за здание, сколько юнитов и насколько свежие данные. */
  let freshness = '';
  try { const t = ctx.fmt.rel(snap.syncedAt); if (t) freshness = ' · synced ' + t; } catch (_) { /* пусто */ }
  const offline = snap.online === false;
  const h0 = '<div class="topbar"><div class="tb-row"><div><div class="tb-title sm">Check a payment</div>'
    + '<div class="sync"><i' + (offline ? ' style="background:var(--warn)"' : '') + '></i>'
    + esc(scopeName) + ' · ' + countableOf(ctx, scopeRows).length + ' units'
    + (offline ? ' · offline copy' : freshness) + '</div></div></div></div>';

  const h1 = '<div class="searchwrap"><div class="searchbox">' + I.search
    + '<input id="q" placeholder="Tenant, suite or phone" value="' + esc(S.q || '') + '"'
    + ' autocomplete="off" autocapitalize="off" autocorrect="off" enterkeyhint="search" aria-label="Search payments">'
    + (S.q ? '<button class="x-btn" data-act="clearq" aria-label="Clear search" style="margin:0;width:26px;height:26px;font-size:14px">✕</button>' : '')
    + '</div></div>';

  if (!blds.length) {
    return h0 + h1 + '<div class="card"><div class="empty">No buildings in this snapshot yet.<br>Pull to refresh once you are online.</div></div>';
  }

  let h = h0 + h1;

  /* ---- ветка ПОИСКА ---- */
  if (q) {
    const qd = digits(q);
    const toks = q.split(/\s+/).filter(Boolean);
    const wide = searchAll && b;
    const pool = wide ? collect(blds) : scopeRows;
    const hits = [];
    for (const r of pool) {
      const sc = matchScore(r, q, qd, toks);
      if (sc) { r._sc = sc; hits.push(r); }
    }
    hits.sort((a, c) => (c._sc - a._sc)
      || ((URGENCY[stOf(ctx, a, ym)] ?? 9) - (URGENCY[stOf(ctx, c, ym)] ?? 9))
      || (rentOf(c.u) - rentOf(a.u)));

    if (b) {
      h += '<div class="chips"><button class="fchip" data-act="searchall" aria-pressed="' + searchAll + '">'
        + (searchAll ? 'Searching all ' + blds.length + ' buildings' : 'Search all buildings too')
        + '</button></div>';
    }

    const limit = Math.max(PAGE, +S.limit || 0);
    const page = hits.slice(0, limit);
    h += '<div class="card"><div class="card-h"><h3>Results</h3><span class="ch-sub">' + hits.length + '</span></div>';
    if (page.length) {
      const floors = b && Array.isArray(b.floors) ? b.floors : [];
      h += page.map(r => answerRow(ctx, r, ym, !b || r.b !== b, floors.indexOf(r.f))).join('');
      if (hits.length > page.length) {
        h += '<button class="more-link" data-act="showmore">Show more (' + (hits.length - page.length) + ')</button>';
      }
    } else {
      h += '<div class="empty">Nobody matches “' + esc(S.q) + '”'
        + (b && !searchAll ? ' in ' + esc(scopeName) : '') + '.</div>'
        + (b && !searchAll ? '<button class="more-link" data-act="searchall">Search all buildings too</button>' : '');
    }
    h += '</div><div style="height:10px"></div>';
    return h;
  }

  /* ---- ветка БЕЗ ЗАПРОСА: фильтры + список + здание целиком ---- */
  const agg = { n: { paid: 0, free: 0, invoiced: 0, due: 0, overdue: 0, idle: 0, vacant: 0, reserved: 0 } };
  let money = { collected: 0, awaiting: 0, overdue: 0 };
  for (const r of scopeRows) {
    const s = stOf(ctx, r, ym);
    if (!countable(ctx, r)) continue;                // тень мульти-лизы не считаем дважды
    agg.n[s] = (agg.n[s] || 0) + 1;
    const a = rentOf(r.u);
    if (s === 'paid' || s === 'free') money.collected += a;
    else if (s === 'invoiced' || s === 'due') money.awaiting += a;
    else if (s === 'overdue') money.overdue += a;
  }
  const billed = money.collected + money.awaiting + money.overdue;
  let pct = billed ? Math.round(money.collected / billed * 100) : 0;
  if (b) {
    try {
      const bs = ctx.money.buildingStats(b, ym, snap);
      if (bs && Number.isFinite(+bs.pct)) pct = Math.round(+bs.pct);
      else if (bs && +bs.billed) pct = Math.round((+bs.collected || 0) / +bs.billed * 100);
    } catch (_) { /* остаёмся на локальной оценке */ }
  }

  const filter = S.filter || 'overdue';
  const counted = countableOf(ctx, scopeRows);
  const unpaidN = agg.n.invoiced + agg.n.due + agg.n.overdue;
  h += '<div class="chips">' + [
    ['overdue', 'Overdue', agg.n.overdue, 'bad'],
    ['unpaid', 'Unpaid', unpaidN, ''],
    ['paid', 'Paid', agg.n.paid + agg.n.free, ''],
    ['all', 'Everyone', counted.length, ''],
  ].map(c => '<button class="chip" data-act="filter" data-k="' + c[0] + '" data-tone="' + c[3]
    + '" aria-pressed="' + (filter === c[0]) + '">' + c[1] + ' <span class="c-n">' + c[2] + '</span></button>').join('')
    + '</div>';

  const list = counted.filter(r => {
    const s = stOf(ctx, r, ym);
    if (filter === 'overdue') return s === 'overdue';
    if (filter === 'unpaid') return isUnpaid(ctx, s);
    if (filter === 'paid') return s === 'paid' || s === 'free';
    return true;
  }).sort((a, c) => ((URGENCY[stOf(ctx, a, ym)] ?? 9) - (URGENCY[stOf(ctx, c, ym)] ?? 9))
    || (rentOf(c.u) - rentOf(a.u)));

  const limit = Math.max(PAGE, +S.limit || 0);
  const page = list.slice(0, limit);
  const floorsArr = b && Array.isArray(b.floors) ? b.floors : [];
  h += '<div class="card"><div class="card-h"><h3>'
    + (filter === 'overdue' ? 'Overdue first' : filter === 'paid' ? 'Paid this month' : filter === 'unpaid' ? 'Still open' : 'Tenants')
    + '</h3><span class="ch-sub">' + list.length + '</span></div>'
    + (page.length
      ? page.map(r => answerRow(ctx, r, ym, !b, floorsArr.indexOf(r.f))).join('')
      : '<div class="empty">Nobody is ' + esc(filter === 'all' ? 'listed' : filter) + ' in ' + esc(scopeName) + ' this month.</div>')
    + (list.length > page.length ? '<button class="more-link" data-act="showmore">Show more (' + (list.length - page.length) + ')</button>' : '')
    + '</div>';

  if (b) {
    h += '<div class="sec-h"><h2>Whole building at a glance</h2><span class="sec-sub">' + pct + '% collected</span></div>';
    h += glance(ctx, b, scopeRows, ym, agg);
  }
  h += '<div style="height:10px"></div>';
  return h;
}

/* ---------- handle ----------
   Возвращаем true — оболочка (app.js) перерисовывает экран.
   Юнит открываем ТОЛЬКО по id-ам: держать ссылку на объект юнита нельзя,
   удалённый listener подменяет здание целиком. */
export function handle(act, el, ctx) {
  const S = ctx.S || {};
  if (act === 'unit') {
    ctx.openSheet('unit', {
      buildingId: el.getAttribute('data-b') || null,
      floorId: el.getAttribute('data-floor') || null,
      unitId: el.getAttribute('data-id') || null,
    });
    return true;
  }
  if (act === 'filter') { S.filter = el.getAttribute('data-k') || 'all'; S.limit = 0; return true; }
  if (act === 'searchall') { S.searchAll = !S.searchAll; S.limit = 0; return true; }
  if (act === 'clearq') { S.q = ''; S.searchAll = false; S.limit = 0; return true; }
  if (act === 'floor') { S.floor = el.getAttribute('data-f') || 'all'; return true; }
  if (act === 'showmore') { S.limit = Math.max(PAGE, +S.limit || 0) + PAGE; return true; }
  return false;
}
