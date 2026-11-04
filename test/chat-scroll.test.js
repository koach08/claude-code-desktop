// 会話タブがスクロールできなくなった不具合の再発防止(2026-11-04)
// .pane は position: absolute; inset: 0 で枠に収まる。.pane.chat に position: relative を
// 当てると中身の高さまで伸び、.chat-scroll にスクロールの余地がなくなって下が切れる
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf-8');

test('.pane は枠に収まる形のまま', () => {
  assert.match(css, /\.pane \{ position: absolute; inset: 0;/);
});

test('.pane.chat で position を上書きしない', () => {
  const rules = css.match(/(^|\n)\s*\.pane\.chat\s*\{[^}]*\}/g) || [];
  assert.ok(rules.length > 0, '.pane.chat の規則が見つからない');
  for (const r of rules) assert.doesNotMatch(r, /position\s*:/);
});
