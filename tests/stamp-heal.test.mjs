/**
 * Регрессионный тест FIXES_LOG Entry 108 (2026-11-22) — самоочистка штампов
 * (_healStaleStripeStamps) не стирает депозит и первую ренту, выставленные ЗАРАНЕЕ.
 *
 * Инцидент: Apt 206 / 4355 Central Ave — аренда с 28 декабря, депозит $1,375
 * выставлен 22 ноября. Правило «штамп старше leaseStart − 7 дней — от прошлого
 * арендатора» стирало u.stripe.depositInvoice при каждой загрузке вкладки, а
 * редактирующая вкладка записывала это на сервер: карточка показывала «Not sent»
 * при открытом счёте в Stripe; открытие юнита возвращало штамп — и он «мигал».
 * На проде так же потеряны штампы Bay Vista 112 и 251.
 *
 * Правило теперь: начало аренды для вопроса «чей это штамп» — самый ранний из
 * якорей (конвенция _firstTenancyYm): leaseStart − 7 дней и момент, когда ЭТОГО
 * арендатора завели на юнит — _tenantAddedAt (если метка поставлена на текущего
 * арендатора) или договор, отправленный на его адрес; минус сутки, не дальше
 * 120 дней до начала аренды.
 *
 * Функции берутся ИЗ floor-map-editor.html и исполняются в vm. Никуда не ходит.
 *
 * node tests/stamp-heal.test.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'floor-map-editor.html'), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`); }
};

function cut(open, close) {
  const from = src.indexOf(open);
  if (from < 0) throw new Error(`floor-map-editor.html: marker not found: ${open.trim().slice(0, 60)}`);
  const to = src.indexOf(close, from + open.length);
  if (to < 0) throw new Error(`floor-map-editor.html: end marker not found: ${close.trim().slice(0, 60)}`);
  return src.slice(from, to);
}
function ctx(rows = []) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const code = [
    cut('\nfunction _parseDateUTC(', '\nfunction '),
    cut('\nfunction _tenantTenureStartMs(', '\n// Write u.stripe.depositInvoice'),
    cut('\nfunction _tenantKey(', '\n// Title Case только'),
    // всё от начала блока самоочистки до следующего раздела (включая хелперы Entry 108, если есть)
    src.includes('// ─── Entry 108:')
      ? cut('// ─── Entry 108:', '\n// Proactive quota-pressure warning.')
      : cut('\nfunction _healStaleStripeStamps(', '\n// Proactive quota-pressure warning.'),
    'this.heal = _healStaleStripeStamps;',
  ].join('\n');
  const c = { console, _lookupInvoiceRow: (id) => byId.get(id) || null };
  vm.createContext(c);
  vm.runInContext(code, c, { filename: 'floor-map-editor.lifted.js' });
  return c.heal;
}

// ── Фикстура по инциденту: аренда с 28 декабря 2026 ─────────────────────────
const LEASE = '2026-12-28';
const iso = (s) => new Date(s).toISOString();
const dep = (sentAt, over = {}) => ({ invoiceId: 'in_dep', amount: 1375, sentAt: iso(sentAt), status: 'open', ...over });
const mi = (sentAt, over = {}) => ({ invoiceId: 'in_rent', ym: '2026-12', amount: 177.42, sentAt: iso(sentAt), status: 'open', ...over });
const unit = (over = {}) => ({ id: '206', tenant: 'New Tenant', _lastStampedTenant: 'New Tenant', email: 'new@tenant.test', status: 'occupied', leaseStart: LEASE, deposit: 1375, payments: {}, ...over });
const env = (createdAt, recipientEmail = 'new@tenant.test', over = {}) => ({ envelopeId: 'env_' + createdAt, createdAt: iso(createdAt), recipientEmail, status: 'sent', ...over });

console.log('\nEntry 108 — депозит и первая рента, выставленные заранее\n');

t('инцидент Apt 206: арендатор заведён 19 ноября, депозит выставлен 22 ноября, аренда с 28 декабря → штамп депозита остаётся', () => {
  const u = unit({ _tenantAddedAt: iso('2026-11-19T23:30:00Z'), stripe: { depositInvoice: dep('2026-11-22T01:27:53Z') } });
  ctx()(u);
  assert.equal(u.stripe.depositInvoice?.invoiceId, 'in_dep');
});
t('первая рента выставлена за 5 недель до въезда → moveInRent и пара lastInvoiceId / lastInvoiceYm остаются', () => {
  const u = unit({ _tenantAddedAt: iso('2026-11-19T23:30:00Z'),
    stripe: { moveInRent: mi('2026-11-22T01:30:00Z'), lastInvoiceId: 'in_rent', lastInvoiceYm: '2026-12' } });
  ctx()(u);
  assert.deepEqual({ mi: u.stripe.moveInRent?.invoiceId, id: u.stripe.lastInvoiceId, ym: u.stripe.lastInvoiceYm }, { mi: 'in_rent', id: 'in_rent', ym: '2026-12' });
});
t('депозит выставлен в тот же день, что завели арендатора (Bay Vista 112: 3 ноября, аренда с 1 декабря) → остаётся', () => {
  const u = unit({ leaseStart: '2026-12-01', _tenantAddedAt: iso('2026-11-03T15:00:00Z'), stripe: { depositInvoice: dep('2026-11-03T15:20:00Z') } });
  ctx()(u);
  assert.ok(u.stripe.depositInvoice);
});
t('счёт выставлен на несколько часов РАНЬШЕ, чем сохранили карточку арендатора (запас 1 день) → остаётся', () => {
  const u = unit({ _tenantAddedAt: iso('2026-11-19T23:30:00Z'), stripe: { depositInvoice: dep('2026-11-19T09:00:00Z') } });
  ctx()(u);
  assert.ok(u.stripe.depositInvoice);
});

t('заселение с телефона: _tenantAddedAt нет, но договор отправлен текущему арендатору 19 ноября → депозит от 22 ноября остаётся', () => {
  const u = unit({ _lastStampedTenant: undefined, leaseEnvelopes: [env('2026-11-19T23:30:00Z')], stripe: { depositInvoice: dep('2026-11-22T01:27:53Z') } });
  ctx()(u);
  assert.ok(u.stripe.depositInvoice);
});
t('Bay Vista 112: имя в карточке правили после заведения (метка на другое имя), договор ушёл 30 октября → депозит от 3 ноября остаётся', () => {
  const u = unit({ leaseStart: '2026-12-01', tenant: 'Acme Holdings LLC', _lastStampedTenant: 'John Smith', _tenantAddedAt: iso('2026-11-03T15:00:00Z'),
    leaseEnvelopes: [env('2026-10-30T18:00:00Z')], stripe: { depositInvoice: dep('2026-11-03T15:20:00Z') } });
  ctx()(u);
  assert.ok(u.stripe.depositInvoice);
});
t('регистр и пробелы в имени не считаются другим арендатором (метка «NEW  TENANT» = «New Tenant»)', () => {
  const u = unit({ _lastStampedTenant: 'NEW  TENANT', _tenantAddedAt: iso('2026-11-19T23:30:00Z'), stripe: { depositInvoice: dep('2026-11-22T01:27:53Z') } });
  ctx()(u);
  assert.ok(u.stripe.depositInvoice);
});

console.log('\nЗащита от штампов прошлого арендатора не ослаблена\n');

t('метка _tenantAddedAt осталась от ПРОШЛОГО арендатора (другое имя): нового завели путём без метки → граница прежняя, чужой штамп удаляется', () => {
  const u = unit({ tenant: 'New Tenant', _lastStampedTenant: 'Old Tenant', _tenantAddedAt: iso('2026-10-01T10:00:00Z'),
    stripe: { depositInvoice: dep('2026-10-02T10:00:00Z', { status: 'paid' }) } });
  ctx()(u);
  assert.equal(u.stripe.depositInvoice, undefined);
});
t('тёзка: метка двухлетней давности с тем же именем (дальше 120 дней до аренды) не раздвигает окно → старый штамп удаляется', () => {
  const u = unit({ _tenantAddedAt: iso('2025-03-01T10:00:00Z'), stripe: { depositInvoice: dep('2025-03-02T10:00:00Z', { status: 'paid' }) } });
  ctx()(u);
  assert.equal(u.stripe.depositInvoice, undefined);
});
t('договор, отправленный на ДРУГОЙ адрес (прошлый арендатор), якорем не считается', () => {
  const u = unit({ _lastStampedTenant: undefined, leaseEnvelopes: [env('2026-10-01T10:00:00Z', 'old@tenant.test')], stripe: { depositInvoice: dep('2026-10-02T10:00:00Z', { status: 'paid' }) } });
  ctx()(u);
  assert.equal(u.stripe.depositInvoice, undefined);
});
t('продление: свежий договор действующему арендатору (аренда началась давно) границу не меняет', () => {
  const kept = unit({ leaseStart: '2026-03-01', _lastStampedTenant: undefined, leaseEnvelopes: [env('2026-11-10T10:00:00Z')], stripe: { depositInvoice: dep('2026-02-26T10:00:00Z', { status: 'paid' }) } });
  ctx()(kept);
  assert.ok(kept.stripe.depositInvoice);
  const stale = unit({ leaseStart: '2026-03-01', _lastStampedTenant: undefined, leaseEnvelopes: [env('2026-11-10T10:00:00Z')], stripe: { depositInvoice: dep('2026-01-10T10:00:00Z', { status: 'paid' }) } });
  ctx()(stale);
  assert.equal(stale.stripe.depositInvoice, undefined);
});


t('штамп прошлого арендатора: выставлен в августе, нового завели 19 ноября → удаляется', () => {
  const u = unit({ _tenantAddedAt: iso('2026-11-19T23:30:00Z'),
    stripe: { depositInvoice: dep('2026-08-10T12:00:00Z', { status: 'paid' }), moveInRent: mi('2026-08-10T12:05:00Z', { ym: '2026-08' }), lastInvoiceId: 'in_rent', lastInvoiceYm: '2026-08' } });
  ctx()(u);
  assert.deepEqual({ dep: u.stripe.depositInvoice ?? null, mi: u.stripe.moveInRent ?? null, id: u.stripe.lastInvoiceId ?? null }, { dep: null, mi: null, id: null });
});
t('счёт прежнего кандидата: выставлен за 3 дня до того, как завели нового арендатора → удаляется', () => {
  const u = unit({ _tenantAddedAt: iso('2026-11-19T23:30:00Z'), stripe: { depositInvoice: dep('2026-11-16T12:00:00Z') } });
  ctx()(u);
  assert.equal(u.stripe.depositInvoice, undefined);
});
t('момент заведения неизвестен (старые записи) → прежнее правило: старше leaseStart − 7 дней удаляется, в пределах 7 дней остаётся', () => {
  const old = unit({ stripe: { depositInvoice: dep('2026-11-22T01:27:53Z') } });
  ctx()(old);
  assert.equal(old.stripe.depositInvoice, undefined);
  const near = unit({ stripe: { depositInvoice: dep('2026-12-23T10:00:00Z') } });
  ctx()(near);
  assert.ok(near.stripe.depositInvoice);
});
t('арендатора завели ПОЗЖЕ начала аренды (импорт) → якорь leaseStart − 7 дней не сдвигается вперёд', () => {
  const kept = unit({ leaseStart: '2026-03-01', _tenantAddedAt: iso('2026-06-15T10:00:00Z'), stripe: { depositInvoice: dep('2026-02-26T10:00:00Z', { status: 'paid' }) } });
  ctx()(kept);
  assert.ok(kept.stripe.depositInvoice);
  const stale = unit({ leaseStart: '2026-03-01', _tenantAddedAt: iso('2026-06-15T10:00:00Z'), stripe: { depositInvoice: dep('2026-01-10T10:00:00Z', { status: 'paid' }) } });
  ctx()(stale);
  assert.equal(stale.stripe.depositInvoice, undefined);
});
t('мусор в _tenantAddedAt → как будто его нет (прежнее правило)', () => {
  const u = unit({ _tenantAddedAt: 'not-a-date', stripe: { depositInvoice: dep('2026-11-22T01:27:53Z') } });
  ctx()(u);
  assert.equal(u.stripe.depositInvoice, undefined);
});
t('вакантный юнит → все штампы удаляются (без изменений)', () => {
  const u = unit({ tenant: '', company: '', _tenantAddedAt: iso('2026-11-19T23:30:00Z'),
    stripe: { customerId: 'cus_1', depositInvoice: dep('2026-11-22T01:27:53Z'), moveInRent: mi('2026-11-22T01:30:00Z'), lastInvoiceId: 'in_rent', lastInvoiceYm: '2026-12' } });
  ctx()(u);
  assert.deepEqual(Object.keys(u.stripe), ['customerId']);
});
t('ручная привязка (manualLink) не трогается при любой дате (без изменений)', () => {
  const u = unit({ stripe: { depositInvoice: dep('2025-01-05T10:00:00Z', { manualLink: true, status: 'paid' }) } });
  ctx()(u);
  assert.ok(u.stripe.depositInvoice);
});
t('нет leaseStart → самоочистка по дате не работает вовсе (без изменений)', () => {
  const u = unit({ leaseStart: '', _tenantAddedAt: iso('2026-11-19T23:30:00Z'), stripe: { depositInvoice: dep('2026-01-01T00:00:00Z') } });
  ctx()(u);
  assert.ok(u.stripe.depositInvoice);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
