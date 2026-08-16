/* ============================================================================
   m/ui/plan.js — план этажа на телефоне.

   Геометрия уже лежит в снимке: data.js разворачивает pointsFlat → points
   (MONO:34959), а большинство юнитов в проде — прямоугольники x/y/w/h.
   Рисуем ОБА вида: полигон, если он есть, иначе прямоугольник.

   ИНВАРИАНТЫ:
   • Цвет юнита — только из ctx.money.uiStatus. Собственных денежных суждений
     здесь нет: план обязан совпадать с экраном Payments и с десктопом.
   • Общие зоны (лестницы, лифты, санузлы, коридоры) не кликабельны и не
     красятся статусом — они ничего не должны.
   • viewBox считаем от контура этажа, а если его нет — от границ юнитов.
     Пустой этаж не должен давать viewBox с нулевой шириной (деление на ноль).
   • Тап открывает ТОТ ЖЕ лист юнита, что и остальные экраны, — одно место,
     где показываются деньги и действия.
   Вёрстка — только классы прототипа (m.html) + inline-стили.
   ========================================================================== */

const I = {
  zoom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/><line x1="11" y1="8.5" x2="11" y2="13.5"/><line x1="8.5" y1="11" x2="13.5" y2="11"/></svg>',
  zoomOut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/><line x1="8.5" y1="11" x2="13.5" y2="11"/></svg>',
};

/* Палитра плана живёт CSS-переменными --plan-* в m.html: те же шаги, что у
   полосы этажей на Payments, и тёмная тема переключается вместе со всем
   остальным. В SVG подставляем var(--plan-<status>) — своих цветов здесь нет. */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function todayYm() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
/* deletedAt — это поле, которым архивирует ДЕСКТОП (floor-map-editor.html:30443).
   Мобильный проверял archivedAt, которого в базе нет ни у одного юнита,
   поэтому показывал и считал удалённые (в проде их 2, напр. сьют 111).
   Проверяем ОБА поля: archivedAt оставляем на случай старых записей. */
const isArchived = (u) => !!(u && (u.deletedAt || u.archivedAt));
const isRentable = (u) => !!u && !isArchived(u) && u.rentable !== false && (!u.type || u.type === 'office');

/* Словарь типов 1:1 с десктопом (TYPE_LABELS, MONO:27027). Там все общие зоны
   залиты ОДНИМ серым (COMMON_GREY #EBE8E2), а различаются подписью внутри
   фигуры — повторяем это, а не выдумываем свою палитру типов.
   Свои типы воркспейса (settings.customUnitTypes) подхватываем из настроек. */
const TYPE_LABELS = {
  kitchen: 'Kitchen', storage: 'Storage', toilet: 'Restroom', conf: 'Conference',
  mechanical: 'Mechanical', stairs: 'Stairs', elevator: 'Elevator', atrium: 'Atrium',
  hallway: 'Hallway', restroom: 'Restroom', conference: 'Conference',
};
function typeLabel(u, snap) {
  const k = String((u && u.type) || '').trim();
  if (!k || k === 'office') return '';
  const custom = (snap && snap.settings && snap.settings.customUnitTypes) || [];
  if (Array.isArray(custom)) {
    const hit = custom.find(t => t && t.key === k && t.label);
    if (hit) return String(hit.label);
  }
  return TYPE_LABELS[k] || (k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' '));
}

/**
 * Статус ЗАЛИВКИ + отдельный флаг просрочки (money.mapStatus).
 * Цвет как на десктопе: «счёт выставлен» синим бьёт просрочку. Но сам факт
 * просрочки не теряем — по нему рисуем пометку поверх заливки, иначе синий
 * маскировал бы долг (болезнь десктопной карты).
 */
function stOf(ctx, u, ym) {
  try {
    if (typeof ctx.money.mapStatus === 'function') {
      const r = ctx.money.mapStatus(u, ym, ctx.snap);
      if (r && typeof r.status === 'string') return r;
    }
    const s = ctx.money.uiStatus(u, ym, ctx.snap);
    return { status: typeof s === 'string' ? s : 'vacant', overdue: s === 'overdue' };
  } catch (e) { return { status: 'vacant', overdue: false }; }
}

