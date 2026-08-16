/* m/ui/switcher.js — шит выбора здания.
   Контракт: render(ctx) -> HTML-строка, handle(act, el, ctx) -> true|false.
   Оператор живёт в ОДНОМ здании: переключение редкое, поэтому список
   должен отвечать на «где я сейчас» и «где горит» без лишних касаний. */


const I = {
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
};

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const num = n => (Number.isFinite(+n) ? +n : 0);

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

function todayYm() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
const ymOf = ctx => (/^\d{4}-\d{2}$/.test(ctx && ctx.S && ctx.S.ym) ? ctx.S.ym : todayYm());

const floorsOf = b => (Array.isArray(b && b.floors) ? b.floors
  : (b && b.doc && Array.isArray(b.doc.floors) ? b.doc.floors : []));

/* Архивные юниты остаются в документе здания с archivedAt — в счётчик
   «N units» они попадать не должны. */
function unitCount(b) {
  let n = 0;
  for (const f of floorsOf(b)) {
    const units = Array.isArray(f && f.units) ? f.units : [];
    for (const u of units) if (u && !u.archivedAt) n++;
  }
  return n;
}

/* Код-бейдж: b.code, иначе первые буквы первого ЗНАЧАЩЕГО слова имени —
   «4355 Central Ave» -> CEN, «Pinnellas Park» -> PIN, «New Tampa» -> TAM.
   Служебные слова пропускаем: бейдж «NEW» читается как метка «новое»,
   а не как код здания. */
const CODE_SKIP = new Set(['new', 'the', 'old']);
function codeFor(b) {
  const raw = (b && (b.code || b.shortCode || b.abbr)) || '';
  if (raw) return String(raw).toUpperCase().slice(0, 4);
  const name = String((b && (b.name || b.id)) || '').trim();
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const alpha = words.filter(w => /^[A-Za-z]/.test(w));
  const meaningful = alpha.filter(w => !CODE_SKIP.has(w.toLowerCase()));
  const pick = meaningful[0] || alpha[0] || words[0] || '?';
  return pick.toUpperCase().slice(0, 3);
}

function normStats(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const src = (s.n && typeof s.n === 'object') ? s.n : (s.counts && typeof s.counts === 'object' ? s.counts : {});
  const n = {
    paid: num(src.paid), invoiced: num(src.invoiced), due: num(src.due), overdue: num(src.overdue),
    idle: num(src.idle), vacant: num(src.vacant), reserved: num(src.reserved),
  };
  const out = {
    collected: num(s.collected),
    awaiting: num(s.awaiting != null ? s.awaiting : s.pending),
    overdue: num(s.overdue),
    n,
  };
  out.billed = num(s.billed) > 0 ? num(s.billed) : (out.collected + out.awaiting + out.overdue);
  out.pct = Number.isFinite(+s.pct)
    ? Math.max(0, Math.min(100, Math.round(+s.pct)))
    : (out.billed > 0 ? Math.round(out.collected / out.billed * 100) : 0);
  return out;
}

function statsOf(ctx, b, ym) {
  try { return normStats(ctx.money.buildingStats(b, ym, ctx.snap)); } catch (err) { return normStats(null); }
}

const pctColor = p => (p >= 80 ? 'var(--ok)' : p >= 55 ? 'var(--warn)' : 'var(--bad)');

function bar(st) {
  const w = v => (st.billed > 0 ? Math.max(v > 0 ? 3 : 0, v / st.billed * 100) : 0);
  return '<span class="brow-bar">'
    + '<span style="width:' + w(st.collected) + '%;background:var(--ok)"></span>'
    + '<span style="width:' + w(st.awaiting) + '%;background:var(--info)"></span>'
    + '<span style="width:' + w(st.overdue) + '%;background:var(--bad)"></span></span>';
}

