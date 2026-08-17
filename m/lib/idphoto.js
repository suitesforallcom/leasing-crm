/* /m/lib/idphoto.js — фото документа (водительские права) с телефона:
   автообрезка, выравнивание перспективы и яркости.

   Два движка (решение оператора 2026-08-16 — «используй готовые инструменты»):
   1) ОСНОВНОЙ — jscanify (MIT) поверх OpenCV.js: контур документа →
      выравнивание перспективы (getPerspectiveTransform). Библиотеки
      САМОхостятся в /vendor/ (не CDN!) и грузятся ЛЕНИВО — только когда
      оператор реально фотографирует права; OpenCV ~10.5 МБ, после первого
      раза сидит в HTTP-кэше. Файлы в vendor/ именуются С ВЕРСИЕЙ и никогда
      не перезаписываются — обновление = новое имя (в /vendor нет no-store).
   2) ЗАПАСНОЙ — прежний чистый canvas-детектор (энергия рёбер + Кадане):
      офлайн, таймаут загрузки, мусорный контур. Перспективу он не правит.

   detectCardBox / snapToCardAspect — чистые функции, их гоняет стенд. */

export const CARD_ASPECT = 1.586;                 // ISO/IEC 7810 ID-1
export const VENDOR_CV = '/vendor/opencv-jscanify-143.js';
export const VENDOR_SCANNER = '/vendor/jscanify.min.js';

/* ДВИЖОК В WEB WORKER (2026-08-16). Два независимых повода:
   1) 9 МБ emscripten-кода компилируются ВНЕ главного потока — телефон не
      замерзает (прогрев успевает до снимка, а UI жив даже во время него);
   2) opencv.js стабильно вешал главный поток страницы с длинной цепочкой
      top-level await (стенд воспроизводил намертво), в чистом же скоупе
      воркера компилируется за сотни миллисекунд — проверено бисекцией.
   jscanify в воркере ищет контур (findPaperContour/getCornerPoints — чистые
   cv-операции, DOM не нужны); перспективу правит сам OpenCV
   (getPerspectiveTransform + warpPerspective). Канвасов в воркере нет —
   обмен ImageData с переносом буферов. */

let _workerPromise = null;
let _workerSeq = 0;

