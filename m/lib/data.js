/* m/lib/data.js — слой данных мобильного клиента. Ни DOM, ни UI.
   Пути, гарды (_schema==='v2'), restore точек и merge платежей скопированы с монолита
   floor-map-editor.html: расхождение здесь = ложные деньги. Пишем наружу ТОЛЬКО через callCF. */
const FB_SDK_VERSION = '10.14.1';                 // MONO:29728 — та же версия, общий auth-сеанс
const FB_CDN = 'https://www.gstatic.com/firebasejs';
const REGION = 'us-central1';                     // MONO:32720 == functions/index.js
const WS_ALLOWED = ['default', 'staging'];        // MONO:29809 — жёсткий whitelist
const HEAL_DELAYS = [5000, 30000, 60000];         // MONO:34600 — ошибка onSnapshot терминальна
const HEAL_STEADY = 300000;
const CACHE_LIMIT = 1500000;                      // ~1.5 МБ на снимок в localStorage
const INV_PAGE = 100, INV_PAGES = 6;              // 600 свежих инвойсов хватает мобильному
const AUTH_WAIT_MS = 12000;                       // splash не должен залипать навсегда

export const WORKSPACE_ID = (() => {              // MONO:29808-29821
  try {
    const q = new URLSearchParams(location.search).get('ws');
    if (q && WS_ALLOWED.includes(q)) { try { localStorage.setItem('sfa_workspace', q); } catch {} return q; }
    const ls = localStorage.getItem('sfa_workspace');
    if (ls && WS_ALLOWED.includes(ls)) return ls;
  } catch {}
  return 'default';
})();
export const IS_STAGING = WORKSPACE_ID !== 'default';

const S = {
  sdk: null, app: null, auth: null, db: null, fns: null,
  user: null, role: null, memberBuildings: [], canEditMap: undefined,
  settings: {}, buildings: [], units: [], unitsIndex: Object.create(null),
  invoices: [], invById: Object.create(null), invByUnit: Object.create(null),
  bucketDisk: {}, invoicesAvailable: false, syncedAt: 0, refreshing: true, fromCache: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  errors: { state: null, buildings: null, payments: null, invoices: null },
};
const payCache = Object.create(null);             // 'bid|uid' -> { ym: rec }  (MONO:34593)
const streams = Object.create(null);
const subs = new Set();
let snapObj = null, emitTimer = null, cacheTimer = null, refreshInflight = null, collectionsAttached = false;

/* ---------------- подписка / снимок ---------------- */
export const unitKey = (bid, uid) => String(bid) + '|' + String(uid);
export function getUnit(buildingId, unitId) {     // suite id повторяется между зданиями → building обязателен
  return (!buildingId || unitId == null) ? null : (S.unitsIndex[unitKey(buildingId, unitId)] || null);
}
export function isEditor() { return S.role === 'admin' || S.role === 'manager'; }
export function subscribe(cb) { subs.add(cb); return () => subs.delete(cb); }
export function getSnapshot() { return snapObj || (snapObj = buildSnap()); }
function buildSnap() {
  return {
    buildings: S.buildings, unitsIndex: S.unitsIndex, units: S.units,
    invoices: S.invoices, invoicesByUnit: S.invByUnit, invoiceById: S.invById,
    // invoiceBuckets — имя, которое ждёт money.js (инъекция диск-кэша вместо своего memo).
    invoiceBucketDisk: S.bucketDisk, invoiceBuckets: S.bucketDisk, invoicesAvailable: S.invoicesAvailable,
    settings: S.settings, memberBuildings: S.memberBuildings, canEditMap: S.canEditMap,
    user: S.user, role: S.role, syncedAt: S.syncedAt, online: S.online,
    refreshing: S.refreshing, fromCache: S.fromCache, errors: Object.assign({}, S.errors),
    workspace: WORKSPACE_ID, staging: IS_STAGING,
  };
}
function emitNow() {
  if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
  snapObj = buildSnap();
  for (const cb of subs) { try { cb(snapObj); } catch (e) { console.warn('[m/data] subscriber threw', e); } }
  if (!cacheTimer && S.user) cacheTimer = setTimeout(() => { cacheTimer = null; saveCache(); }, 4000);
}
// Уведомления коалесим (первый снапшот платежей = ~1300 doc-add подряд), но снимок
// инвалидируем сразу: getSnapshot() обязан быть синхронным И актуальным, без 60мс лага.
function emit() { snapObj = null; if (!emitTimer) emitTimer = setTimeout(emitNow, 60); }