function buildingRow(b, st, active) {
  // Здания у нас названы адресом («4355 Central Ave»), поэтому подпись-адрес
  // повторяла заголовок дословно. Дублирующийся адрес не показываем.
  const nm = String(b.name || '').trim().toLowerCase();
  const addr = String(b.address || b.addr || b.id || '').trim();
  const sub = [esc(addr.toLowerCase() === nm ? '' : addr), plural(unitCount(b), 'unit', 'units')]
    .filter(Boolean).join(' · ');
  return '<button class="brow" data-act="setscope" data-k="' + esc(b.id) + '"'
    + (active ? ' aria-pressed="true"' : '') + '>'
    + '<span class="brow-code">' + esc(codeFor(b)) + '</span>'
    + '<span class="brow-main"><span class="brow-name">' + esc(b.name || b.id) + '</span>'
    + '<span class="brow-sub">' + sub + '</span>' + bar(st) + '</span>'
    + '<span class="brow-right"><span class="brow-pct" style="color:' + pctColor(st.pct) + '">' + st.pct + '%</span>'
    + (st.n.overdue ? '<span class="brow-od">' + st.n.overdue + ' late</span>' : '') + '</span>'
    + (active ? '<span class="brow-code" style="background:var(--accent);color:var(--on-accent)">NOW</span>' : '')
    + '</button>';
}

export function render(ctx) {
  const ym = ymOf(ctx);
  const list = Array.isArray(ctx.snap && ctx.snap.buildings) ? ctx.snap.buildings.filter(Boolean) : [];
  const S = ctx.S || {};
  const scope = String(S.scope || S.buildingId || 'all');

  let h = '<div class="sheet-h"><div><h3>Which building?</h3>'
    + '<p>The app stays here until you change it</p></div>'
    + '<button class="x-btn" data-act="close" aria-label="Close">✕</button></div>';

  if (!list.length) {
    return h + '<div class="empty">No buildings in this workspace yet.</div>';
  }

  const total = { collected: 0, awaiting: 0, overdue: 0, late: 0, units: 0 };
  h += list.map(b => {
    const st = statsOf(ctx, b, ym);
    total.collected += st.collected; total.awaiting += st.awaiting; total.overdue += st.overdue;
    total.late += st.n.overdue; total.units += unitCount(b);
    return buildingRow(b, st, scope === String(b.id));
  }).join('');

  const billed = total.collected + total.awaiting + total.overdue;
  const pct = billed > 0 ? Math.round(total.collected / billed * 100) : 0;
  h += '<button class="act-row" data-act="setscope" data-k="all" style="margin-top:14px"'
    + (scope === 'all' ? ' aria-pressed="true"' : '') + '>' + I.grid
    + '<span><span class="t">All buildings together'
    + (scope === 'all' ? ' · now' : '') + '</span>'
    + '<span class="s">' + plural(total.units, 'unit', 'units') + ' · ' + pct + '% collected · '
    + total.late + ' late</span>'
    + '</span></button>';
  return h;
}

export function handle(act, el, ctx) {
  if (act !== 'setscope') return false;
  const key = el.getAttribute('data-k') || 'all';
  const S = ctx.S || {};
  const list = Array.isArray(ctx.snap && ctx.snap.buildings) ? ctx.snap.buildings : [];
  const b = key === 'all' ? null : list.find(x => x && String(x.id) === key);
  const name = b ? (b.name || b.id) : 'All buildings';

  // Состояние области видимости принадлежит оболочке: она же его и запоминает
  // на устройстве. Своя копия здесь писалась в ДРУГОЙ ключ localStorage, из-за
  // чего выбранное здание не переживало перезапуск приложения.
  if (typeof ctx.setScope === 'function') {
    ctx.setScope(key);
    return true;                    // оболочка уже перерисовала и показала тост
  }
  S.scope = key;
  S.buildingId = (key === 'all') ? null : key;
  // Смена здания обнуляет всё, что относилось к прежнему: этаж, поиск и
  // расширение поиска на другие здания. Иначе поиск молча живёт в старом.
  if ('floor' in S) S.floor = 'all';
  if ('q' in S) S.q = '';
  if ('searchAll' in S) S.searchAll = false;

  ctx.closeSheet();
  // Перерисовка: если shell уже рисует по true из handle — это но-оп.
  try { if (S.tab && typeof ctx.go === 'function') ctx.go(S.tab); } catch (err) { /* shell сам решит */ }
  ctx.toast(key === 'all' ? 'Showing all buildings' : 'Now in ' + name);
  return true;
}
