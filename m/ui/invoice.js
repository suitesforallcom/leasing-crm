/* ============================================================================
   m/ui/invoice.js — «Send an invoice»: пресет → сумма → срок → review →
   createStripeInvoice, затем ссылка на оплату, QR и «Text link».

   ИНВАРИАНТЫ (ACTIONS/MONEY-контракты — не ослаблять):
   • idempotencyKey = стабильная база (одна на лист) + отпечаток ПАРАМЕТРОВ.
     База не пересоздаётся между попытками (MONO:151783): свежий ключ на втором
     тапе = два реальных счёта. Но чистая база тоже неверна: Stripe держит ключ
     24 часа, поэтому (а) исправил сумму после ошибки и отправил снова — Stripe
     отвечает «same key, different parameters», (б) осознанный дубль вторым
     тапом вернул бы ПЕРВЫЙ счёт, и оператор ушёл бы уверенный, что выставил
     второй. Отпечаток решает оба: тот же запрос → тот же ключ (ретрай безопасен),
     другой запрос → другой ключ. Формат обязан пройти /^[A-Za-z0-9_-]{8,128}$/,
     иначе CF молча выбрасывает ключ и дедупа Stripe не будет вообще.
   • Дубликат ищем в snap.invoices ДО отправки; поверх живого счёта уходим
     только вторым осознанным тапом и с allowDuplicate:true.
   • Лимиты считают ПОПЫТКИ (5/сьют/сутки, 100/workspace/час) — авто-ретраев нет.
   • amountOverride — ДОЛЛАРЫ, ответ CF (amount) — ЦЕНТЫ.
   • Рента = +u.contractRent || +u.rent (MONEY RULE), не проформа.
   • Member мульти-сьют лизы: биллинг уезжает на lease head (MONO:30004) —
     говорим об этом явно, иначе оператор не поймёт чужой номер сьюта.
   • Никакого optimistic success: 30s таймаут и честная ошибка.
   Вёрстка — только классы прототипа (m.html) + inline-стили.
   ========================================================================== */