/* ---------------- SDK + конфиг ---------------- */
async function loadSdk() {
  // Динамический ESM-импорт с gstatic (MONO:29745). Обрыв импорта на сотовой — штатная
  // история: монолит лечится reload'ом, мы просто повторяем импорт (без reload-петли).
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const [a, au, fs, fn] = await Promise.all([
        import(`${FB_CDN}/${FB_SDK_VERSION}/firebase-app.js`),
        import(`${FB_CDN}/${FB_SDK_VERSION}/firebase-auth.js`),
        import(`${FB_CDN}/${FB_SDK_VERSION}/firebase-firestore.js`),
        import(`${FB_CDN}/${FB_SDK_VERSION}/firebase-functions.js`),
      ]);
      return {
        initializeApp: a.initializeApp,
        getAuth: au.getAuth, onAuthStateChanged: au.onAuthStateChanged, signOut: au.signOut,
        setPersistence: au.setPersistence, indexedDBLocalPersistence: au.indexedDBLocalPersistence,
        browserLocalPersistence: au.browserLocalPersistence, GoogleAuthProvider: au.GoogleAuthProvider,
        signInWithPopup: au.signInWithPopup, signInWithRedirect: au.signInWithRedirect,
        getRedirectResult: au.getRedirectResult,
        getFirestore: fs.getFirestore, initializeFirestore: fs.initializeFirestore, doc: fs.doc,
        collection: fs.collection, getDoc: fs.getDoc, getDocs: fs.getDocs, onSnapshot: fs.onSnapshot,
        getFunctions: fn.getFunctions, httpsCallable: fn.httpsCallable,
      };
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1200)); }
  }
  throw new Error('Could not load the Firebase library. Check your connection and reopen the app. ('
    + ((lastErr && lastErr.message) || lastErr) + ')');
}
async function readConfig() {
  // Tier 1 в репозитории пуст: apiKey === '' (MONO:32645) — хардкодить нечего.
  try {                                            // Tier 2 — Firebase Hosting (MONO:32663)
    const r = await fetch('/__/firebase/init.json', { cache: 'no-store' });
    if (r.ok) { const c = await r.json(); if (c && c.apiKey && c.projectId) return c; }
  } catch {}
  try {                                            // Tier 3 — локальная отладка (MONO:32680)
    const projectId = localStorage.getItem('sfa_firebase_project');
    const apiKey = localStorage.getItem('sfa_firebase_key');
    const authDomain = localStorage.getItem('sfa_firebase_domain') || (projectId ? projectId + '.firebaseapp.com' : null);
    if (projectId && apiKey) return { projectId, apiKey, authDomain };
  } catch {}
  return null;
}

