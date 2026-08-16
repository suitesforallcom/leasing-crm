/* /m/app.js — оболочка мобильного клиента SuitesForAll.
   Владеет: состоянием S, циклом рендера, вкладками, полосой здания,
   шторками, тостом и делегированием кликов по [data-act].
   Внутренности экранов — в /m/ui/*, деньги — в /m/lib/money.js.
   Здесь НЕТ прямого обращения к Firebase: только через ./lib/data.js. */

import { initApp, subscribe, getSnapshot, refresh, callCF } from './lib/data.js';
import * as data from './lib/data.js';           // мягкий доступ к signIn/signOut
import * as money from './lib/money.js';
import * as fmt from './lib/format.js';
import * as home from './ui/home.js';
import * as payments from './ui/payments.js';
import * as unit from './ui/unit.js';
import * as lease from './ui/lease.js';
import * as invoice from './ui/invoice.js';
import * as switcher from './ui/switcher.js';
import * as plan from './ui/plan.js';

const SCOPE_KEY = 'sfa_m_building';   // здание запоминается на устройстве
const BOOT_STUCK_MS = 12000;          // не оставляем оператора на вечном сплэше

const I = {
  home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/></svg>',
  money:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  plan:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h7V3"/><path d="M10 9v12"/><path d="M10 15h11"/></svg>',
  alert:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 3 2 20h20L12 3z"/><line x1="12" y1="9" x2="12" y2="14"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
  grid:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  caret:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  doc:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/></svg>',
  sync:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><polyline points="3 21 3 16 8 16"/><polyline points="21 3 21 8 16 8"/></svg>',
  ext:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  user:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
};

/* ---------------- DOM ---------------- */
const appEl = document.getElementById('app');
const scrollEl = document.getElementById('scroll');
const tabbarEl = document.getElementById('tabbar');
const scrimEl = document.getElementById('scrim');
const sheetEl = document.getElementById('sheet');
const sheetBody = document.getElementById('sheetBody');
const sheetFoot = document.getElementById('sheetFoot');
const toastEl = document.getElementById('toast');
const gateEl = document.getElementById('gate');
const gateMsg = document.getElementById('gateMsg');
const gateBtn = document.getElementById('gateBtn');
const gateAlt = document.getElementById('gateAlt');

/* ---------------- state ---------------- */
const S = {
  tab: 'home',                 // home | payments | more
  scope: readScope(),          // building id | 'all'
  floor: 'all',
  q: '',
  filter: 'overdue',
  sheet: null,                 // unit | lease | invoice | switcher
  payload: null,
  searchAll: false,
  ym: todayYm(),
};
let snap = null;
let booted = false;
let rafId = 0;

