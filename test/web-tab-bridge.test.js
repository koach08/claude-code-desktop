// Web タブを外から読む・書く・押す橋。サイトの構造ではなく「守り」と「振り分け」を試す。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../src/web-tab-bridge');
const { judgeEngine } = require('../src/engine-judge');

test('作業に応じて投げ先が決まる: 画面操作は ChatGPT、書き物は Claude、コードベース横断は Web に投げない', () => {
  assert.strictEqual(B.pickWebTarget(judgeEngine('Excelを操作して入力を代わりにやって')), 'chatgpt');
  assert.strictEqual(B.pickWebTarget(judgeEngine('note の記事の下書きを書いて')), 'claude');
  assert.strictEqual(B.pickWebTarget(judgeEngine('既存のコードベース全体をリファクタして')), null);
});

test('EGAKU は ChatGPT に行かない(Claude 固定)', () => {
  assert.strictEqual(B.pickWebTarget(judgeEngine('EGAKU の管理画面を操作して入力を代わりにやって')), 'claude');
});

test('制御文字は落とし、長さに上限がある', () => {
  const s = B.cleanText('a\x03b\x1bc\n', 5);
  assert.strictEqual(s, 'abc\n');
  assert.strictEqual(B.cleanText('x'.repeat(100), 10).length, 10);
});

test('ページに流すスクリプトは text を JSON で埋める(閉じ引用で抜けない)', () => {
  const js = B.askScript('"); alert(1); ("', true);
  assert.ok(js.includes(JSON.stringify('"); alert(1); ("')));
  assert.ok(!/\)\("\); alert\(1\)/.test(js.replace(JSON.stringify('"); alert(1); ("'), '')));
  const c = B.clickScript('</script>', 'x');
  assert.ok(c.includes(JSON.stringify('</script>')));
});

test('タブの当たり判定は https の正しいホストだけ', () => {
  assert.ok(B.tabMatches({ url: 'https://chatgpt.com/c/abc' }, 'chatgpt'));
  assert.ok(!B.tabMatches({ url: 'https://chatgpt.com.evil.example/' }, 'chatgpt'));
  assert.ok(B.tabMatches({ url: 'https://claude.ai/new' }, 'claude'));
  assert.ok(!B.tabMatches({ url: 'http://claude.ai/' }, 'claude'));
});

test('制御窓の /web は合言葉の後・control-off の後にある', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'control-server.js'), 'utf-8');
  const auth = src.indexOf('auth !== token');
  const off = src.indexOf('writesBlocked()) {');
  const web = src.indexOf("parts[0] === 'web'");
  assert.ok(auth > 0 && auth < web, '/web が合言葉の確認より前にある');
  assert.ok(off > 0 && off < web, '/web が control-off の確認より前にある');
});
