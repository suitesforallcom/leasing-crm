/* ============================================================================
   m/ui/lease.js — «Send a lease»: юнит → арендатор → условия/review → DocuSign.

   ИНВАРИАНТЫ (ACTIONS/DATA-контракты — не ослаблять):
   • Гейт занятости как на десктопе (MONO:126457): занят = status==='occupied'
     ИЛИ есть tenant/company (живой tenant при статусе vacant — сьюты 414/344).
   • Клиент НЕ пишет состояние юнита: leaseEnvelopes / currentLeaseEnvelopeId /
     outreach пишет сам CF (functions/index.js:10024-10059), а building-док
     мобильному писать нельзя вообще (_savedRev-гард). После успеха — refresh().
   • Через await держим только id и перерезолвим юнит (whole-object-swap trap).
   • Новые условия уезжают в envelopeMeta ДО снапшота (MONO:152336-152367).
   • Никакого optimistic success: 30s таймаут; Retry ТОЛЬКО там, где повтор
     безопасен — двойной контракт арендатору это реальный инцидент.
   • Деньги форматируем один раз и не парсим обратно (десктопный двойной проход
     через _liveLeaseFields давал $0 вместо $1,350).
   Вёрстка — только классы прототипа (m.html) + inline-стили.
   ========================================================================== */

