// Тест functions/mail-link.js (UNIT_EMAIL_PLAN.md § 4.4): индекс адресов (strip-aware),
// авто-ссылки по точному адресу, ручные ссылки / reject, денормализация на письма.
// Запуск: node tests/mail-link.test.cjs
'use strict';
const assert = require('assert');
const { makeHarness } = require('./_mail-harness.cjs');

const H = makeHarness();
H.install();
const link = H.loadModule('mail-link');

let n = 0;
async function t(name, fn) { await fn(); n++; console.log('  ✓ ' + name); }

const B1 = { id: 'bldg_a', name: 'Milam', floors: [{ id: 'f2', units: [
  { id: '204', tenant: 'Kastle Systems', email: 'Ryan.Quinty@kastle.com', emailCc: 'jackie@kastle.com', status: 'occupied' },
  { id: '205', tenant: 'Old Co', email: '', tenantHistory: [{ tenant: 'Former LLC', email: 'former@old.test' }], prospects: [{ id: 'p1', name: 'New Lead', email: 'lead@new.test' }] },
  { id: '206', tenant: 'Gone', email: 'gone@x.test', deletedAt: '2026-01-01' },
] }] };
const B2 = { id: 'bldg_b', name: 'Pinellas', floors: [{ id: 'f1', units: [{ id: '204', tenant: 'Other 204', email: 'other204@p.test' }] }] };