function _buildWorkerSource(origin) {
  // Абсолютные URL: у blob-воркера нет origin для относительных importScripts.
  return `
importScripts(${JSON.stringify(origin + VENDOR_CV)}, ${JSON.stringify(origin + VENDOR_SCANNER)});
var CARD_ASPECT = ${CARD_ASPECT};
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function quadArea(q) {
  var s = 0;
  for (var i = 0; i < 4; i++) { var a = q[i], b = q[(i + 1) % 4]; s += a.x * b.y - b.x * a.y; }
  return Math.abs(s) / 2;
}
function pickQuad(scanner, scales) {
  var best = null;
  for (var si = 0; si < scales.length; si++) {
    var sc = scales[si];
    var mat = cv.matFromImageData(sc.img), pts = null;
    try {
      var contour = scanner.findPaperContour(mat);
      if (contour) {
        try { pts = scanner.getCornerPoints(contour); }
        finally { try { contour.delete(); } catch (e) {} }
      }
    } finally { mat.delete(); }
    if (!pts || !pts.topLeftCorner || !pts.topRightCorner
        || !pts.bottomLeftCorner || !pts.bottomRightCorner) continue;
    var tl = pts.topLeftCorner, tr = pts.topRightCorner,
        bl = pts.bottomLeftCorner, br = pts.bottomRightCorner;
    var dw = sc.img.width, dh = sc.img.height;
    var areaF = quadArea([tl, tr, br, bl]) / (dw * dh);
    if (areaF < 0.10 || areaF > 0.97) continue;
    var wA = (dist(tl, tr) + dist(bl, br)) / 2;
    var hA = (dist(tl, bl) + dist(tr, br)) / 2;
    var ratio = Math.max(wA, hA) / Math.max(1, Math.min(wA, hA));
    if (ratio < 1.15 || ratio > 2.4) continue;
    var d0 = Math.abs(ratio - CARD_ASPECT);
    if (!best || d0 < best.d0) best = { d0: d0, dw: dw, tl: tl, tr: tr, bl: bl, br: br, wA: wA, hA: hA, ratio: ratio };
  }
  return best;
}
self.onmessage = function (ev) {
  var d = ev.data;
  var reply = { id: d.id, ok: false };
  var src = null, dst = null, M = null, s1 = null, s2 = null, rot = null;
  try {
    var scanner = new jscanify();
    var best = pickQuad(scanner, d.scales);
    if (best) {
      var W = d.full.width;
      var k = W / best.dw;
      var cx = (best.tl.x + best.tr.x + best.bl.x + best.br.x) / 4;
      var cy = (best.tl.y + best.tr.y + best.bl.y + best.br.y) / 4;
      var m = function (p) { return { x: (cx + (p.x - cx) * 1.025) * k, y: (cy + (p.y - cy) * 1.025) * k }; };
      var tl = m(best.tl), tr = m(best.tr), bl = m(best.bl), br = m(best.br);
      var sideways = best.hA > best.wA;
      var outW = Math.max(320, Math.min(d.targetW, Math.round(Math.max(best.wA, best.hA) * k * 1.025)));
      var outH = Math.round(outW / best.ratio);
      var exW = sideways ? outH : outW, exH = sideways ? outW : outH;
      src = cv.matFromImageData(d.full);
      s1 = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
      s2 = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, exW, 0, exW, exH, 0, exH]);
      M = cv.getPerspectiveTransform(s1, s2);
      dst = new cv.Mat();
      cv.warpPerspective(src, dst, M, new cv.Size(exW, exH));
      if (sideways) {                              // довернуть боковую карту
        rot = new cv.Mat();
        cv.rotate(dst, rot, cv.ROTATE_90_COUNTERCLOCKWISE);
        dst.delete(); dst = rot; rot = null;
      }
      var out = new Uint8ClampedArray(dst.data);   // копия: Mat освобождаем
      reply = { id: d.id, ok: true, w: dst.cols, h: dst.rows, buf: out.buffer };
      self.postMessage(reply, [out.buffer]);
      return;
    }
  } catch (e) { reply.err = String(e && e.message || e); }
  finally {
    for (var x of [src, dst, M, s1, s2, rot]) { if (x) { try { x.delete(); } catch (e2) {} } }
  }
  self.postMessage(reply);
};
(function signalReady() {
  // importScripts синхронен, но wasm-рантайм доинициализируется ПОСЛЕ него:
  // ready шлём только с живым cv.Mat, иначе первый снимок придёт в пустоту.
  if (self.cv && self.cv.Mat) { self.postMessage({ ready: true }); return; }
  if (self.cv) { self.cv.onRuntimeInitialized = function () { self.postMessage({ ready: true }); }; }
  var waited = 0;
  var iv = setInterval(function () {
    waited += 250;
    if (self.cv && self.cv.Mat) { clearInterval(iv); self.postMessage({ ready: true }); }
    else if (waited >= 25000) { clearInterval(iv); }
  }, 250);
})();
`;
}

/** Ленивый воркер с движком. Провал (нет Worker, 404 vendor, упавший
    importScripts) сбрасывает кэш — следующая фотография попробует снова. */
export function loadScanEngine() {
  if (_workerPromise) return _workerPromise;
  _workerPromise = new Promise((res, rej) => {
    let w = null;
    try {
      const src = _buildWorkerSource(location.origin);
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      w = new Worker(url);
      const t = setTimeout(() => { try { w.terminate(); } catch (e) {} rej(new Error('scan worker init timeout')); }, 30000);
      w.onmessage = (ev) => {
        if (ev.data && ev.data.ready) { clearTimeout(t); res(w); }
      };
      w.onerror = (e) => { clearTimeout(t); try { w.terminate(); } catch (e2) {} rej(new Error('scan worker failed: ' + (e.message || 'load'))); };
    } catch (e) { rej(e); }
  });
  _workerPromise.catch(() => { _workerPromise = null; });
  return _workerPromise;
}

/** Прогрев: дёрнуть загрузку движка заранее (открылся шаг с фото), чтобы к
    моменту снимка 9 МБ уже скомпилировались в фоне. Ошибки глотаются — при
    самом снимке будет честный фолбэк на canvas-путь. */
export function prewarmScanEngine() { try { loadScanEngine().catch(() => {}); } catch (e) { /* нет DOM */ } }