/* ---------------- auth ---------------- */
export async function initApp() {
  if (S.sdk) return { user: S.user, role: S.role, rejected: null };
  const sdk = await loadSdk();
  const cfg = await readConfig();
  if (!cfg) throw new Error('Firebase is not configured for this address. Open the app from its normal https link (it must be served by Firebase Hosting).');
  S.sdk = sdk;
  S.app = sdk.initializeApp(cfg);
  S.auth = sdk.getAuth(S.app);
  // Сеанс обязан переживать закрытие вкладки. indexedDB — дефолт монолита: берём его же,
  // чтобы не мигрировать общий сеанс и не разлогинить оператора на десктопе. browserLocal —
  // фолбэк там, где indexedDB недоступен (webview / приватный режим). Анонимного входа нет.
  try { await sdk.setPersistence(S.auth, sdk.indexedDBLocalPersistence); }
  catch { try { await sdk.setPersistence(S.auth, sdk.browserLocalPersistence); } catch {} }
  try {   // initializeFirestore ДО любого обращения к Firestore; long-polling обязателен (MONO:32711)
    S.db = sdk.initializeFirestore(S.app, { experimentalForceLongPolling: true });
  } catch (e) {
    console.warn('[m/data] initializeFirestore fallback:', (e && e.message) || e);
    S.db = sdk.getFirestore(S.app);
  }
  S.fns = sdk.getFunctions(S.app, REGION);
  try { await sdk.getRedirectResult(S.auth); } catch (e) { console.warn('[m/data] redirect:', (e && e.code) || e); }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { S.online = true; emitNow(); refresh().catch(() => {}); });
    window.addEventListener('offline', () => { S.online = false; emitNow(); });
    window.addEventListener('storage', (e) => { if (e && e.key === 'sfa_signout_at') location.reload(); });
  }
  sdk.onAuthStateChanged(S.auth, (u) => { if (!u && S.user) hardReset(); });
  const user = await firstAuthUser();
  if (!user) { S.user = null; S.refreshing = false; emitNow(); return { user: null, role: null, rejected: null }; }
  return afterSignIn(user);
}
function firstAuthUser() {
  return new Promise((resolve) => {
    let done = false, un = null;
    const fin = (v) => { if (done) return; done = true; clearTimeout(t); try { un && un(); } catch {} resolve(v); };
    const t = setTimeout(() => fin(null), AUTH_WAIT_MS);   // splash не должен висеть вечно на медленной сети
    un = S.sdk.onAuthStateChanged(S.auth, (u) => fin(u || null), () => fin(null));
  });
}
// Общий хвост входа: и холодный старт, и возврат из popup идут сюда, иначе после
// signInWithGoogle() роль осталась бы неизвестной до перезагрузки страницы.
async function afterSignIn(user) {
  S.user = { uid: user.uid, email: user.email || '', name: user.displayName || '', photo: user.photoURL || '' };
  const boot = await bootstrapMember(user);
  if (boot.rejected) {   // аутентифицирован ≠ авторизован (MONO:32861): стену снимает только успешный boot
    try { await S.sdk.signOut(S.auth); } catch {}
    S.user = null; S.role = null; S.refreshing = false; emitNow();
    return { user: null, role: null, rejected: boot };
  }
  S.role = boot.role; S.memberBuildings = boot.buildings; S.canEditMap = boot.canEditMap;
  loadCache();                                     // холодный старт рисуется мгновенно
  S.bucketDisk = loadBucketDisk();
  emitNow();
  stream('state', stateRef, (s) => applyState(s.exists() ? s.data() : null));
  fetchInvoices().catch((e) => console.warn('[m/data] invoices:', e));
  return { user: S.user, role: S.role, rejected: null };
}
// Возвращает {user, role, rejected} как initApp, либо null если ушли в redirect (страница перезагрузится).
/**
 * Совпадает ли origin страницы с доменом входа Firebase.
 * ЭТО РЕШАЮЩЕЕ УСЛОВИЕ для signInWithRedirect. Приложение отдаётся и на
 * suitesforall.web.app, и на suitesforall.firebaseapp.com; authDomain —
 * второй. С web.app redirect идёт МЕЖДУ доменами, а Safari на iPhone режет
 * межсайтовое хранилище (ITP) — состояние теряется, и до Google доходит битый
 * запрос: «400. That's an error… malformed» (поймано 2026-08-15 на телефоне
 * оператора). С firebaseapp.com тот же вызов доходит до обычной страницы входа.
 */
function authSameOrigin() {
  try {
    const d = (S.auth && S.auth.config && S.auth.config.authDomain) || '';
    return !!d && d === location.host;
  } catch (e) { return false; }
}
/** Тот же путь на домене входа — там вход работает в любом браузере. */
export function authDomainUrl(extraQuery) {
  const d = (S.auth && S.auth.config && S.auth.config.authDomain) || '';
  if (!d) return '';
  return 'https://' + d + location.pathname + (extraQuery || '') + location.hash;
}

export async function signInWithGoogle() {
  if (!S.sdk) throw new Error('App is still starting — try again in a moment.');
  const provider = new S.sdk.GoogleAuthProvider();
  try {
    const cred = await S.sdk.signInWithPopup(S.auth, provider);
    return await afterSignIn(cred.user);
  } catch (e) {
    const code = (e && e.code) || '';
    // Мобильные браузеры и webview рутинно режут popup. Раньше здесь безусловно
    // шёл signInWithRedirect — и на iPhone это давало не вход, а ошибку Google.
    // Теперь redirect разрешён ТОЛЬКО когда он остаётся внутри одного origin.
    if (/popup-blocked|popup-closed-by-user|cancelled-popup-request|operation-not-supported/.test(code)) {
      if (authSameOrigin()) { await S.sdk.signInWithRedirect(S.auth, provider); return null; }
      const err = new Error('Safari blocked the sign-in window. Continue on the sign-in address — same app, same data.');
      err.code = 'sfa/needs-auth-domain';
      err.authUrl = authDomainUrl('?signin=1');
      throw err;
    }
    throw new Error(code === 'auth/network-request-failed' ? 'No connection to the sign-in service. Check your network and try again.'
      : code === 'auth/too-many-requests' ? 'Too many attempts. Wait a minute and try again.'
      : code === 'auth/unauthorized-domain' ? 'This address is not authorized for sign-in. Open the app from its normal link.'
      : 'Sign-in failed: ' + ((e && e.message) || code || 'unknown error'));
  }
}