/* ---------------- utils ---------------- */
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function safe(fn, dflt){ try { const v = fn(); return (v == null || v === '') ? dflt : v; } catch { return dflt; } }
function num(v){ const n = +v; return Number.isFinite(n) ? n : 0; }
function todayYm(){ const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function readScope(){ return safe(() => localStorage.getItem(SCOPE_KEY), '') || ''; }   // '' = ещё ни разу не выбирали
function writeScope(v){ try { localStorage.setItem(SCOPE_KEY, v); } catch {} }
function errText(e){ return String((e && (e.message || e.code)) || e || 'Unknown error'); }

/* ---------------- snapshot helpers ---------------- */
function buildings(){ return (snap && Array.isArray(snap.buildings)) ? snap.buildings : []; }
function curBld(){
  if (!snap || S.scope === 'all') return null;
  return buildings().find(b => b && String(b.id) === String(S.scope)) || null;
}
function scopeName(){
  if (S.scope === 'all') return 'All buildings';
  const b = curBld();
  return b ? (b.name || b.id) : 'Loading…';
}
function codeOf(b){
  const c = b && (b.code || b.shortCode || b.invoiceCode);
  return String(c || safe(() => fmt.initials(b && b.name), '') || String((b && b.name) || '?').slice(0, 3)).toUpperCase().slice(0, 4);
}
function statsOf(b){
  const st = safe(() => money.buildingStats(b, S.ym, snap), null);
  if (!st || typeof st !== 'object') return null;
  const collected = num(st.collected), awaiting = num(st.awaiting), overdue = num(st.overdue);
  const billed = num(st.billed) || (collected + awaiting + overdue);
  const late = num(st.late != null ? st.late : (st.lateCount != null ? st.lateCount : (st.n && st.n.overdue)));
  const pct = Number.isFinite(+st.pct) ? Math.round(+st.pct) : (billed ? Math.round(collected / billed * 100) : 0);
  return { collected, billed, late, pct };
}
function scopeStats(){
  const list = S.scope === 'all' ? buildings() : [curBld()].filter(Boolean);
  let collected = 0, billed = 0, late = 0, one = null, any = false;
  for (const b of list){ const s = statsOf(b); if (!s) continue; any = true; one = s; collected += s.collected; billed += s.billed; late += s.late; }
  if (!any) return null;
  return { pct: list.length === 1 ? one.pct : (billed ? Math.round(collected / billed * 100) : 0), late };
}
// пустой список зданий = снимок ещё грузится; НЕ затираем запомненное здание.
// Первый запуск (scope='') открывается в первом здании: оператор живёт в одном.
function ensureScope(){
  const list = buildings();
  if (!list.length || S.scope === 'all') return;
  if (S.scope && list.some(b => b && String(b.id) === String(S.scope))) return;
  S.scope = String(list[0].id); S.buildingId = S.scope; writeScope(S.scope);
}

/* ---------------- ctx для UI-модулей ---------------- */
function ctx(){
  return {
    S, snap, money, fmt, callCF,
    building: curBld(),
    go, openSheet, closeSheet, toast,
    setScope,                       // менять здание можно ТОЛЬКО так (один владелец состояния)
    canSend,                        // право отправлять деньги/договоры — одна проверка на все экраны
    // Перерисовать ТОЛЬКО подвал листа. Нужно модулям, у которых кнопка внизу
    // зависит от того, что человек печатает: ввод не вызывает handle, значит
    // подвал сам по себе никогда не обновится (оператор набирал имя и почту, а
    // Continue оставался серым, пока он не переключит вкладку).
    refreshFoot: () => { if (S.sheet) paintFoot(S.sheet); },
    refresh: () => doRefresh(false),
  };
}
function paintFoot(name){
  const mod = SHEETS[name];
  let footHtml = '';
  if (mod && typeof mod.foot === 'function'){
    try { footHtml = mod.foot(ctx()) || ''; }
    catch (e){ console.error('[m] foot failed:', name, e); footHtml = ''; }
  }
  sheetFoot.innerHTML = footHtml;
  sheetFoot.style.display = footHtml.trim() ? 'flex' : 'none';
  hoistFoot();
}
function go(name){
  if (TABS[name]){ if (S.sheet) hideSheet(); S.tab = name; render(); return; }
  if (SHEETS[name]) openSheet(name);
}

/* ---------------- More (вкладка-«всё остальное» живёт в оболочке) ---------------- */
function moreRow(act, key, ico, t, s){
  return '<button class="arow" type="button" data-act="' + esc(act) + '"' + (key ? ' data-k="' + esc(key) + '"' : '') + '>'
    + '<span class="astat" style="background:var(--accent-soft);color:var(--accent)">' + ico + '</span>'
    + '<span class="amain"><span class="aname">' + esc(t) + '</span><span class="await">' + esc(s) + '</span></span>'
    + '<span class="job-go">' + I.caret + '</span></button>';
}
function syncLine(){
  const on = !snap || snap.online !== false;
  const when = safe(() => fmt.rel(snap && snap.syncedAt), '');
  const txt = on ? (when ? 'synced ' + when : 'syncing…') : ('offline · last synced ' + (when || 'never'));
  return '<div class="sync"><i data-s="' + (on ? 'live' : 'off') + '"></i>' + esc(txt) + '</div>';
}
/**
 * Данные, которые сами себе противоречат и БЛОКИРУЮТ действие с телефона.
 * Не выдумываем «качество данных вообще» — только то, из-за чего оператор
 * упирается в стену и не понимает почему.
 *
 * Историй за такими юнитами могут быть совершенно разные (проверено на проде
 * 2026-08-16: у одного аренда живая и оплаченная, у другого закончилась, у
 * третьего договор на пять лет без единого платежа, у четвёртого отскочили
 * чеки). Поэтому приложение НЕ чинит их само и ничего не удаляет — показывает
 * и отдаёт решение человеку.
 */
function dataIssues(){
  const out = [];
  const list = buildings();
  for (const b of list){
    for (const f of ((b && b.floors) || [])){
      for (const u of ((f && f.units) || [])){
        if (!u || u.deletedAt || u.archivedAt || u.rentable === false) continue;
        if (u.type && u.type !== 'office') continue;
        // Финансовые тени пропускаем — как это делает денежная модель. У членов
        // мульти-сьютовой лизы своей почты нет по устройству (она на head'е), и
        // без этого фильтра карточка ругалась бы на 8 исправных сьютов из 9.
        try { if (money.isFinanceShadow(u, snap)) continue; } catch (e) { /* деньги молчат */ }
        const who = String(u.tenant || u.company || '').trim();
        const ref = { buildingId: b.id, floorId: f && f.id, unitId: u.id };
        if (u.status === 'vacant' && who){
          out.push({ ref, suite: u.id, bld: b.name || b.id,
            title: 'Marked vacant, but still carries ' + who,
            why: 'A new lease cannot be written here — the occupancy check counts it as taken.' });
        } else if ((u.status === 'occupied' || who) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(u.email || '').trim())){
          out.push({ ref, suite: u.id, bld: b.name || b.id,
            title: 'Occupied, but no email on file',
            why: 'Stripe emails the invoice, so nothing can be billed from the phone.' });
        }
      }
    }
  }
  return out;
}
function issuesCard(){
  const items = dataIssues();
  if (!items.length) return '';
  const shown = items.slice(0, 8);
  return '<div class="card"><div class="card-h"><h3>Needs a human</h3>'
    + '<span class="ch-sub">' + items.length + '</span></div>'
    + shown.map(x => '<button class="arow" data-act="unit" data-b="' + esc(x.ref.buildingId) + '"'
      + ' data-floor="' + esc(x.ref.floorId || '') + '" data-id="' + esc(x.ref.unitId) + '">'
      + '<span class="astat" data-s="due">' + I.alert + '</span>'
      + '<span class="amain"><span class="aname">' + esc('Suite ' + x.suite + ' · ' + x.title) + '</span>'
      + '<span class="await">' + esc(x.bld + ' — ' + x.why) + '</span></span></button>').join('')
    + (items.length > shown.length
      ? '<div class="hintline" style="padding:8px 14px">and ' + (items.length - shown.length) + ' more</div>' : '')
    + '<div class="hintline" style="padding:0 14px 12px">Nothing is changed automatically — these need your '
    + 'judgement, and fixing them lives in the full version.</div></div>';
}

