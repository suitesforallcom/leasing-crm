// Тест functions/mail-access.js (UNIT_EMAIL_PLAN.md § 4.5): матрица ролей × грантов.
// Запуск: node tests/mail-access.test.cjs
'use strict';
const assert = require('assert');
const { makeHarness } = require('./_mail-harness.cjs');

const H = makeHarness();
H.install();
const access = H.loadModule('mail-access');
const shared = H.loadModule('mail-shared');

let n = 0;
function t(name, fn) { const r = fn(); if (r && r.then) return r.then(() => { n++; console.log('  ✓ ' + name); }); n++; console.log('  ✓ ' + name); return Promise.resolve(); }

async function main() {
  const D = access.decideAccess;

  await t('root admin → всё', () => {
    const a = D({ rootAdmin: true, member: null, grant: null });
    assert.deepStrictEqual([a.denied, a.role, a.read, a.send, a.seeUnlinked], [false, 'admin', 'all', true, true]);
    assert.ok(access.canRead(a, 'B9', 'inbound'));
    assert.ok(access.canReadThread(a, { buildingIds: [] }), 'admin видит непривязанные');
  });

  await t('admin-член → всё; архивированный admin → denied', () => {
    const a = D({ rootAdmin: false, member: { role: 'admin', buildings: ['B1'] }, grant: null });
    assert.strictEqual(a.read, 'all');
    const b = D({ rootAdmin: false, member: { role: 'admin', archived: true }, grant: null });
    assert.strictEqual(b.denied, true);
    assert.strictEqual(b.reason, 'archived');
  });

  await t('manager без ограничений → all + send, без непривязанных', () => {
    const a = D({ rootAdmin: false, member: { role: 'manager', buildings: [] }, grant: null });
    assert.deepStrictEqual([a.read, a.send, a.seeUnlinked], ['all', true, false]);
    assert.ok(access.canSend(a, 'B1'));
    assert.ok(!access.canReadThread(a, { buildingIds: [] }));
    assert.ok(access.canReadThread(a, { buildingIds: ['B2'] }));
  });

  await t('manager с members.buildings=[B1] → только B1', () => {
    const a = D({ rootAdmin: false, member: { role: 'manager', buildings: ['B1'] }, grant: null });
    assert.strictEqual(a.read, 'buildings');
    assert.ok(access.canRead(a, 'B1'));
    assert.ok(!access.canRead(a, 'B2'));
    assert.ok(access.canReadThread(a, { buildingIds: ['B2', 'B1'] }));
    assert.ok(!access.canReadThread(a, { buildingIds: ['B2'] }));
    assert.ok(!access.canSend(a, 'B2'));
  });

  await t('mapeditor / teamviewer / viewer → none', () => {
    for (const role of ['mapeditor', 'teamviewer', 'viewer']) {
      const a = D({ rootAdmin: false, member: { role }, grant: null });
      assert.strictEqual(a.read, 'none', role);
      assert.ok(!access.canRead(a, 'B1'));
      assert.ok(!access.canSend(a, 'B1'));
    }
  });

  await t('не-член → denied not-member', () => {
    const a = D({ rootAdmin: false, member: null, grant: null });
    assert.strictEqual(a.denied, true);
    assert.strictEqual(a.reason, 'not-member');
  });

  await t('грант расширяет viewer до чтения B1 без отправки', () => {
    const a = D({ rootAdmin: false, member: { role: 'viewer' }, grant: { read: 'buildings', buildings: ['B1'], send: false } });
    assert.strictEqual(a.read, 'buildings');
    assert.ok(access.canRead(a, 'B1'));
    assert.ok(!access.canRead(a, 'B2'));
    assert.ok(!access.canSend(a, 'B1'));
  });

  await t('грант сужает направления (teamviewer видит только исходящие)', () => {
    const a = D({ rootAdmin: false, member: { role: 'teamviewer' }, grant: { read: 'all', directions: ['outbound'] } });
    assert.ok(access.canRead(a, 'B1', 'outbound'));
    assert.ok(!access.canRead(a, 'B1', 'inbound'));
    assert.ok(access.directionVisible(a, 'outbound'));
    assert.ok(!access.directionVisible(a, 'inbound'));
  });

  await t('потолок members.buildings: грант read:all для ограниченного manager → только его здания', () => {
    const a = D({ rootAdmin: false, member: { role: 'manager', buildings: ['B1'] }, grant: { read: 'all' } });
    assert.strictEqual(a.read, 'buildings');
    assert.deepStrictEqual(a.buildings, ['B1']);
    const b = D({ rootAdmin: false, member: { role: 'manager', buildings: ['B1'] }, grant: { read: 'buildings', buildings: ['B2'] } });
    assert.strictEqual(b.read, 'none', 'здания вне потолка отфильтрованы → none');
  });

  await t('грант read:none отключает всё, даже admin-члена', () => {
    const a = D({ rootAdmin: false, member: { role: 'admin' }, grant: { read: 'none' } });
    assert.deepStrictEqual([a.read, a.send, a.seeUnlinked], ['none', false, false]);
  });

  await t('мусор в гранте игнорируется', () => {
    const a = D({ rootAdmin: false, member: { role: 'manager' }, grant: { read: 'everything', directions: ['sideways'], buildings: 'B1', send: 'yes' } });
    assert.deepStrictEqual([a.read, a.send, a.directions], ['all', true, ['inbound', 'outbound']]);
  });

  // ---- accessFor через in-memory Firestore ----
  H.store.set('workspaces/default/members/m1', { role: 'manager', email: 'm1@x.com', buildings: ['B1'] });
  H.store.set('workspaces/default/members/v1', { role: 'viewer', email: 'v1@x.com' });
  H.store.set('workspaces/default/mailAccess/v1', { read: 'buildings', buildings: ['B2'], send: true });
  H.store.set('workspaces/default/members/arch', { role: 'admin', email: 'a@x.com', archived: true });

  await t('accessFor: manager читает members.buildings', async () => {
    const a = await access.accessFor({ uid: 'm1', token: { email: 'm1@x.com' } });
    assert.strictEqual(a.read, 'buildings');
    assert.ok(a.canRead('B1'));
    assert.ok(!a.canRead('B2'));
    assert.strictEqual(a.uid, 'm1');
  });

  await t('accessFor: грант viewer → B2 + send', async () => {
    const a = await access.accessFor({ uid: 'v1', token: { email: 'v1@x.com' } });
    assert.ok(a.canRead('B2'));
    assert.ok(a.canSend('B2'));
    assert.ok(!a.canRead('B1'));
  });

  await t('accessFor: root admin по email (verified) → admin; unverified root → как член', async () => {
    const a = await access.accessFor({ uid: 'zzz', token: { email: 'tony@al-en.com', email_verified: true } });
    assert.strictEqual(a.isAdmin, true);
    const b = await access.accessFor({ uid: 'zzz', token: { email: 'tony@al-en.com', email_verified: false } });
    assert.strictEqual(b.denied, true);
  });

  await t('accessFor: архивированный → denied; assertMailReader бросает permission-denied', async () => {
    const a = await access.accessFor({ uid: 'arch', token: { email: 'a@x.com' } });
    assert.strictEqual(a.denied, true);
    assert.throws(() => access.assertMailReader(a), (e) => e.code === 'permission-denied');
    await assert.rejects(access.accessFor(null), (e) => e.code === 'unauthenticated');
  });

  await t('shared: parseAddressList / parseUnitKey / maskEmail', () => {
    const list = shared.parseAddressList('"Quinty, Ryan" <Ryan.Quinty@kastle.com>, jackie@kastle.com, Bad <not-an-email>, <Dup@Kastle.com>, ryan.quinty@kastle.com');
    assert.deepStrictEqual(list.map((x) => x.email), ['ryan.quinty@kastle.com', 'jackie@kastle.com', 'dup@kastle.com']);
    assert.strictEqual(list[0].name, 'Quinty, Ryan');
    assert.deepStrictEqual(shared.parseUnitKey('bldg_1__204'), { buildingId: 'bldg_1', unitId: '204' });
    assert.strictEqual(shared.parseUnitKey('nokey'), null);
    assert.strictEqual(shared.maskEmail('kristen@kiwi-rentals.com'), 'k***@kiwi-rentals.com');
    assert.strictEqual(shared.normalizeMessageId('<ABC@x.com>'), 'abc@x.com');
    assert.strictEqual(shared.safeFilename('../../evil\u0000.pdf'), '.._.._evil.pdf');
  });

  await t('shared: normalizeConfig — allowlist ящиков, лимиты, ownDomains', () => {
    const cfg = shared.normalizeConfig({ enabled: true, mailboxes: [{ id: 'leasing', address: 'Leasing@AL-EN.com', displayName: 'SFA' }, { id: 'bad' }], limits: { perUserPerDay: 5, maxRecipients: -1 }, ownDomains: ['Suitesforall.com'] });
    assert.strictEqual(cfg.mailboxes.length, 1);
    assert.strictEqual(cfg.mailboxes[0].address, 'leasing@al-en.com');
    assert.deepStrictEqual(cfg.ownDomains.sort(), ['al-en.com', 'suitesforall.com']);
    assert.strictEqual(cfg.limits.perUserPerDay, 5);
    assert.strictEqual(cfg.limits.maxRecipients, 20);
    assert.strictEqual(cfg.timeZone, 'America/New_York');
    assert.strictEqual(shared.mailboxByAddress(cfg, 'LEASING@al-en.com').id, 'leasing');
    assert.strictEqual(shared.mailboxById(cfg, 'nope'), null);
  });

  console.log(`\nmail-access: ${n} tests passed`);
}

main().catch((e) => { console.error('✗', e); process.exit(1); }).finally(() => H.uninstall());
