// Claude Code のセッションから起動されても、タブの claude を「子セッション」にしない。
// 子セッション扱いだと会話が保存されず --resume で戻らない(2026-09-11 に半日分のタブがそうなった)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
const sw = fs.readFileSync(path.join(__dirname, '..', 'switchover.sh'), 'utf-8');

test('main.js はエンジンに渡す環境から CLAUDECODE / CLAUDE_CODE_CHILD_SESSION を外す', () => {
  assert.match(main, /CLAUDE_INHERIT_KEYS = \['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION'/);
  assert.ok((main.match(/scrubInheritedClaudeEnv\(shellEnv\)/g) || []).length >= 2, '初期化とログインシェル読込の両方で外す');
});

test('switchover.sh は open の前に同じ変数を外す', () => {
  const opens = sw.match(/^[^#\n]*\bopen "\$DST"/gm) || [];
  assert.ok(opens.length >= 1);
  for (const line of opens) assert.match(line, /env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION/, `外していない: ${line.trim()}`);
});