const more = {
  render(){
    const u = (snap && snap.user) || {};
    let h = '<div class="topbar"><div class="tb-row"><div><div class="tb-title sm">More</div>' + syncLine() + '</div></div></div>';
    h += '<div class="card">'
      + moreRow('job', 'lease', I.doc, 'Send a lease', 'One unit, sent for signature')
      + moreRow('job', 'invoice', I.money, 'Send an invoice', 'Rent, deposit, late fee or custom')
      + moreRow('switcher', '', I.grid, 'Building', scopeName() + (buildings().length > 1
          ? ' · tap to switch (' + buildings().length + ' buildings)' : ''))
      + moreRow('refresh', '', I.sync, 'Refresh now', 'Pull the latest payments and buildings')
      + moreRow('openfull', '', I.ext, 'Open the full version', 'Floor plans, analytics, settings — best on a computer')
      + '</div>';
    h += '<div class="card"><div class="card-h"><h3>Account</h3></div>'
      + '<div style="padding:0 14px 10px;font-size:13px;color:var(--ink-2)">'
      + esc(u.email || u.uid || 'signed in') + ' · ' + esc((snap && snap.role) || 'member')
      + ' · workspace ' + esc((snap && snap.workspace) || 'default') + '</div>'
      + moreRow('signout', '', I.user, 'Sign out', 'Google will be asked again on this phone') + '</div>';
    h += issuesCard();
    h += '<div class="card"><div class="card-h"><h3>No bulk actions here</h3></div>'
      + '<div style="padding:0 14px 14px;font-size:13px;color:var(--ink-2);line-height:1.5">'
      + 'Reminders and invoices go out one tenant at a time, on purpose. Anything that sends in batches stays in the full version.</div></div>';
    return h;
  },
  handle(){ return false; },
};

const TABS = { home, payments, plan, more };
const SHEETS = { unit, lease, invoice, switcher };