const I = {
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12" y2="8"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 3 2 20h20L12 3z"/><line x1="12" y1="9" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (ctx, n) => (ctx.fmt && ctx.fmt.money) ? ctx.fmt.money(n) : '$' + Math.round(+n || 0).toLocaleString('en-US');
const dshort = (ctx, v) => (ctx.fmt && ctx.fmt.dateShort && v) ? ctx.fmt.dateShort(v) : String(v || '—');
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ymLabel = (ym) => { const p = String(ym).split('-'); return (MON[+p[1] - 1] || ym) + ' ' + p[0]; };
function todayYm() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function shiftYm(ym, d) {
  const p = String(ym).split('-').map(Number), t = new Date(p[0], p[1] - 1 + d, 1);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
}
function payloadOf(ctx) {                 // имя ключа payload'а оболочка ещё не зафиксировала
  const S = ctx.S || {};
  const p = ctx.payload || S.sheetPayload || S.payload || S.sheetData || S.sheetArg || null;
  if (!p) return null;
  const parts = String(p.key || '').includes('__') ? String(p.key).split('__') : [];
  return {
    buildingId: p.buildingId || p.bid || parts[0] || null,
    unitId: p.unitId || p.uid || parts[1] || null,
    floorId: p.floorId || p.fid || null,
    // Открытие с уже выбранным назначением: после отправки договора оператор
    // идёт за первой рентой и депозитом, и незачем заставлять его тыкать
    // пресет заново.
    preset: p.preset || null,
    ym: p.ym || null,
    // Открыт с экрана заселения: туда же и вернёмся, отметив строку.
    returnTo: p.returnTo || null,
    slot: p.slot || null,
  };
}
function repaint(ctx) {
  if (typeof ctx.rerender === 'function') return ctx.rerender();
  if (typeof ctx.repaint === 'function') return ctx.repaint();
  if (typeof ctx.openSheet === 'function') return ctx.openSheet('invoice');
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
const isOccupied = (u) => !!u && (u.status === 'occupied' || !!(u.tenant || u.company));
const suiteLabel = (u) => 'Suite ' + (u ? u.id : '—');
// Member мульти-сьют лизы держит пустые денежные поля: биллинг идёт на head.
function headOf(ctx, hit) {
  const u = hit && hit.unit;
  if (!u || !u.groupId || u.groupRole === 'primary') return hit;
  const head = (ctx.money && ctx.money.leaseHead) ? ctx.money.leaseHead(u, ctx.snap) : u;
  if (!head || head === u) return hit;
  const e = ((ctx.snap && ctx.snap.units) || []).find((x) => x.unit === head);
  return e ? { unit: e.unit, building: e.building, floor: e.floor, from: u.id } : hit;
}

/* ---- состояние: живёт в S.inv. idempotencyKey рождается вместе с ним и
   переживает неудачные попытки — это и есть защита от двойного счёта. ------- */
function newKey() {
  try { if (crypto && crypto.randomUUID) return 'm-' + crypto.randomUUID(); } catch (e) { /* старый webview */ }
  return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

/** FNV-1a → base36. Нужен только для различения запросов, не для криптографии. */
function fp(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
/**
 * Ключ идемпотентности запроса: база листа + отпечаток того, что реально уходит.
 * Ретрай тем же телом → тот же ключ (Stripe вернёт тот же счёт вместо второго).
 * Изменил сумму/назначение/месяц/срок/текст → ключ другой (иначе Stripe ответит
 * ошибкой о несовпадении параметров). Осознанный дубль → суффикс -d, иначе
 * Stripe отдал бы первый счёт и второй никогда бы не выставился.
 */
function idemFor(L, body, isDup) {
  const sig = [body.purpose, body.ym, body.amountOverride, body.daysUntilDue, body.description || ''].join('|');
  return (L.idem + '-' + fp(sig) + (isDup ? '-d' : '')).slice(0, 128);
}
function st(ctx) {
  const S = ctx.S || (ctx.S = {});
  const p = payloadOf(ctx);
  const seed = p ? (p.buildingId || '') + '|' + (p.unitId || '') : '';
  let L = S.inv;
  if (!L || (seed && L._seed !== seed)) {
    L = S.inv = {
      _seed: seed, buildingId: (p && p.buildingId) || null, unitId: (p && p.unitId) || null,
      floorId: (p && p.floorId) || null,
      preset: (p && p.preset) || 'rent',
      ym: (p && p.ym) || todayYm(),
      amount: '', days: 14, memo: '',
      idem: newKey(), confirmDup: null, busy: false, err: null, done: null, svcId: null, q: '',
      returnTo: (p && p.returnTo) || null, slot: (p && p.slot) || null,
    };
  }
  return L;
}
function readForm(L) {
  const a = document.getElementById('invAmt'); if (a) L.amount = a.value;
  const m = document.getElementById('invMemo'); if (m) L.memo = m.value;
}
function bindFilter(inputId, attr) {         // фильтр списка без перерисовки — фокус и каретка на месте
  setTimeout(() => {
    const inp = document.getElementById(inputId);
    if (!inp || inp.dataset.bound) return;
    inp.dataset.bound = '1';
    inp.addEventListener('input', () => {
      const q = inp.value.trim().toLowerCase(), q0 = q.replace(/^0+(\d)/, '$1');
      document.querySelectorAll('[' + attr + ']').forEach((el) => {
        const hay = el.getAttribute(attr) || '';
        el.style.display = (!q || hay.includes(q) || hay.includes(q0)) ? '' : 'none';
      });
    });
  }, 0);
}

/* ---- пресеты и суммы ------------------------------------------------------- */
const PRESETS = [
  { k: 'rent', purpose: 'rent', label: 'Rent' },
  { k: 'deposit', purpose: 'deposit', label: 'Deposit' },
  { k: 'late', purpose: 'late_fee', label: 'Late fee' },
  // 'service' НЕ существует в словаре системы: десктоп шлёт только rent /
  // deposit / late_fee, а Cloud Function ветвится по rent / deposit / custom.
  // Счёт с чужим purpose ушёл бы в Stripe, но ни один предикат «оплачено» его
  // бы не узнал. Поэтому Service — это custom с готовым текстом.
  { k: 'service', purpose: 'custom', label: 'Service' },
  { k: 'custom', purpose: 'custom', label: 'Custom' },
];
const presetOf = (k) => PRESETS.find((p) => p.k === k) || PRESETS[0];

/* ---- каталог услуг воркспейса ---------------------------------------------
   Источник тот же, что у полной версии: state.settings.additionalServices
   (десктоп строит из него optgroup «From service catalog», MONO:150300).
   Позиция каталога = счёт с purpose 'custom', описанием = name и суммой из
   каталога — ровно как делает десктоп (MONO:151104). Свой список здесь не
   заводим: разойдётся с прайсом, по которому выставляют счета с компьютера. */
const FREQ_SUFFIX = { monthly: '/mo', hourly: '/hr', daily: '/day', once: ' one-time' };
function serviceCatalog(snap) {
  const list = (snap && snap.settings && snap.settings.additionalServices) || [];
  if (!Array.isArray(list)) return [];
  return list.filter((s) => s && s.name && +s.amount > 0)
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
const serviceById = (snap, id) => serviceCatalog(snap).find((s) => String(s.id) === String(id)) || null;
const servicePrice = (ctx, s) => usd(ctx, +s.amount) + (FREQ_SUFFIX[s.frequency || 'monthly'] || '');

/** Список услуг: тап подставляет и сумму, и текст для арендатора. */
function serviceList(ctx, L) {
  const cat = serviceCatalog(ctx.snap);
  if (!cat.length) {
    return '<div class="whatnext" style="margin-bottom:10px">' + I.info + '<span>No services in the catalog yet. '
      + 'Add them in the full version (Settings → Billing), or use Custom and type the amount.</span></div>';
  }
  return '<div class="field"><label>Which service</label></div>'
    + cat.map((s) => {
      const on = String(L.svcId || '') === String(s.id);
      return '<button class="act-row" data-act="inv:svc" data-id="' + esc(s.id) + '"'
        + ' aria-pressed="' + on + '"'
        + (on ? ' style="border-color:var(--accent);background:var(--accent-soft)"' : '') + '>'
        + (on ? I.check : I.money)
        + '<span><span class="t">' + esc(s.name) + '</span><span class="s">' + esc(servicePrice(ctx, s))
        + (s.description ? ' · ' + esc(s.description) : '') + '</span></span></button>';
    }).join('');
}
const periodic = (k) => k === 'rent' || k === 'late';        // только у этих ym входит в дедуп-ключ
// Каскад late fee workspace → building → floor → unit (getLateFeeConfig :144072).
function lateCfg(snap, hit) {
  const u = hit.unit, f = hit.floor, b = hit.building;
  let c = Object.assign({ enabled: true, graceDays: 5, type: 'percent', amount: 8 }, (snap.settings && snap.settings.lateFee) || {});
  for (const o of [b && b.billingRulesOverride && b.billingRulesOverride.lateFee,
    f && f.billingRulesOverride && f.billingRulesOverride.lateFee]) {
    if (!o || typeof o !== 'object') continue;
    if (o.source === 'fromLease') { if (o.enabled !== undefined) c.enabled = o.enabled === true; }   // цифры остаются от юнита
    else c = Object.assign({}, c, o);
  }
  if (u && u.lateFeeOverride && typeof u.lateFeeOverride === 'object') c = Object.assign({}, c, u.lateFeeOverride);
  if (b && b.billingRulesOverride && b.billingRulesOverride.paused === true) c.enabled = false;
  return c;
}
function defaultAmount(ctx, L, hit) {
  const u = hit.unit, rent = +u.contractRent || +u.rent || 0;     // contractRent выигрывает
  if (L.preset === 'rent') return rent;
  if (L.preset === 'deposit') return +u.deposit || rent;
  if (L.preset === 'late') {
    const c = lateCfg(ctx.snap || {}, hit);
    return c.type === 'percent' ? Math.round(rent * (+c.amount || 0)) / 100 : (+c.amount || 0);
  }
  return 0;
}
function defaultMemo(L, hit) {
  const s = suiteLabel(hit.unit);
  if (L.preset === 'rent') return 'Rent — ' + s + ' · ' + ymLabel(L.ym);
  if (L.preset === 'deposit') return 'Security deposit — ' + s;
  if (L.preset === 'late') return 'Late charge — ' + s + ' · ' + ymLabel(L.ym);
  if (L.preset === 'service') return '';                 // текст приходит из выбранной позиции каталога
  return '';
}
const amountOf = (ctx, L, hit) => (L.amount === '' ? defaultAmount(ctx, L, hit) : (+String(L.amount).replace(/[$,\s]/g, '') || 0));
const memoOf = (L, hit) => (L.memo === '' ? defaultMemo(L, hit) : L.memo);

/* ---- защита от дубля: живой счёт на тот же (сьют, назначение, месяц).
   Депозит дедупится БЕЗ месяца — один на юнит навсегда (CF:1142). Bucket из
   кэша протухает, поэтому past due пересчитываем от dueDate локально. ------- */
function dupOf(ctx, L, hit) {
  const snap = ctx.snap || {};
  if (!snap.invoicesAvailable) return null;
  const purpose = presetOf(L.preset).purpose;
  const rows = (snap.invoicesByUnit && snap.invoicesByUnit[String(hit.unit.id)])
    || (snap.invoices || []).filter((r) => String((r && (r.unitId || (r.metadata && r.metadata.unitId))) || '') === String(hit.unit.id));
  const cust = hit.unit.stripe && hit.unit.stripe.customerId;
  const mail = String(hit.unit.email || '').trim().toLowerCase();
  for (const r of rows || []) {
    if (!r) continue;
    if (((r.metadata && r.metadata.purpose) || r.purpose || '') !== purpose) continue;
    const b = r.bucket || r.status;
    if (b === 'void' || b === 'uncollectible' || b === 'refunded' || b === 'draft') continue;   // слот свободен
    if (purpose !== 'deposit') {
      const rYm = r.ym || (r.metadata && r.metadata.ym) || '';
      if (rYm ? rYm !== L.ym : ymOfMs(r.created) !== L.ym) continue;
    }
    // Тот же сьют может был у прежнего арендатора — сверяем клиента, когда есть чем.
    const rc = r.customerId || '', re = String(r.customerEmail || '').trim().toLowerCase();
    if ((cust || mail) && (rc || re) && !(cust && rc === cust) && !(mail && re === mail)) continue;
    return { row: r, paid: b === 'paid', pastDue: !!(r.dueDate && r.dueDate < Date.now() && b !== 'paid') };
  }
  return null;
}
function ymOfMs(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* ============================ QR: byte mode, EC level L, версии 1..10 ========
   Свой кодер (внешних зависимостей в проекте нет). Проверен в scratch против
   опубликованных таблиц (RS-генераторы 7/10/15, format info L×8 масок, version
   info v7..v10), канонического вектора HELLO WORLD и round-trip разбора
   собственной матрицы. Не влезло (>271 байт) → null, рисуем заглушку. ------- */
const EXP = new Uint8Array(256), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11D : 0); x &= 0xFF; } })();
const gmul = (a, b) => (a && b) ? EXP[(LOG[a] + LOG[b]) % 255] : 0;
// [data-кодовых слов, EC на блок, блоков г1, data в блоке г1, блоков г2, data г2]
const CAP = [null, [19, 7, 1, 19, 0, 0], [34, 10, 1, 34, 0, 0], [55, 15, 1, 55, 0, 0], [80, 20, 1, 80, 0, 0],
  [108, 26, 1, 108, 0, 0], [136, 18, 2, 68, 0, 0], [156, 20, 2, 78, 0, 0], [194, 24, 2, 97, 0, 0],
  [232, 30, 2, 116, 0, 0], [274, 18, 2, 68, 2, 69]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (((r / 2) | 0) + ((c / 3) | 0)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
];
function rsEC(data, d) {
  let g = [1];
  for (let i = 0; i < d; i++) {
    const n = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { n[j] ^= g[j]; n[j + 1] ^= gmul(g[j], EXP[i]); }
    g = n;
  }
  const r = new Array(d).fill(0);
  for (const b of data) {
    const f = b ^ r[0];
    r.shift(); r.push(0);
    for (let i = 0; i < d; i++) r[i] ^= gmul(g[i + 1], f);
  }
  return r;
}
function qrPenalty(g, size) {                        // штрафы 1-4 по ISO/IEC 18004
  let p = 0, dark = 0;
  const scan = (s) => {
    let run = 1;
    for (let i = 1; i <= s.length; i++) {
      if (i < s.length && s[i] === s[i - 1]) run++; else { if (run >= 5) p += 3 + (run - 5); run = 1; }
    }
    for (const pat of ['10111010000', '00001011101']) {
      for (let at = s.indexOf(pat); at >= 0; at = s.indexOf(pat, at + 1)) p += 40;
    }
  };
  for (let y = 0; y < size; y++) {
    let row = '', col = '';
    for (let x = 0; x < size; x++) { row += g[y][x] ? '1' : '0'; col += g[x][y] ? '1' : '0'; dark += g[y][x]; }
    scan(row); scan(col);
    if (y < size - 1) for (let x = 0; x < size - 1; x++) {
      const s = g[y][x] + g[y][x + 1] + g[y + 1][x] + g[y + 1][x + 1];
      if (s === 0 || s === 4) p += 3;
    }
  }
  return p + 10 * Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5);
}
function qrMatrix(text) {
  const bytes = [];
  for (const ch of unescape(encodeURIComponent(String(text)))) bytes.push(ch.charCodeAt(0) & 0xFF);
  let ver = 0;
  for (let v = 1; v <= 10; v++) if (bytes.length <= ((CAP[v][0] * 8 - 4 - (v < 10 ? 8 : 16)) >> 3)) { ver = v; break; }
  if (!ver) return null;
  const dataCw = CAP[ver][0], ecCw = CAP[ver][1], g1 = CAP[ver][2], g1d = CAP[ver][3], g2 = CAP[ver][4], g2d = CAP[ver][5];

  const bits = [];                                   // mode 0100 + длина + байты + терминатор + паддинг
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4); push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < dataCw * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let i = 0; cw.length < dataCw; i++) cw.push(i % 2 ? 0x11 : 0xEC);

  const blocks = [];                                 // блоки + RS, затем чередование
  for (let i = 0, at = 0; i < g1 + g2; i++) {
    const n = i < g1 ? g1d : g2d, d = cw.slice(at, at + n);
    at += n; blocks.push({ d, e: rsEC(d, ecCw) });
  }
  const stream = [];
  const put = (b) => { for (let i = 7; i >= 0; i--) stream.push((b >> i) & 1); };
  for (let i = 0; i < Math.max(g1d, g2d); i++) for (const b of blocks) if (i < b.d.length) put(b.d[i]);
  for (let i = 0; i < ecCw; i++) for (const b of blocks) put(b.e[i]);
  for (let i = 0, rem = (ver >= 2 && ver <= 6) ? 7 : 0; i < rem; i++) stream.push(0);

  const size = 17 + 4 * ver, m = [], res = [];       // каркас: finder / timing / alignment / dark
  for (let y = 0; y < size; y++) { m.push(new Array(size).fill(0)); res.push(new Array(size).fill(0)); }
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < size && y < size) { m[y][x] = v ? 1 : 0; res[y][x] = 1; } };
  for (const f of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
      const inner = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      set(f[0] + dx, f[1] + dy, inner && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)));
    }
  }
  for (let i = 8; i < size - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
  for (const cx of ALIGN[ver]) for (const cy of ALIGN[ver]) {
    if ((cx <= 8 && cy <= 8) || (cx <= 8 && cy >= size - 9) || (cx >= size - 9 && cy <= 8)) continue;   // под finder не лезем
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  set(8, size - 8, 1);                                               // dark module
  for (let i = 0; i <= 8; i++) { set(8, i, m[i][8]); set(i, 8, m[8][i]); }         // резерв под format info
  for (let i = 0; i < 8; i++) { set(size - 1 - i, 8, 0); set(8, size - 1 - i, 0); }
  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
    const vb = (ver << 12) | r;
    for (let i = 0; i < 18; i++) {
      const bit = (vb >> i) & 1, a = size - 11 + (i % 3), b = (i / 3) | 0;
      set(a, b, bit); set(b, a, bit);
    }
  }
  let idx = 0, up = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5;                                          // столбец тайминга пропускаем
    for (let n = 0; n < size; n++) {
      const y = up ? size - 1 - n : n;
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        if (res[y][x]) continue;
        m[y][x] = idx < stream.length ? stream[idx] : 0;
        idx++;
      }
    }
    up = !up;
  }
  let best = null, bestPen = Infinity;
  for (let k = 0; k < 8; k++) {
    const g = m.map((row, y) => row.map((v, x) => (res[y][x] ? v : (v ^ (MASKS[k](y, x) ? 1 : 0)))));
    let f = (0b01 << 3) | k, r = f;                                  // 01 = EC level L
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const fb = ((f << 10) | r) ^ 0x5412;
    for (let i = 0; i <= 5; i++) g[i][8] = (fb >> i) & 1;
    g[7][8] = (fb >> 6) & 1; g[8][8] = (fb >> 7) & 1; g[8][7] = (fb >> 8) & 1;
    for (let i = 9; i < 15; i++) g[8][14 - i] = (fb >> i) & 1;
    for (let i = 0; i < 8; i++) g[size - 1 - i][8] = (fb >> i) & 1;
    for (let i = 8; i < 15; i++) g[8][size - 15 + i] = (fb >> i) & 1;
    g[size - 8][8] = 1;
    const p = qrPenalty(g, size);
    if (p < bestPen) { bestPen = p; best = g; }
  }
  return { size, m: best };
}
function qrBlock(url) {
  const q = qrMatrix(url);
  if (!q) {
    return '<div class="qr" style="display:grid;place-items:center;width:150px;height:150px;padding:16px;'
      + 'color:#6b7180;font-size:11.5px;text-align:center;line-height:1.35">Link too long for an on-screen code —'
      + ' use Copy or Text link</div>';
  }
  let d = '';
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.m[y][x]) d += 'M' + x + ' ' + y + 'h1v1h-1z';
  const s = q.size + 8;                                              // тихая зона 4 модуля с каждой стороны
  return '<div class="qr" style="display:block;width:min(230px,72%);height:auto;aspect-ratio:1;padding:12px">'
    + '<svg viewBox="-4 -4 ' + s + ' ' + s + '" width="100%" height="100%" shape-rendering="crispEdges" '
    + 'role="img" aria-label="Payment QR code"><rect x="-4" y="-4" width="' + s + '" height="' + s + '" fill="#fff"/>'
    + '<path d="' + d + '" fill="#12110F"/></svg></div>';
}

