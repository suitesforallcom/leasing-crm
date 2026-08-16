/* m/lib/format.js — форматирование для мобильного клиента SuitesForAll.
   Чистые функции, без зависимостей и без побочных эффектов.
   Инвариант: любой мусор на входе даёт '' или '$0', но НИКОГДА не бросает —
   экран с деньгами не имеет права упасть из-за кривой даты в одном юните. */

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MIN = 60000, HOUR = 3600000, DAY = 86400000;

/* 'YYYY-MM-DD' парсим как ЛОКАЛЬНУЮ полночь — ровно как десктоп
   (new Date(iso + 'T00:00:00'), floor-map-editor.html:137247). Через
   new Date('2026-08-01') получилась бы полночь UTC, и телефон западнее
   Гринвича показал бы «Jul 31» для даты старта лизы. */
function asDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 1);
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ]/.exec(s);
  if (m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? new Date(+m[1], +m[2] - 1, +m[3]) : d;
  }
  if (/^-?\d+$/.test(s)) {
    const d = new Date(+s);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function toNum(n) {
  const v = typeof n === 'number' ? n : parseFloat(String(n == null ? '' : n).replace(/[$,\s]/g, ''));
  return Number.isFinite(v) ? v : 0;
}

/** money(1350) -> '$1,350'  ·  money(-90) -> '-$90'  ·  money(null) -> '$0' */
export function money(n) {
  const v = Math.round(toNum(n));
  const abs = Math.abs(v).toLocaleString('en-US');
  return (v < 0 ? '-$' : '$') + abs;
}

/** kmoney(142400) -> '$142k'  ·  kmoney(4200) -> '$4.2k'  ·  kmoney(880) -> '$880' */
export function kmoney(n) {
  const v = toNum(n);
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1000000) return sign + '$' + (a / 1000000).toFixed(a >= 10000000 ? 0 : 1) + 'm';
  if (a >= 1000) return sign + '$' + (a / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k';
  return sign + '$' + Math.round(a).toLocaleString('en-US');
}

/** dateLong('2026-08-15') -> 'August 15, 2026' */
export function dateLong(v) {
  const d = asDate(v);
  if (!d) return '';
  return MONTHS_LONG[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

/** dateShort('2026-08-03') -> 'Aug 3' в текущем году, иначе 'Aug 31, 2027'. */
export function dateShort(v) {
  const d = asDate(v);
  if (!d) return '';
  const base = MONTHS_SHORT[d.getMonth()] + ' ' + d.getDate();
  return d.getFullYear() === new Date().getFullYear() ? base : base + ', ' + d.getFullYear();
}

/** rel(ts) -> 'just now' | '2 min ago' | '5 hr ago' | '12 days ago' | 'in 3 days'.
    Принимает epoch-ms, Date или ISO-строку. nowMs — только для тестов. */
export function rel(v, nowMs) {
  const d = asDate(v);
  if (!d) return '';
  const now = Number.isFinite(+nowMs) ? +nowMs : Date.now();
  const diff = now - d.getTime();
  const a = Math.abs(diff);
  if (a < 45 * 1000) return 'just now';
  let phrase;
  if (a < 90 * 1000) phrase = '1 min';
  else if (a < 55 * MIN) phrase = Math.round(a / MIN) + ' min';
  else if (a < 90 * MIN) phrase = '1 hr';
  else if (a < 22 * HOUR) phrase = Math.round(a / HOUR) + ' hr';
  else if (a < 36 * HOUR) phrase = '1 day';
  else if (a < 26 * DAY) phrase = Math.round(a / DAY) + ' days';
  else if (a < 46 * DAY) phrase = '1 month';
  else if (a < 320 * DAY) phrase = Math.round(a / (30.44 * DAY)) + ' months';
  else if (a < 548 * DAY) phrase = '1 year';
  else phrase = Math.round(a / (365.25 * DAY)) + ' years';
  return diff >= 0 ? phrase + ' ago' : 'in ' + phrase;
}

/** initials('Marcus Alvarez') -> 'MA'  ·  initials('Vega') -> 'VE'  ·  initials('') -> '' */
export function initials(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return '';
  const parts = s.split(/[\s.,\-_/&]+/)
    .map(p => p.replace(/^[^A-Za-z0-9]+/, ''))
    .filter(p => /^[A-Za-z0-9]/.test(p));
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Экранирование для строковых рендереров. Экспортируется как утилита —
    каждый UI-модуль обязан прогонять через неё любые данные арендатора. */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