/** OpenCV-путь: найти четырёхугольник документа и выровнять перспективу.
    Возвращает canvas с картой (альбомно) или null — тогда снаружи отработает
    canvas-фолбэк.

    МУЛЬТИМАСШТАБ (настроено на двух реальных прод-снимках 2026-08-16: карта
    на тёмном дереве с тенью от руки): Canny внутри jscanify чувствителен к
    масштабу — на 1000px контур бэка уползал в тень (ratio 3.05), на 500px
    оказывался точным. Пробуем 1000/640/500 и берём ВАЛИДНЫЙ четырёхугольник
    с соотношением, ближайшим к карте ID-1 (валидация и выбор — в воркере).
    Извлечение с полем 2.5% от центроида и ИЗМЕРЕННЫМ соотношением — там же. */
async function _cvExtractCard(full, W, H, T) {
  const worker = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('scan engine timeout')), 25000);
    loadScanEngine().then((v) => { clearTimeout(t); res(v); },
                          (e) => { clearTimeout(t); rej(e); });
  });
  const imageDataAt = (w2) => {
    const h2 = Math.max(1, Math.round(H * w2 / W));
    const c = document.createElement('canvas');
    c.width = w2; c.height = h2;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(full, 0, 0, w2, h2);
    return g.getImageData(0, 0, w2, h2);
  };
  const fullId = imageDataAt(Math.min(2048, W));
  const scales = [Math.min(1000, W), 640, 500].map((w2) => ({ img: imageDataAt(w2) }));
  const id = ++_workerSeq;
  const reply = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('scan extract timeout')), 20000);
    const onMsg = (ev) => {
      if (!ev.data || ev.data.id !== id) return;
      worker.removeEventListener('message', onMsg);
      clearTimeout(t); res(ev.data);
    };
    worker.addEventListener('message', onMsg);
    const bufs = [fullId.data.buffer].concat(scales.map((s3) => s3.img.data.buffer));
    worker.postMessage({ id, full: fullId, scales, targetW: T }, bufs);
  });
  if (!reply.ok || !reply.w) return null;
  const out = document.createElement('canvas');
  out.width = reply.w; out.height = reply.h;
  out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(reply.buf), reply.w, reply.h), 0, 0);
  return out;
}

/** Поиск карты в кадре. v2 (2026-08-16): прежняя версия брала рамку «от
    первой грани до последней», и ФАКТУРНЫЙ фон (деревянный стол — случай из
    прода) растягивал её почти на весь кадр. Теперь:
    1) яркостный приоритет — карта почти всегда СВЕТЛЕЕ стола, поэтому
       энергия граней взвешивается превышением яркости над медианой кадра;
    2) вместо «первая-последняя грань» — самый ПЛОТНЫЙ интервал профиля
       (Кадане относительно базовой линии): диффузная текстура фона уходит
       в минус, плотная карта — в плюс.
    Белая карта на белом столе тоже работает — по граням текста (яркостный
    буст нулевой, остаётся базовый вес 0.25). Настроено на 4 синтетических
    случаях: гладкий стол 0.97, дерево 0.97, карта у края 0.94, белое-на-белом
    0.71 (IoU). data — Uint8Clamped RGBA. */
export function detectCardBox(data, w, h) {
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  const smp = [];
  for (let y = 0; y < h; y += 5) for (let x = 0; x < w; x += 5) smp.push(lum[y * w + x]);
  smp.sort((a, b) => a - b);
  const med = smp[smp.length >> 1] || 0;
  const colS = new Float32Array(w), rowS = new Float32Array(h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const e = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + w] - lum[i - w]);
      if (e < 14) continue;
      const bright = Math.max(0, lum[i] - med) / 48;
      const sc = e * (0.25 + Math.min(2, bright));
      colS[x] += sc; rowS[y] += sc;
    }
  }
  const kadane = (arr) => {
    let mean = 0; for (const v of arr) mean += v; mean /= arr.length || 1;
    const base = mean * 1.15;
    let best = -1, b0 = 0, b1 = arr.length - 1, cur = 0, c0 = 0;
    for (let i = 0; i < arr.length; i++) {
      cur += arr[i] - base;
      if (cur <= 0) { cur = 0; c0 = i + 1; continue; }
      if (cur > best) { best = cur; b0 = c0; b1 = i; }
    }
    return best > 0 ? [b0, b1] : [0, arr.length - 1];
  };
  const [x0, x1] = kadane(colS), [y0, y1] = kadane(rowS);
  const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  let inn = 0, out = 0, cin = 0, cout = 0;
  for (let x = 0; x < w; x++) { if (x >= x0 && x <= x1) { inn += colS[x]; cin++; } else { out += colS[x]; cout++; } }
  const contrast = (inn / Math.max(1, cin)) / Math.max(1e-6, out / Math.max(1, cout));
  const areaFrac = box.w * box.h / (w * h);
  box.confidence = Math.min(1, Math.max(0, (contrast - 1.4) / 4)) * (areaFrac < 0.85 ? 1 : 0.2);
  return box;
}