async function main() {
  await t('buildUnitsIndex: все поля, lower-case, архивные юниты пропущены, ключи с buildingId', () => {
    const idx = link.buildUnitsIndex([B1, B2, { id: 'arch', archivedAt: 'x', floors: [{ id: 'f', units: [{ id: '1', email: 'a@arch.test' }] }] }]);
    assert.strictEqual(idx.units, 3, 'deletedAt-юнит и архивное здание не считаются');
    assert.deepStrictEqual(idx.byEmail.get('ryan.quinty@kastle.com')[0].unitKey, 'bldg_a__204');
    assert.strictEqual(idx.byEmail.get('jackie@kastle.com')[0].field, 'emailCc');
    assert.strictEqual(idx.byEmail.get('former@old.test')[0].field, 'tenantHistory');
    assert.strictEqual(idx.byEmail.get('lead@new.test')[0].label, 'New Lead');
    assert.ok(!idx.byEmail.has('gone@x.test'));
    assert.ok(!idx.byEmail.has('a@arch.test'));
    assert.strictEqual(idx.byEmail.get('other204@p.test')[0].unitKey, 'bldg_b__204', 'suite 204 в другом здании — другой ключ');
  });

  await t('computeAutoLinks: точный адрес, не домен; ранг email > emailCc > prospect > history', () => {
    const idx = link.buildUnitsIndex([B1, B2]);
    const links = link.computeAutoLinks(['ryan.quinty@kastle.com', 'someone-else@kastle.com', 'former@old.test'], idx);
    assert.deepStrictEqual(links.map((l) => [l.unitKey, l.via, l.field]), [['bldg_a__204', 'address', 'email'], ['bldg_a__205', 'history', 'tenantHistory']]);
    const both = link.computeAutoLinks(['jackie@kastle.com', 'ryan.quinty@kastle.com'], idx);
    assert.strictEqual(both.length, 1);
    assert.strictEqual(both[0].field, 'email', 'сильная ссылка вытесняет слабую');
  });

  await t('mergeLinks: manual сохраняется, rejected исключается, linked/buildingIds считаются', () => {
    const idx = link.buildUnitsIndex([B1, B2]);
    const auto = link.computeAutoLinks(['ryan.quinty@kastle.com', 'other204@p.test'], idx);
    const m = link.mergeLinks({ links: [{ unitKey: 'bldg_b__999', buildingId: 'bldg_b', unitId: '999', via: 'manual' }], rejected: [{ unitKey: 'bldg_b__204' }] }, auto);
    assert.deepStrictEqual(m.unitKeys, ['bldg_b__999', 'bldg_a__204']);
    assert.deepStrictEqual(m.buildingIds.sort(), ['bldg_a', 'bldg_b']);
    assert.strictEqual(m.linked, true);
    assert.strictEqual(link.mergeLinks({}, []).linked, false);
  });

  // ---- strip-aware loadBuildings ----
  await t('loadBuildings: strip ON → коллекция buildings; strip OFF → монолит', async () => {
    H.store.set('workspaces/default/data/state', { state: { settings: { syncBuildingsStrip: true }, buildings: [] } });
    H.store.set('workspaces/default/buildings/bldg_a', { _schema: 'v2', doc: B1 });
    H.store.set('workspaces/default/buildings/bldg_b', { _schema: 'v2', doc: B2 });
    let b = await link.loadBuildings();
    assert.deepStrictEqual(b.map((x) => x.id).sort(), ['bldg_a', 'bldg_b']);
    H.store.set('workspaces/default/data/state', { state: { settings: { syncBuildingsStrip: false }, buildings: [B2] } });
    b = await link.loadBuildings();
    assert.deepStrictEqual(b.map((x) => x.id), ['bldg_b']);
    H.store.set('workspaces/default/data/state', { state: { settings: { syncBuildingsStrip: true }, buildings: [] } });
    link._resetCachesForTests();
  });

  // ---- callable mailLinkThread ----
  H.store.set('workspaces/default/members/mgr', { role: 'manager', email: 'mgr@al-en.com', buildings: [] });
  H.store.set('workspaces/default/members/mgrB', { role: 'manager', email: 'mgrb@al-en.com', buildings: ['bldg_b'] });
  H.store.set('workspaces/default/mailThreads/leasing__t1', { mailboxId: 'leasing', gmailThreadId: 't1', subject: 'Kastle agreement', participants: ['ryan.quinty@kastle.com'], links: [{ unitKey: 'bldg_a__204', buildingId: 'bldg_a', unitId: '204', via: 'address', field: 'email', value: 'ryan.quinty@kastle.com' }], rejected: [], unitKeys: ['bldg_a__204'], buildingIds: ['bldg_a'], linked: true });
  H.store.set('workspaces/default/mailMessages/leasing__m1', { mailboxId: 'leasing', gmailThreadId: 't1', unitKeys: ['bldg_a__204'], buildingIds: ['bldg_a'] });
  H.store.set('workspaces/default/mailMessages/leasing__m2', { mailboxId: 'leasing', gmailThreadId: 't1', unitKeys: ['bldg_a__204'], buildingIds: ['bldg_a'] });
  const mgr = { uid: 'mgr', token: { email: 'mgr@al-en.com' } };

  await t('mailLinkThread link: ручная ссылка + денормализация на письма + аудит', async () => {
    const r = await link.mailLinkThread({ auth: mgr, data: { threadDocId: 'leasing__t1', unitKey: 'bldg_b__204', action: 'link' } });
    assert.deepStrictEqual(r.unitKeys, ['bldg_b__204', 'bldg_a__204']);
    const th = H.store.get('workspaces/default/mailThreads/leasing__t1');
    assert.strictEqual(th.links[0].via, 'manual');
    assert.strictEqual(th.links[0].by, 'mgr@al-en.com');
    assert.deepStrictEqual(H.store.get('workspaces/default/mailMessages/leasing__m2').unitKeys, ['bldg_b__204', 'bldg_a__204']);
    assert.ok(H.auditLog.some((a) => a.action === 'mail.link' && a.unitId === '204' && a.buildingId === 'bldg_b'));
  });

  await t('mailLinkThread reject: «Not this unit» убирает авто-ссылку и держит её в rejected', async () => {
    const r = await link.mailLinkThread({ auth: mgr, data: { threadDocId: 'leasing__t1', unitKey: 'bldg_a__204', action: 'reject', reason: 'wrong tenant' } });
    assert.deepStrictEqual(r.unitKeys, ['bldg_b__204']);
    const th = H.store.get('workspaces/default/mailThreads/leasing__t1');
    assert.strictEqual(th.rejected[0].unitKey, 'bldg_a__204');
    assert.strictEqual(th.rejected[0].reason, 'wrong tenant');
    // пересчёт по индексу НЕ возвращает отклонённый ключ
    const idx = await link.loadUnitsIndex({ fresh: true });
    const rr = await link.relinkThreadDoc(H.db.doc('workspaces/default/mailThreads/leasing__t1'), H.store.get('workspaces/default/mailThreads/leasing__t1'), idx);
    assert.deepStrictEqual(rr.unitKeys, ['bldg_b__204']);
  });

  await t('mailLinkThread unreject: ключ возвращается по индексу', async () => {
    const r = await link.mailLinkThread({ auth: mgr, data: { threadDocId: 'leasing__t1', unitKey: 'bldg_a__204', action: 'unreject' } });
    assert.deepStrictEqual(r.unitKeys.sort(), ['bldg_a__204', 'bldg_b__204']);
  });

  await t('mailLinkThread: manager другого здания → permission-denied; мусор → invalid-argument', async () => {
    await assert.rejects(link.mailLinkThread({ auth: { uid: 'mgrB', token: { email: 'mgrb@al-en.com' } }, data: { threadDocId: 'leasing__t1', unitKey: 'bldg_a__204', action: 'link' } }), (e) => e.code === 'permission-denied');
    await assert.rejects(link.mailLinkThread({ auth: mgr, data: { threadDocId: 'leasing__t1', unitKey: 'nokey', action: 'link' } }), (e) => e.code === 'invalid-argument');
    await assert.rejects(link.mailLinkThread({ auth: mgr, data: { threadDocId: 'leasing__missing', unitKey: 'bldg_a__204', action: 'link' } }), (e) => e.code === 'permission-denied', 'несуществующий тред — тот же отказ');
  });

  await t('mailRelinkUnit: находит треды по адресам юнита и пересчитывает', async () => {
    H.store.set('workspaces/default/mailThreads/leasing__t2', { mailboxId: 'leasing', gmailThreadId: 't2', subject: 'x', participants: ['jackie@kastle.com'], links: [], rejected: [], unitKeys: [], buildingIds: [], linked: false });
    const r = await link.mailRelinkUnit({ auth: mgr, data: { unitKey: 'bldg_a__204' } });
    assert.strictEqual(r.ok, true);
    assert.ok(r.threadsChecked >= 2, 'оба треда проверены');
    const t2 = H.store.get('workspaces/default/mailThreads/leasing__t2');
    assert.deepStrictEqual(t2.unitKeys, ['bldg_a__204']);
    assert.strictEqual(t2.links[0].field, 'emailCc');
  });

  console.log(`\nmail-link: ${n} tests passed`);
}

main().catch((e) => { console.error('✗', e); process.exit(1); }).finally(() => H.uninstall());