/**
 * Продолжение входа после перехода на домен входа: ?signin=1.
 * Здесь мы уже same-origin, поэтому redirect работает БЕЗ жеста пользователя —
 * оператору не приходится жать кнопку второй раз.
 */
export async function resumeSignInIfAsked() {
  try {
    if (!/[?&]signin=1(?:&|$)/.test(location.search)) return false;
    if (S.user || !authSameOrigin() || !S.sdk) return false;
    // Метку убираем ДО старта: Firebase вернёт браузер на текущий URL, и если
    // вход не завершился (отмена, чужой аккаунт), страница с ?signin=1 запустила
    // бы его снова — бесконечная петля вместо экрана входа.
    try {
      const clean = location.pathname
        + location.search.replace(/([?&])signin=1(&|$)/, (m, a, b) => (b ? a : '')).replace(/[?&]$/, '')
        + location.hash;
      history.replaceState(null, '', clean);
    } catch (e) { /* старый webview — переживём один лишний круг */ }
    await S.sdk.signInWithRedirect(S.auth, new S.sdk.GoogleAuthProvider());
    return true;
  } catch (e) { console.warn('[m/data] resume sign-in:', (e && e.code) || e); return false; }
}
async function bootstrapMember(user) {
  // Только ЧТЕНИЕ members/{uid}. Новый uid себя завести не может (firestore.rules:112,
  // оба allowlist'а пусты) — онбординг не строим, показываем понятный отказ.
  const email = (user.email || '').trim();
  try {
    const snap = await S.sdk.getDoc(S.sdk.doc(S.db, 'workspaces', WORKSPACE_ID, 'members', user.uid));
    if (!snap.exists()) return { rejected: true, reason: 'not-invited', message: 'This workspace is invitation-only. Ask an admin to add ' + (email || 'your account') + ', then sign in again.' };
    const m = snap.data() || {};
    if (m.archived === true && m.rootAdmin !== true) return { rejected: true, reason: 'archived', message: 'This account has been archived' + (m.archivedByEmail ? ' by ' + m.archivedByEmail : '') + '. Contact an admin to restore access.' };
    return {
      role: m.role || 'viewer',
      buildings: Array.isArray(m.buildings) ? m.buildings : [],   // пустой массив = БЕЗ ограничений (MONO:37619)
      canEditMap: typeof m.canEditMap === 'boolean' ? m.canEditMap : undefined,
    };
  } catch (e) {
    return { rejected: true, reason: (e && e.code) || 'read-failed', message: 'Could not verify your access (' + ((e && e.code) || (e && e.message) || 'error') + '). Try again, or ask an admin to check your membership.' };
  }
}
export async function signOut() {
  try { localStorage.setItem('sfa_signout_at', String(Date.now())); } catch {}   // MONO:58903 — кросс-табный сигнал
  try { localStorage.removeItem(cacheKey()); } catch {}
  try { await S.sdk.signOut(S.auth); } catch {}
  hardReset();
}
function hardReset() {
  for (const k in streams) {
    const st = streams[k];
    try { st.unsub && st.unsub(); } catch {}
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.unsub = null; st.attempt = 0;
  }
  collectionsAttached = false;
  S.user = null; S.role = null; S.buildings = []; S.units = []; S.unitsIndex = Object.create(null);
  S.invoices = []; S.invById = Object.create(null); S.invByUnit = Object.create(null);
  S.invoicesAvailable = false; S.refreshing = false;
  for (const k in payCache) delete payCache[k];
  emitNow();
}

/* ---------------- листенеры: ошибка = стрим мёртв → unsub → backoff → re-attach ---------------- */
const stateRef = () => S.sdk.doc(S.db, 'workspaces', WORKSPACE_ID, 'data', 'state');
const bldRef = () => S.sdk.collection(S.db, 'workspaces', WORKSPACE_ID, 'buildings');
const payRef = () => S.sdk.collection(S.db, 'workspaces', WORKSPACE_ID, 'payments');