/* ---- экраны ---------------------------------------------------------------- */
const PICK_CAP = 120;      // потолок ОТРИСОВКИ, а не поиска

const invHay = (e) => [e.unit.tenant, e.unit.company, e.unit.id, e.building.name,
  e.floor && e.floor.name, e.unit.tel || e.unit.phone].filter(Boolean).join(' ').toLowerCase();

/**
 * Список арендаторов.
 * Раньше здесь было slice(0, 80) + bindFilter, то есть поиск прятал уже
 * ОТРИСОВАННЫЕ строки — всё, что не попало в первые 80, найти было нельзя.
 * Тот же дефект стоил оператору попытки выписать договор (см. lease.js).
 * Фильтруем данные, потолок применяем к результату.
 */
function pickRows(ctx, rows, q) {
  const hits = q ? rows.filter((e) => {
    const hay = invHay(e);
    return hay.includes(q) || hay.includes(q.replace(/^0+(\d)/, '$1'));
  }) : rows;
  const shown = hits.slice(0, PICK_CAP);
  if (!shown.length) {
    return '<div class="empty">' + (q ? 'No tenant matches “' + esc(q) + '”.'
      : 'No tenants in this building yet.') + '</div>';
  }
  let h = shown.map((e) => {
    const u = e.unit, nm = u.tenant || u.company || suiteLabel(u);
    return '<button class="act-row" data-act="inv:pick" data-b="' + esc(e.building.id) + '" data-f="'
      + esc((e.floor && e.floor.id) || '') + '" data-u="' + esc(u.id) + '">' + I.user
      + '<span><span class="t">' + esc(nm) + '</span><span class="s">' + esc(suiteLabel(u)) + ' · '
      + esc(e.building.name || '') + '</span></span></button>';
  }).join('');
  if (hits.length > shown.length) {
    h += '<div class="hintline" style="text-align:center;padding:8px">Showing ' + shown.length
      + ' of ' + hits.length + ' — type to narrow it down.</div>';
  }
  return h;
}