const I = {
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  bld: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v15"/><path d="M15 10h3a2 2 0 0 1 2 2v9"/><line x1="2" y1="21" x2="22" y2="21"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12" y2="8"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 3 2 20h20L12 3z"/><line x1="12" y1="9" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (ctx, n) => (ctx.fmt && ctx.fmt.money) ? ctx.fmt.money(n) : '$' + Math.round(+n || 0).toLocaleString('en-US');
const dlong = (ctx, iso) => (iso && ctx.fmt && ctx.fmt.dateLong) ? ctx.fmt.dateLong(iso) : (iso || '—');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;      // строже десктопного /@/ — договор уходит НАВСЕГДА
// Зеркало money.isAptType (локальная копия — как esc): «Apt» уходит в тему
// письма DocuSign и в текст для арендатора — квартире нельзя писать «Suite».
const isAptType = (t) => String(t || '').slice(0, 4) === 'apt_';
const suiteLabel = (u) => ((u && isAptType(u.type)) ? 'Apt ' : 'Suite ') + (u ? u.id : '—');
// Конец лизы считает money.js (конвенция _leaseEndFromStartTerm); m2m — открытая.
function endOf(ctx, L) {
  if (L.term === 'mtm' || !ctx.money || !ctx.money.leaseEndFromStartTerm) return '';
  try { return ctx.money.leaseEndFromStartTerm(L.start, +L.term) || ''; } catch (e) { return ''; }
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Оболочка ещё не зафиксировала имя ключа payload'а — принимаем все варианты,
// которыми его кладут home.js/payments.js (buildingId|bid, unitId|uid, key).
function payloadOf(ctx) {
  const S = ctx.S || {};
  const p = ctx.payload || S.sheetPayload || S.payload || S.sheetData || S.sheetArg || null;
  if (!p) return null;
  const parts = String(p.key || '').includes('__') ? String(p.key).split('__') : [];
  return {
    buildingId: p.buildingId || p.bid || parts[0] || null,
    unitId: p.unitId || p.uid || parts[1] || null,
    floorId: p.floorId || p.fid || null,
  };
}
function repaint(ctx) {
  if (typeof ctx.rerender === 'function') return ctx.rerender();
  if (typeof ctx.repaint === 'function') return ctx.repaint();
  if (typeof ctx.openSheet === 'function') return ctx.openSheet('lease');
}
// Suite-id повторяется между зданиями — building обязателен (DATA-контракт).
function findUnit(snap, buildingId, unitId) {
  if (!unitId) return null;
  const e = (snap && snap.unitsIndex && buildingId) ? snap.unitsIndex[String(buildingId) + '|' + String(unitId)] : null;
  if (e) return { unit: e.unit, building: e.building, floor: e.floor };
  for (const b of (snap && snap.buildings) || []) {
    if (buildingId && String(b.id) !== String(buildingId)) continue;
    for (const f of b.floors || []) for (const u of f.units || []) {
      if (String(u.id) === String(unitId)) return { unit: u, building: b, floor: f };
    }
  }
  return null;
}
function isOccupied(u) { return !!u && (u.status === 'occupied' || !!(u.tenant || u.company)); }
function isLeasable(u) {
  if (!u || u.deletedAt || u.archivedAt || u.rentable === false) return false;
  if (u.type && u.type !== 'office' && !isAptType(u.type)) return false;   // общие зоны не сдаются (DATA: isRentable); apt_* сдаются
  return !(u.groupId && u.groupRole !== 'primary');               // member мульти-сьют лизы — финансовая тень
}

/* ---- состояние мастера: живёт в S.lease (S принадлежит оболочке). Пересоздаём
   только на ДРУГОЙ payload — пустой payload при перерисовке не должен стирать
   выбранный юнит и введённые поля. ------------------------------------------ */
function st(ctx) {
  const S = ctx.S || (ctx.S = {});
  const p = payloadOf(ctx);
  const seed = p ? (p.buildingId || '') + '|' + (p.unitId || '') : '';
  let L = S.lease;
  if (!L || (seed && L._seed !== seed)) {
    L = S.lease = {
      _seed: seed, step: p && p.unitId ? 2 : 1, all: false,
      buildingId: (p && p.buildingId) || null, unitId: (p && p.unitId) || null, floorId: (p && p.floorId) || null,
      who: 'new', name: '', email: '', phone: '', company: '',
      start: todayIso(), term: '12', rent: '', deposit: '', busy: false, err: null, done: null,
    };
  }
  return L;
}
// Значения полей забираем из DOM в момент действия: оболочка перерисовывает
// лист целиком, а input-события на [data-act] не приходят — так ничего не теряется.
function readForm(L) {
  const set = (k, id) => { const el = document.getElementById(id); if (el) L[k] = el.value; };
  set('name', 'lsName'); set('email', 'lsEmail'); set('phone', 'lsPhone'); set('company', 'lsCompany');
  set('start', 'lsStart'); set('rent', 'lsRent'); set('deposit', 'lsDep');
}
// Живой фильтр списка без перерисовки: сохраняет фокус, каретку и скролл.
function bindFilter(inputId, attr) {
  setTimeout(() => {
    const inp = document.getElementById(inputId);
    if (!inp || inp.dataset.bound) return;
    inp.dataset.bound = '1';
    inp.addEventListener('input', () => {
      const q = inp.value.trim().toLowerCase(), q0 = q.replace(/^0+(\d)/, '$1');   // сьют без ведущих нулей
      document.querySelectorAll('[' + attr + ']').forEach((el) => {
        const hay = el.getAttribute(attr) || '';
        el.style.display = (!q || hay.includes(q) || hay.includes(q0)) ? '' : 'none';
      });
    });
  }, 0);
}

/* ---- каскад шаблона: порядок десктопного _resolveLeaseTemplate (MONO:121012) —
   override юнита → шаблон юнита → этаж → здание → workspace → сгенерированный.
   В Storage мобильный клиент не ходит: html берём только если он inline в
   снапшоте, иначе честно говорим, что уйдёт terms sheet. -------------------- */
function tplLib(snap) {
  const s = (snap && snap.settings) || {};
  for (const c of [s.leaseTemplateLibrary, s.leaseTemplates && s.leaseTemplates.library, s.leaseTemplateList]) {
    if (Array.isArray(c) && c.length) return c;
  }
  return [];
}
function resolveTpl(snap, u, f, b) {
  const s = (snap && snap.settings) || {};
  const byId = (id) => tplLib(snap).find((t) => t && (t.id === id || t._id === id)) || null;
  const ovr = u && u.leaseTemplateOverrides && u.leaseTemplateOverrides.lease;
  if (ovr && ovr.html) return { name: ovr.name || 'Custom lease for this unit', where: 'Set on this unit', html: ovr.html };
  const chain = [
    [u && u.leaseTemplateId, 'Chosen for ' + suiteLabel(u)],
    [f && f.defaultLeaseTemplateId, 'Floor default' + (f && f.name ? ' · ' + f.name : '')],
    [b && b.defaultLeaseTemplateId, 'Building default' + (b && b.name ? ' · ' + b.name : '')],
    [s.defaultLeaseTemplateId, 'Workspace default'],
  ];
  for (const [id, where] of chain) {
    if (!id) continue;
    const t = byId(id);
    return { name: (t && (t.name || t.title)) || String(id), where, html: (t && t.html) || '' };
  }
  const ws = s.leaseTemplates && s.leaseTemplates.lease;
  if (ws && ws.html) return { name: ws.name || 'Workspace lease template', where: 'Workspace default', html: ws.html };
  return { name: 'Standard terms sheet', where: 'No template set — built on the phone', html: '' };
}

/* ---- документ конверта ---------------------------------------------------- */
/**
 * Деньги мастера — ОДНО правило на все три потребителя (сводка, документ,
 * заведение аренды). Пустое поле = берём значение юнита; ЯВНЫЙ 0 = ноль.
 *
 * Раньше документ считал через `+L.deposit || +u.deposit`: вписанный ноль
 * (прощёный депозит) — falsy, и в договор печаталось старое значение юнита.
 * Сводка и аренда при этом показывали 0 — три места расходились на деньгах.
 */
function termsOf(L, u) {
  const pick = (typed, fallback) => {
    const t = String(typed == null ? '' : typed).trim();
    if (t === '') return +fallback || 0;
    const n = +t;
    return Number.isFinite(n) && n >= 0 ? n : (+fallback || 0);
  };
  return {
    rent: pick(L.rent, +u.contractRent || +u.rent || 0),
    deposit: pick(L.deposit, +u.deposit || 0),
  };
}

function leaseFields(ctx, L, hit, end) {
  const u = hit.unit, b = hit.building, s = (ctx.snap && ctx.snap.settings) || {};
  const t = termsOf(L, u);                                        // общее правило: см. termsOf
  const rent = t.rent;
  return {
    tenant_name: L.name, tenant_email: L.email, tenant_phone: L.phone, client_company: L.company,
    suite: String(u.id), building_name: b.name || '', building_address: b.address || '',
    lease_start: dlong(ctx, L.start), lease_end: end ? dlong(ctx, end) : 'Month-to-month',
    term: L.term === 'mtm' ? 'Month-to-month' : L.term + ' months',
    rent: usd(ctx, rent), deposit: usd(ctx, t.deposit),
    landlord_name: s.landlordName || b.name || 'Landlord',
    landlord_title: s.landlordTitle || 'Authorized Signatory',
    landlord_signed_date: dlong(ctx, todayIso()),
  };
}
/**
 * Подстановка merge-токенов.
 *  • Значение ЭКРАНИРУЕТСЯ. Имя, компанию и адрес печатает оператор, а результат
 *    уходит в DocuSign как HTML-документ: «O'Brien & Sons <Ltd>» без экранирования
 *    ломает разметку договора, а строка с угловыми скобками может подменить
 *    служебный якорь /signHere/ — тогда подписывать будет нечем. Все поля здесь
 *    текстовые, HTML среди них нет, так что экранирование ничего не портит.
 *  • Неизвестный токен остаётся литералом {{key}} — сознательно. Пустая строка
 *    молча вырезала бы условие договора (например сумму ренты); литерал заметен,
 *    и sendGuard ниже не даст такой документ отправить.
 */
const fillTpl = (html, F) => String(html).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,
  (m, k) => (Object.prototype.hasOwnProperty.call(F, k) ? esc(F[k] == null ? '' : F[k]) : m));

/** Незакрытые токены в готовом документе = дырка в договоре. Не отправляем. */
function unresolvedTokens(html) {
  const out = [];
  String(html).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (m, k) => { if (!out.includes(k)) out.push(k); return m; });
  return out;
}

