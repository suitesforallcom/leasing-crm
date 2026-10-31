/**
 * Счёт принадлежит ЗДАНИЮ юнита — Entry 102 (FIXES_LOG).
 *
 * Инцидент 2026-10-31: Apt 113 в 4355 Central Ave показывал Invoice history /
 * Invoice report со счетами Suite 113 Bay Vista Dr (BAY-D-113-OCT30-1527,
 * BAY-R-113-NOV26-OCT30-1526), а анти-дубль в stripeCreateInvoice называл чужой
 * счёт дублем и блокировал отправку депозита. Юнит в клиенте опознаётся голым
 * u.id («113»), кэш счетов один на весь портфель, и per-unit выборки матчили
 * только metadata.unitId — хотя buildingId CF пишет в каждый счёт. На проде
 * 294 номера из 675 повторяются между зданиями; 93 номера текли.
 *
 * Правило (то же, что у сетки Payment history с Entry 91 и у m/lib/money.js
 * _rowsForUnit): строка с ЧУЖИМ buildingId отбрасывается всегда; строка без
 * buildingId (legacy) принимается как раньше; явный штамп самого юнита
 * (depositInvoice / moveInRent / lastInvoiceId) показывается всегда.
 *
 * Функции достаём ИЗ ФАЙЛОВ (как tests/email-guard.test.mjs): десктоп —
 * floor-map-editor.html (блок «Entry 102: invoice ↔ building scope» + индекс
 * _invRowsForUnit + сканеры кэша + Entry 95 для _normEmail), телефон —
 * m/lib/money.js через import(). Плюс гейты по исходнику для мест, которые не
 * исполнить без DOM (анти-дубль в stripeCreateInvoice, heal в renderUnits,
 * _voidTenantOpenInvoices, заливка карты, m/ui/invoice.js dupOf).
 *
 * node tests/invoice-scope.test.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(here, '..', 'floor-map-editor.html');
const MONEY_PATH = path.join(here, '..', 'm', 'lib', 'money.js');
const M_INVOICE_PATH = path.join(here, '..', 'm', 'ui', 'invoice.js');
const src = fs.readFileSync(HTML_PATH, 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' — ' + e.message); fail++; } };
const ta = async (name, fn) => { try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' — ' + e.message); fail++; } };
const section = (title) => console.log('\n' + title);
const count = (hay, needle) => hay.split(needle).length - 1;
// Массивы из vm-контекста живут в другом realm (другой Array.prototype) — deepStrictEqual
// сравнивает прототипы; копируем в realm теста.
const eqArr = (got, want) => assert.deepStrictEqual(Array.from(got), want);

// Вырезает top-level функцию от «\nfunction NAME(» / «\nasync function NAME(» до
// следующей top-level «\nfunction » (или до явного маркера endMarker).
function fnSource(name, endMarker) {
  let open = src.indexOf(`\nfunction ${name}(`);
  if (open < 0) open = src.indexOf(`\nasync function ${name}(`);
  if (open < 0) throw new Error(`floor-map-editor.html: function ${name} not found`);
  const end = endMarker ? src.indexOf(endMarker, open + 1) : src.indexOf('\nfunction ', open + 1);
  if (end < 0) throw new Error(`floor-map-editor.html: end of ${name} not found`);
  return src.slice(open, end);
}
function sliceBetween(open, close, label) {
  const from = src.indexOf(open);
  if (from < 0) throw new Error(`floor-map-editor.html: marker "${open}" not found — ${label} block missing`);
  const to = src.indexOf(close, from);
  if (to < 0) throw new Error(`floor-map-editor.html: marker "${close}" not found — ${label} block unterminated`);
  return src.slice(from, to);
}

// ── Фикстура: три здания, в каждом юнит «113»; два счёта Bay Vista в кэше ──
const BAY = 'b1778422024964', CEN = 'b1786454392162', SOU = 'b1776578294270';
const T_BAY = Date.UTC(2026, 9, 30, 19, 27);       // 2026-10-30 15:27 ET
const bayDep = () => ({ id: 'in_BAY_D', number: 'BAY-D-113-OCT30-1527', status: 'paid', bucket: 'paid', total: 1150,
  customerId: 'cus_JOE', customerEmail: 'joe@asset-tree.com', customerName: 'Joseph DelGuidice',
  description: 'Security deposit — Suite 113 · move-in November 2026', created: T_BAY,
  metadata: { source: 'suitesforall', unitId: '113', buildingId: BAY, floorId: 'bay-f1', purpose: 'deposit', ym: '2026-10' } });
const bayRent = () => ({ id: 'in_BAY_R', number: 'BAY-R-113-NOV26-OCT30-1526', status: 'paid', bucket: 'paid', total: 1111.67,
  customerId: 'cus_JOE', customerEmail: 'joe@asset-tree.com', customerName: 'Joseph DelGuidice',
  description: 'Rent · Suite 113 · November 2026 (prorated)', created: T_BAY - 8000,
  metadata: { source: 'suitesforall', unitId: '113', buildingId: BAY, floorId: 'bay-f1', purpose: 'rent', ym: '2026-11' } });
// legacy-строка: наш счёт без buildingId (до того как CF начал его писать)
const legacyRow = () => ({ id: 'in_LEGACY', number: 'R-113-MAY26-APR20-0900', status: 'paid', bucket: 'paid', total: 900,
  customerId: 'cus_OLD', customerEmail: 'old@tenant.test', created: Date.UTC(2026, 3, 20),
  metadata: { source: 'suitesforall', unitId: '113', purpose: 'rent', ym: '2026-05' } });

function mkUnits() {
  const sou113 = { id: '113', tenant: '', email: '', status: 'vacant', payments: {}, stripe: null };
  const bay113 = { id: '113', tenant: 'Joseph DelGuidice', email: 'joe@asset-tree.com', status: 'occupied',
    leaseStart: '2026-11-02', contractRent: 1150, deposit: 1150, payments: {}, stripe: { customerId: 'cus_JOE' } };
  const cen113 = { id: '113', tenant: 'Abigail Renee Brogdon', email: 'kilgoreabigail222@gmail.com', status: 'occupied',
    leaseStart: '2026-12-01', contractRent: 1525, deposit: 1525, payments: {}, stripe: null };
  const state = { buildings: [
    { id: SOU, name: 'Pasadena', floors: [{ id: 'sou-f1', units: [sou113] }] },
    { id: BAY, name: 'Bay Vista Dr', floors: [{ id: 'bay-f1', units: [bay113] }] },
    { id: CEN, name: '4355 Central Ave', floors: [{ id: 'cen-f1', units: [cen113] }] },
  ], ui: {} };
  return { state, sou113, bay113, cen113 };
}

// ── Десктопный контекст: лифтим реальные функции в vm ───────────────────────
function desktopCtx(rows, units, opts = {}) {
  const code = [
    "const MONTH_NAMES_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];",
    src.split('\n').find(l => l.startsWith('function isValidEmail(')) || 'function isValidEmail(e){ return /@/.test(String(e||"")); }',
    sliceBetween('// ─── Entry 95: tenant contact hygiene ───', '// ─── /Entry 95 ───', 'Entry 95'),
    sliceBetween('// ─── Entry 102: invoice ↔ building scope ───', '// ─── /Entry 102 ───', 'Entry 102'),
    // индекс кэша: var-ы + _invIndexEnsure + _invRowsForUnit
    src.slice(src.indexOf('\nvar _invoicesCacheById = null;'), src.indexOf("\n// Look up a Stripe invoice's real bucket")),
    fnSource('_parseDateUTC'),
    fnSource('_tenantTenureStartMs'),
    fnSource('_invoiceBelongsHere'),
    fnSource('_mergeIntoInvoicesCache', '\n// Invoice-bucket persistence'),
    fnSource('_collectUnitInvoices', '\n// Inject a just-sent invoice into _invoicesCache'),
    fnSource('_findDepositInvoiceInCache'),
    fnSource('_findRentInvoiceInCache'),
    fnSource('_depositPaidFromCache'),
    fnSource('_rentPaidRowFromCache'),
    fnSource('_verifyAndStampAfterSend'),
    'this.api = { _collectUnitInvoices, _findDepositInvoiceInCache, _findRentInvoiceInCache, _depositPaidFromCache,',
    '  _rentPaidRowFromCache, _invRowsForUnit, _invRowInBuilding, _unitBuildingIdOf, _verifyAndStampAfterSend, _mergeIntoInvoicesCache };',
  ].join('\n');
  const ctx = {
    state: units.state, _invoicesCache: rows, console,
    currentBuilding: opts.currentBuilding || (() => units.state.buildings[2]),   // панель открыта на 4355 Central
    fbSync: { enabled: true },
    stripeListInvoices: async () => ({ rows: rows.slice() }),
    _persistInvoiceBucketsFromCache: () => {},
    saveState: () => { ctx.saved = (ctx.saved || 0) + 1; },
    fbPushNow: () => Promise.resolve(),
    renderUnits: () => {},
    _loadInvoiceBucketDisk: () => ({}),
    _stampInvoiceBucketPaidDisk: () => {},
    _lookupInvoiceBucket: () => null,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'floor-map-editor.lifted.js' });
  return ctx;
}

section('Entry 102 — Invoice history / report: счёт только своего здания');
t('Central/113 и вакантный Pasadena/113 НЕ видят счета Bay Vista/113; Bay Vista видит оба', () => {
  const u = mkUnits(); const c = desktopCtx([bayDep(), bayRent()], u);
  eqArr(c.api._collectUnitInvoices(u.cen113).map(r => r.number), []);
  eqArr(c.api._collectUnitInvoices(u.sou113).map(r => r.number), []);
  eqArr(c.api._collectUnitInvoices(u.bay113).map(r => r.number).sort(),
    ['BAY-D-113-OCT30-1527', 'BAY-R-113-NOV26-OCT30-1526']);
});
t('legacy-строка без buildingId видна на обоих «113», как раньше', () => {
  const u = mkUnits(); const c = desktopCtx([legacyRow(), bayDep()], u);
  eqArr(c.api._collectUnitInvoices(u.cen113).map(r => r.number), ['R-113-MAY26-APR20-0900']);
  assert.ok(c.api._collectUnitInvoices(u.bay113).some(r => r.number === 'R-113-MAY26-APR20-0900'));
});
t('явный штамп самого юнита показывается даже с чужим buildingId (ссылка юнита сильнее здания)', () => {
  const u = mkUnits(); u.cen113.stripe = { depositInvoice: { invoiceId: 'in_BAY_D', status: 'paid' } };
  const c = desktopCtx([bayDep(), bayRent()], u);
  eqArr(c.api._collectUnitInvoices(u.cen113).map(r => r.number), ['BAY-D-113-OCT30-1527']);
});
t('тот же арендатор (email) в двух зданиях: сигнал customer/email не тянет счёт чужого сьюта', () => {
  const u = mkUnits(); u.cen113.email = 'joe@asset-tree.com'; u.cen113.stripe = { customerId: 'cus_JOE' }; u.cen113.leaseStart = '2026-10-01';
  const c = desktopCtx([bayDep(), bayRent()], u);
  eqArr(c.api._collectUnitInvoices(u.cen113).map(r => r.number), []);
});

section('Entry 102 — хелперы: _unitBuildingIdOf · _invRowInBuilding · _invRowsForUnit(unitId, bid)');
t('_unitBuildingIdOf находит здание по объекту юнита; чужой объект → currentBuilding()', () => {
  const u = mkUnits(); const c = desktopCtx([], u);
  assert.strictEqual(c.api._unitBuildingIdOf(u.bay113), BAY);
  assert.strictEqual(c.api._unitBuildingIdOf(u.cen113), CEN);
  assert.strictEqual(c.api._unitBuildingIdOf({ id: '113' }), CEN);   // не в state → текущее здание
  assert.strictEqual(c.api._unitBuildingIdOf(null), null);
});
t('_unitBuildingIdOf переживает подмену объекта здания (buildings-strip листенер)', () => {
  const u = mkUnits(); const c = desktopCtx([], u);
  assert.strictEqual(c.api._unitBuildingIdOf(u.bay113), BAY);
  const fresh = { id: '113', tenant: 'Joseph DelGuidice' };
  u.state.buildings[1] = { id: BAY, name: 'Bay Vista Dr', floors: [{ id: 'bay-f1', units: [fresh] }] };
  assert.strictEqual(c.api._unitBuildingIdOf(fresh), BAY);
});
t('_unitBuildingIdOf: юнит, вставленный в state ПОСЛЕ первого запроса, находится (промах не кэшируется)', () => {
  const u = mkUnits(); const c = desktopCtx([], u);
  const late = { id: '999', tenant: 'Late Tenant' };
  assert.strictEqual(c.api._unitBuildingIdOf(late), CEN);           // ещё не в state → текущее здание
  u.state.buildings[0].floors[0].units.push(late);                   // вставили в Pasadena
  assert.strictEqual(c.api._unitBuildingIdOf(late), SOU);
});
t('_unitBuildingIdOf → null, когда объект не в state и currentBuilding() пуст', () => {
  const u = mkUnits(); const c = desktopCtx([], u, { currentBuilding: () => null });
  assert.strictEqual(c.api._unitBuildingIdOf({ id: '1' }), null);
  assert.strictEqual(c.api._unitBuildingIdOf(u.bay113), BAY);
});
t('_invRowInBuilding: чужое здание → false; своё / без buildingId / без bid → true; верхнеуровневый r.buildingId тоже', () => {
  const u = mkUnits(); const c = desktopCtx([], u);
  assert.strictEqual(c.api._invRowInBuilding(bayDep(), CEN), false);
  assert.strictEqual(c.api._invRowInBuilding(bayDep(), BAY), true);
  assert.strictEqual(c.api._invRowInBuilding(legacyRow(), CEN), true);
  assert.strictEqual(c.api._invRowInBuilding(bayDep(), ''), true);
  assert.strictEqual(c.api._invRowInBuilding(bayDep(), null), true);
  assert.strictEqual(c.api._invRowInBuilding({ id: 'x', buildingId: BAY, metadata: {} }, CEN), false);
  assert.strictEqual(c.api._invRowInBuilding(null, CEN), false);
});
t('_invRowsForUnit(unitId, bid) отдаёт строки своего здания + legacy; без bid — старое поведение', () => {
  const u = mkUnits(); const c = desktopCtx([bayDep(), bayRent(), legacyRow()], u);
  eqArr(c.api._invRowsForUnit('113', CEN).map(r => r.id), ['in_LEGACY']);
  eqArr(c.api._invRowsForUnit('113', BAY).map(r => r.id).sort(), ['in_BAY_D', 'in_BAY_R', 'in_LEGACY']);
  assert.strictEqual(c.api._invRowsForUnit('113').length, 3);
  eqArr(c.api._invRowsForUnit('999', BAY), []);
});

section('Entry 102 — safety-net сканеры не штампуют чужой счёт');
t('_findDepositInvoiceInCache: юнит без email больше не усыновляет депозит чужого здания', () => {
  const u = mkUnits(); u.cen113.email = ''; const c = desktopCtx([bayDep(), bayRent()], u);
  assert.strictEqual(c.api._findDepositInvoiceInCache(u.cen113), null);
  assert.strictEqual(c.api._findDepositInvoiceInCache(u.bay113)?.id, 'in_BAY_D');
});
t('_findRentInvoiceInCache: то же для ренты', () => {
  const u = mkUnits(); u.cen113.email = ''; const c = desktopCtx([bayDep(), bayRent()], u);
  assert.strictEqual(c.api._findRentInvoiceInCache(u.cen113, '2026-11'), null);
  assert.strictEqual(c.api._findRentInvoiceInCache(u.bay113, '2026-11')?.id, 'in_BAY_R');
});
t('_depositPaidFromCache / _rentPaidRowFromCache: один арендатор в двух зданиях — чужой сьют не «оплачен»', () => {
  const u = mkUnits(); u.cen113.email = 'joe@asset-tree.com'; u.cen113.stripe = { customerId: 'cus_JOE' };
  const c = desktopCtx([bayDep(), bayRent()], u);
  assert.strictEqual(c.api._depositPaidFromCache(u.cen113), null);
  assert.strictEqual(c.api._rentPaidRowFromCache(u.cen113, '2026-11'), null);
  assert.strictEqual(c.api._depositPaidFromCache(u.bay113), 'in_BAY_D');
  assert.strictEqual(c.api._rentPaidRowFromCache(u.bay113, '2026-11')?.id, 'in_BAY_R');
});
await ta('_verifyAndStampAfterSend: после таймаута отправки чужой свежий депозит НЕ штампуется на Central/113', async () => {
  const u = mkUnits();
  const fresh = bayDep(); fresh.created = Date.now() - 60 * 1000;      // создан минуту назад, в 10-минутном окне
  const c = desktopCtx([fresh], u);
  assert.strictEqual(await c.api._verifyAndStampAfterSend(u.cen113, 'Deposit'), false);
  assert.strictEqual(u.cen113.stripe?.depositInvoice, undefined);
  assert.strictEqual(await c.api._verifyAndStampAfterSend(u.bay113, 'Deposit'), true);
  assert.strictEqual(u.bay113.stripe.depositInvoice.invoiceId, 'in_BAY_D');
});

section('Entry 102 — гейты по исходнику (места без DOM)');
t('анти-дубль в stripeCreateInvoice отбрасывает счёт чужого здания', () => {
  assert.strictEqual(count(src, "if (buildingId && typeof _invRowInBuilding === 'function' && !_invRowInBuilding(inv, buildingId)) return false;"), 1);
});
t('heal красной рамки авто-счёта, move-out void и recovery-void смотрят только на своё здание', () => {
  assert.strictEqual(count(src, "if (!_invRowInBuilding(r, _e102Bid)) return false; // Entry 102"), 3);
  assert.strictEqual(count(src, "if (!_invRowInBuilding(r, _e102Bid)) continue; // Entry 102"), 4);
});
t('заливка карты, сетка и вердикты берут подындекс со зданием; голых _invRowsForUnit(u.id) не осталось', () => {
  assert.strictEqual(count(src, '_invRowsForUnit(u.id, _unitBuildingIdOf(u))'), 6);   // карта ×2, вердикты ×2, MPM ×2
  assert.strictEqual(count(src, '_invRowsForUnit(u?.id, _unitBuildingIdOf(u))'), 1);
  assert.strictEqual(count(src, '_invRowsForUnit(u.id, b && b.id)'), 1);
  assert.strictEqual(count(src, '_invRowsForUnit(u.id)'), 0);
  assert.strictEqual(count(src, '_invRowsForUnit(u?.id)'), 0);
});
t('Record payment из отчёта, roll-in пени и ключ мемо заливки знают здание', () => {
  assert.strictEqual(count(src, "const _wantBid = _md.buildingId ? String(_md.buildingId) : (_cb && _cb.id != null ? String(_cb.id) : null);"), 1);
  assert.strictEqual(count(src, "&& _invRowInBuilding(i, _ciSelection.buildingId)"), 1);
  assert.strictEqual(count(src, "+ invCacheKey + errKey + leaseKey + bldKey;"), 1);
});
t('m/ui/invoice.js dupOf отбрасывает счёт чужого здания', () => {
  const mi = fs.readFileSync(M_INVOICE_PATH, 'utf8');
  assert.strictEqual(count(mi, "if (bid && rb && rb !== bid) continue;"), 1);
});
t('m/lib/money.js _hasOpenInvoice читает строки через _rowsForUnit (здание учтено)', () => {
  const mj = fs.readFileSync(MONEY_PATH, 'utf8');
  const body = mj.slice(mj.indexOf('function _hasOpenInvoice('), mj.indexOf('\nfunction ', mj.indexOf('function _hasOpenInvoice(') + 1));
  assert.ok(body.includes('_rowsForUnit(unit, snap)'), '_hasOpenInvoice must use _rowsForUnit');
  assert.ok(!body.includes('snap.invoices'), '_hasOpenInvoice must not scan snap.invoices by bare unitId');
});

section('Entry 102 — телефон: uiStatus не объявляет «invoiced» по счёту чужого здания');
await ta('Central/113 в статусе due с открытым счётом Bay Vista/113 → due, не invoiced; Bay Vista/113 → invoiced', async () => {
  const money = await import(pathToFileURL(MONEY_PATH).href);
  const openBay = Object.assign(bayRent(), { status: 'open', bucket: 'open', amountPaid: 0 });
  const bay = { id: '113', type: 'office', status: 'occupied', tenant: 'Joseph DelGuidice', email: 'joe@asset-tree.com',
    contractRent: 1150, leaseStart: '2026-10-01', until: '2027-09-30', leaseTerm: 12, stripe: { customerId: 'cus_JOE' } };
  const cen = { id: '113', type: 'office', status: 'occupied', tenant: 'Abigail Renee Brogdon', email: 'kilgoreabigail222@gmail.com',
    contractRent: 1525, leaseStart: '2026-10-01', until: '2028-09-30', leaseTerm: 24 };
  const snap = {
    buildings: [
      { id: BAY, name: 'Bay Vista Dr', floors: [{ id: 'bay-f1', units: [bay] }] },
      { id: CEN, name: '4355 Central Ave', floors: [{ id: 'cen-f1', units: [cen] }] },
    ],
    invoices: [openBay], invoiceBuckets: {}, settings: {}, now: Date.UTC(2026, 10, 3, 12),   // 3 ноября: месяц «due», грейс ещё идёт
  };
  assert.strictEqual(money.uiStatus(bay, '2026-11', snap), 'invoiced');
  assert.strictEqual(money.uiStatus(cen, '2026-11', snap), 'due');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
