// 会話画面の Markdown。AI の返事にはメール本文や取得したページが混ざるので、
// 生の HTML が通らないこと(=画面で動かないこと)を最初に固定する。
const test = require('node:test');
const assert = require('node:assert');
const { render } = require('../src/chat-markdown');
const presets = require('../src/chat-presets');

test('生の HTML は文字として出る', () => {
  const h = render('<img src=x onerror=alert(1)> <script>x</script>');
  assert.ok(!/<img|<script/i.test(h));
  assert.ok(h.includes('&lt;img'));
});

test('リンクは http(s)/mailto だけ。javascript: は通さない', () => {
  assert.ok(render('[a](https://e.com)').includes('href="https://e.com"'));
  assert.ok(!render('[a](javascript:alert(1))').includes('href'));
  assert.ok(render('見て https://e.com/x です').includes('href="https://e.com/x"'));
});

test('よく出る形: 見出し・箇条書き・コード・表・太字', () => {
  const h = render('## 見出し\n\n- 一\n- **二**\n\n```js\nconst a = "<b>";\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(h.includes('<h3>見出し</h3>'));
  assert.ok(h.includes('<ul><li>一</li><li><strong>二</strong></li></ul>'));
  assert.ok(h.includes('<span class="code-lang">js</span>'));
  assert.ok(h.includes('const a = &quot;&lt;b&gt;&quot;;'));
  assert.ok(h.includes('<td>1</td><td>2</td>'));
});

test('コードの中では他の記法を効かせない', () => {
  assert.ok(render('`**x**`').includes('<code>**x**</code>'));
});

test('用途とキャラ: 追記プロンプトに両方が入り、知らない id は既定に倒れる', () => {
  const p = presets.systemPromptFor({ purpose: 'mail', character: 'kuro' });
  assert.ok(p.includes('クロ'));
  assert.ok(p.includes('送信・転送・削除'));
  assert.strictEqual(presets.purposeOf('nope').id, 'general');
  assert.strictEqual(presets.characterOf('nope').id, 'ariya');
  assert.strictEqual(presets.characterOf('x', [{ id: 'x', name: 'X' }]).name, 'X');
});
