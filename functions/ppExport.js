// =========================================================================
// PropertyPulse read-only export — pure logic (no Firebase, no I/O).
//
// Это ЧИСТЫЙ модуль: разбор API-ключа, constant-time сравнение секрета и
// маппинг state → стабильный read-only DTO. Никаких обращений к Firestore,
// никаких записей — только трансформация переданного объекта state в новый
// объект. Тонкая HTTP-обёртка живёт в index.js (exports.ppOfficeExport) и
// переиспользует write-free readWorkspaceState().
//
// Контракт DTO версионируется через schemaVersion, чтобы PropertyPulse не
// ломался при изменении формы state. Отдаём ТОЛЬКО поля коворкинга
// (здания/этажи/юниты: tenant/company, lease, payments, stripe-указатели);
// геометрия плана, DocuSign-конверты, prospects, credentials и прочее
// НЕ экспортируются (allowlist ниже).
// =========================================================================
const crypto = require('crypto');

const SCHEMA_VERSION = 1;

// ── helpers: безопасное приведение типов (никогда не мутируем вход) ──────────
function num(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (v == null || v === '') return null;
  const n = +v;
  return isFinite(n) ? n : null;
}
function str(v) {
  if (typeof v === 'string') return v;
  if (v == null) return null;
  return String(v);
}
function bool(v) { return typeof v === 'boolean' ? v : null; }

// ── auth: достать ключ из заголовков (Authorization: Bearer … | X-Api-Key) ───
function extractApiKey(req) {
  const h = (req && req.headers) || {};
  const auth = h.authorization || h.Authorization || '';
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, '').trim();
  }
  const x = h['x-api-key'] || h['X-Api-Key'] || h['X-API-Key'] || '';
  if (typeof x === 'string' && x.trim()) return x.trim();
  return '';
}

// constant-time сравнение; пустой/несконфигурированный expected → всегда deny.
function checkApiKey(provided, expected) {
  if (!expected || typeof expected !== 'string') return false;
  if (!provided || typeof provided !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;          // timingSafeEqual требует равной длины
  try { return crypto.timingSafeEqual(a, b); } catch (_) { return false; }
}

// ── DTO mappers (allowlist) ─────────────────────────────────────────────────
function curatePayment(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    status: str(p.status),
    amount: num(p.amount),
    date: str(p.date),
    paidVia: str(p.paidVia),
    paidMethod: str(p.paidMethod),
    reference: str(p.paidReference != null ? p.paidReference : p.ref),
    memo: str(p.memo),
    recordedAt: str(p.recordedAt),
    source: str(p.source),
    stripeInvoiceId: str(p.stripeInvoiceId != null ? p.stripeInvoiceId : (p.stripe && p.stripe.invoiceId)),
    stripeInvoiceNumber: str(p.stripeInvoiceNumber),
    bankTxnId: str(p.bankTxnId),
    coversInvoiceMonths: Array.isArray(p.coversInvoiceMonths)
      ? p.coversInvoiceMonths.slice(0, 24).map(str) : null,
  };
}

function curatePayments(pm) {
  const out = {};
  if (!pm || typeof pm !== 'object') return out;
  for (const ym of Object.keys(pm)) {
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;        // только месячные ключи; deposit → отдельно
    out[ym] = curatePayment(pm[ym]);
  }
  return out;
}

function curateStripe(s) {
  if (!s || typeof s !== 'object') return null;
  const out = { customerId: str(s.customerId) };
  if (s.lastSentInvoice && typeof s.lastSentInvoice === 'object') {
    out.lastSentInvoice = {
      invoiceId: str(s.lastSentInvoice.invoiceId),
      ym: str(s.lastSentInvoice.ym),
      amount: num(s.lastSentInvoice.amount),
      hostedUrl: str(s.lastSentInvoice.hostedUrl),
      sentAt: str(s.lastSentInvoice.sentAt),
    };
  }
  if (s.depositInvoice && typeof s.depositInvoice === 'object') {
    out.depositInvoice = {
      invoiceId: str(s.depositInvoice.invoiceId),
      status: str(s.depositInvoice.status),
      amount: num(s.depositInvoice.amount),
      paidAt: str(s.depositInvoice.paidAt),
    };
  }
  return out;
}

