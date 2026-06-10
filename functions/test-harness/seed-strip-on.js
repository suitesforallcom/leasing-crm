// =========================================================================
// Prod-faithful strip-ON сид для эмуляторного E2E вебхука (local-only).
// Форма 1-в-1 с продом: монолит с buildings:[], здания в коллекции
// workspaces/default/buildings/{bid} ({_schema:'v2', buildingId, doc,
// _savedRev, _mirroredAt, _mirroredBy}), платежи в payments/{bid__uid__ym}.
// Масштаб маленький (3 здания) — E2E проверяет ЛОГИКУ вебхука, а не объём;
// полномасштабный 638-юнитный сид был нужен только для leak-тестов экспорта.
// =========================================================================

function makeBuildingDoc(id, excelId, tenant) {
  return {
    id, excelId, code: 'TST', name: `Building ${id}`, address: `${id} Test St`,
    icon: 'office',
    floors: [{
      id: `${id}-f1`, number: 1, name: '1st Floor', grossSqft: 10000, rentableSqft: 8000,
      units: [{
        id: 'u1', type: 'office', status: tenant ? 'occupied' : 'vacant', rentable: true,
        sqft: 500, rent: 1000, contractRent: tenant ? 950 : 0, deposit: 950,
        tenant: tenant || '', company: '', email: '', phone: '',
        leaseStart: tenant ? '2026-01-01' : null, leaseEnd: tenant ? '2026-12-31' : null,
        pointsFlat: [0, 0, 10, 0, 10, 10, 0, 10],
        stripe: { customerId: tenant ? 'cus_t' : null },
      }],
    }],
  };
}

function mirrorShape(doc, savedRev) {
  return {
    _schema: 'v2', buildingId: doc.id, doc,
    _savedRev: savedRev || 1,
    _mirroredAt: new Date(),
    _mirroredBy: 'client',
  };
}

async function seed(db, opts) {
  const o = opts || {};
  // Runtime-конфиг вебхука — ПЕРВЫМ (до зданий), чтобы functions-эмулятор
  // закэшировал enabled-конфиг с первого же триггера.
  await db.doc('ppWebhookQueue/_config').set({
    enabled: o.enabled !== false,
    url: o.url || 'http://127.0.0.1:9099/hook',
    debounceMs: o.debounceMs || 3000,
  });
  // Монолит под strip: зданий нет, флаги включены (как в проде).
  await db.doc('workspaces/default/data/state').set({
    state: {
      settings: { syncV2: true, syncBuildingsV2: true, syncBuildingsRead: true, syncBuildingsStrip: true },
      ui: {}, buildings: [],
    },
    _rev: 1,
  });
  // Здания.
  const b1 = makeBuildingDoc('b1', '101.1', 'Alice LLC');
  const b2 = makeBuildingDoc('b2', '102.1', 'Bob Inc');
  const b3 = makeBuildingDoc('b3', '103.1', null);
  await db.doc('workspaces/default/buildings/b1').set(mirrorShape(b1, 1));
  await db.doc('workspaces/default/buildings/b2').set(mirrorShape(b2, 1));
  await db.doc('workspaces/default/buildings/b3').set(mirrorShape(b3, 1));
  return { b1, b2, b3, mirrorShape, makeBuildingDoc };
}

module.exports = { seed, makeBuildingDoc, mirrorShape };