function buildDoc(tpl, F) {
  const row = (k, v) => '<tr><td style="padding:7px 10px;border-bottom:1px solid #e5e2db;color:#6b7180">' + esc(k)
    + '</td><td style="padding:7px 10px;border-bottom:1px solid #e5e2db;font-weight:600">' + esc(v || '—') + '</td></tr>';
  let html = tpl.html ? fillTpl(tpl.html, F)
    : '<html><body style="font-family:Helvetica,Arial,sans-serif;color:#1a1a1c;font-size:13px;padding:30px">'
      + '<h1 style="font-size:20px;margin:0 0 4px">Lease agreement — terms sheet</h1>'
      + '<p style="color:#6b7180;margin:0 0 18px">' + esc(F.building_name) + ' · ' + esc(F.building_address) + '</p>'
      + '<table style="border-collapse:collapse;width:100%;margin-bottom:18px">'
      + row('Tenant', F.tenant_name) + row('Company', F.client_company) + row('Email', F.tenant_email)
      + row('Phone', F.tenant_phone) + row('Suite', F.suite) + row('Lease start', F.lease_start)
      + row('Lease end', F.lease_end) + row('Term', F.term) + row('Monthly rent', F.rent)
      + row('Security deposit', F.deposit) + '</table>'
      + '<p>By signing below the tenant accepts the terms above together with the landlord&rsquo;s standard lease '
      + 'conditions, which form part of this agreement.</p>'
      + '<p style="margin-top:26px;color:#6b7180">Landlord: ' + esc(F.landlord_name) + ' · '
      + esc(F.landlord_title) + ' · ' + esc(F.landlord_signed_date) + '</p></body></html>';
  // Без якоря DocuSign не поставит поле подписи и подписывать будет НЕЧЕМ.
  if (!/\/signHere\//.test(html)) html += '<p style="margin-top:36px">Tenant signature: /signHere/</p><p>Date: /dateSigned/</p>';
  return html;
}
// UTF-8-safe base64 — идиома монолита (MONO:109842): btoa(html) падает на любом
// типографском тире или кириллице в имени арендатора.
const b64 = (html) => btoa(unescape(encodeURIComponent(html)));

function dsCfg(snap) {
  const s = (snap && snap.settings) || {}, d = s.docusign || s.docuSign || {};
  return {
    expireAfterDays: +d.expireAfterDays || 120,
    reminderAfterDays: +d.reminderAfterDays || 3,
    reminderFrequencyDays: +d.reminderFrequencyDays || 3,
    senderName: String(d.senderName || s.landlordName || '').trim(),
    replyEmail: String(d.replyEmail || '').trim(),
    subject: String(d.defaultSubject || '').trim(),
    message: String(d.defaultMessage || '').trim(),
  };
}

/* ---- шаги ------------------------------------------------------------------ */
/** «4th Floor» уже человекочитаемо; голое «3» — нет. Как на экране Payments. */
function floorName(f, idx) {
  const n = String((f && f.name) || '').trim();
  if (n) return /^\d{1,3}[A-Za-z]?$/.test(n) ? 'Floor ' + n : n;
  const lv = f && f.level;
  return 'Floor ' + (lv != null ? lv : (idx + 1));
}
/** Строка поиска юнита: номер, имя, здание, этаж — всё, что оператор может набрать. */
const rowHay = (e) => [e.unit.id, e.unit.name, e.building.name, e.floor && e.floor.name]
  .filter(Boolean).join(' ').toLowerCase();

function matches(e, q) {
  if (!q) return true;
  const hay = rowHay(e);
  // Прощаем ведущие нули: «044» должно находить сьют 44.
  return hay.includes(q) || hay.includes(q.replace(/^0+(\d)/, '$1'));
}

const PICK_CAP = 120;      // потолок ОТРИСОВКИ, а не поиска: искать надо во всём

/**
 * Список свободных юнитов, сгруппированный по зданию и этажу.
 *
 * Раньше здесь было rows.slice(0, 60), а поиск работал через bindFilter —
 * то есть прятал уже отрисованные строки. Всё, что не попало в первые 60
 * (у Pinnellas Park это весь 4-й этаж), НАЙТИ БЫЛО НЕВОЗМОЖНО: оператор
 * набирал «445» и получал пустоту. Теперь фильтруем ДАННЫЕ, а потолок
 * применяем к результату фильтра.
 */
function pickList(ctx, vacant, taken, q) {
  const hits = vacant.filter((e) => matches(e, q));
  const shown = hits.slice(0, PICK_CAP);

  let h = '';
  // Занятый юнит — частая причина «его нет в списке». Молчать здесь нельзя:
  // оператор ищет сьют 445, а он сдан, и пустой экран это не объясняет.
  const busy = q ? taken.filter((e) => matches(e, q)).slice(0, 4) : [];
  if (busy.length) {
    h += '<div class="verdict" data-s="due" style="align-items:flex-start;margin-bottom:10px">'
      + '<span class="vi">' + I.alert + '</span><span><span class="vt">'
      + (busy.length === 1 ? 'That unit is occupied' : 'Some matches are occupied') + '</span>'
      + busy.map((e) => '<span class="vs">' + esc(suiteLabel(e.unit)) + ' · '
          + esc(floorName(e.floor, 0)) + ' — ' + esc(e.unit.tenant || e.unit.company || 'occupied') + '</span>').join('')
      + '<span class="vs" style="margin-top:3px">A new lease needs a vacant unit. For a renewal use the full version.</span>'
      + '</span></div>';
  }

  if (!shown.length) {
    h += '<div class="empty">' + (q ? 'No vacant unit matches “' + esc(q) + '”.'
      : 'No vacant units here. Try “Search all buildings too”.') + '</div>';
    return h;
  }

  // Группируем: здание → этаж. Порядок этажей — как в самом здании.
  const byB = new Map();
  for (const e of shown) {
    const bk = String(e.building.id);
    if (!byB.has(bk)) byB.set(bk, { b: e.building, floors: new Map() });
    const g = byB.get(bk);
    const fk = String((e.floor && e.floor.id) || '');
    if (!g.floors.has(fk)) g.floors.set(fk, { f: e.floor, rows: [] });
    g.floors.get(fk).rows.push(e);
  }
  const multiB = byB.size > 1;
  for (const g of byB.values()) {
    if (multiB) {
      h += '<div style="font-size:11.5px;font-weight:700;color:var(--ink);margin:14px 0 6px">'
        + esc(g.b.name || g.b.id) + '</div>';
    }
    let i = 0;
    for (const fg of g.floors.values()) {
      h += '<div style="font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);'
        + 'font-weight:700;margin:' + (i++ ? '14px' : '10px') + ' 0 6px;display:flex;justify-content:space-between">'
        + '<span>' + esc(floorName(fg.f, i - 1)) + '</span><span style="opacity:.7">' + fg.rows.length + '</span></div>';
      h += fg.rows.map((e) => {
        const u = e.unit, b = e.building;
        return '<button class="act-row" data-act="lease:pick" data-b="' + esc(b.id) + '" data-f="' + esc((e.floor && e.floor.id) || '')
          + '" data-u="' + esc(u.id) + '">' + I.bld
          + '<span><span class="t">' + esc(suiteLabel(u)) + (multiB ? ' · ' + esc(b.name || b.id) : '') + '</span><span class="s">'
          + (u.sqft ? esc(u.sqft) + ' ft² · ' : '') + 'asking ' + esc(usd(ctx, u.rent || u.contractRent || 0))
          + '/mo</span></span></button>';
      }).join('');
    }
  }
  if (hits.length > shown.length) {
    h += '<div class="hintline" style="text-align:center;padding:8px">Showing ' + shown.length
      + ' of ' + hits.length + ' — type to narrow it down.</div>';
  }
  return h;
}

/** Список знакомых арендаторов. Фильтр по ДАННЫМ — см. комментарий у pickList. */
function peopleList(people, q) {
  const hay = (e) => [e.unit.tenant, e.unit.company, e.unit.id, e.building.name, e.unit.email]
    .filter(Boolean).join(' ').toLowerCase();
  const hits = q ? people.filter((e) => {
    const s = hay(e);
    return s.includes(q) || s.includes(q.replace(/^0+(\d)/, '$1'));
  }) : people;
  const shown = hits.slice(0, PICK_CAP);
  if (!shown.length) {
    return '<div class="empty">' + (q ? 'Nobody matches “' + esc(q) + '”. Use “New tenant”.'
      : 'Nobody with an email on file here yet — use “New tenant”.') + '</div>';
  }
  let h = shown.map((e) => {
    const u = e.unit, nm = u.tenant || u.company || u.email;
    return '<button class="act-row" data-act="lease:person" data-name="' + esc(u.tenant || '') + '" data-co="'
      + esc(u.company || '') + '" data-email="' + esc(u.email) + '" data-tel="' + esc(u.tel || u.phone || '') + '">' + I.user
      + '<span><span class="t">' + esc(nm) + '</span><span class="s">' + esc(u.email) + ' · ' + esc(suiteLabel(u))
      + ' · ' + esc(e.building.name || '') + '</span></span></button>';
  }).join('');
  if (hits.length > shown.length) {
    h += '<div class="hintline" style="text-align:center;padding:8px">Showing ' + shown.length
      + ' of ' + hits.length + ' — type to narrow it down.</div>';
  }
  return h;
}
function bindPeople(L, people) {
  setTimeout(() => {
    const inp = document.getElementById('lsWho');
    const list = document.getElementById('lsWhoList');
    if (!inp || !list || inp.dataset.bound) return;
    inp.dataset.bound = '1';
    inp.addEventListener('input', () => {
      L.wq = inp.value;
      try { list.innerHTML = peopleList(people, inp.value.trim().toLowerCase()); }
      catch (e) { console.error('[m] people picker failed:', e); }
      keepQueryVisible(inp);
    });
  }, 0);
}

function step1(ctx, L) {
  const snap = ctx.snap || {}, scope = String((ctx.S && ctx.S.scope) || 'all');
  const all = L.all || scope === 'all';
  const inScope = (e) => e && (all || String(e.building.id) === scope);
  const units = snap.units || [];
  const vacant = units.filter((e) => inScope(e) && isLeasable(e.unit) && !isOccupied(e.unit));
  const taken = units.filter((e) => inScope(e) && isLeasable(e.unit) && isOccupied(e.unit));

  let h = '<div class="field"><label>Find a unit</label><div class="searchbox" style="box-shadow:none">' + I.search
    + '<input id="lsQ" placeholder="Suite number, floor or building" autocomplete="off"'
    + ' value="' + esc(L.q || '') + '"></div></div>';
  if (scope !== 'all') {
    h += '<div class="chips searchall-chip" style="padding:8px 0 2px"><button class="fchip" data-act="lease:all" aria-pressed="'
      + (!!L.all) + '">' + (L.all ? 'Searching every building' : 'Search all buildings too') + '</button></div>';
  }
  h += '<div style="font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);'
    + 'font-weight:700;margin:14px 0 8px">Vacant right now · ' + vacant.length + '</div>';
  h += '<div id="lsList">' + pickList(ctx, vacant, taken, String(L.q || '').trim().toLowerCase()) + '</div>';

  // Перерисовываем ТОЛЬКО список: трогать input нельзя — на телефоне это уводит
  // фокус и закрывает клавиатуру после каждой набранной цифры.
  bindPick(ctx, L, vacant, taken);
  return h;
}

function bindPick(ctx, L, vacant, taken) {
  setTimeout(() => {
    const inp = document.getElementById('lsQ');
    const list = document.getElementById('lsList');
    if (!inp || !list || inp.dataset.bound) return;
    inp.dataset.bound = '1';
    inp.addEventListener('input', () => {
      L.q = inp.value;                                   // переживает перерисовку листа оболочкой
      try { list.innerHTML = pickList(ctx, vacant, taken, inp.value.trim().toLowerCase()); }
      catch (e) { console.error('[m] unit picker failed:', e); }
      keepQueryVisible(inp);
    });
  }, 0);
}
function step2(ctx, L) {
  const snap = ctx.snap || {}, scope = String((ctx.S && ctx.S.scope) || 'all');
  let h = '<div class="seg" style="margin-bottom:16px">'
    + '<button data-act="lease:who" data-k="new" aria-pressed="' + (L.who === 'new') + '">New tenant</button>'
    + '<button data-act="lease:who" data-k="existing" aria-pressed="' + (L.who === 'existing') + '">Existing</button></div>';
  if (L.who === 'new') {
    // Биндер ДО return — иначе он недостижим (первая версия правки именно так
    // и не работала: кнопка по-прежнему не загоралась по вводу).
    bindFootFields(ctx, L, [['name', 'lsName'], ['email', 'lsEmail'], ['phone', 'lsPhone'], ['company', 'lsCompany']]);
    return h
      + '<div class="field"><label>Full name</label><input class="val" id="lsName" placeholder="Elliot Reyes"'
      + ' autocomplete="off" value="' + esc(L.name) + '"></div>'
      + '<div class="field"><label>Email</label><input class="val" id="lsEmail" type="email" inputmode="email"'
      + ' placeholder="elliot@example.com" autocomplete="off" value="' + esc(L.email) + '">'
      + '<div class="hintline">The lease is emailed here for signature — only this address can sign.</div></div>'
      + '<div class="field"><label>Phone</label><input class="val" id="lsPhone" type="tel" inputmode="tel"'
      + ' placeholder="(727) 555-0134" autocomplete="off" value="' + esc(L.phone) + '">'
      + '<div class="hintline">Printed on the lease. Saved to the unit in the full version.</div></div>'
      + '<div class="field"><label>Company <span style="text-transform:none;letter-spacing:0">(optional)</span></label>'
      + '<input class="val" id="lsCompany" placeholder="Reyes Design" autocomplete="off" value="' + esc(L.company) + '"></div>';
  }
  const seen = new Set();
  const people = (snap.units || []).filter((e) => {
    const u = e.unit;
    if (!u || !EMAIL_RE.test(String(u.email || ''))) return false;
    if (scope !== 'all' && String(e.building.id) !== scope) return false;
    const k = String(u.email).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  h += '<div class="field"><label>Pick someone already in the system</label>'
    + '<div class="searchbox" style="box-shadow:none">' + I.search
    + '<input id="lsWho" placeholder="Name, company or suite" autocomplete="off" value="' + esc(L.wq || '') + '"></div></div>';
  h += '<div id="lsWhoList">' + peopleList(people, String(L.wq || '').trim().toLowerCase()) + '</div>';
  bindPeople(L, people);
  return h;
}
function step3(ctx, L, hit) {
  const snap = ctx.snap || {}, u = hit.unit;
  const end = endOf(ctx, L);
  const tpl = resolveTpl(snap, u, hit.floor, hit.building);
  const t0 = termsOf(L, u);
  const rent = t0.rent, dep = t0.deposit;
  return (L.err ? errCard(L) : '')
    + '<div class="field"><label>Template</label><div class="picked"><span class="doc">' + I.doc + '</span>'
    + '<span class="mid"><span class="t">' + esc(tpl.name) + '</span><span class="s">' + esc(tpl.where)
    + '</span></span></div>' + (tpl.html ? '' : '<div class="hintline">No lease template is set for this unit, so a '
      + 'plain terms sheet is sent. Assign one in the full version for the complete contract.</div>') + '</div>'
    + '<div class="field"><label>Lease start</label><input class="val" id="lsStart" type="date" value="'
    + esc(L.start) + '"></div>'
    + '<div class="field"><label>Term</label><div class="seg" style="margin-bottom:0">'
    + ['6', '12', '24', 'mtm'].map((t) => '<button data-act="lease:term" data-k="' + t + '" aria-pressed="'
      + (L.term === t) + '">' + (t === 'mtm' ? 'M2M' : t + ' mo') + '</button>').join('') + '</div></div>'
    + '<div class="field"><label>Rent · monthly</label><input class="val" id="lsRent" inputmode="decimal" value="'
    + esc(String(rent || '')) + '"></div>'
    + '<div class="field"><label>Security deposit</label><input class="val" id="lsDep" inputmode="decimal" value="'
    + esc(String(dep || '')) + '"></div>'
    + '<div class="field"><label>The lease will be emailed to</label><div class="picked">'
    + '<span class="doc">' + I.mail + '</span><span class="mid">'
    + '<span class="t" style="font-family:var(--num);font-size:16px;word-break:break-all">'
    + esc(L.email || 'no email yet') + '</span><span class="s">' + esc(L.name || 'no name yet')
    + ' · only this address can sign</span></span>'
    + '<button class="chg" data-act="lease:step" data-d="-1">Change</button></div>'
    + (EMAIL_RE.test(L.email) ? '' : '<div class="hintline" style="color:var(--bad)">That address is not a valid '
      + 'email — go back and fix it.</div>') + '</div>'
    + '<div id="lsRecap">' + (bindRecap(ctx, L, hit), recapHtml(ctx, L, hit)) + '</div>'
    + '<div class="whatnext">' + I.info + '<span>The tenant gets a DocuSign email; signature status appears under '
    + 'More. Sending also puts the tenant on the unit with these terms, so you can bill the deposit and the first '
    + 'rent straight away.</span></div>';
}

/**
 * Сводка условий. Вынесена отдельно, потому что перерисовывается ПО ВВОДУ:
 * значения полей забираются из DOM только при нажатии (readForm), а сводка
 * рисовалась один раз — оператор печатал депозит 1800 и видел под ним «$0».
 * На отправку это не влияло (readForm срабатывает раньше), но проверять перед
 * отправкой было нечем, а сводка существует ровно для этого.
 */
function recapHtml(ctx, L, hit) {
  const u = hit.unit;
  const end = endOf(ctx, L);
  const t = termsOf(L, u);
  const rent = t.rent, dep = t.deposit;
  return '<div class="recap"><div><span>Unit</span><b>' + esc(suiteLabel(u)) + '</b></div>'
    + '<div><span>Building</span><b>' + esc(hit.building.name || hit.building.id) + '</b></div>'
    + '<div><span>Starts</span><b>' + esc(dlong(ctx, L.start)) + '</b></div>'
    + '<div><span>Ends</span><b>' + (end ? esc(dlong(ctx, end)) : 'Open · month-to-month') + '</b></div>'
    + '<div><span>Rent</span><b>' + esc(usd(ctx, rent)) + '/mo</b></div>'
    + '<div><span>Deposit</span><b>' + esc(usd(ctx, dep)) + '</b></div></div>';
}
/**
 * Держим поле поиска у ВЕРХА видимой области, пока человек печатает.
 * На телефоне клавиатура съедает две трети экрана: найденный сьют оказывался
 * под ней, и его приходилось искать, пряча клавиатуру (поймано оператором на
 * поиске «1018»). Подтягиваем поле к верху — результаты попадают в тот кусок
 * экрана, который остался видимым.
 */
function keepQueryVisible(inp) {
  const sc = inp && inp.closest && inp.closest('.sheet-scroll');
  if (!sc) return;
  const delta = inp.getBoundingClientRect().top - sc.getBoundingClientRect().top;
  if (delta > 12) sc.scrollTop += delta - 8;      // уже наверху — не дёргаем
}

/**
 * Кнопка внизу зависит от того, что человек ПЕЧАТАЕТ. Ввод не вызывает handle,
 * поэтому подвал сам не обновлялся: оператор вводил имя и почту, а «Continue»
 * оставался серым, пока он не переключит вкладку и не вернётся (тогда
 * срабатывал readForm). Слушаем ввод и просим оболочку перерисовать подвал.
 */
function bindFootFields(ctx, L, fields) {
  setTimeout(() => {
    for (const [key, id] of fields) {
      const inp = document.getElementById(id);
      if (!inp || inp.dataset.foot) continue;
      inp.dataset.foot = '1';
      inp.addEventListener('input', () => {
        L[key] = inp.value;
        if (typeof ctx.refreshFoot === 'function') {
          try { ctx.refreshFoot(); } catch (e) { console.error('[m] refreshFoot failed:', e); }
        }
      });
    }
  }, 0);
}

/** Сводка следует за полями. Перерисовываем ТОЛЬКО её — input трогать нельзя. */
function bindRecap(ctx, L, hit) {
  setTimeout(() => {
    const box = document.getElementById('lsRecap');
    if (!box) return;
    for (const [key, id] of [['start', 'lsStart'], ['rent', 'lsRent'], ['deposit', 'lsDep']]) {
      const inp = document.getElementById(id);
      if (!inp || inp.dataset.recap) continue;
      inp.dataset.recap = '1';
      inp.addEventListener('input', () => {
        L[key] = inp.value;
        try { box.innerHTML = recapHtml(ctx, L, hit); }
        catch (e) { console.error('[m] recap failed:', e); }
      });
    }
  }, 0);
}
/** Отказ по роли. Сервер откажет всё равно — но узнать об этом надо ДО работы. */
function roleGate() {
  return '<div class="verdict" data-s="due" style="align-items:flex-start"><span class="vi">' + I.alert + '</span>'
    + '<span><span class="vt">Your role cannot send leases</span>'
    + '<span class="vs">You can look at payments and units, but sending a lease for signature needs an admin or '
    + 'manager account. Ask an admin to change your role, then reopen the app.</span></span></div>';
}

function gateBody(ctx, hit) {
  const u = hit.unit, who = u.tenant || u.company || 'someone', until = u.until || u.leaseEnd || '';
  return '<div class="verdict" data-s="overdue"><span class="vi">' + I.alert + '</span>'
    + '<span><span class="vt">' + esc(suiteLabel(u)) + ' is occupied</span><span class="vs">' + esc(who)
    + (until ? ' · lease ends ' + esc(dlong(ctx, until)) : '') + '</span></span></div>'
    + '<p style="font-size:13.5px;color:var(--ink-2);margin:0 0 14px">A new lease can only go onto a vacant unit — '
    + 'the same rule as the full version. For a renewal or an amendment on an active lease, use the desktop.</p>'
    + '<button class="act-row" data-act="lease:openunit">' + I.user + '<span><span class="t">Open the unit</span>'
    + '<span class="s">' + esc(who) + ' · payments, balance and contacts</span></span></button>';
}
function errCard(L) {
  return '<div class="verdict" data-s="overdue" style="align-items:flex-start"><span class="vi">' + I.alert + '</span>'
    + '<span><span class="vt">Not sent</span><span class="vs">' + esc(L.err.msg) + '</span></span></div>';
}
/**
 * Экран заселения: договор, депозит, первая рента — и статус каждого СРАЗУ.
 * Статус берём из двух источников: то, что отправили в этой сессии (мгновенно,
 * без ожидания синхронизации), и живой счёт из снимка (переживает перезаход).
 * Ничего не «оптимистично»: строка становится отправленной только по факту.
 */
function moveInRows(ctx, L) {
  const d = L.done || {};
  const hit = d.unitId ? findUnit(ctx.snap || {}, d.buildingId, d.unitId) : null;
  const u = hit && hit.unit;
  const sent = d.sent || {};
  const live = (purpose, ym) => {
    try { return ctx.money && ctx.money.liveInvoiceFor ? ctx.money.liveInvoiceFor(u, purpose, ym, ctx.snap) : null; }
    catch (e) { return null; }
  };
  const rentYm = String(d.leaseStart || '').slice(0, 7) || null;
  const rentAmt = u ? (+u.contractRent || +u.rent || 0) : 0;
  const depAmt = u ? (+u.deposit || rentAmt) : 0;
  return [
    { key: 'lease', title: 'Lease', icon: I.doc,
      doneText: 'Sent to ' + (d.email || '') + ' · awaiting signature', row: null, always: true },
    { key: 'deposit', title: 'Security deposit', icon: I.send, amount: depAmt,
      row: sent.deposit || live('deposit', null) },
    { key: 'rent', title: rentYm ? 'First rent · ' + monthLabel(rentYm) : 'First rent', icon: I.send, amount: rentAmt,
      row: sent.rent || live('rent', rentYm) },
  ];
}
function monthLabel(ym) {
  const M = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const i = (+String(ym).slice(5, 7) || 1) - 1;
  return (M[i] || '') + ' ' + String(ym).slice(0, 4);
}
function invStateText(ctx, r) {
  if (!r) return '';
  const b = r.bucket || r.status || 'open';
  // total ВСЕГДА в долларах: и строки снимка, и запись об отправке приведены
  // к одной единице на входе. Угадывать единицу по величине суммы нельзя —
  // $1,200,000 годовой аренды не отличить от 12 000 центов.
  const amt = (+r.total > 0) ? usd(ctx, +r.total) : '';
  const word = b === 'paid' ? 'paid' : b === 'past_due' ? 'sent · past due' : 'sent · awaiting payment';
  return [r.number || '', amt, word].filter(Boolean).join(' · ');
}

function doneBody(ctx, L) {
  const d = L.done;
  let h = '<div class="done"><div class="ring">' + I.check + '</div><h3>Lease sent</h3>'
    + '<p>' + (d.suite ? esc(d.suite) + ' is now leased to ' + esc(d.tenant || d.email)
                       : 'DocuSign emailed it for signature') + '</p></div>';

  if (!d.stateWriteOk) {
    h += '<div class="verdict" data-s="overdue" style="align-items:flex-start;margin-top:14px">'
      + '<span class="vi">' + I.alert + '</span><span><span class="vt">Recorded only partly</span>'
      + '<span class="vs">The envelope went out, but the server could not record it on the unit. '
      + 'Open the full version once to reconcile before sending anything else.</span></span></div>'
      + '<div class="recap" style="margin-top:12px"><div><span>Envelope</span>'
      + '<b style="word-break:break-all">' + esc(d.envelopeId || '—') + '</b></div></div>';
    return h;
  }

  h += '<div style="font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);'
    + 'font-weight:700;margin:16px 0 8px">Move-in checklist</div>';

  for (const r of moveInRows(ctx, L)) {
    const done = !!(r.always || r.row);
    const detail = r.always ? r.doneText : (r.row ? invStateText(ctx, r.row) : (r.amount > 0 ? usd(ctx, r.amount) + ' — not sent yet' : 'not sent yet'));
    h += '<div class="act-row" style="cursor:default">'
      + '<span class="astat" style="background:' + (done ? 'var(--good-soft,#E7F5EE)' : 'var(--sunk)') + ';'
      + 'color:' + (done ? 'var(--good,#0F8B5F)' : 'var(--ink-3)') + '">' + (done ? I.check : r.icon) + '</span>'
      + '<span class="amain"><span class="aname">' + esc(r.title) + '</span>'
      + '<span class="await">' + esc(detail) + '</span></span>'
      + (done ? '' : '<button class="fchip" data-act="lease:invoice" data-p="' + esc(r.key) + '"'
          + ' style="border-color:var(--accent);color:var(--accent)">Send</button>')
      + '</div>';
  }

  h += '<div class="whatnext" style="margin-top:12px">' + I.info
    + '<span>Signature status appears under More. Sending an invoice opens the invoice sheet with the amount '
    + 'already filled in, and brings you straight back here.</span></div>';
  return h;
}

/* ---- публичный API --------------------------------------------------------- */
export function render(ctx) {
  const L = st(ctx);
  if (!L.unitId && L.step > 1) L.step = 1;                             // без юнита дальше первого шага нечего рисовать
  const hit = L.unitId ? findUnit(ctx.snap || {}, L.buildingId, L.unitId) : null;
  const sub = L.step === 1 ? 'which unit' : L.step === 2 ? 'who signs' : 'terms and review';
  let h = '<div class="sheet-h"><div><h3>Send a lease</h3><p>'
    + (L.done ? 'Done' : 'Step ' + L.step + ' of 3 · ' + sub) + '</p></div>'
    + '<button class="x-btn" data-act="lease:close" aria-label="Close">✕</button></div>';
  // Роль без права отправки — говорим сразу, а не после заполнения мастера.
  if (typeof ctx.canSend === 'function' && !ctx.canSend()) return h + roleGate();
  if (L.done) return h + doneBody(ctx, L);
  h += '<div class="steps">' + [1, 2, 3].map((i) => '<span class="step" data-on="' + (i <= L.step ? 1 : 0)
    + '"></span>').join('') + '</div>';
  if (L.unitId && !hit) {
    return h + '<div class="empty">That unit is no longer in this snapshot.</div>'
      + '<button class="act-row" data-act="lease:reset">' + I.bld + '<span><span class="t">Pick another unit</span></span></button>';
  }
  if (hit && isOccupied(hit.unit)) return h + gateBody(ctx, hit);       // ГЕЙТ: занятый юнит
  if (L.step === 1) return h + step1(ctx, L);
  if (L.step === 2) return h + step2(ctx, L);
  return h + step3(ctx, L, hit);
}

export function foot(ctx) {
  const L = st(ctx);
  const hit = L.unitId ? findUnit(ctx.snap || {}, L.buildingId, L.unitId) : null;
  if (typeof ctx.canSend === 'function' && !ctx.canSend()) {
    return '<button class="big-btn" data-act="lease:close">Close</button>';
  }
  // Отправка депозита и первой ренты живёт в строках экрана заселения —
  // там же, где виден их статус. Внизу остаётся только выход.
  if (L.done) return '<button class="big-btn" data-act="lease:close">Done</button>';
  if (hit && isOccupied(hit.unit)) {
    return '<button class="big-btn ghost" data-act="lease:reset">' + I.left + '</button>'
      + '<button class="big-btn" data-act="lease:openunit">Open the unit</button>';
  }
  if (L.busy) return '<button class="big-btn" disabled>Sending…</button>';
  if (L.step === 1) return '';
  const back = '<button class="big-btn ghost" data-act="lease:step" data-d="-1">' + I.left + '</button>';
  if (L.step === 2) {
    const ok = !!String(L.name).trim() && EMAIL_RE.test(String(L.email).trim());
    return back + '<button class="big-btn" data-act="lease:step" data-d="1"' + (ok ? '' : ' disabled') + '>Continue</button>';
  }
  // Неоднозначная ошибка (таймаут/сеть): конверт мог уйти. Повтор — только
  // вторым осознанным тапом, иначе арендатор получает ДВА контракта.
  if (L.err && !L.err.retry) {
    return back + (L.resend
      ? '<button class="big-btn" style="background:var(--bad)" data-act="lease:send">' + I.send + 'Yes — send a second one</button>'
      : '<button class="big-btn ghost" style="flex:1" data-act="lease:resend">Send again anyway</button>');
  }
  return back + '<button class="big-btn" data-act="lease:send">' + I.send
    + (L.err && L.err.retry ? 'Try again' : 'Send lease') + '</button>';
}

export function handle(act, el, ctx) {
  if (typeof act !== 'string' || act.indexOf('lease:') !== 0) return false;
  const S = ctx.S || {}, L = st(ctx);
  readForm(L);                                     // введённое сохраняем ДО любой перерисовки
  if (act === 'lease:close') { S.lease = null; ctx.closeSheet(); return true; }
  if (act === 'lease:invoice') {
    // Юнит только что стал занятым — лист счёта откроется уже с арендатором,
    // нужным назначением и суммой из условий договора.
    // S.lease НЕ обнуляем: с листа счёта возвращаемся на этот же экран, где
    // строка уже будет отмечена отправленной.
    const d = L.done || {};
    const preset = el && el.getAttribute('data-p') === 'deposit' ? 'deposit' : 'rent';
    S.inv = null;                                  // не тащим предыдущий черновик счёта
    if (!d.buildingId || !d.unitId) return true;
    ctx.openSheet('invoice', {
      buildingId: d.buildingId, floorId: d.floorId, unitId: d.unitId,
      preset,
      // Рента за ПЕРВЫЙ месяц договора, а не за текущий: договор часто
      // начинается со следующего месяца, и счёт за август тут был бы ошибкой.
      ym: preset === 'rent' ? (String(d.leaseStart || '').slice(0, 7) || null) : null,
      returnTo: 'lease', slot: preset,
    });
    return true;
  }
  if (act === 'lease:reset') { S.lease = null; const N = st(ctx); N.step = 1; N.unitId = null; return true; }
  if (act === 'lease:all') { L.all = !L.all; return true; }
  if (act === 'lease:pick') {
    L.buildingId = el.getAttribute('data-b') || null;
    L.floorId = el.getAttribute('data-f') || null;
    L.unitId = el.getAttribute('data-u') || null;
    L.step = 2; L.err = null;
    return true;
  }
  if (act === 'lease:who') { L.who = el.getAttribute('data-k') === 'new' ? 'new' : 'existing'; return true; }
  if (act === 'lease:person') {
    L.who = 'new';                                  // поля заполнены — дальше правятся как обычные
    L.name = el.getAttribute('data-name') || el.getAttribute('data-co') || '';
    L.company = el.getAttribute('data-co') || '';
    L.email = el.getAttribute('data-email') || '';
    L.phone = el.getAttribute('data-tel') || '';
    return true;
  }
  if (act === 'lease:term') { L.term = el.getAttribute('data-k') || '12'; return true; }
  if (act === 'lease:resend') { L.resend = true; return true; }        // взводим повтор после неоднозначной ошибки
  if (act === 'lease:step') {
    L.err = null; L.resend = false;
    L.step = Math.max(1, Math.min(3, L.step + (+el.getAttribute('data-d') || 0)));
    return true;
  }
  if (act === 'lease:openunit') {
    ctx.openSheet('unit', { buildingId: L.buildingId, floorId: L.floorId, unitId: L.unitId, bid: L.buildingId, uid: L.unitId });
    return true;
  }
  if (act === 'lease:send') { send(ctx, L); return true; }
  return false;
}

/* ---- отправка: через await держим ТОЛЬКО id. После ответа состояние юнита не
   трогаем — его пишет CF, мы лишь перечитываем снапшот. --------------------- */
async function send(ctx, L) {
  const snap = ctx.snap || {};
  const buildingId = L.buildingId, floorId = L.floorId, unitId = L.unitId;
  const hit = findUnit(snap, buildingId, unitId);
  const email = String(L.email || '').trim(), name = String(L.name || '').trim();

  if (!hit) return fail(ctx, L, 'That unit is no longer in this snapshot. Pick it again.', true);
  if (isOccupied(hit.unit)) return fail(ctx, L, 'That unit is occupied — a lease cannot be sent onto it.', false);
  if (!EMAIL_RE.test(email)) return fail(ctx, L, 'That recipient email is not valid.', true);
  if (!name) return fail(ctx, L, 'The tenant name is missing.', true);
  if (!buildingId || !floorId || !unitId) return fail(ctx, L, 'This unit is missing its building or floor — open it in the full version.', false);
  if (typeof ctx.callCF !== 'function') return fail(ctx, L, 'The app is not connected to the server yet.', true);

  const cfg = dsCfg(snap);
  const end = endOf(ctx, L);
  const terms = termsOf(L, hit.unit);
  const rent = terms.rent;
  const html = buildDoc(resolveTpl(snap, hit.unit, hit.floor, hit.building), leaseFields(ctx, L, hit, end));
  const suite = suiteLabel(hit.unit);

  // Каждое значение в notification — СТРОКА: DocuSign REST v2.1 отвергает
  // настоящие boolean/number (MONO:109752-109764).
  const payload = {
    emailSubject: cfg.subject || ('Please sign your lease — ' + suite),
    emailBlurb: cfg.message || (name + ', please review and sign the lease for ' + suite
      + (hit.building.name ? ' at ' + hit.building.name : '') + '.'),
    status: 'sent',
    notification: {
      useAccountDefaults: 'false',
      reminders: { reminderEnabled: 'true', reminderDelay: String(cfg.reminderAfterDays), reminderFrequency: String(cfg.reminderFrequencyDays) },
      expirations: { expireEnabled: 'true', expireAfter: String(cfg.expireAfterDays), expireWarn: '2' },
    },
    documents: [{ documentId: '1', name: 'Lease agreement', fileExtension: 'html', documentBase64: b64(html) }],
    recipients: {
      signers: [{
        email, name, recipientId: '1', routingOrder: '1',
        tabs: {
          signHereTabs: [{ anchorString: '/signHere/', anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0' }],
          dateSignedTabs: [{ anchorString: '/dateSigned/', anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0' }],
        },
      }],
    },
  };
  if (cfg.senderName || cfg.replyEmail) {
    payload.emailSettings = {};
    if (cfg.senderName) payload.emailSettings.replyEmailNameOverride = cfg.senderName;
    if (cfg.replyEmail) payload.emailSettings.replyEmailAddressOverride = cfg.replyEmail;
  }

  // Последняя проверка перед отправкой: в договоре не должно остаться
  // неподставленных {{токенов}} — арендатор увидел бы служебный плейсхолдер
  // вместо условия, а подписанный документ уже не переделать.
  const holes = unresolvedTokens(html);
  if (holes.length) {
    L.busy = false;
    L.err = 'The lease still has unfilled fields (' + holes.slice(0, 3).join(', ')
      + (holes.length > 3 ? ' and ' + (holes.length - 3) + ' more' : '')
      + '). Finish this one in the full version.';
    repaint(ctx);
    return;
  }

  L.busy = true; L.err = null; L.resend = false; repaint(ctx);
  try {
    const res = await ctx.callCF('dsSendEnvelope', {
      payload, recipientEmail: email, unitId, buildingId, floorId,
      envelopeMeta: {
        recipientName: name, subject: payload.emailSubject, templateId: null, mode: 'inline',
        leaseStart: L.start || null, leaseEnd: end || null, rent,     // НОВЫЕ условия, не прежние
      },
      // Аренду заводит СЕРВЕР, в той же транзакции, что и запись конверта.
      // Клиент документ здания не пишет вообще (_savedRev-гард). До этого
      // договор уходил, а юнит оставался свободным: счёт выставить не по кому.
      tenancy: {
        tenant: name, company: L.company || '', email, tel: L.phone || '',
        leaseStart: L.start || '', leaseEnd: end || '',
        contractRent: rent, deposit: terms.deposit,
      },
    }, { timeoutMs: 30000 });
    const r = (res && res.envelopeId === undefined && res.data) ? res.data : (res || {});
    L.busy = false;
    // stateWriteOk===false — НЕ провал: конверт уже у арендатора
    // (functions/index.js:10060-10066), нужна лишь сверка.
    L.done = {
      envelopeId: r.envelopeId || '', status: r.status || 'sent',
      stateWriteOk: r.stateWriteOk !== false, email,
      suite, tenant: name,
      buildingId, floorId, unitId,
      leaseStart: L.start || '',
    };
    if (typeof ctx.refresh === 'function') { try { ctx.refresh(); } catch (e) { /* сеть */ } }
    if (typeof ctx.toast === 'function') ctx.toast('Lease sent to ' + email);
  } catch (e) {
    L.busy = false;
    // Повтор разрешаем только когда сервер ТОЧНО отказал до отправки. При
    // таймауте/недоступности конверт мог уйти, и второй Send = второй контракт.
    const code = String((e && e.code) || '');
    const ambiguous = !!(e && e.mayHaveCompleted) || /timeout|deadline|unavailable|internal|aborted/.test(code);
    const safe = /invalid-argument|permission-denied|unauthenticated|not-found|failed-precondition/.test(code);
    L.err = { msg: (e && e.message) || 'The send failed.', retry: safe && !ambiguous };
    if (ambiguous) L.err.msg += ' Check More → leases before sending again.';
  }
  repaint(ctx);
}
function fail(ctx, L, msg, retry) {
  L.busy = false; L.err = { msg, retry: !!retry };
  repaint(ctx);
}