/* ---------------- render ---------------- */
function errCard(where, e){
  console.error('[m] render failed:', where, e);
  return '<div class="errcard"><h4>This part could not be drawn</h4>'
    + '<p>' + esc(where) + ' — ' + esc(errText(e)) + '</p>'
    + '<button data-act="retry">Try again</button><button data-act="reboot">Reload the app</button></div>';
}
function renderSafe(mod, where){
  try {
    if (!mod || typeof mod.render !== 'function') throw new Error('module has no render()');
    const html = mod.render(ctx());
    if (typeof html !== 'string') throw new Error('render() returned ' + typeof html);
    return html;
  } catch (e){ return errCard(where, e); }
}
function grabFocus(){
  const el = document.activeElement;
  if (!el || !el.id || !scrollEl.contains(el)) return null;
  return { id: el.id, s: el.selectionStart, e: el.selectionEnd };
}
function restoreFocus(f){
  if (!f) return;
  const el = document.getElementById(f.id);
  if (!el) return;
  try { el.focus({ preventScroll: true }); if (f.s != null && el.setSelectionRange) el.setSelectionRange(f.s, f.e); } catch {}
}
function onQueryInput(ev){ S.q = ev.target.value; render(true); }
function wireInputs(){
  scrollEl.querySelectorAll('#q, [data-q]').forEach(el => el.addEventListener('input', onQueryInput));
}
function renderTabs(){
  const tabs = [['home', 'Home', I.home], ['payments', 'Payments', I.money],
    ['plan', 'Plan', I.plan], ['more', 'More', I.grid]];
  tabbarEl.innerHTML = tabs.map(t =>
    '<button class="tab" type="button" data-act="tab" data-k="' + t[0] + '" aria-selected="' + (S.tab === t[0]) + '">'
    + t[2] + '<span>' + t[1] + '</span></button>').join('');
}
/* Постоянной панели переключения зданий больше нет: оператор работает в одном
   здании и меняет его редко, а панель занимала полосу над таб-баром на каждом
   экране. Смена живёт в меню More; какое здание открыто — видно в шапке Home
   и Payments. Выбор запоминается на устройстве (writeScope), приложение
   открывается в нём же. */
function render(keep){
  if (!booted) return;
  const y = scrollEl.scrollTop, f = grabFocus();
  S.ym = todayYm();
  const ws = snap && snap.workspace;
  let html = (ws && String(ws) !== 'default')
    ? '<div class="wsbanner">' + esc(ws) + ' workspace — not production</div>' : '';
  html += renderSafe(TABS[S.tab] || TABS.home, 'tab:' + S.tab);
  scrollEl.innerHTML = html;
  renderTabs();
  scrollEl.scrollTop = keep ? y : 0;
  wireInputs(); restoreFocus(f);
}
function scheduleRender(){
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; render(true); });
}

/* ---------------- sheets ----------------
   Модуль возвращает ОДНУ строку HTML. Если внутри есть [data-foot] или
   .sheet-foot — оболочка поднимает его содержимое в закреплённый футер. */
function hoistFoot(){
  // Совместимость: если модуль вместо foot() положил низ внутрь body —
  // поднимаем его. Уже отрендеренный foot() не затираем.
  const node = sheetBody.querySelector('[data-foot], .sheet-foot');
  if (node){ sheetFoot.innerHTML = node.innerHTML; node.remove(); }
  sheetFoot.style.display = sheetFoot.innerHTML.trim() ? 'flex' : 'none';
}
function openSheet(name, payload){
  const same = (S.sheet === name);
  if (payload !== undefined) S.payload = payload;
  else if (!same) S.payload = null;
  S.sheet = name;
  const y = same ? sheetBody.scrollTop : 0;
  const mod = SHEETS[name];
  sheetBody.innerHTML = mod
    ? renderSafe(mod, 'sheet:' + name)
    : errCard('sheet:' + name, new Error('unknown sheet'));
  // Модуль может отдавать закреплённый низ листа через foot(ctx) — там живут
  // ВСЕ кнопки отправки. Без этого вызова листы договора и счёта нерабочие.
  paintFoot(name);
  sheetEl.setAttribute('data-on', '1');
  scrimEl.setAttribute('data-on', '1');
  sheetBody.scrollTop = y;
}
function hideSheet(){
  sheetEl.setAttribute('data-on', '0');
  scrimEl.setAttribute('data-on', '0');
  S.sheet = null; S.payload = null;
}
function closeSheet(){ hideSheet(); render(true); }

/* ---------------- toast ---------------- */
let toastT = 0;
function toast(msg){
  toastEl.innerHTML = I.check + '<span>' + esc(msg || 'Done') + '</span>';
  toastEl.setAttribute('data-on', '1');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.setAttribute('data-on', '0'), 2600);
}

