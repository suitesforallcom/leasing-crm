// Pure-Node tests for the PropertyPulse export logic (no Firebase / no emulator
// needed — this is the exact transform + auth the Cloud Function uses).
// Run: node functions/ppExport.test.js
const assert = require('assert');
const pp = require('./ppExport');

let passed = 0;
function ok(name, cond) { assert.ok(cond, 'FAIL: ' + name); passed++; }

// ── seed: representative state (mirrors real shape from docs/integration-recon.md)
const seed = {
  settings: { syncBuildingsStrip: false },
  buildings: [
    {
      id: 'b1717862400000',
      externalId: 'PP-PARK-01',         // crosswalk key
      code: 'PPK',
      name: 'Pinellas Park Main',
      address: '6698 68th Ave N, Pinellas Park, FL 33781',
      icon: 'tower',
      notes: 'internal operator note — should NOT be exported',
      credentials: [{ user: 'admin', pass: 'secret' }],   // must NOT leak
      manager: { name: 'Dana', email: 'dana@x.com', phone: '555-1', extra: 'drop me' },
      floors: [
        {
          id: 'b1-f1', buildingId: 'b1717862400000', number: 1, name: '1st Floor',
          grossSqft: 12000, rentableSqft: 9000,
          walls: [{ points: [0, 0, 1, 1] }],              // geometry must NOT be exported
          units: [
            {
              id: '101', type: 'office', status: 'occupied', rentable: true,
              x: 10, y: 20, w: 30, h: 40, points: [[0, 0], [1, 1]],   // geometry → drop
              sqft: 450, rent: 1800, contractRent: 1650, deposit: 1650,
              tenant: 'John Smith', company: 'Acme LLC', email: 'j@acme.com', phone: '555-2',
              leaseStart: '2026-01-01', leaseEnd: '2026-12-31',
              groupId: 'g1', groupRole: 'primary',
              leaseEnvelopes: [{ envelopeId: 'env_1', recipientEmail: 'j@acme.com' }], // drop
              prospects: [{ name: 'someone' }],            // drop
              payments: {
                '2026-01': { status: 'paid', amount: 1650, date: '2026-01-03', paidVia: 'stripe',
                  paidReference: 'in_1', stripeInvoiceId: 'in_1', source: 'stripe',
                  receiptUrl: 'https://drop.me/receipt.jpg', history: [{ ts: 'x' }] },
                '2026-02': { status: 'past_due', amount: 1650, date: null, paidVia: null },
                'deposit': { status: 'paid', amount: 1650, date: '2026-01-02', paidVia: 'ach' },
                'garbage-key': { status: 'paid' },         // non-YYYY-MM → must be skipped
              },
              stripe: {
                customerId: 'cus_abc',
                lastSentInvoice: { invoiceId: 'in_9', ym: '2026-02', amount: 1650, hostedUrl: 'https://h', sentAt: '2026-02-01T00:00:00Z' },
                depositInvoice: { invoiceId: 'in_dep', status: 'paid', amount: 1650, paidAt: '2026-01-02T00:00:00Z' },
                secretField: 'should be dropped by allowlist',
              },
            },
            { id: '102', type: 'office', status: 'vacant', rentable: true, sqft: 300, rent: 1200,
              contractRent: 0, tenant: '', company: '', payments: {} },
          ],
        },
      ],
    },
    {
      id: 'b2', externalId: null, code: 'TAM', name: 'New Tampa', address: '18205 Crane Nest Dr, Tampa, FL 33645',
      floors: [{ id: 'b2-f1', number: 1, name: '1st', units: [] }],
    },
  ],
};

// ── checkApiKey ──────────────────────────────────────────────────────────────
ok('correct key passes', pp.checkApiKey('s3cret-key', 's3cret-key') === true);
ok('wrong key fails', pp.checkApiKey('nope', 's3cret-key') === false);
ok('wrong-length key fails', pp.checkApiKey('s3cret', 's3cret-key') === false);
ok('empty expected (unconfigured) denies', pp.checkApiKey('anything', '') === false);
ok('empty provided denies', pp.checkApiKey('', 's3cret-key') === false);
ok('null provided denies', pp.checkApiKey(null, 's3cret-key') === false);

// ── extractApiKey ────────────────────────────────────────────────────────────
ok('Bearer header parsed', pp.extractApiKey({ headers: { authorization: 'Bearer abc123' } }) === 'abc123');
ok('x-api-key header parsed', pp.extractApiKey({ headers: { 'x-api-key': 'xyz' } }) === 'xyz');
ok('no header → empty', pp.extractApiKey({ headers: {} }) === '');
ok('missing req → empty', pp.extractApiKey(undefined) === '');