/**
 * Сводка счёта. Отдельно, потому что перерисовывается ПО ВВОДУ: значения полей
 * забираются из DOM только при нажатии (readForm), а сводка рисовалась один раз.
 * Оператор набирал 777 и видел под кнопкой Send прежний «Total $2,400» — то же,
 * что поймали на мастере договора. На саму отправку это не влияло, но проверять
 * перед отправкой было нечем, а сводка существует ровно для этого.
 */
function recapHtml(ctx, L, hit) {
  const u = hit.unit;
  return '<div class="recap"><div><span>Tenant</span><b>' + esc(u.tenant || u.company || '—') + '</b></div>'
    + '<div><span>Emails to</span><b style="word-break:break-all">' + esc(u.email || 'no email on file') + '</b></div>'
    + '<div><span>Suite</span><b>' + esc(suiteLabel(u)) + '</b></div>'
    + '<div><span>Total</span><b>' + esc(usd(ctx, amountOf(ctx, L, hit))) + '</b></div></div>';
}
/** Сводка следует за суммой и текстом. Перерисовываем ТОЛЬКО её. */
function bindRecap(ctx, L, hit) {
  setTimeout(() => {
    const box = document.getElementById('invRecap');
    if (!box) return;
    for (const [key, id] of [['amount', 'invAmt'], ['memo', 'invMemo']]) {
      const inp = document.getElementById(id);
      if (!inp || inp.dataset.recap) continue;
      inp.dataset.recap = '1';
      inp.addEventListener('input', () => {
        L[key] = inp.value;
        try { box.innerHTML = recapHtml(ctx, L, hit); }
        catch (e) { console.error('[m] invoice recap failed:', e); }
      });
    }
  }, 0);
}