function stream(key, makeRef, apply) {
  const st = streams[key] || (streams[key] = { unsub: null, attempt: 0, timer: null });
  if (st.unsub || !S.db) return;
  const onError = (err) => {
    console.warn('[m/data] ' + key + ' stream error:', (err && err.code) || (err && err.message) || err);
    try { st.unsub && st.unsub(); } catch {}
    st.unsub = null;
    S.errors[key] = friendly(err, key);            // молчаливых сбоев не бывает — UI обязан показать
    emitNow();
    if (st.timer) return;
    const d = st.attempt < HEAL_DELAYS.length ? HEAL_DELAYS[st.attempt] : HEAL_STEADY;
    st.timer = setTimeout(() => { st.timer = null; st.attempt++; stream(key, makeRef, apply); }, d);
  };
  try {
    st.unsub = S.sdk.onSnapshot(makeRef(), (snap) => {
      st.attempt = 0;
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      S.errors[key] = null;
      try { apply(snap); } catch (e) { console.warn('[m/data] apply ' + key + ':', e); }
      S.syncedAt = Date.now(); S.refreshing = false; S.fromCache = false;
      emit();
    }, onError);
  } catch (e) { onError(e); }
}

function applyState(data) {
  if (!data) return;
  const st = (data.state && typeof data.state === 'object') ? data.state : data;   // конверт {_rev,…,state:{…}}
  S.settings = st.settings || {};
  // Где лежит правда — решают РАНТАЙМ-флаги, не константа (DATA-контракт §flags). Под
  // включённым read-switch'ем авторитетна коллекция, и монолитные buildings трогать нельзя.
  if (!S.settings.syncBuildingsRead && Array.isArray(st.buildings) && st.buildings.length) {
    S.buildings = st.buildings.map(restorePoints); rebuildIndex();
  }
  if (!S.settings.syncV2Read && Array.isArray(st.buildings)) {   // платежи ещё внутри state-дока
    for (const b of st.buildings) for (const f of ((b && b.floors) || [])) for (const u of ((f && f.units) || [])) {
      if (u && u.payments) payCache[unitKey(b.id, u.id)] = u.payments;
    }
  }
  attachCollections();
}
function attachCollections() {
  if (collectionsAttached) return;
  collectionsAttached = true;
  if (S.settings.syncV2Read) stream('payments', payRef, applyPaymentsSnap);
  if (S.settings.syncBuildingsRead) stream('buildings', bldRef, applyBuildingsSnap);
  // getDocs параллельно стриму — стрим медленнее (MONO:34884). Обязательный .catch:
  // без него сбой уходит в unhandled rejection и оператор видит пустой экран без причины.
  pullCollections('cold-start').catch((e) => { S.errors.state = friendly(e, 'state'); emitNow(); });
}

