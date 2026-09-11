// Web タブ(サイトをこのアプリの中のタブで開く)の守り。
// 中身のサイトは別のレンダラで動くので、node と preload を渡さない・http(s) 以外を付けない。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf-8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf-8');

test('webview を許可し、付く前に preload/node を落として http(s) 以外を止める', () => {
  assert.match(main, /webviewTag: true/);
  const i = main.indexOf("'will-attach-webview'");
  assert.ok(i > 0);
  const block = main.slice(i, i + 500);
  assert.match(block, /delete webPreferences\.preload/);
  assert.match(block, /nodeIntegration = false/);
  assert.match(block, /event\.preventDefault\(\)/);
});

test('ログインは persist:web に残し、ポップアップも同じ領域で開く', () => {
  assert.match(renderer, /setAttribute\('partition', 'persist:web'\)/);
  assert.match(main, /partition: 'persist:web'/);
  assert.match(main, /setWindowOpenHandler/);
});

test('Web ボタンはエンジンの再起動(switchSessionMode)に流さない', () => {
  assert.match(renderer, /if \(b\.dataset\.mode === 'web'\) \{ openWebPicker\(\); return; \}/);
  assert.match(html, /data-mode="web"/);
});

test('端末タブへ切り替えたら Web タブは全部おろす(重なって見えない事故を防ぐ)', () => {
  const i = renderer.indexOf('function switchTab(id)');
  const block = renderer.slice(i, i + 400);
  assert.match(block, /webTabs\.forEach\(\(w\) => \{ w\.tabEl\.classList\.remove\('active'\); w\.pane\.classList\.remove\('active'\); \}\)/);
});

test('保存する URL は http(s) だけ', () => {
  const i = main.indexOf("'save-web-tabs'");
  assert.match(main.slice(i, i + 600), /https\?:/);
});