/* ---------------- actions ---------------- */
async function doRefresh(quiet){
  try {
    await refresh();
    if (!quiet) toast('Up to date');
  } catch (e){
    console.warn('[m] refresh failed', e);
    if (!quiet) toast('Could not refresh — ' + errText(e));
  }
}
/* Право отправлять договор и счёт. Сервер всё равно последняя инстанция
   (_dsAssertCanSendLeases / requireEditor), но узнавать об отказе ПОСЛЕ того,
   как заполнил весь мастер и нажал Send, — худший момент из возможных.
   Незнакомую или ещё не подъехавшую роль не блокируем: иначе админ на
   холодном старте останется без кнопок. Ровно та же логика, что в unit.js. */
const KNOWN_ROLES = { admin: 1, manager: 1, mapeditor: 1, teamviewer: 1, viewer: 1 };
const EDITOR_ROLES = { admin: 1, manager: 1 };
function canSend(){
  const r = snap && snap.role;
  if (!r || !KNOWN_ROLES[r]) return true;
  return !!EDITOR_ROLES[r];
}

function setScope(k){
  if (!k) return;
  if (k !== 'all' && !buildings().some(b => b && String(b.id) === String(k))) return;
  S.scope = String(k); S.floor = 'all'; S.q = ''; S.searchAll = false;
  // Зеркало для модулей, читающих S.buildingId (payments, unit). ЕДИНСТВЕННОЕ
  // место, где меняется область видимости: два писателя уже приводили к тому,
  // что переключатель менял здание, а вкладка Payments оставалась в прежнем.
  S.buildingId = (S.scope === 'all') ? null : S.scope;
  writeScope(S.scope);
  hideSheet(); render();
  toast(S.scope === 'all' ? 'Showing all buildings' : 'Now in ' + scopeName());
}
async function doSignOut(){
  if (!confirm('Sign out of SuitesForAll on this phone?')) return;
  try { if (typeof data.signOut === 'function') await data.signOut(); } catch (e){ console.warn('[m] signOut', e); }
  location.reload();
}
function builtin(a, el){
  const d = el.dataset || {};
  switch (a){
    case 'tab': if (S.sheet) hideSheet(); S.tab = d.k || 'home'; render(); break;
    case 'switcher': openSheet('switcher', null); break;
    case 'setscope': setScope(d.k); break;
    case 'floor': S.floor = d.f || 'all'; render(true); break;
    case 'filter': S.filter = d.k || 'all'; render(true); break;
    case 'searchall': S.searchAll = !S.searchAll; render(true); break;
    case 'clearq': S.q = ''; render(true); break;
    case 'job': if (d.k === 'payments'){ S.tab = 'payments'; render(); } else openSheet(d.k, null); break;
    case 'unit': openSheet('unit', { unitId: d.id || d.unit, buildingId: d.b || d.building, floorId: d.floor }); break;
    case 'close': closeSheet(); break;
    case 'refresh': toast('Refreshing…'); doRefresh(false); break;
    case 'signout': doSignOut(); break;
    // ?desktop=1 — метка «оператор просил именно полную версию». Без неё
    // редирект в floor-map-editor.html вернёт нас сюда же: петля.
    case 'openfull': location.href = '/?desktop=1'; break;
    case 'retry': if (S.sheet) openSheet(S.sheet); else render(true); break;
    case 'reboot': location.reload(); break;
    case 'toast': toast(d.msg || 'Done'); break;
    default: break;
  }
}
// сначала спрашиваем активный модуль (шторка, затем вкладка), потом встроенные
function onClick(ev){
  const el = ev.target.closest && ev.target.closest('[data-act]');
  if (!el || !appEl.contains(el)) return;
  const a = el.getAttribute('data-act');
  const mods = [];
  if (S.sheet && SHEETS[S.sheet]) mods.push([SHEETS[S.sheet], 'sheet:' + S.sheet]);
  const tm = TABS[S.tab];
  if (tm && !mods.some(m => m[0] === tm)) mods.push([tm, 'tab:' + S.tab]);
  for (const [m, where] of mods){
    try {
      if (m && typeof m.handle === 'function' && m.handle(a, el, ctx()) === true){
        // КРИТИЧНО: модули меняют своё состояние и рассчитывают, что оболочка
        // перерисует экран. Без этого шаг мастера/подтверждение дубля счёта
        // не видно — оператор жмёт второй раз и уходит второй Stripe-счёт.
        if (S.sheet) openSheet(S.sheet); else render(true);
        return;
      }
    } catch (e){
      console.error('[m] handle failed:', where, a, e);
      toast('That did not work — ' + errText(e));
      return;
    }
  }
  builtin(a, el);
}