function applyPaymentsSnap(snap) {
  let missed = 0;
  snap.docChanges().forEach((ch) => { if (applyPaymentDoc(ch.type, ch.doc.data()) === 'orphan') missed++; });
  if (missed) rebuildIndex();                      // юнит приехал позже платежа — досыпаем из кэша
}
function applyPaymentDoc(type, data) {
  if (!data || data._schema !== 'v2') return false;   // v1-сироты ключуются без buildingId (MONO:34667)
  const { buildingId, unitId, ym } = data;
  if (!buildingId || !unitId || !ym) return false;
  const ck = unitKey(buildingId, unitId);
  const bucket = payCache[ck] || (payCache[ck] = Object.create(null));   // кэш обновляем ВСЕГДА
  if (type === 'removed') delete bucket[ym]; else bucket[ym] = data.rec || {};
  const hit = S.unitsIndex[ck];
  if (!hit || !hit.unit) return 'orphan';
  hit.unit.payments = hit.unit.payments || {};
  if (type === 'removed') delete hit.unit.payments[ym]; else hit.unit.payments[ym] = data.rec || {};
  return true;
}
function applyBuildingsSnap(snap) {
  let changed = 0;
  snap.docChanges().forEach((ch) => {
    try {                                          // одна битая запись не должна ронять весь снапшот
      const data = ch.doc.data();
      if (!data || data._schema !== 'v2' || !data.doc) return;
      const bid = data.buildingId || data.doc.id || ch.doc.id;
      if (!bid) return;
      if (ch.type === 'removed') {
        const i = S.buildings.findIndex(b => b && b.id === bid);
        if (i >= 0) { S.buildings.splice(i, 1); changed++; }
        return;
      }
      applyBuildingDoc(bid, data.doc); changed++;
    } catch (e) { console.warn('[m/data] building doc failed:', ch.doc.id, (e && e.message) || e); }
  });
  if (changed) rebuildIndex();
}
function applyBuildingDoc(bid, incoming) {
  restorePoints(incoming);
  const idx = S.buildings.findIndex(b => b && b.id === bid);
  const kept = Object.create(null);                // свап меняет ВЕСЬ объект — платежи спасаем (MONO:35702)
  if (idx >= 0) for (const f of (S.buildings[idx].floors || [])) for (const u of (f.units || [])) if (u && u.payments) kept[u.id] = u.payments;
  for (const f of (incoming.floors || [])) for (const u of (f.units || [])) {
    if (!u) continue;
    if (kept[u.id]) u.payments = kept[u.id];
    fillFromCache(bid, u);
  }
  if (idx >= 0) S.buildings[idx] = incoming; else S.buildings.push(incoming);
}
function fillFromCache(bid, u) {                   // кэш НИКОГДА не перетирает уже выставленный ym
  const cp = payCache[unitKey(bid, u.id)];
  if (!cp) return;
  u.payments = u.payments || {};
  for (const ym in cp) if (!(ym in u.payments)) u.payments[ym] = cp[ym];
}
function restorePoints(doc) {                      // pointsFlat -> points (MONO:34959): порог 6, points уже есть — не трогаем
  if (!doc || typeof doc !== 'object') return doc;
  const unflat = (o) => {
    if (!Array.isArray(o.pointsFlat) || o.pointsFlat.length < 6 || Array.isArray(o.points)) return;
    const pts = [];
    for (let i = 0; i + 1 < o.pointsFlat.length; i += 2) pts.push([+o.pointsFlat[i] || 0, +o.pointsFlat[i + 1] || 0]);
    o.points = pts; delete o.pointsFlat;
  };
  for (const f of (doc.floors || [])) {
    for (const u of (f.units || [])) if (u) unflat(u);
    if (f.outline) unflat(f.outline);
  }
  return doc;
}
function rebuildIndex() {
  const idx = Object.create(null), flat = [];
  for (const b of S.buildings) {
    if (!b || !b.id) continue;
    for (const f of (b.floors || [])) for (const u of (f.units || [])) {
      if (!u || u.id == null) continue;
      fillFromCache(b.id, u);
      const entry = { unit: u, building: b, floor: f, key: unitKey(b.id, u.id) };
      idx[entry.key] = entry; flat.push(entry);
    }
  }
  S.unitsIndex = idx; S.units = flat;
}

/* ---------------- дозагрузка + refresh ---------------- */
async function pullCollections(reason) {
  const jobs = [];
  const job = (key, run) => { try { jobs.push(run().catch(e => { S.errors[key] = friendly(e, key); })); } catch (e) { S.errors[key] = friendly(e, key); } };
  if (S.settings.syncV2Read) job('payments', () => S.sdk.getDocs(payRef())
    .then((s) => { s.forEach(d => applyPaymentDoc('added', d.data())); console.info('[m/data] payments getDocs (' + reason + ')'); }));
  if (S.settings.syncBuildingsRead) job('buildings', () => S.sdk.getDocs(bldRef())
    .then((s) => { s.forEach(d => { const v = d.data(); if (v && v._schema === 'v2' && v.doc) applyBuildingDoc(v.buildingId || d.id, v.doc); }); }));
  if (!jobs.length) return;
  await Promise.all(jobs);
  rebuildIndex();
  S.syncedAt = Date.now(); S.fromCache = false; S.refreshing = false;
  emitNow();
}
export function refresh() {
  if (!S.db || !S.user) return Promise.resolve(getSnapshot());
  if (refreshInflight) return refreshInflight;
  S.refreshing = true; emitNow();
  refreshInflight = (async () => {
    try { const s = await S.sdk.getDoc(stateRef()); applyState(s.exists() ? s.data() : null); S.errors.state = null; }
    catch (e) { S.errors.state = friendly(e, 'state'); }
    try { await pullCollections('manual-refresh'); } catch (e) { console.warn('[m/data] refresh:', e); }
    await fetchInvoices();
    S.refreshing = false; refreshInflight = null;
    emitNow();
    return getSnapshot();
  })();
  return refreshInflight;
}

