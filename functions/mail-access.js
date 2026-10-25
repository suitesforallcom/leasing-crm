/**
 * Unit mail — права доступа к переписке (UNIT_EMAIL_PLAN.md § 4.5).
 *
 * Дефолты по роли (members/{uid}.role):
 *   admin (и root admins)        — все здания, оба направления, отправка, видит непривязанные;
 *   manager                      — здания из members.buildings ([] = все), отправка;
 *   mapeditor/teamviewer/viewer  — ничего.
 * Гранты mailAccess/{uid} (Phase 2, пишет только CF mailSetAccess) переопределяют
 * дефолт: read 'all'|'buildings'|'none', buildings[], directions[], send, seeUnlinked.
 * Ограничение members.buildings остаётся потолком для всех, кроме admin
 * (канон canAccessBuilding — AUTH_AND_PERMISSIONS_RULES).
 * Архивированный член — ничего (как _dsAssertCanSendLeases). Любой отказ
 * наружу — один и тот же permission-denied без деталей (Entry 92).
 *
 * Клиентский зеркальный хелпер canUseMail()/canSendMail() — только видимость UI;
 * View-As (Entry 19) сюда не доходит: CF всегда видит реального пользователя.
 */
'use strict';

const {HttpsError} = require('firebase-functions/v2/https');
const shared = require('./mail-shared');

const DIRECTIONS = ['inbound', 'outbound'];
const READ_MODES = ['all', 'buildings', 'none'];

function _strList(arr) {
  return Array.isArray(arr) ? arr.map((x) => String(x)).filter(Boolean) : [];
}

/**
 * Чистое решение (без Firestore) — тестируется напрямую.
 * @param {{rootAdmin:boolean, member:object|null, grant:object|null}} p
 */
function decideAccess(p) {
  const rootAdmin = !!(p && p.rootAdmin);
  const member = p && p.member && typeof p.member === 'object' ? p.member : null;
  const grant = p && p.grant && typeof p.grant === 'object' ? p.grant : null;

  if (!rootAdmin && (!member || member.archived === true)) {
    return { denied: true, reason: member ? 'archived' : 'not-member', role: null, read: 'none', buildings: [], directions: [], send: false, seeUnlinked: false, isAdmin: false };
  }
  const role = rootAdmin ? 'admin' : String(member.role || 'viewer');
  const memberBuildings = rootAdmin ? [] : _strList(member && member.buildings);
  const ceiling = role === 'admin' ? null : (memberBuildings.length ? memberBuildings : null); // null = без потолка

  let read; let buildings; let send; let seeUnlinked;
  if (role === 'admin') { read = 'all'; buildings = []; send = true; seeUnlinked = true; }
  else if (role === 'manager') { read = ceiling ? 'buildings' : 'all'; buildings = ceiling ? ceiling.slice() : []; send = true; seeUnlinked = false; }
  else { read = 'none'; buildings = []; send = false; seeUnlinked = false; }
  let directions = DIRECTIONS.slice();

  if (grant) {
    if (READ_MODES.includes(grant.read)) read = grant.read;
    if (Array.isArray(grant.buildings)) buildings = _strList(grant.buildings);
    if (typeof grant.send === 'boolean') send = grant.send;
    if (typeof grant.seeUnlinked === 'boolean') seeUnlinked = grant.seeUnlinked;
    if (Array.isArray(grant.directions)) {
      const d = grant.directions.filter((x) => DIRECTIONS.includes(x));
      if (d.length) directions = d;
    }
  }

  // Потолок members.buildings для не-admin: грант не расширяет зону члена.
  if (ceiling) {
    if (read === 'all') { read = 'buildings'; buildings = ceiling.slice(); }
    else if (read === 'buildings') buildings = buildings.filter((b) => ceiling.includes(b));
  }
  if (read === 'buildings' && !buildings.length) read = 'none';
  if (read === 'none') { send = false; seeUnlinked = false; buildings = []; }

  return { denied: false, reason: null, role, read, buildings, directions, send, seeUnlinked, isAdmin: role === 'admin' };
}

function canRead(a, buildingId, direction) {
  if (!a || a.denied || a.read === 'none') return false;
  if (direction && !a.directions.includes(direction)) return false;
  if (a.read === 'all') return true;
  return !!buildingId && a.buildings.includes(String(buildingId));
}

// Тред допущен, если хоть одно из его зданий в зоне; непривязанный — только seeUnlinked.
function canReadThread(a, thread) {
  if (!a || a.denied || a.read === 'none') return false;
  const bids = _strList(thread && thread.buildingIds);
  if (!bids.length) return !!a.seeUnlinked;
  if (a.read === 'all') return true;
  return bids.some((b) => a.buildings.includes(b));
}

function canSend(a, buildingId) {
  return !!(a && !a.denied && a.send && canRead(a, buildingId));
}

function directionVisible(a, direction) {
  if (!a || a.denied) return false;
  if (!direction) return true;
  return a.directions.includes(direction);
}

/**
 * Читает members/{uid} + mailAccess/{uid} и возвращает решение с методами.
 */
async function accessFor(auth) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const email = shared.normalizeEmail(auth.token && auth.token.email);
  const verified = !(auth.token && auth.token.email_verified === false);
  const rootAdmin = verified && (await shared.isRootAdminEmail(email));
  const db = shared.db();
  const [mSnap, gSnap] = await Promise.all([
    db.doc(shared.col(`members/${auth.uid}`)).get(),
    db.doc(shared.col(`mailAccess/${auth.uid}`)).get(),
  ]);
  const member = mSnap.exists ? (mSnap.data() || {}) : null;
  const grant = gSnap.exists ? (gSnap.data() || {}) : null;
  const a = decideAccess({ rootAdmin, member, grant });
  return Object.assign(a, {
    uid: auth.uid,
    email,
    canRead: (b, d) => canRead(a, b, d),
    canReadThread: (t) => canReadThread(a, t),
    canSend: (b) => canSend(a, b),
    directionVisible: (d) => directionVisible(a, d),
  });
}

function denied() {
  return new HttpsError('permission-denied', 'No access to unit emails');
}

function assertMailReader(a) {
  if (!a || a.denied || a.read === 'none') throw denied();
  return a;
}

function assertCanReadBuilding(a, buildingId) {
  if (!canRead(a, buildingId)) throw denied();
  return a;
}

function assertAdmin(a) {
  if (!a || a.denied || !a.isAdmin) throw denied();
  return a;
}

module.exports = {
  DIRECTIONS, READ_MODES,
  decideAccess, canRead, canReadThread, canSend, directionVisible,
  accessFor, assertMailReader, assertCanReadBuilding, assertAdmin, denied,
};
