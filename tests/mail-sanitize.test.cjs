// Тест functions/mail-sanitize.js (UNIT_EMAIL_PLAN.md § 6.1).
// Запуск: node tests/mail-sanitize.test.cjs  (нужен functions/node_modules с sanitize-html).
// Настоящий sanitize-html, без сети.
'use strict';
const assert = require('assert');
const path = require('path');

const FN_DIR = process.env.SFA_FN_DIR || path.join(__dirname, '..', 'functions');
const { sanitizeEmailHtml, htmlToText, decodeEntities } = require(path.join(FN_DIR, 'mail-sanitize.js'));

let n = 0;
function t(name, fn) { fn(); n++; console.log('  ✓ ' + name); }
const S = (html) => sanitizeEmailHtml(html);

t('script удаляется вместе с содержимым', () => {
  const r = S('<p>hi</p><script>alert(1)</script><p>there</p>');
  assert.ok(!/script|alert/.test(r.html), r.html);
  assert.ok(/<p>hi<\/p><p>there<\/p>/.test(r.html));
});

t('on*-атрибуты и javascript: href вырезаются', () => {
  const r = S('<a href="javascript:alert(1)" onclick="x()">x</a><img src="x" onerror="alert(1)">');
  assert.ok(!/onclick|onerror|javascript/.test(r.html), r.html);
  assert.ok(!/<img/.test(r.html), 'img без допустимого src удалён');
});

t('http: ссылки отбрасываются, https: получают target/rel', () => {
  const r = S('<a href="http://evil.test/x">a</a><a href="https://ok.test/y">b</a><a href="mailto:t@x.com">c</a><a href="tel:+15551234567">d</a>');
  assert.ok(!/http:\/\/evil/.test(r.html), r.html);
  assert.ok(/<a href="https:\/\/ok\.test\/y" target="_blank" rel="noopener noreferrer nofollow">b<\/a>/.test(r.html), r.html);
  assert.ok(/href="mailto:t@x\.com"/.test(r.html));
  assert.ok(/href="tel:\+15551234567"/.test(r.html));
});

t('style: url()/expression() вырезаются, цвет и размер остаются', () => {
  const r = S('<p style="color:#ff0000;background:url(https://t.test/p.gif);font-size:14px;width:expression(alert(1))">x</p>');
  assert.ok(/color:#ff0000/.test(r.html), r.html);
  assert.ok(/font-size:14px/.test(r.html), r.html);
  assert.ok(!/url\(|expression/.test(r.html), r.html);
});

t('<style>@import и <iframe>/<form>/<object>/<svg> удаляются с содержимым', () => {
  const r = S('<style>@import url(https://x);</style><iframe src="https://x"></iframe><form action="https://x"><input name="pw"></form><object data="x"></object><svg onload="a()"><circle/></svg><p>ok</p>');
  assert.strictEqual(r.html.replace(/\s+/g, ''), '<p>ok</p>');
});

t('удалённые изображения не грузятся: src → data-blocked-src', () => {
  const r = S('<img src="https://track.test/pixel.gif" width="1" height="1" alt="">');
  assert.ok(!/ src=/.test(r.html), r.html);
  assert.ok(/data-blocked-src="https:\/\/track\.test\/pixel\.gif"/.test(r.html), r.html);
  assert.strictEqual(r.blockedImages, 1);
});

t('cid: → data-mail-cid; data:image остаётся; http: img удаляется', () => {
  const r = S('<img src="cid:logo@x"><img src="data:image/png;base64,iVBORw0KGgo="><img src="http://x/y.png">');
  assert.ok(/data-mail-cid="logo@x"/.test(r.html), r.html);
  assert.ok(/src="data:image\/png;base64,iVBORw0KGgo="/.test(r.html), r.html);
  assert.strictEqual((r.html.match(/<img/g) || []).length, 2, r.html);
  assert.strictEqual(r.inlineImages, 1);
  assert.strictEqual(r.droppedImages, 1);
});

t('таблицы и инлайн-форматирование сохраняются', () => {
  const r = S('<table border="1"><tr><td align="left" style="padding:4px">A</td><td>B</td></tr></table><b>bold</b> <font color="#333">f</font>');
  assert.ok(/<table border="1"><tr><td align="left" style="padding:4px">A<\/td><td>B<\/td><\/tr><\/table>/.test(r.html.replace(/<tbody>|<\/tbody>/g, '')), r.html);
  assert.ok(/<b>bold<\/b>/.test(r.html));
  assert.ok(/<font color="#333">f<\/font>/.test(r.html));
});

t('идемпотентность: повторная санитизация не меняет результат', () => {
  const once = S('<div style="color:red"><a href="https://a.test">x</a><img src="https://a.test/i.png"><p>t &amp; u</p></div>').html;
  const twice = S(once).html;
  assert.strictEqual(twice, once);
});

t('cap 2 МБ: обрезка + пометка truncated', () => {
  const big = '<p>' + 'x'.repeat(2 * 1024 * 1024 + 10) + '</p>';
  const r = S(big);
  assert.strictEqual(r.truncated, true);
  assert.ok(/Message clipped/.test(r.html));
});

t('глубокая вложенность не роняет санитайзер', () => {
  const deep = '<div>'.repeat(500) + 'x' + '</div>'.repeat(500);
  const r = S(deep);
  assert.ok(typeof r.html === 'string');
});

t('htmlToText: переносы, сущности, удаление скриптов', () => {
  const txt = htmlToText('<style>p{}</style><p>Hello &amp; <b>world</b></p><script>x</script><div>line2<br>line3</div>&nbsp;&#169;');
  assert.ok(/^Hello & world\nline2\nline3/.test(txt), JSON.stringify(txt));
  assert.ok(/©$/.test(txt), JSON.stringify(txt));
  assert.ok(!/style|script|p\{\}/.test(txt));
});

t('decodeEntities', () => {
  assert.strictEqual(decodeEntities('a &lt; b &amp;&amp; c &#x41;&#66; &quot;q&quot;'), 'a < b && c AB "q"');
});

console.log(`\nmail-sanitize: ${n} tests passed`);