/* ---------------- Cloud Functions ---------------- */
export function callCF(name, payload, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 30000;
  if (!S.fns || !S.user) return Promise.reject(new Error('Not connected — sign in first.'));
  let fn;
  try { fn = S.sdk.httpsCallable(S.fns, name, { timeout: timeoutMs }); } catch (e) { return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      // Оптимистичного успеха не бывает. Таймаут ≠ отказ: запрос мог дойти до сервера.
      const e = new Error('No answer from the server after ' + Math.round(timeoutMs / 1000)
        + 's. It may still have gone through — check before sending again.');
      e.code = 'timeout'; e.isTimeout = true; e.mayHaveCompleted = true;
      reject(e);
    }, timeoutMs);
    let p;
    try { p = fn(payload || {}); } catch (e) { settled = true; clearTimeout(timer); reject(e); return; }
    p.then((res) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve(res && typeof res === 'object' && 'data' in res ? res.data : res);
    }, (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      reject(cfError(err, name));
    });
  });
}
function cfError(err, name) {
  const code = (err && err.code) || '', raw = (err && err.message) || String(err);
  const e = new Error(   // already-exists / resource-exhausted несут готовый серверный текст
    code === 'functions/permission-denied' ? 'Your role is not allowed to do that.'
    : code === 'functions/unauthenticated' ? 'Session expired — sign in again.'
    : code === 'functions/unavailable' ? 'Server unreachable. Check your connection and try again.'
    : code === 'functions/deadline-exceeded' ? 'The server took too long. It may still have gone through — check before sending again.'
    : (raw || ('Call "' + name + '" failed.')));
  e.code = code || 'unknown';
  e.mayHaveCompleted = code === 'functions/deadline-exceeded';
  e.cause = err;
  return e;
}

/* ---------------- Stripe-инвойсы (listStripeInvoices требует EDITOR, не member) ---------------- */
function normRow(r) {
  const row = Object.assign({}, r), meta = row.metadata || {};
  row.ym = row.ym || meta.ym || null;
  row.unitId = row.unitId || meta.unitId || null;
  row.purpose = row.purpose || meta.purpose || '';
  // bucket с сервера считается на момент выборки и протухает → пересчитываем локально.
  row.bucket = (row.status === 'open' && row.dueDate && row.dueDate < Date.now()) ? 'past_due' : row.status;
  return row;
}
async function fetchInvoices() {
  if (!isEditor()) { S.invoicesAvailable = false; S.errors.invoices = null; emit(); return; }
  const map = new Map(S.invoices.map(r => [r.id, r]));
  const take = (res) => { for (const r of ((res && res.rows) || [])) if (r && r.id) map.set(r.id, normRow(r)); return res; };
  const call = (args) => callCF('listStripeInvoices', args, { timeoutMs: 45000 });
  try {
    // Сперва открытые (живые обязательства), затем свежая лента страницами.
    // lean:true пропускает expand customer — ~1с вместо ~5с на страницу.
    take(await call({ limit: INV_PAGE, status: 'open', lean: true }));
    let cursor = null;
    for (let p = 0; p < INV_PAGES; p++) {
      const args = { limit: INV_PAGE, lean: true };
      if (cursor) args.startingAfter = cursor;
      const res = take(await call(args));
      if (!res || !res.hasMore || !res.nextCursor) break;
      cursor = res.nextCursor;
    }
    S.invoices = Array.from(map.values());
    indexInvoices(S.invoices);
    S.invoicesAvailable = true; S.errors.invoices = null;
  } catch (e) {
    S.invoicesAvailable = S.invoices.length > 0;
    // viewer/teamviewer к Stripe не допущен — это роль, а не сбой.
    S.errors.invoices = (e && e.code === 'functions/permission-denied') ? null : friendly(e, 'invoices');
  }
  emitNow();
}
function indexInvoices(rows) {
  const byId = Object.create(null), byUnit = Object.create(null);
  for (const r of rows) {
    if (!r || !r.id) continue;
    byId[r.id] = r;
    const k = String(r.unitId || (r.metadata && r.metadata.unitId) || '');   // пустой ключ сохраняем намеренно
    (byUnit[k] || (byUnit[k] = [])).push(r);
  }
  S.invById = byId; S.invByUnit = byUnit;
}
function loadBucketDisk() {                        // терминальные 'paid' от десктопа, тот же origin (MONO:141540)
  try { return JSON.parse(localStorage.getItem('sfa_inv_buckets_v1') || '{}') || {}; } catch { return {}; }
}