/** Прямоугольник или полигон — приводим к одному описанию для отрисовки. */
function shapeOf(o) {
  if (o && Array.isArray(o.points) && o.points.length >= 3) {
    return { kind: 'poly', pts: o.points.filter(p => Array.isArray(p) && p.length >= 2) };
  }
  const x = +o.x, y = +o.y, w = +o.w, h = +o.h;
  if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) return { kind: 'rect', x, y, w, h };
  return null;
}
function boundsOf(shape, acc) {
  if (!shape) return acc;
  if (shape.kind === 'rect') {
    acc.x0 = Math.min(acc.x0, shape.x); acc.y0 = Math.min(acc.y0, shape.y);
    acc.x1 = Math.max(acc.x1, shape.x + shape.w); acc.y1 = Math.max(acc.y1, shape.y + shape.h);
  } else {
    for (const [px, py] of shape.pts) {
      acc.x0 = Math.min(acc.x0, px); acc.y0 = Math.min(acc.y0, py);
      acc.x1 = Math.max(acc.x1, px); acc.y1 = Math.max(acc.y1, py);
    }
  }
  return acc;
}
/** Площадь фигуры — для порядка отрисовки: мелкое рисуем ПОВЕРХ крупного. */
function areaOf(s) {
  if (!s) return 0;
  if (s.kind === 'rect') return s.w * s.h;
  let a = 0;
  for (let i = 0; i < s.pts.length; i++) {
    const [x1, y1] = s.pts[i], [x2, y2] = s.pts[(i + 1) % s.pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}
const centerOf = (s) => s.kind === 'rect'
  ? [s.x + s.w / 2, s.y + s.h / 2]
  : s.pts.reduce((a, p) => [a[0] + p[0] / s.pts.length, a[1] + p[1] / s.pts.length], [0, 0]);
const sizeOf = (s) => {
  if (s.kind === 'rect') return [s.w, s.h];
  const b = boundsOf(s, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  return [b.x1 - b.x0, b.y1 - b.y0];
};

/* ---------- выбор этажа ---------- */
function floorsOf(b) { return Array.isArray(b && b.floors) ? b.floors : []; }
function floorName(f, i) {
  const n = String((f && f.name) || '').trim();
  if (n) return /^\d{1,3}[A-Za-z]?$/.test(n) ? 'Floor ' + n : n;
  return 'Floor ' + ((f && f.level != null) ? f.level : i + 1);
}
function currentFloor(ctx, b) {
  const S = ctx.S || {};
  const list = floorsOf(b);
  if (!list.length) return null;
  return list.find(f => String(f.id) === String(S.planFloor)) || list[0];
}

/** Слово для скринридера: то же различие, что в легенде. */
function ariaWord(st, overdue) {
  if (st === 'invoiced') return overdue ? 'invoice sent, payment past due' : 'invoice sent';
  if (st === 'overdue') return 'not billed, payment past due';
  return st;
}

/* ---------- сам план ---------- */
function planSvg(ctx, b, f, ym, zoom) {
  const units = Array.isArray(f && f.units) ? f.units : [];
  const outline = f && f.outline ? shapeOf(f.outline) : null;

  let bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  if (outline) bb = boundsOf(outline, bb);
  const drawn = [];
  for (const u of units) {
    const s = shapeOf(u);
    if (!s) continue;
    drawn.push({ u, s });
    if (!outline) bb = boundsOf(s, bb);
  }
  if (!drawn.length || !Number.isFinite(bb.x0) || !(bb.x1 > bb.x0) || !(bb.y1 > bb.y0)) {
    return '<div class="empty">This floor has no drawn plan yet — open the full version to draw it.</div>';
  }

  const pad = Math.max((bb.x1 - bb.x0), (bb.y1 - bb.y0)) * 0.02;
  const vx = bb.x0 - pad, vy = bb.y0 - pad;
  const vw = (bb.x1 - bb.x0) + pad * 2, vh = (bb.y1 - bb.y0) + pad * 2;

  // Порог читаемости считаем В ЭКРАННЫХ пикселях: план ужимается по ширине,
  // поэтому единицы viewBox сами по себе ничего не говорят. В увеличенном виде
  // SVG шире (см. .plan-wrap.zoom .plan-svg), и подписей должно стать БОЛЬШЕ —
  // иначе кнопка «Zoom in» не даёт того, ради чего её жмут.
  const renderPx = zoom ? 360 * 2.2 : 360;
  const scale = renderPx / vw;
  const MIN_PX = 7;
  // Потолок обязателен: у большого сьюта (2-й этаж, 205 площадью 444k) кегль,
  // посчитанный от его габаритов, вырастал на пол-экрана и накрывал соседей.
  // На десктопе номер крупного сьюта такого же размера, как у мелкого.
  const MAX_PX = 13;

  let body = '';
  if (outline) {
    body += outline.kind === 'rect'
      ? '<rect x="' + outline.x + '" y="' + outline.y + '" width="' + outline.w + '" height="' + outline.h
        + '" fill="var(--plan-shell)" stroke="var(--plan-line)" stroke-width="' + (vw / 380) + '"/>'
      : '<polygon points="' + outline.pts.map(p => p[0] + ',' + p[1]).join(' ')
        + '" fill="var(--plan-shell)" stroke="var(--plan-line)" stroke-width="' + (vw / 380) + '"/>';
  }

  // ТРИ ПРОХОДА, порядок важен:
  //   1) общие зоны (коридоры, лестницы, санузлы) — они в данных нередко
  //      перекрывают соседние сьюты по координатам;
  //   2) сдаваемые юниты — поверх, иначе коридор закрывает сьют (видели на 401);
  //   3) подписи — поверх всего, иначе номер прячется под соседней фигурой.
  const labels = [];
  const overlays = [];   // пометки просрочки: поверх заливки, под подписями
  // Внутри каждой группы — от БОЛЬШИХ к маленьким. В данных крупный сьют и его
  // под-комнаты пересекаются по координатам (2-й этаж: 205 площадью 444k
  // накрывает 20510/20511/20512, а 204 и 207 — 201 и 2041). Без сортировки
  // побеждал порядок массива, и большой юнит закрывал мелкие целиком.
  const ordered = drawn.slice().sort((a, bq) => {
    const ra = isRentable(a.u) ? 1 : 0, rb = isRentable(bq.u) ? 1 : 0;
    if (ra !== rb) return ra - rb;                 // общие зоны — под всеми
    return areaOf(bq.s) - areaOf(a.s);             // большие ниже, мелкие поверх
  });
  for (const { u, s } of ordered) {
    const rentable = isRentable(u);
    const m = rentable ? stOf(ctx, u, ym) : { status: 'common', overdue: false };
    const st = m.status;
    const fill = rentable ? 'var(--plan-' + st + ')' : 'var(--plan-common)';
    const attrs = ' fill="' + fill + '" stroke="var(--plan-line)" stroke-width="' + (vw / 520) + '"'
      + (rentable
        ? ' data-act="unit" data-b="' + esc(b.id) + '" data-floor="' + esc(f.id || '') + '" data-id="' + esc(u.id) + '"'
          + ' style="cursor:pointer" role="button" tabindex="0"'
          + ' aria-label="' + esc('Suite ' + u.id + ' — ' + ariaWord(st, m.overdue)) + '"'
        : ' aria-hidden="true"');
    body += s.kind === 'rect'
      ? '<rect x="' + s.x + '" y="' + s.y + '" width="' + s.w + '" height="' + s.h + '" rx="' + (vw / 900) + '"' + attrs + '/>'
      : '<polygon points="' + s.pts.map(p => p[0] + ',' + p[1]).join(' ') + '"' + attrs + '/>';

    const [cx, cy] = centerOf(s);
    const [w, h] = sizeOf(s);
    // Сдаваемому — номер сьюта, общей зоне — тип, как на десктопе.
    const txt = rentable ? String(u.id) : typeLabel(u, ctx.snap).toUpperCase();
    // Пометка просрочки поверх синей заливки: заливка совпадает с десктопом,
    // но «не заплатили» не исчезает. Рисуем ВТОРЫМ контуром внутрь фигуры —
    // он не мешает тапу (pointer-events выключены) и виден на любом фоне.
    if (m.overdue && st !== 'overdue') {
      const inset = vw / 300;
      overlays.push(s.kind === 'rect'
        ? '<rect x="' + (s.x + inset) + '" y="' + (s.y + inset) + '" width="' + Math.max(0, s.w - inset * 2)
          + '" height="' + Math.max(0, s.h - inset * 2) + '" fill="none" stroke="var(--plan-overdue-mark)"'
          + ' stroke-width="' + (vw / 300) + '" stroke-dasharray="' + (vw / 90) + ' ' + (vw / 180) + '"'
          + ' pointer-events="none"/>'
        : '<polygon points="' + s.pts.map(p => p[0] + ',' + p[1]).join(' ') + '" fill="none"'
          + ' stroke="var(--plan-overdue-mark)" stroke-width="' + (vw / 300) + '"'
          + ' stroke-dasharray="' + (vw / 90) + ' ' + (vw / 180) + '" pointer-events="none"/>');
    }
    if (!txt) continue;
    // Кегль подбираем так, чтобы номер ПОМЕЩАЛСЯ: по высоте — доля фигуры,
    // по ширине — исходя из ширины моноширинного знака (~0.62 кегля).
    const fs = Math.min(
      h * (rentable ? 0.38 : 0.24),
      w / (txt.length * (rentable ? 0.72 : 0.66)),
      MAX_PX / scale,                                  // и не больше потолка
    );
    if (fs * scale < MIN_PX) continue;                 // не влезает читаемо — не рисуем
    labels.push('<text x="' + cx + '" y="' + (cy + fs * 0.35) + '" text-anchor="middle"'
      + ' font-size="' + fs + '" font-weight="' + (rentable ? 700 : 600) + '"'
      + ' fill="var(--plan-' + (rentable ? 'ink' : 'ink-soft') + ')"'
      + (rentable ? '' : ' letter-spacing="' + (fs * 0.06) + '"')
      + ' pointer-events="none" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">'
      + esc(txt) + '</text>');
  }
  body += overlays.join('') + labels.join('');

  return '<svg class="plan-svg" viewBox="' + vx + ' ' + vy + ' ' + vw + ' ' + vh + '"'
    + ' preserveAspectRatio="xMidYMid meet" role="img"'
    + ' aria-label="' + esc(floorName(f, 0) + ' plan') + '">' + body + '</svg>';
}

/* ---------- экран ---------- */
export function render(ctx) {
  const S = ctx.S || {};
  const snap = ctx.snap || {};
  const blds = Array.isArray(snap.buildings) ? snap.buildings : [];
  const b = (S.scope && S.scope !== 'all' ? blds.find(x => x && String(x.id) === String(S.scope)) : null) || blds[0];
  const ym = S.ym || todayYm();

  let h = '<div class="topbar"><div class="tb-row"><div><div class="tb-title sm">Floor plan</div>'
    + '<div class="sync"><i></i>' + esc(b ? (b.name || b.id) : 'no building') + '</div></div></div></div>';

  if (!b) return h + '<div class="empty">No building loaded yet.</div>';

  const floors = floorsOf(b);
  const f = currentFloor(ctx, b);
  if (floors.length > 1) {
    h += '<div class="chips">' + floors.map((x, i) =>
      '<button class="fchip" data-act="planfloor" data-f="' + esc(x.id) + '" aria-pressed="'
      + (f && String(x.id) === String(f.id)) + '">' + esc(floorName(x, i)) + '</button>').join('') + '</div>';
  }
  if (!f) return h + '<div class="empty">This building has no floors yet.</div>';

  const big = !!S.planZoom;
  h += '<div class="plan-wrap' + (big ? ' zoom' : '') + '" id="planWrap">' + planSvg(ctx, b, f, ym, big) + '</div>';
  h += '<div class="chips" style="padding-top:2px">'
    + '<button class="fchip" data-act="planzoom" aria-pressed="' + big + '">'
    + (big ? I.zoomOut + ' Fit to screen' : I.zoom + ' Zoom in') + '</button>'
    + '<span class="hintline" style="align-self:center;padding-left:4px">Tap a suite for money and actions</span></div>';

  // Легенда — те же слова, что на экране Payments.
  // Reserved модель отдаёт (money.uiStatus) и план его красит — значит он обязан
  // быть в легенде, иначе оператор видит цвет, которому нет объяснения.
  /* Слова легенды называют ДЕЙСТВИЕ, а не только состояние. На карте (mapStatus)
     «overdue» означает ровно «срок прошёл, а счёта не видно» — синюю заливку
     такие юниты не получают. Значит оператору надо ВЫСТАВИТЬ счёт, а не гнаться
     за арендатором; на проде это 2 юнита из 11 просроченных, остальные 9 —
     синие с пометкой. Писать на них «Overdue» значит подсказывать не то. */
  const L = [['paid', 'Paid'], ['invoiced', 'Invoice sent'], ['due', 'Due'],
    ['overdue', 'Not billed · past due'], ['idle', 'Not billed yet'],
    ['reserved', 'Reserved'], ['vacant', 'Vacant']];
  h += '<div class="legend" style="padding:2px 16px 10px">' + L.map(([k, t]) =>
    '<span><i style="background:var(--plan-' + k + ');border:1px solid var(--plan-line)"></i>' + t + '</span>').join('')
    + '<span><i style="background:var(--plan-invoiced);border:1.5px dashed var(--plan-overdue-mark)"></i>'
    + 'Invoice sent · past due</span></div>';
  return h;
}

export function handle(act, el, ctx) {
  const S = ctx.S || {};
  if (act === 'planfloor') { S.planFloor = el.getAttribute('data-f') || null; return true; }
  if (act === 'planzoom') { S.planZoom = !S.planZoom; return true; }
  return false;
}