/** Прижать бокс к соотношению карты (расширяем меньшую сторону, поля 4%),
    не вылезая за кадр. Чистая функция — гоняется стендом. */
export function snapToCardAspect(box, imgW, imgH, aspect) {
  const A = aspect || CARD_ASPECT;
  let { x, y, w, h } = box;
  const mx = w * 0.04, my = h * 0.04;
  x -= mx; y -= my; w += mx * 2; h += my * 2;
  if (w / h < A) { const nw = h * A; x -= (nw - w) / 2; w = nw; }
  else { const nh = w / A; y -= (nh - h) / 2; h = nh; }
  if (w > imgW) { const k = imgW / w; w = imgW; h *= k; }
  if (h > imgH) { const k = imgH / h; h = imgH; w *= k; }
  x = Math.max(0, Math.min(imgW - w, x));
  y = Math.max(0, Math.min(imgH - h, y));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/* Лёгкое выравнивание яркости: растяжка гистограммы по 2-му и 98-му
   перцентилю яркости. Текст на правах становится читаемым при тусклом кадре. */
function stretchContrast(ctx2d, w, h) {
  const img = ctx2d.getImageData(0, 0, w, h), d = img.data;
  const hist = new Uint32Array(256);
  for (let p = 0; p < d.length; p += 4) {
    hist[(0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) | 0]++;
  }
  const n = w * h; let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.02) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.02) { hi = i; break; } }
  if (hi - lo < 30 || (lo < 8 && hi > 247)) return;      // уже нормальный кадр
  const k = 255 / (hi - lo);
  for (let p = 0; p < d.length; p += 4) {
    d[p]     = Math.max(0, Math.min(255, (d[p] - lo) * k));
    d[p + 1] = Math.max(0, Math.min(255, (d[p + 1] - lo) * k));
    d[p + 2] = Math.max(0, Math.min(255, (d[p + 2] - lo) * k));
  }
  ctx2d.putImageData(img, 0, 0);
}

/** Полный конвейер: File/Blob → { blob (JPEG), thumb (dataURL), width, height,
    detected, engine } . target — ширина результата (1280 достаточно для
    читаемых прав, ~150–250 КБ). EXIF-поворот отдаёт createImageBitmap.
    opts.engine==='canvas' принудительно выключает OpenCV (нужно стенду,
    который проверяет запасной путь). */
