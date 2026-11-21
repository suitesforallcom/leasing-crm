/**
 * Entry 104 — адрес здания в договоре при одинаковом номере юнита в
 * нескольких зданиях.
 *
 * Инцидент 2026-11-21: договор для Apt 206 / 4355 Central Ave ушёл арендатору
 * с адресом «6698 68th Ave N, Pinellas Park» — первого здания, где есть юнит
 * «206». Между превью и «Confirm & send» листенер buildings подменил объекты
 * зданий, запомненный в payload юнит отвязался от state, и _liveLeaseFields
 * нашёл здание по голому номеру юнита.
 *
 * Функции достаём ИЗ ФАЙЛА, копию не держим.
 *
 * node tests/lease-building.test.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'floor-map-editor.html'), 'utf8');

function cut(startMarker, endMarker) {
  const from = src.indexOf(startMarker);
  if (from < 0) throw new Error('не найдено в floor-map-editor.html: ' + startMarker);
  const to = src.indexOf(endMarker, from);
  if (to < 0) throw new Error('не найден конец после: ' + startMarker);
  return src.slice(from, to + endMarker.length);
}

const liveSrc = cut('function _liveLeaseFields(', '\n  }, ld);\n}');
const liveUnitFnSrc = (() => {
  const from = src.indexOf('function _slLiveUnit(');
  if (from < 0) return null;
  const to = src.indexOf('\n}\n', from);
  return src.slice(from, to + 2);
})();

const pts = [[0, 0], [1, 0], [1, 1]];
function makeState() {
  return {
    settings: {},
    buildings: [
      { id: 'b1', name: 'Pinnellas Park', address: '6698 68th Ave N, Pinellas Park, FL 33781',
        floors: [{ id: 'f2', units: [{ id: '206', type: 'office', points: pts }] }] },
      { id: 'b6', name: '4355 Central Ave', address: '4355 Central Ave, St. Petersburg, FL 33713',
        floors: [{ id: 'f2', units: [{ id: '206', type: 'apt_1_1', tenant: 'Test Tenant', rent: 1500, points: pts }] }] },
    ],
  };
}

function build(state, currentId) {
  const stubs = {
    state,
    getLeaseDefaults: () => ({}),
    currentBuilding: () => state.buildings.find(b => b.id === currentId) || null,
    _extractCityFromAddress: (a) => String(a || '').split(',')[1]?.trim() || '',
    _buildFloorPlanSvgHtml: () => '',
    _findFloorByUnit: () => null,
    _leaseEndFromStartTerm: () => '',
    _landlordSignatureHtml: () => '',
    _autoRenewNextDay: () => '',
    toIsoDate: (v) => v,
  };
  const names = Object.keys(stubs);
  const body = liveSrc + (liveUnitFnSrc ? '\n' + liveUnitFnSrc : '')
    + '\nreturn { _liveLeaseFields, _slLiveUnit: (typeof _slLiveUnit === "function") ? _slLiveUnit : null };';
  return new Function(...names, body)(...names.map(n => stubs[n]));
}

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' — ' + e.message); fail++; } };

const CENTRAL = '4355 Central Ave, St. Petersburg, FL 33713';

t('юнит из state (ссылка жива) → адрес своего здания', () => {
  const state = makeState();
  const { _liveLeaseFields } = build(state, 'b1');
  const u = state.buildings[1].floors[0].units[0];
  assert.strictEqual(_liveLeaseFields(u, {}).building_address, CENTRAL);
});

t('ОТВЯЗАННЫЙ юнит + явное здание → адрес явного здания, а не первого с тем же номером', () => {
  const state = makeState();
  const { _liveLeaseFields } = build(state, 'b1');
  // Слепок юнита, каким он остаётся в payload после whole-object swap.
  const stale = JSON.parse(JSON.stringify(state.buildings[1].floors[0].units[0]));
  const f = _liveLeaseFields(stale, {}, 'b6');
  assert.strictEqual(f.building_address, CENTRAL,
    'в договор ушёл адрес чужого здания: ' + f.building_address);
  assert.strictEqual(f.building_name, '4355 Central Ave');
  assert.strictEqual(f.city, 'St. Petersburg');
});

t('явное здание выигрывает и у текущего здания на экране', () => {
  const state = makeState();
  const { _liveLeaseFields } = build(state, 'b1');
  const stale = { id: '999', tenant: 'X' };   // такого юнита нет нигде
  assert.strictEqual(_liveLeaseFields(stale, {}, 'b6').building_address, CENTRAL);
});

t('неизвестный buildingId не ломает прежний путь (ссылка → своё здание)', () => {
  const state = makeState();
  const { _liveLeaseFields } = build(state, 'b1');
  const u = state.buildings[1].floors[0].units[0];
  assert.strictEqual(_liveLeaseFields(u, {}, 'nope').building_address, CENTRAL);
});

t('_slLiveUnit находит юнит по полному пути здание → этаж → юнит', () => {
  const state = makeState();
  const { _slLiveUnit } = build(state, 'b1');
  assert.ok(_slLiveUnit, '_slLiveUnit не найдена в floor-map-editor.html');
  const r = _slLiveUnit('b6', 'f2', '206');
  assert.strictEqual(r.u, state.buildings[1].floors[0].units[0]);
  assert.strictEqual(r.b.id, 'b6');
  assert.strictEqual(_slLiveUnit('b6', 'f2', '777'), null);
  assert.strictEqual(_slLiveUnit('gone', 'f2', '206'), null);
});

t('_slLiveUnit после подмены объектов отдаёт НОВЫЙ объект юнита', () => {
  const state = makeState();
  const { _slLiveUnit } = build(state, 'b1');
  const before = _slLiveUnit('b6', 'f2', '206').u;
  state.buildings = JSON.parse(JSON.stringify(state.buildings));   // whole-object swap
  const after = _slLiveUnit('b6', 'f2', '206').u;
  assert.notStrictEqual(after, before);
  assert.strictEqual(after.type, 'apt_1_1');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