/* ---------------- gate / boot ---------------- */
function gateState(state, msg){
  gateEl.setAttribute('data-on', '1');
  gateEl.setAttribute('data-state', state);
  if (msg) gateMsg.textContent = msg;
  const lbl = gateBtn.querySelector('span');
  if (lbl) lbl.textContent = (state === 'error') ? 'Try again' : 'Continue with Google';
}
function friendly(e){
  const m = errText(e);
  if (/popup[-_ ]?blocked/i.test(m)) return 'The browser blocked the Google popup. Allow popups for this site, then try again.';
  if (/popup[-_ ]?closed|cancelled/i.test(m)) return 'Sign-in was cancelled.';
  if (/not-invited|permission-denied|create-denied|archived|not a workspace member/i.test(m)) return 'This account has no access to the workspace. Ask an admin to invite it, then try again.';
  if (/network|offline|unavailable|Failed to fetch|Load failed/i.test(m)) return 'Cannot reach the sign-in service. Check the connection and try again.';
  if (/not configured|no config/i.test(m)) return 'This page must be opened from the app address, not a local file.';
  return m;
}
// снимок отдаём только когда членство подтверждено — не даём «мигнуть» данными
function afterAuth(){
  snap = safe(getSnapshot, null);
  if (!snap || !snap.user) return false;
  ensureScope();
  try { subscribe(s => { snap = (s && typeof s === 'object' && 'buildings' in s) ? s : (safe(getSnapshot, null) || snap); ensureScope(); scheduleRender(); }); }
  catch (e){ console.error('[m] subscribe failed', e); }
  booted = true;
  window.__sfaMBooted = true;
  try { sessionStorage.removeItem('sfa_m_boot_reloads'); } catch {}   // бюджет перезагрузок в m.html
  gateEl.setAttribute('data-on', '0');
  render();
  doRefresh(true);            // холодный старт: кэш уже на экране, тихо обновляем
  return true;
}
async function onGateBtn(){
  gateState('loading', 'Opening Google…');
  try {
    const signIn = data.signIn || data.signInWithGoogle || data.login;
    if (typeof signIn === 'function') await signIn();
    else await initApp();
    if (!afterAuth()) gateState('error', 'Signed in, but this account has no access to the workspace.');
  } catch (e){
    // Safari срезал окно входа, а redirect отсюда невозможен (разные origin у
    // приложения и домена входа — именно это давало ошибку Google 400).
    // Уводим на домен входа с ?signin=1: там вход продолжится сам.
    if (e && e.code === 'sfa/needs-auth-domain' && e.authUrl){
      gateState('loading', 'Taking you to the sign-in address…');
      location.href = e.authUrl;
      return;
    }
    gateState('error', friendly(e));
  }
}
async function onGateAlt(){
  try { if (typeof data.signOut === 'function') await data.signOut(); } catch {}
  location.reload();
}
async function boot(){
  gateBtn.addEventListener('click', onGateBtn);
  gateAlt.addEventListener('click', onGateAlt);
  appEl.addEventListener('click', onClick);
  scrimEl.addEventListener('click', () => closeSheet());
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.sheet) closeSheet(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && booted) doRefresh(true); });

  const stuck = setTimeout(() => {
    if (!booted) gateState('signin', 'This is taking longer than usual. Sign in again, or reload the page.');
  }, BOOT_STUCK_MS);
  try {
    const res = await initApp();
    clearTimeout(stuck);
    if (res && typeof res === 'object' && (res.rejected || res.ok === false || res.error)){
      gateState('error', friendly((res.rejected && (res.rejected.message || res.rejected.reason)) || res.reason || res.error || 'This account has no access to the workspace.'));
      return;
    }
    if (afterAuth()) return;
    // Пришли с ?signin=1 — значит на прошлом домене Safari срезал окно входа и
    // нас сюда увели специально. Здесь origin совпадает с доменом входа, поэтому
    // redirect работает без жеста: продолжаем сами, не заставляя жать второй раз.
    if (typeof data.resumeSignInIfAsked === 'function'){
      gateState('loading', 'Opening Google…');
      let resumed = false;
      try { resumed = await data.resumeSignInIfAsked(); } catch (e){ resumed = false; }
      if (resumed) return;                      // страница уже уходит на Google
    }
    gateState('signin', 'Sign in with the Google account that has access to this workspace.');
  } catch (e){
    clearTimeout(stuck);
    const m = friendly(e);
    gateState(/no access|cancelled|blocked/i.test(m) ? 'error' : 'signin', m);
  }
}

boot();
