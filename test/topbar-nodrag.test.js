// topbar(窓を掴む領域)に置いたボタンは no-drag に入っていないと click が届かない。
// ↗(他のアプリの会話を開く)が「押しても何も起きない」で踏んだ(2026-09-11)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf-8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf-8');

test('topbar 直下の button は全部 no-drag の選択子に入っている', () => {
  const top = html.slice(html.indexOf('<div id="topbar">'), html.indexOf('<div id="topbar-spacer">'));
  const ids = [...top.matchAll(/<button id="([^"]+)"/g)].map((m) => m[1]);
  const m = css.match(/([^{}]+)\{\s*-webkit-app-region:\s*no-drag;\s*\}/);
  assert.ok(m, 'no-drag のルールが無い');
  const sel = m[1];
  for (const id of ids) assert.ok(sel.includes(`#${id}`), `#${id} が no-drag に入っていない(押しても窓を掴むだけになる)`);
  assert.ok(sel.includes('#engine-suggest-btn'), '#engine-suggest-btn も同じ列にある');
});
