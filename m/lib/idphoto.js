/* /m/lib/idphoto.js — фото документа (водительские права) с телефона:
   автообрезка + выравнивание яркости, БЕЗ внешних библиотек (правило проекта:
   никаких CDN-модулей; OpenCV.js на 8 МБ сюда не поедет — хватает canvas).

   Как режем: карта ID-1 (85.6×54 мм, соотношение 1.586) на контрастном фоне
   даёт плотное пятно градиентов. Считаем карту энергии рёбер на уменьшенной
   копии, берём охватывающий бокс плотной области, прижимаем к соотношению
   карты и режем полноразмерный кадр. Перспективу НЕ исправляем (это уже
   территория OpenCV) — оператору показывается предпросмотр с «Retake».

   detectCardBox / snapToCardAspect — чистые функции, их гоняет стенд. */

export const CARD_ASPECT = 1.586;                 // ISO/IEC 7810 ID-1

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
    detected } . target — ширина результата (1280 достаточно для читаемых прав,
    ~150–250 КБ). EXIF-поворот отдаёт createImageBitmap. */
export async function processIdPhoto(file, target) {
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

  // Анализ на копии ~360px.
  const aw = 360, ah = Math.max(1, Math.round(H * (aw / W)));
  const an = document.createElement('canvas');
  an.width = aw; an.height = ah;
  const ac = an.getContext('2d', { willReadFrequently: true });
  ac.drawImage(full, 0, 0, aw, ah);
  const raw = detectCardBox(ac.getImageData(0, 0, aw, ah).data, aw, ah);
  const detected = raw.confidence >= 0.35 && raw.w > aw * 0.25 && raw.h > ah * 0.25;
  const boxA = detected ? raw : { x: 0, y: 0, w: aw, h: ah };
  const box = snapToCardAspect(boxA, aw, ah);
  const k = W / aw;                                  // масштаб анализа → полный кадр

  const outW = Math.min(T, Math.round(box.w * k));
  const outH = Math.round(outW / (box.w / box.h));
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const oc = out.getContext('2d', { willReadFrequently: true });
  oc.drawImage(full, box.x * k, box.y * k, box.w * k, box.h * k, 0, 0, outW, outH);
  stretchContrast(oc, outW, outH);

  const blob = await new Promise((res) => out.toBlob(res, 'image/jpeg', 0.82));
  const th = document.createElement('canvas');
  th.width = 160; th.height = Math.round(outH * (160 / outW));
  th.getContext('2d').drawImage(out, 0, 0, th.width, th.height);
  return { blob, thumb: th.toDataURL('image/jpeg', 0.6), width: outW, height: outH, detected };
}
