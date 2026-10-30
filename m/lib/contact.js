/* contact.js — гигиена контактов арендатора: email / имя / телефон.
 *
 * ОДИН исходник для сервера и для мобильного клиента:
 *   functions/index.js  → const _contact = require → './lib/contact.js'   (канон)
 *   m/app.js            → import('./lib/contact.js?v=…') → globalThis.sfaContact → ctx.contact
 * Файл лежит в репо ДВАЖДЫ, байт-в-байт: functions/lib/contact.js (канон) и
 * m/lib/contact.js (копия). Почему не симлинк и не один путь: Firebase упаковывает
 * functions/ отдельным архивом (симлинк уезжает в zip симлинком и в облаке висит),
 * а hosting не раздаёт functions/**. Совпадение копий держат гейты:
 * scripts/check-invariants.sh (cmp) и tests/email-guard.test.mjs.
 * Десктоп (floor-map-editor.html, блок «Entry 95: tenant contact hygiene») несёт ту же
 * логику inline (классические <script>) — тест сверяет его с этим модулем на всех кейсах.
 *
 * Формат — UMD без import / export / require внутри: Node читает файл через
 * module.exports (любой Node 22, require-esm не нужен), браузер — как ES-модуль,
 * API кладётся в globalThis.sfaContact. Правила — FIXES_LOG Entry 95 / Entry 96.
 *
 * API: EMAIL_RE, normEmail(raw) → { email, repaired }, emailLooksValid(email),
 *      normPersonName(raw), normCompanyName(raw), normPhone(raw).
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  root.sfaContact = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
}(globalThis, function () {
  'use strict';

  // Строгий паттерн: один @, точка в домене, без пробелов. Тот же, что isValidEmail
  // на десктопе, _TENANT_EMAIL_RE в CF и EMAIL_RE в m/ui/lease.js.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // Zero-width символы (U+200B–U+200D) и BOM — невидимый мусор из копипасты.
  const ZW_RE = /[\u200B-\u200D\uFEFF]/g;

  // Нормализация email. Zero-width символы убираем везде; вставку вида
  // "Zev Gluck <zgluck@vivohc.com>" сводим к адресу из угловых скобок; пробелы
  // убираем ТОЛЬКО вплотную к точке или @ ("VIVOHC .COM", "ZGLUCK @VIVOHC" —
  // опечатка). Любой другой пробел ("a b@c.com", "jdoe@gmail.com - Jane") НЕ
  // склеиваем: угадать, что имелось в виду, нельзя, а склейка дала бы валидный на
  // вид ЧУЖОЙ адрес — такой адрес остаётся невалидным и возвращается оператору.
  // Регистр → lower. repaired === true только если значение изменилось не только
  // по регистру/краям (смена регистра — не ремонт). Валидности не проверяет.
  function normEmail(raw) {
    const trimmed = String(raw || '').trim();
    let s = trimmed.replace(ZW_RE, '');
    const angled = s.match(/<([^<>]*@[^<>]*)>/);
    if (angled) s = angled[1].trim();
    s = s.replace(/\s+([.@])/g, '$1').replace(/([.@])\s+/g, '$1');
    return { email: s.toLowerCase(), repaired: s !== trimmed };
  }

  // Строже EMAIL_RE: плюс запрет символов «прозы» — скобок, запятых, кавычек,
  // точки с запятой, двоеточия. "zgluck@vivohc.com(primary)" проходит EMAIL_RE,
  // но Stripe его отвергнет — не выпускаем такое из гейтов и не пишем как «ремонт».
  function emailLooksValid(email) {
    const e = String(email || '');
    return !!e && EMAIL_RE.test(e) && !/[<>()\[\],;:"]/.test(e);
  }

  // Title Case только для «кричащих» значений — целиком UPPER или целиком lower.
  // Смешанный регистр (McDonald, iPhone Repair LLC) оставляем как ввели (кроме
  // чистки пробелов). Аббревиатуры из TC_UPPER остаются заглавными, PHD → PhD,
  // инициалы (A., J.R., N.A.) — заглавные, токены с & (H&R, AT&T) — как ввели,
  // служебные слова (TC_SMALL) — строчные, если не первые. Неизвестные
  // аббревиатуры (CVS, JCS) станут словами — цена правила «без капса».
  const TC_UPPER = new Set(['LLC', 'L.L.C', 'LP', 'L.P', 'LLP', 'L.L.P', 'PLLC', 'PA', 'P.A', 'PC', 'P.C',
    'PLC', 'DBA', 'D/B/A', 'II', 'III', 'IV', 'VI', 'VII', 'MD', 'DDS', 'DMD', 'CPA', 'RN', 'NP',
    'PT', 'JD', 'DC', 'OD', 'USA', 'US', 'UK']);
  const TC_SMALL = new Set(['of', 'and', 'the', 'for', 'at', 'in', 'on', 'by', 'to', 'a', 'an', 'de', 'la',
    'del', 'van', 'von', 'der', 'di', 'da', 'du', 'le', 'les', 'des', 'y', 'e']);
  function tcWord(tok, isFirst) {
    // Ядро токена — без обрамляющей пунктуации (запятые, точки, скобки): "LLC," → "LLC".
    const core = tok.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
    if (!core) return tok; // "&", "—" и т.п.
    if (core.includes('&')) return tok; // H&R, AT&T, A&M — аббревиатуры, как ввели
    const coreUp = core.toUpperCase();
    if (TC_UPPER.has(coreUp)) return tok.toUpperCase();
    if (coreUp === 'PHD') return tok.replace(core, 'PhD');
    if (/^\p{L}(\.\p{L})*$/u.test(core)) return tok.toUpperCase(); // инициалы: A, A., J.R., N.A.
    const low = tok.toLowerCase();
    if (!isFirst && TC_SMALL.has(core.toLowerCase())) return low;
    // Заглавная — первая буква (после открывающей пунктуации), после дефиса и слэша;
    // после апострофа только если дальше ≥ 2 букв (O'Neil, D'Angelo — да; Smith's — нет).
    return low.replace(/(^[^\p{L}\p{N}]*|[-\/])(\p{L})|(['\u2019])(\p{L})(?=\p{L})/gu,
      (m, pre, ch, apos, ch2) => (apos !== undefined ? apos + ch2.toUpperCase() : pre + ch.toUpperCase()));
  }
  function titleCaseIfShouty(raw) {
    const s = String(raw || '').replace(ZW_RE, '').trim().replace(/\s+/g, ' ');
    if (!s || !/\p{L}/u.test(s)) return s;
    const shouty = s === s.toUpperCase() || s === s.toLowerCase();
    if (!shouty) return s;
    return s.split(' ').map((tok, i) => tcWord(tok, i === 0)).join(' ');
  }
  function normPersonName(raw) { return titleCaseIfShouty(raw); }
  function normCompanyName(raw) { return titleCaseIfShouty(raw); }

  // Телефон: 10 цифр или 11 с ведущей 1 → XXX-XXX-XXXX; иначе (международный,
  // добавочный) — только чистка пробелов, значение не трогаем.
  function normPhone(raw) {
    const s = String(raw || '').replace(ZW_RE, '').trim().replace(/\s+/g, ' ');
    const digits = s.replace(/\D/g, '');
    const fmt = (d) => d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
    if (digits.length === 10) return fmt(digits);
    if (digits.length === 11 && digits[0] === '1') return fmt(digits.slice(1));
    return s;
  }

  return { EMAIL_RE, normEmail, emailLooksValid, normPersonName, normCompanyName, normPhone };
}));