// ── ppBuildExportDTO: shape + versioning ─────────────────────────────────────
const snapshot = JSON.stringify(seed);     // to prove no mutation
const dto = pp.ppBuildExportDTO(seed, { generatedAt: '2026-06-07T00:00:00Z', workspaceId: 'default' });

ok('schemaVersion present', dto.schemaVersion === 1);
ok('source tagged', dto.source === 'suitesforall');
ok('readOnly flag', dto.readOnly === true);
ok('generatedAt passthrough', dto.generatedAt === '2026-06-07T00:00:00Z');
ok('buildingCount = 2', dto.buildingCount === 2);
ok('input NOT mutated', JSON.stringify(seed) === snapshot);

const b = dto.buildings[0];
ok('building externalId exported', b.externalId === 'PP-PARK-01');
ok('building code exported', b.code === 'PPK');
ok('building unitCount computed', b.unitCount === 2);
ok('building floorCount computed', b.floorCount === 1);
ok('manager curated to allowlist', b.manager && b.manager.name === 'Dana' && b.manager.extra === undefined);
ok('building.notes NOT exported', b.notes === undefined);
ok('building.credentials NOT exported', b.credentials === undefined);

const f = b.floors[0];
ok('floor geometry (walls) NOT exported', f.walls === undefined);
ok('floor sqft exported', f.grossSqft === 12000 && f.rentableSqft === 9000);

const u = f.units[0];
ok('unit lease fields exported', u.leaseStart === '2026-01-01' && u.leaseEnd === '2026-12-31');
ok('unit rent fields exported', u.rent === 1800 && u.contractRent === 1650 && u.deposit === 1650);
ok('unit tenant/company exported', u.tenant === 'John Smith' && u.company === 'Acme LLC');
ok('unit group fields exported', u.groupId === 'g1' && u.groupRole === 'primary');
ok('unit geometry (x/y/points) NOT exported', u.x === undefined && u.points === undefined);
ok('unit leaseEnvelopes NOT exported', u.leaseEnvelopes === undefined);
ok('unit prospects NOT exported', u.prospects === undefined);

ok('payments: YYYY-MM kept', !!u.payments['2026-01'] && !!u.payments['2026-02']);
ok('payments: deposit key not in monthly map', u.payments['deposit'] === undefined);
ok('payments: non-date key skipped', u.payments['garbage-key'] === undefined);
ok('payment: stripeInvoiceId mapped', u.payments['2026-01'].stripeInvoiceId === 'in_1');
ok('payment: receiptUrl NOT exported', u.payments['2026-01'].receiptUrl === undefined);
ok('payment: history NOT exported', u.payments['2026-01'].history === undefined);
ok('depositPayment surfaced separately', u.depositPayment && u.depositPayment.amount === 1650);

ok('stripe.customerId exported', u.stripe.customerId === 'cus_abc');
ok('stripe.lastSentInvoice exported', u.stripe.lastSentInvoice.invoiceId === 'in_9');
ok('stripe.depositInvoice exported', u.stripe.depositInvoice.status === 'paid');
ok('stripe.secretField NOT exported (allowlist)', u.stripe.secretField === undefined);

// ── filtering for crosswalk ──────────────────────────────────────────────────
const byId = pp.ppBuildExportDTO(seed, { buildingId: 'b2' });
ok('filter by buildingId → 1', byId.buildingCount === 1 && byId.buildings[0].id === 'b2');
ok('filter echoes back', byId.filter && byId.filter.buildingId === 'b2');

const byExt = pp.ppBuildExportDTO(seed, { externalId: 'PP-PARK-01' });
ok('filter by externalId → 1', byExt.buildingCount === 1 && byExt.buildings[0].id === 'b1717862400000');

const byExtMiss = pp.ppBuildExportDTO(seed, { externalId: 'does-not-exist' });
ok('filter externalId miss → 0', byExtMiss.buildingCount === 0);

// ── edge cases ───────────────────────────────────────────────────────────────
ok('empty state → 0 buildings', pp.ppBuildExportDTO({}, {}).buildingCount === 0);
ok('null state → 0 buildings', pp.ppBuildExportDTO(null, {}).buildingCount === 0);

console.log('\nAll ' + passed + ' assertions passed.\n');
console.log('── Sample DTO (building[0], one unit) ─────────────────────────');
const sample = JSON.parse(JSON.stringify(dto));
sample.buildings = [sample.buildings[0]];
sample.buildings[0].floors[0].units = [sample.buildings[0].floors[0].units[0]];
console.log(JSON.stringify(sample, null, 2));
