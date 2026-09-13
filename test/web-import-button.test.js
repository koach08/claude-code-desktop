// ChatGPT のログイン取り込みを「押せる場所」に置いた部分の守り。
// 本人はメニューバーの項目を見つけられなかった(2026-09-12)。Web の画面の中にボタンを出し、
// Claude Code からも起こせるようにした。ここが外れると、また「押すところが無い」に戻る。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf-8');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf-8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf-8');
const control = fs.readFileSync(path.join(root, 'src', 'control-server.js'), 'utf-8');
const web = fs.readFileSync(path.join(root, 'tools', 'web.sh'), 'utf-8');

test('Web の画面にボタンがある(メニューバーだけに頼らない)', () => {
  assert.match(html, /id="web-import-brave"/);
  assert.match(html, /id="web-picker"/);
  const picker = html.slice(html.indexOf('id="web-picker"'), html.indexOf('id="external-picker"'));
  assert.ok(picker.includes('web-import-brave'), 'ボタンが Web の画面の中にない');
});

test('ボタンが押されたら取り込みが走る', () => {
  assert.match(renderer, /getElementById\('web-import-brave'\)\.addEventListener\('click'/);
  assert.match(renderer, /async function importBraveChatgpt\(/);
});

test('メニューからも起こせる(両方残す)', () => {
  assert.match(main, /'menu-action', 'import-brave-chatgpt'/);
  assert.match(renderer, /case 'import-brave-chatgpt':/);
});

test('件数が ok を上書きして成功を失敗に見せない', () => {
  // r.ok は「取り込めた件数」。{ok:true, ...r} と書くと 0 件のとき ok:0 になり失敗扱いになる。
  assert.ok(!/return \{ ok: true, \.\.\.r \}/.test(main), '{ok:true, ...r} が復活している');
  assert.match(main, /ok: true, set: r\.ok/);
  assert.match(renderer, /r\.set/);
});

test('Claude Code からも起こせる(制御窓の口と web.sh)', () => {
  assert.match(control, /parts\[1\] === 'import-brave'/);
  assert.match(web, /import\)\s+curl/);
  // 合言葉の確認より後にあること
  const auth = control.indexOf('auth !== token');
  const imp = control.indexOf("parts[1] === 'import-brave'");
  assert.ok(auth > 0 && auth < imp, '取り込みの口が合言葉の確認より前にある');
});

test('古い版では 503 を返す(黙って何もしない、にしない)', () => {
  assert.match(control, /web\.importBrave\b[\s\S]{0,120}503/);
});