function picker(ctx) {
  const snap = ctx.snap || {}, scope = String((ctx.S && ctx.S.scope) || 'all');
  const L = st(ctx);
  const rows = (snap.units || []).filter((e) => e && !e.unit.archivedAt && isOccupied(e.unit)
    && (scope === 'all' || String(e.building.id) === scope));
  bindPickInv(ctx, L, rows);
  return '<div class="field"><label>Who is this for?</label><div class="searchbox" style="box-shadow:none">' + I.search
    + '<input id="invQ" placeholder="Tenant, suite or company" autocomplete="off" value="' + esc(L.q || '') + '"></div></div>'
    + '<div id="invList">' + pickRows(ctx, rows, String(L.q || '').trim().toLowerCase()) + '</div>';
}
function bindPickInv(ctx, L, rows) {
  setTimeout(() => {
    const inp = document.getElementById('invQ');
    const list = document.getElementById('invList');
    if (!inp || !list || inp.dataset.bound) return;
    inp.dataset.bound = '1';
    // Перерисовываем только список: трогать input нельзя — на телефоне это
    // уводит фокус и закрывает клавиатуру после каждого символа.
    inp.addEventListener('input', () => {
      L.q = inp.value;
      try { list.innerHTML = pickRows(ctx, rows, inp.value.trim().toLowerCase()); }
      catch (e) { console.error('[m] tenant picker failed:', e); }
    });
  }, 0);
}
function dupCard(ctx, L, dup) {
  const r = dup.row;
  // Даты может не быть (счёт из урезанного кэша) — тогда просто не пишем «sent»:
  // висящее «sent —» читается как сломанный интерфейс.
  const when = r.created ? dshort(ctx, new Date(r.created)) : '';
  const state = dup.paid ? 'already PAID' : dup.pastDue ? 'open and past due' : 'still open';
  const armed = L.confirmDup === r.id;
  return '<div class="verdict" data-s="overdue" style="align-items:flex-start"><span class="vi">' + I.alert + '</span>'
    + '<span><span class="vt">' + (dup.paid ? 'This month is already paid' : 'An invoice already exists') + '</span>'
    + '<span class="vs">' + esc(r.number || r.id) + ' · ' + esc(usd(ctx, r.total)) + ' · ' + state
    + (when ? ' · sent ' + esc(when) : '') + '</span></span></div>'
    + '<div class="hintline" style="margin:-6px 0 14px;color:' + (armed ? 'var(--bad)' : 'var(--ink-2)') + '">'
    + (armed ? 'Confirmed — the next tap really does send a second invoice for the same thing.'
      : 'Sending now creates a SECOND invoice for the same suite, month and purpose. Void the old one in the full '
      + 'version, or tap Send twice to do it anyway.') + '</div>';
}
function form(ctx, L, hit) {
  const snap = ctx.snap || {}, u = hit.unit;
  const amt = amountOf(ctx, L, hit), dup = dupOf(ctx, L, hit);
  const autopay = !!(u.autoPayConsent && u.autoPayConsent.acceptedAt);
  let h = '';
  if (L.err) {
    h += '<div class="verdict" data-s="overdue" style="align-items:flex-start"><span class="vi">' + I.alert + '</span>'
      + '<span><span class="vt">Not sent</span><span class="vs">' + esc(L.err) + '</span></span></div>';
  }
  if (hit.from) {
    h += '<div class="whatnext" style="margin-bottom:12px">' + I.info + '<span>Suite ' + esc(hit.from)
      + ' is part of a multi-suite lease — billing runs through ' + esc(suiteLabel(u)) + '.</span></div>';
  }
  h += '<div class="presets">' + PRESETS.map((p) => '<button class="preset" data-act="inv:preset" data-k="' + p.k
    + '" aria-pressed="' + (L.preset === p.k) + '">' + p.label + (p.k === 'rent' ? ' · ' + ymLabel(L.ym).split(' ')[0] : '')
    + '</button>').join('') + '</div>';
  if (periodic(L.preset)) {
    h += '<div class="field"><label>Billing month</label><div class="seg" style="margin-bottom:0">'
      + '<button data-act="inv:ym" data-d="-1" style="flex:0 0 56px">‹</button>'
      + '<button aria-pressed="true" data-act="inv:noop">' + esc(ymLabel(L.ym)) + '</button>'
      + '<button data-act="inv:ym" data-d="1" style="flex:0 0 56px">›</button></div></div>';
  }
  // Service — не свободная строка: оператор выбирает позицию из того же
  // каталога, по которому выставляет счета с компьютера.
  if (L.preset === 'service') h += serviceList(ctx, L);
  h += '<div class="amount"><span class="cur">$</span><input class="n" id="invAmt" inputmode="decimal" '
    + 'aria-label="Amount" value="' + esc(amt ? String(amt) : '') + '" placeholder="0"></div>';
  h += '<div class="field"><label>Payment due in</label><div class="seg" style="margin-bottom:0">'
    + [7, 14, 30].map((d) => '<button data-act="inv:due" data-d="' + d + '" aria-pressed="' + (L.days === d) + '">'
      + d + ' days</button>').join('') + '</div></div>';
  h += '<div class="field"><label>What the tenant sees</label><input class="val" id="invMemo" value="'
    + esc(memoOf(L, hit)) + '" placeholder="Invoice description"></div>';
  if (dup) h += dupCard(ctx, L, dup);
  else if (!snap.invoicesAvailable) {
    h += '<div class="whatnext" style="margin-bottom:10px">' + I.info + '<span>Invoice history has not loaded, so '
      + 'this cannot be checked against existing invoices. Stripe still blocks an exact duplicate.</span></div>';
  }
  h += '<div id="invRecap">' + (bindRecap(ctx, L, hit), recapHtml(ctx, L, hit)) + '</div>';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(u.email || '').trim())) {
    h += '<div class="verdict" data-s="due" style="align-items:flex-start;margin-top:10px">'
      + '<span class="vi">' + I.alert + '</span><span><span class="vt">No email on this unit</span>'
      + '<span class="vs">Stripe emails the invoice, so it cannot go out. Add the address in the full version.</span>'
      + '</span></div>';
  }
  h += '<div class="whatnext">' + I.info + '<span>' + (autopay
    ? 'This tenant is on autopay — the card on file is charged and there may be no payment link to show.'
    : 'After sending you get a payment link and a QR code — the tenant can pay right in front of you.')
    + '</span></div>';
  return h;
}
function doneBody(ctx, L) {
  const d = L.done;
  let h = '<div class="done"><div class="ring">' + I.check + '</div><h3>Invoice sent</h3><p>'
    + esc(usd(ctx, d.amount)) + ' · ' + esc(d.number || d.invoiceId) + '</p></div>';
  if (d.hostedUrl) {
    h += qrBlock(d.hostedUrl);
    h += '<div class="linkrow">' + I.link + '<span>' + esc(d.hostedUrl.replace(/^https?:\/\//, '')) + '</span>'
      + '<button data-act="inv:copy" data-url="' + esc(d.hostedUrl) + '">Copy</button></div>';
    h += '<div class="whatnext">' + I.info + '<span>Show the QR to the tenant or text the link — the payment lands '
      + 'here automatically.</span></div>';
  } else {
    h += '<div class="whatnext" style="margin-top:14px">' + I.info + '<span>Stripe returned no payment page for this '
      + 'invoice — that happens when the tenant is charged automatically. Nothing else to do.</span></div>';
  }
  return h;
}

/* ---- публичный API --------------------------------------------------------- */
export function render(ctx) {
  const L = st(ctx);
  const raw = L.unitId ? findUnit(ctx.snap || {}, L.buildingId, L.unitId) : null;
  const hit = raw ? headOf(ctx, raw) : null;
  const title = L.done ? 'Invoice sent' : 'Send an invoice';
  const sub = L.done ? 'Payment link ready'
    : hit ? (hit.unit.tenant || hit.unit.company || 'Tenant') + ' · ' + suiteLabel(hit.unit)
      : 'Pick the tenant first';
  const h = '<div class="sheet-h"><div><h3>' + title + '</h3><p>' + esc(sub) + '</p></div>'
    + '<button class="x-btn" data-act="inv:close" aria-label="Close">✕</button></div>';
  // Роль без права отправки — говорим сразу, а не после заполнения формы.
  if (!L.done && typeof ctx.canSend === 'function' && !ctx.canSend()) {
    return h + '<div class="verdict" data-s="due" style="align-items:flex-start"><span class="vi">' + I.alert + '</span>'
      + '<span><span class="vt">Your role cannot send invoices</span>'
      + '<span class="vs">You can look at payments, but issuing an invoice needs an admin or manager account. '
      + 'Ask an admin to change your role, then reopen the app.</span></span></div>';
  }
  if (L.done) return h + doneBody(ctx, L);
  if (L.unitId && !hit) {
    return h + '<div class="empty">That unit is no longer in this snapshot.</div>'
      + '<button class="act-row" data-act="inv:reset">' + I.user + '<span><span class="t">Pick someone else</span></span></button>';
  }
  return h + (hit ? form(ctx, L, hit) : picker(ctx));
}

export function foot(ctx) {
  const L = st(ctx);
  if (!L.done && typeof ctx.canSend === 'function' && !ctx.canSend()) {
    return '<button class="big-btn" data-act="inv:close">Close</button>';
  }
  if (L.done) {
    const tel = String(L.done.tel || '').replace(/[^\d+]/g, '');
    const sms = (tel && L.done.hostedUrl)
      ? '<a class="big-btn ghost" style="text-decoration:none" href="sms:' + esc(tel) + '?&body='
        + encodeURIComponent('Here is your invoice: ' + L.done.hostedUrl) + '">' + I.phone + 'Text link</a>'
      : '';
    return sms + '<button class="big-btn" data-act="inv:close">Done</button>';
  }
  const raw = L.unitId ? findUnit(ctx.snap || {}, L.buildingId, L.unitId) : null;
  const hit = raw ? headOf(ctx, raw) : null;
  if (!hit) return '';
  if (L.busy) return '<button class="big-btn" disabled>Sending…</button>';
  const dup = dupOf(ctx, L, hit);
  const armed = dup && L.confirmDup === dup.row.id;
  const label = armed ? 'Send a second one' : dup ? 'Send anyway' : 'Send invoice';
  return '<button class="big-btn" data-act="inv:send"' + (dup ? ' style="background:var(--bad)"' : '') + '>'
    + I.send + label + '</button>';
}

export function handle(act, el, ctx) {
  if (typeof act !== 'string' || act.indexOf('inv:') !== 0) return false;
  const S = ctx.S || {}, L = st(ctx);
  readForm(L);                                      // введённое сохраняем ДО перерисовки
  if (act === 'inv:noop') return true;
  if (act === 'inv:close') {
    const back = L.returnTo;
    S.inv = null;
    // Пришли с экрана заселения — возвращаемся туда, а не в пустоту: там
    // оператор видит, что осталось отправить.
    if (back === 'lease' && S.lease && S.lease.done) { ctx.openSheet('lease'); return true; }
    ctx.closeSheet();
    return true;
  }
  // Сброс должен ПЕРЕЖИТЬ payload: иначе st() тут же вернёт тот же (пропавший)
  // юнит и «Pick someone else» окажется тупиком.
  if (act === 'inv:reset') { S.inv = null; const N = st(ctx); N.unitId = null; N.done = null; N.err = null; return true; }
  if (act === 'inv:pick') {
    L.buildingId = el.getAttribute('data-b') || null;
    L.floorId = el.getAttribute('data-f') || null;
    L.unitId = el.getAttribute('data-u') || null;
    L.amount = ''; L.memo = ''; L.err = null; L.confirmDup = null;
    return true;
  }
  if (act === 'inv:preset') {
    L.preset = el.getAttribute('data-k') || 'rent';
    L.amount = ''; L.memo = ''; L.confirmDup = null; L.err = null;    // сумма и текст пересчитываются под пресет
    L.svcId = null;                                                   // выбор услуги не переносим на другой пресет
    return true;
  }
  if (act === 'inv:svc') {
    const svc = serviceById(ctx.snap, el.getAttribute('data-id'));
    if (!svc) return true;
    // Повторный тап снимает выбор — иначе от ошибочной услуги не отделаться,
    // не закрыв лист целиком.
    if (String(L.svcId || '') === String(svc.id)) { L.svcId = null; L.amount = ''; L.memo = ''; }
    else { L.svcId = String(svc.id); L.amount = String(+svc.amount); L.memo = svc.name; }
    L.confirmDup = null; L.err = null;
    return true;
  }
  if (act === 'inv:ym') {
    L.ym = shiftYm(L.ym, +el.getAttribute('data-d') || 0);
    L.memo = ''; L.confirmDup = null;
    return true;
  }
  if (act === 'inv:due') { L.days = +el.getAttribute('data-d') || 14; return true; }
  if (act === 'inv:copy') {
    const url = el.getAttribute('data-url') || '';
    copy(url).then(() => ctx.toast && ctx.toast('Link copied'), () => ctx.toast && ctx.toast('Could not copy — long-press the link'));
    return true;
  }
  if (act === 'inv:send') {
    const raw = L.unitId ? findUnit(ctx.snap || {}, L.buildingId, L.unitId) : null;
    const hit = raw ? headOf(ctx, raw) : null;
    if (!hit) { L.err = 'That unit is no longer in this snapshot.'; return true; }
    const dup = dupOf(ctx, L, hit);
    // Второй осознанный тап — единственный путь поверх живого счёта.
    if (dup && L.confirmDup !== dup.row.id) { L.confirmDup = dup.row.id; L.err = null; return true; }
    send(ctx, L, hit, !!dup);
    return true;
  }
  return false;
}
function copy(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  } catch (e) { /* не https или старый webview */ }
  return new Promise((res, rej) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? res() : rej(new Error('copy failed'));
    } catch (e) { rej(e); }
  });
}

