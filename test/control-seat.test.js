// オフィスの吹き出しから本物のタブへ返事を届ける口(2026-11-04)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'control-server.js'), 'utf-8');

test('タブ一覧で会話と結び付けられる', () => {
  assert.match(src, /conversation_id: s\.conversationId \|\| null/);
  assert.match(src, /sleeping: !!s\.sleeping/);
});

test('眠っている端末タブは、起こして落ち着いてから書く。会話タブは待たない', () => {
  const i = src.indexOf('await waitForQuiet(s)');
  const j = src.indexOf('s.pty.write(body.submit');
  assert.ok(i > 0 && i < j, '書く前に待っていない');
  assert.match(src, /s\.sleeping && s\.wake && s\.mode !== 'chat'/);
});

test('眠っているタブの古い画面を「許可待ち」と言わない', () => {
  assert.match(src, /!!s && !s\.sleeping && promptDetect\.isAwaitingUser/);
});