/* ---------------- кэш снимка: холодный старт рисуется мгновенно ---------------- */
const cacheKey = () => 'sfa_m_snap_v1|' + WORKSPACE_ID + '|' + ((S.user && S.user.uid) || 'anon');
// Геометрия, подложки и пачки документов в кэш не едут — только деньги и факты аренды.
const HEAVY = new Set(['points', 'pointsFlat', 'outline', 'bg', 'background', 'blueprint', 'image', 'img',
  'svg', 'photo', 'thumbnail', 'leaseDocuments', 'prospects', 'outreach']);

function cacheReplacer(cutYm) {
  return function (k, v) {
    if (HEAVY.has(k)) return undefined;
    if (k === 'leaseEnvelopes' && Array.isArray(v)) {          // хватает последнего — им красится «Lease signed»
      return v.slice(-1).map(e => ({ envelopeId: e && e.envelopeId, status: e && e.status, sentAt: e && e.sentAt, completedAt: e && e.completedAt }));
    }
    if (k === 'payments' && cutYm && v && typeof v === 'object') {
      const p = {};
      for (const ym in v) if (ym === 'deposit' || ym >= cutYm) p[ym] = v[ym];
      return p;
    }
    return v;
  };
}
function saveCache() {
  if (!S.user || !S.buildings.length) return;
  const body = { v: 1, ws: WORKSPACE_ID, uid: S.user.uid, syncedAt: S.syncedAt || Date.now(),
    settings: S.settings, role: S.role, buildings: S.buildings, invoices: S.invoices.slice(-400) };
  const d = new Date(); d.setMonth(d.getMonth() - 8);
  const cut8 = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  // Ступени урезания: полный → без инвойсов → только последние 8 месяцев платежей.
  const steps = [[body, null], [Object.assign({}, body, { invoices: [] }), null], [Object.assign({}, body, { invoices: [] }), cut8]];
  for (const [payload, cut] of steps) {
    let str;
    try { str = JSON.stringify(payload, cacheReplacer(cut)); } catch { return; }
    if (str.length > CACHE_LIMIT) continue;
    try { localStorage.setItem(cacheKey(), str); return; }
    catch { try { localStorage.removeItem(cacheKey()); } catch {} }   // квота — чистим и пробуем меньше
  }
}
function loadCache() {
  let raw = null;
  try { raw = localStorage.getItem(cacheKey()); } catch {}
  if (!raw) return;
  try {
    const c = JSON.parse(raw);
    if (!c || c.v !== 1 || c.ws !== WORKSPACE_ID || c.uid !== (S.user && S.user.uid)) return;
    S.buildings = Array.isArray(c.buildings) ? c.buildings : [];
    S.settings = c.settings || {};
    S.invoices = Array.isArray(c.invoices) ? c.invoices : [];
    indexInvoices(S.invoices);
    S.invoicesAvailable = S.invoices.length > 0;
    for (const b of S.buildings) for (const f of ((b && b.floors) || [])) for (const u of ((f && f.units) || [])) {
      if (u && u.payments) payCache[unitKey(b.id, u.id)] = Object.assign(Object.create(null), u.payments);
    }
    rebuildIndex();
    S.syncedAt = c.syncedAt || 0; S.fromCache = true; S.refreshing = true;   // «synced X ago · refreshing…»
  } catch (e) { console.warn('[m/data] cache read failed:', (e && e.message) || e); }
}

/* ---------------- ошибки в человеческом виде ---------------- */
function friendly(err, key) {
  const code = (err && err.code) || '';
  const what = key === 'payments' ? 'Payments' : key === 'buildings' ? 'Buildings'
    : key === 'invoices' ? 'Stripe invoices' : 'Workspace';
  if (/permission-denied/.test(code)) return what + ': your account is not allowed to read this. Ask an admin.';
  if (/unauthenticated/.test(code)) return 'Session expired — sign in again.';
  if (/unavailable/.test(code) || (err && err.isTimeout)) return what + ': server unreachable — showing the last synced data.';
  return what + ' sync failed (' + (code || (err && err.message) || 'unknown') + '). Reconnecting…';
}