/* ---- отправка: только id через await; локальное состояние юнита не пишем —
   штампы u.stripe/u.payments кладёт сам CF (CF:1709-1742). ------------------ */
async function send(ctx, L, hit, isDup) {
  const buildingId = hit.building.id, floorId = hit.floor && hit.floor.id, unitId = hit.unit.id;
  const purpose = presetOf(L.preset).purpose;
  const amount = amountOf(ctx, L, hit);
  const memo = String(memoOf(L, hit) || '').trim();
  const tel = hit.unit.tel || hit.unit.phone || '';

  if (L.preset === 'service' && !L.svcId && !memoOf(L, hit)) {
    return fail(ctx, L, 'Pick a service from the list first — or use Custom to type your own.');
  }
  if (!(amount > 0)) return fail(ctx, L, 'Enter an amount greater than $0.');
  // Stripe выставляет счёт НА ПОЧТУ. Без неё вызов упадёт невнятной ошибкой уже
  // после того, как оператор всё заполнил (в проде так живёт сьют 101 на
  // $13,318/мес). Говорим до попытки и подсказываем, где чинится.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(hit.unit.email || '').trim())) {
    return fail(ctx, L, 'This unit has no email on file, so Stripe has nowhere to send the invoice. '
      + 'Add the tenant’s email in the full version, then try again.');
  }
  if (!buildingId || !floorId || !unitId) return fail(ctx, L, 'This unit is missing its building or floor — open it in the full version.');
  if (purpose === 'rent' && !/^\d{4}-\d{2}$/.test(L.ym)) return fail(ctx, L, 'Pick a billing month first.');
  if (typeof ctx.callCF !== 'function') return fail(ctx, L, 'The app is not connected to the server yet.');

  L.busy = true; L.err = null; repaint(ctx);
  try {
    const body = {
      buildingId, floorId, unitId,
      ym: L.ym,                                     // rent требует YYYY-MM; остальным — просто дедуп-ключ
      daysUntilDue: L.days,
      purpose,
      amountOverride: amount,                       // ДОЛЛАРЫ
      description: memo || undefined,
      allowDuplicate: isDup || undefined,           // взводится только вторым тапом
    };
    // Тот же ключ на ретрае того же тела; другой — на изменённом теле и на
    // осознанном дубле (см. шапку файла).
    body.idempotencyKey = idemFor(L, body, isDup);
    const res = await ctx.callCF('createStripeInvoice', body, { timeoutMs: 30000 });
    const r = (res && res.invoiceId === undefined && res.data) ? res.data : (res || {});
    L.busy = false;
    L.done = {
      invoiceId: r.invoiceId || '', number: r.number || '', hostedUrl: r.hostedUrl || '',
      amount: (typeof r.amount === 'number' ? r.amount / 100 : amount),   // ответ в ЦЕНТАХ
      tel,
    };
    // Экран заселения ждёт факт отправки СРАЗУ, не дожидаясь синхронизации
    // Stripe-кэша. Пишем ровно то, что вернул сервер — ничего не выдумываем.
    const S = ctx.S || {};
    if (L.slot && S.lease && S.lease.done) {
      S.lease.done.sent = S.lease.done.sent || {};
      S.lease.done.sent[L.slot] = {
        id: r.invoiceId || '', number: r.number || '',
        // ДОЛЛАРЫ: строки снимка (normRow в data.js) тоже в долларах, а ответ CF
        // приходит в центах. Смешать единицы здесь — показать $90,000 вместо $900.
        total: (typeof r.amount === 'number' ? r.amount / 100 : amount),
        status: 'open', bucket: 'open', hostedUrl: r.hostedUrl || '',
      };
    }
    if (typeof ctx.refresh === 'function') { try { ctx.refresh(); } catch (e) { /* сеть */ } }
    if (typeof ctx.toast === 'function') ctx.toast('Invoice sent');
  } catch (e) {
    L.busy = false;
    const code = String((e && e.code) || '');
    let msg = (e && e.message) || 'The invoice was not sent.';
    if (/already-exists/.test(code)) msg += ' Tap Send twice to issue it anyway.';
    else if (/resource-exhausted/.test(code)) msg += ' Failed attempts count too — finish this on the desktop today.';
    else if ((e && e.mayHaveCompleted) || /timeout|deadline/.test(code)) {
      msg += ' Sending again reuses the same key, so Stripe will not double-charge.';
    }
    L.err = msg;
  }
  repaint(ctx);
}
function fail(ctx, L, msg) { L.busy = false; L.err = msg; repaint(ctx); }