export async function processIdPhoto(file, target, opts) {
  const T = target || 1280;
  // Каскад декодеров: Safari разных версий по-разному поддерживает options у
  // createImageBitmap; <img> — последний рубеж (iOS ≥13.4 сам применяет EXIF).
  let bmp = null;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* дальше */ }
  if (!bmp) { try { bmp = await createImageBitmap(file); } catch (e) { /* дальше */ } }
  if (!bmp) {
    const u = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = u;
      await img.decode();
      bmp = img;                                     // drawImage принимает и <img>
      bmp.width = img.naturalWidth; bmp.height = img.naturalHeight;
    } finally { setTimeout(() => URL.revokeObjectURL(u), 5000); }
  }
  let W = bmp.width, H = bmp.height, rot = false;
  // Права — альбомные; портретный кадр поворачиваем на 90°.
  if (H > W * 1.15) { rot = true; const t = W; W = H; H = t; }
  const full = document.createElement('canvas');
  full.width = W; full.height = H;
  const fc = full.getContext('2d');
  if (rot) { fc.translate(W / 2, H / 2); fc.rotate(-Math.PI / 2); fc.drawImage(bmp, -H / 2, -W / 2); }
  else fc.drawImage(bmp, 0, 0);
  try { bmp.close(); } catch (e) { /* не критично */ }

  // ОСНОВНОЙ путь: jscanify/OpenCV — контур + выравнивание перспективы.
  let out = null, detected = false, engine = 'canvas';
  if (!opts || opts.engine !== 'canvas') {
    try {
      out = await _cvExtractCard(full, W, H, T);
      if (out) { detected = true; engine = 'opencv'; }
    } catch (e) { out = null; }                        // офлайн/таймаут → фолбэк
  }

  if (!out) {
    // ЗАПАСНОЙ путь: canvas-детектор. Анализ на копии ~360px.
    const aw = 360, ah = Math.max(1, Math.round(H * (aw / W)));
    const an = document.createElement('canvas');
    an.width = aw; an.height = ah;
    const ac = an.getContext('2d', { willReadFrequently: true });
    ac.drawImage(full, 0, 0, aw, ah);
    const raw = detectCardBox(ac.getImageData(0, 0, aw, ah).data, aw, ah);
    detected = raw.confidence >= 0.35 && raw.w > aw * 0.25 && raw.h > ah * 0.25;
    // Карта лежит БОКОМ внутри альбомного кадра (бокс вертикальный) — кроп
    // надо ДОВЕРНУТЬ на 90°, а прижимать к формату по перевёрнутым осям
    // (v2.1, скриншоты оператора: правый снимок был боком).
    const sideways = detected && raw.h > raw.w * 1.15;
    const boxA = detected ? raw : { x: 0, y: 0, w: aw, h: ah };
    const box = sideways
      ? (() => { const b = snapToCardAspect({ x: boxA.y, y: boxA.x, w: boxA.h, h: boxA.w }, ah, aw);
                 return { x: b.y, y: b.x, w: b.h, h: b.w }; })()
      : snapToCardAspect(boxA, aw, ah);
    const k = W / aw;                                // масштаб анализа → полный кадр

    const cw2 = Math.round(box.w * k), ch2 = Math.round(box.h * k);
    const outW = sideways ? Math.min(T, ch2) : Math.min(T, cw2);
    const outH = sideways ? Math.round(outW / (ch2 / cw2)) : Math.round(outW / (cw2 / ch2));
    out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    const oc = out.getContext('2d', { willReadFrequently: true });
    if (sideways) {
      oc.translate(outW / 2, outH / 2);
      oc.rotate(-Math.PI / 2);
      oc.drawImage(full, box.x * k, box.y * k, cw2, ch2, -outH / 2, -outW / 2, outH, outW);
      oc.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      oc.drawImage(full, box.x * k, box.y * k, cw2, ch2, 0, 0, outW, outH);
    }
  }

  const fc2 = out.getContext('2d', { willReadFrequently: true });
  stretchContrast(fc2, out.width, out.height);

  const blob = await new Promise((res) => out.toBlob(res, 'image/jpeg', 0.82));
  const th = document.createElement('canvas');
  th.width = 160; th.height = Math.round(out.height * (160 / out.width));
  th.getContext('2d').drawImage(out, 0, 0, th.width, th.height);
  return { blob, thumb: th.toDataURL('image/jpeg', 0.6),
           width: out.width, height: out.height, detected, engine };
}

/** Ручной поворот УЖЕ обработанного снимка на 90° по часовой (кнопка ↻ на
    предпросмотре: автомат не знает, где у боковой карты верх). Возвращает
    ту же форму { blob, thumb, width, height }. */
export async function rotateProcessed(blob) {
  let bmp = null;
  try { bmp = await createImageBitmap(blob); } catch (e) {
    const u = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = u;
      await img.decode();
      bmp = img; bmp.width = img.naturalWidth; bmp.height = img.naturalHeight;
    } finally { setTimeout(() => URL.revokeObjectURL(u), 5000); }
  }
  const c = document.createElement('canvas');
  c.width = bmp.height; c.height = bmp.width;
  const cc = c.getContext('2d');
  cc.translate(c.width / 2, c.height / 2);
  cc.rotate(Math.PI / 2);
  cc.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  try { bmp.close(); } catch (e) { /* <img> */ }
  const outBlob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
  const th = document.createElement('canvas');
  th.width = 160; th.height = Math.round(c.height * (160 / c.width));
  th.getContext('2d').drawImage(c, 0, 0, th.width, th.height);
  return { blob: outBlob, thumb: th.toDataURL('image/jpeg', 0.6), width: c.width, height: c.height };
}
