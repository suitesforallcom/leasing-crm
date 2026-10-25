/**
 * Unit mail — серверная санитизация HTML писем (UNIT_EMAIL_PLAN.md § 6.1).
 *
 * Политика портирована с PropertyPulse 2.0 (lib/mailbox/html-sanitize.ts):
 * «REBUILD, NEVER CLEAN» — на выходе только allowlist тегов/атрибутов/стилей.
 *   • script/style/iframe/object/embed/form/svg/math/video/... — вырезаются вместе
 *     с содержимым;
 *   • on*-атрибуты и любые style с url()/expression()/@import — вырезаются;
 *   • href только https: / mailto: / tel:; всем ссылкам rel+target;
 *   • <img src="https://…"> НЕ грузится сам: src → data-blocked-src (трекинг-
 *     пиксели молчат, пока сотрудник не нажмёт «Display images»);
 *   • <img src="cid:…"> → data-mail-cid (клиент подставит подписанный URL вложения);
 *   • data:image/* ≤ 200 КБ остаётся как есть; прочие img удаляются;
 *   • входной HTML > 2 МБ обрезается (truncated:true).
 * Санитайзер запускается при КАЖДОМ чтении (сырой HTML хранится в Storage),
 * поэтому ужесточение политики применяется ко всей истории.
 * Вторая линия обороны — на клиенте: <iframe sandbox> + CSP в srcdoc.
 */
'use strict';

const sanitizeHtml = require('sanitize-html');

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_DATA_IMG = 200 * 1024;

const COLOR_RE = /^(#[0-9a-f]{3,8}|[a-z]{3,24}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|hsla?\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+\s*)?\))$/i;
// Никаких скобок/кавычек/точек с запятой → url(), expression(), @import невозможны.
const PLAIN_RE = /^[^;(){}<>"'\\]{0,200}$/;
const DISPLAY_RE = /^(block|inline|inline-block|none|table|table-row|table-cell|table-row-group|table-header-group|table-footer-group|list-item|flex|inline-flex)$/i;
const SIZE_RE = /^[^;(){}<>"'\\]{0,60}$/;

const COLOR_PROPS = ['color', 'background-color', 'border-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color'];
const PLAIN_PROPS = [
  'background', 'font', 'font-size', 'font-family', 'font-weight', 'font-style', 'font-variant',
  'text-decoration', 'text-align', 'text-transform', 'text-indent', 'line-height', 'letter-spacing',
  'white-space', 'word-break', 'word-wrap', 'overflow-wrap',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-width', 'border-style',
  'border-radius', 'border-collapse', 'border-spacing',
  'vertical-align', 'float', 'clear', 'table-layout', 'list-style', 'list-style-type', 'opacity', 'direction',
];
const SIZE_PROPS = ['width', 'height', 'max-width', 'min-width', 'max-height', 'min-height'];

function buildAllowedStyles() {
  const all = {};
  for (const p of COLOR_PROPS) all[p] = [COLOR_RE];
  for (const p of PLAIN_PROPS) all[p] = [PLAIN_RE];
  for (const p of SIZE_PROPS) all[p] = [SIZE_RE];
  all.display = [DISPLAY_RE];
  return { '*': all };
}

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q',
  's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
];

const COMMON_ATTRS = ['style', 'dir', 'lang', 'title', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'nowrap'];

function makeOptions(counters) {
  return {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      '*': COMMON_ATTRS,
      a: COMMON_ATTRS.concat(['href', 'name', 'target', 'rel']),
      img: ['src', 'alt', 'width', 'height', 'style', 'align', 'border', 'title', 'data-blocked-src', 'data-mail-cid'],
      font: COMMON_ATTRS.concat(['size', 'face']),
      td: COMMON_ATTRS.concat(['headers', 'scope']),
      th: COMMON_ATTRS.concat(['headers', 'scope']),
      ol: COMMON_ATTRS.concat(['start', 'type']),
      li: COMMON_ATTRS.concat(['value']),
    },
    allowedSchemes: ['https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['data'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    allowIframeRelativeUrls: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math',
      'template', 'head', 'title', 'audio', 'video', 'form', 'select', 'button', 'input', 'canvas', 'applet', 'frame', 'frameset'],
    allowedStyles: buildAllowedStyles(),
    parseStyleAttributes: true,
    nestingLimit: 64,
    enforceHtmlBoundary: true,
    transformTags: {
      a: (tagName, attribs) => {
        const out = Object.assign({}, attribs);
        if (out.href) {
          out.target = '_blank';
          out.rel = 'noopener noreferrer nofollow';
        } else {
          delete out.target;
          delete out.rel;
        }
        return { tagName: 'a', attribs: out };
      },
      img: (tagName, attribs) => {
        const src = String(attribs.src || '').trim();
        const out = {};
        for (const k of ['alt', 'width', 'height', 'style', 'align', 'border', 'title']) if (attribs[k] != null) out[k] = attribs[k];
        // Идемпотентность: уже обработанный img (повторная санитизация) сохраняет свои data-* метки.
        if (!src && attribs['data-blocked-src'] && /^https:\/\//i.test(String(attribs['data-blocked-src'])) && String(attribs['data-blocked-src']).length <= 2048) {
          out['data-blocked-src'] = String(attribs['data-blocked-src']);
          return { tagName: 'img', attribs: out };
        }
        if (!src && attribs['data-mail-cid']) {
          out['data-mail-cid'] = String(attribs['data-mail-cid']).slice(0, 200);
          return { tagName: 'img', attribs: out };
        }
        if (/^cid:/i.test(src)) {
          out['data-mail-cid'] = src.slice(4).replace(/^<|>$/g, '').trim().slice(0, 200);
          counters.inlineImages++;
        } else if (/^https:\/\//i.test(src) && src.length <= 2048) {
          out['data-blocked-src'] = src;
          counters.blockedImages++;
        } else if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(src) && src.length <= MAX_DATA_IMG) {
          out.src = src;
        } else {
          counters.droppedImages++;
          // Атрибутов src/data-* нет → exclusiveFilter ниже удалит тег целиком.
        }
        return { tagName: 'img', attribs: out };
      },
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === 'img') {
        const a = frame.attribs || {};
        return !a.src && !a['data-blocked-src'] && !a['data-mail-cid'];
      }
      return false;
    },
  };
}