function curateUnit(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    id: str(u.id),
    type: str(u.type),
    status: str(u.status),
    rentable: bool(u.rentable),
    sqft: num(u.sqft),
    rent: num(u.rent),                 // proforma asking $/mo
    contractRent: num(u.contractRent), // signed-lease $/mo
    deposit: num(u.deposit),
    tenant: str(u.tenant),
    company: str(u.company),
    email: str(u.email),
    phone: str(u.phone),
    leaseStart: str(u.leaseStart),
    leaseEnd: str(u.leaseEnd),
    groupId: str(u.groupId),
    groupRole: str(u.groupRole),
    payments: curatePayments(u.payments),
    depositPayment: (u.payments && u.payments.deposit) ? curatePayment(u.payments.deposit) : null,
    stripe: curateStripe(u.stripe),
  };
}

function curateFloor(f) {
  if (!f || typeof f !== 'object') return null;
  const units = (Array.isArray(f.units) ? f.units.map(curateUnit) : []).filter(Boolean);
  return {
    id: str(f.id),
    number: num(f.number),
    name: str(f.name),
    grossSqft: num(f.grossSqft),
    rentableSqft: num(f.rentableSqft),
    unitCount: units.length,
    units,
  };
}

function curateBuilding(b) {
  if (!b || typeof b !== 'object') return null;
  const floors = (Array.isArray(b.floors) ? b.floors.map(curateFloor) : []).filter(Boolean);
  let unitCount = 0;
  for (const f of floors) unitCount += f.unitCount;
  const mgr = (b.manager && typeof b.manager === 'object')
    ? { name: str(b.manager.name), email: str(b.manager.email), phone: str(b.manager.phone) }
    : null;
  // Excel ID — кросс-системный id из PropertyPulse (поле building.excelId).
  // externalId сохраняем как обобщённый crosswalk-ключ = excelId (с фолбэком на
  // устаревшее поле b.externalId, если кто-то его проставлял). Пустое → null.
  const excelId = (b.excelId == null || b.excelId === '') ? null : str(b.excelId);
  const legacyExt = (b.externalId == null || b.externalId === '') ? null : str(b.externalId);
  return {
    id: str(b.id),
    excelId: excelId,                                   // явное поле Excel ID
    externalId: (excelId != null ? excelId : legacyExt), // crosswalk-ключ (= excelId)
    code: str(b.code),
    name: str(b.name),
    address: str(b.address),
    icon: str(b.icon),
    manager: mgr,
    createdAt: str(b.createdAt),
    archivedAt: str(b.archivedAt),
    floorCount: floors.length,
    unitCount,
    floors,
  };
}

// state → DTO. opts: { buildingId?, externalId?, generatedAt?, workspaceId? }.
// Опциональные фильтры buildingId / externalId — для точечного crosswalk-pull.
// НЕ мутирует state — строит новый объект.
function ppBuildExportDTO(state, opts) {
  opts = opts || {};
  const all = (state && Array.isArray(state.buildings)) ? state.buildings : [];
  let picked = all;
  let filter = null;
  const matchXid = (b, want) =>
    (b.excelId != null && b.excelId !== '' && String(b.excelId) === want) ||
    (b.externalId != null && b.externalId !== '' && String(b.externalId) === want);
  if (opts.buildingId) {
    picked = all.filter((b) => b && str(b.id) === String(opts.buildingId));
    filter = { buildingId: String(opts.buildingId) };
  } else if (opts.externalId) {
    const want = String(opts.externalId);
    picked = all.filter((b) => b && matchXid(b, want));   // matches building.excelId (or legacy externalId)
    filter = { externalId: want };
  } else if (opts.excelId) {
    const want = String(opts.excelId);
    picked = all.filter((b) => b && b.excelId != null && b.excelId !== '' && String(b.excelId) === want);
    filter = { excelId: want };
  }
  const buildings = picked.map(curateBuilding).filter(Boolean);
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'suitesforall',
    readOnly: true,
    workspaceId: opts.workspaceId || 'default',
    generatedAt: opts.generatedAt || null,
    filter,
    buildingCount: buildings.length,
    buildings,
  };
}

module.exports = { SCHEMA_VERSION, extractApiKey, checkApiKey, ppBuildExportDTO };
