// ブラウザから操作窓を叩けるようにした部分の守り。
// ⚠️ ここを緩めると、開いている別のサイトから端末を叩ける。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'control-server.js'), 'utf-8');

test('許すのは本人の画面だけ。ワイルドカードを使っていない', () => {
  assert.ok(!/Allow-Origin'\s*,\s*'\*'/.test(src), 'Allow-Origin に * を使っている');
  assert.match(src, /ALLOWED_ORIGINS\s*=\s*\[/);
});

test('許可先に koach-os の本番が入っている', () => {
  assert.match(src, /https:\/\/koach-os\.vercel\.app/);
});

test('知らない画面には許可を返さない', () => {
  assert.match(src, /if \(!ALLOWED_ORIGINS\.includes\(origin\)\) return;/);
});

test('合言葉の確認は外していない', () => {
  assert.match(src, /auth !== token/);
});

test('下見の問い合わせだけは合言葉なしで通す', () => {
  // ⚠️ ここで 401 を返すとブラウザが本番の要求を送れない
  const i = src.indexOf("req.method === 'OPTIONS'");
  const j = src.indexOf('auth !== token');
  assert.ok(i > 0 && i < j, 'OPTIONS の処理が合言葉の確認より後にある');
});

test('外に向けて開いていない', () => {
  assert.match(src, /server\.listen\(PORT, '127\.0\.0\.1'/);
  assert.ok(!/listen\(PORT, '0\.0\.0\.0'/.test(src));
});