/**
 * @param {string} rawHtml
 * @returns {{html:string, blockedImages:number, inlineImages:number, droppedImages:number, truncated:boolean}}
 */
function sanitizeEmailHtml(rawHtml) {
  let input = String(rawHtml == null ? '' : rawHtml);
  let truncated = false;
  if (Buffer.byteLength(input, 'utf8') > MAX_HTML_BYTES) {
    input = input.slice(0, MAX_HTML_BYTES);
    truncated = true;
  }
  const counters = { blockedImages: 0, inlineImages: 0, droppedImages: 0 };
  let html = sanitizeHtml(input, makeOptions(counters));
  if (truncated) {
    html += '<p data-mail-notice="truncated"><i>[Message clipped — the original is longer than 2 MB]</i></p>';
  }
  return { html, truncated, ...counters };
}

// HTML → plain text для bodyText/сниппетов (не для безопасности — для поиска и превью).
function htmlToText(rawHtml) {
  let s = String(rawHtml == null ? '' : rawHtml);
  if (Buffer.byteLength(s, 'utf8') > MAX_HTML_BYTES) s = s.slice(0, MAX_HTML_BYTES);
  s = s.replace(/<(script|style|head|title|template|svg|math|iframe|object|noscript)[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table|section|article|header|footer|dd|dt)\s*>/gi, '\n');
  s = s.replace(/<\/t[dh]\s*>/gi, '\t');
  s = sanitizeHtml(s, { allowedTags: [], allowedAttributes: {}, nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'head', 'title'] });
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+\n/g, '\n').replace(/\n[ \t\u00a0]+/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t\u00a0]{2,}/g, ' ');
  return s.trim();
}

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'" };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, code) => {
    const lower = code.toLowerCase();
    if (lower[0] === '#') {
      const n = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      if (Number.isFinite(n) && n > 0 && n < 0x110000) { try { return String.fromCodePoint(n); } catch (e) { return m; } }
      return m;
    }
    return ENTITY_MAP[lower] != null ? ENTITY_MAP[lower] : m;
  });
}

module.exports = { sanitizeEmailHtml, htmlToText, decodeEntities, MAX_HTML_BYTES };
