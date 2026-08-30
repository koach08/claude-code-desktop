const test = require('node:test');
const assert = require('node:assert');
const { buildCommand, listEngines } = require('../src/worker-cmd');

const CWD = '/tmp/repo';

test('既定は読み取り専用で組み立てる', () => {
  assert.ok(buildCommand('codex', 'x', { cwd: CWD }).args.join(' ').includes('-s read-only'));
  assert.ok(buildCommand('gemini', 'x', { cwd: CWD }).args.join(' ').includes('--approval-mode plan'));
  // claude は道具を絞らないと既定で編集できてしまう。
  assert.ok(buildCommand('claude', 'x', { cwd: CWD }).args.includes('--allowed-tools'));
});

test('write を明示したときだけ書き込める形になる', () => {
  assert.ok(buildCommand('codex', 'x', { cwd: CWD, write: true }).args.join(' ').includes('workspace-write'));
  assert.ok(buildCommand('gemini', 'x', { cwd: CWD, write: true }).args.join(' ').includes('auto_edit'));
  assert.ok(!buildCommand('claude', 'x', { cwd: CWD, write: true }).args.includes('--allowed-tools'));
});

test('読み取り専用にできないエンジンは、読み取り専用で起動できない', () => {
  // 旗を返すだけだと呼ぶ側が見落とす。組み立ての時点で止める。
  assert.throws(() => buildCommand('grok', 'x', { cwd: CWD }), /読み取り専用で起動できない/);
  // 承知の上なら明示させる。
  assert.ok(buildCommand('grok', 'x', { cwd: CWD, allowUnsandboxed: true }).args.includes('run'));
  assert.ok(buildCommand('grok', 'x', { cwd: CWD, write: true }).args.includes('run'));
});

test('trust チェックを外す旗が付いている(git 外で黙って止まる穴)', () => {
  assert.ok(buildCommand('codex', 'x', { cwd: CWD }).args.includes('--skip-git-repo-check'));
  assert.ok(buildCommand('gemini', 'x', { cwd: CWD }).args.includes('--skip-trust'));
});

test('API キーが要るエンジンはそれを申告する', () => {
  assert.strictEqual(buildCommand('gemini', 'x', { cwd: CWD }).needsKey, 'GEMINI_API_KEY');
  assert.strictEqual(buildCommand('grok', 'x', { cwd: CWD, write: true }).needsKey, 'XAI_API_KEY');
  assert.strictEqual(buildCommand('claude', 'x', { cwd: CWD }).needsKey, null);
});

test('材料が足りなければ組み立てない', () => {
  assert.throws(() => buildCommand('claude', '', { cwd: CWD }), /タスクが空/);
  assert.throws(() => buildCommand('claude', 'x', {}), /cwd は必須/);
  assert.throws(() => buildCommand('unknown', 'x', { cwd: CWD }), /未知のエンジン/);
});

test('タスク文は引数として渡す(シェルを経由させない)', () => {
  const c = buildCommand('codex', 'rm -rf / ; echo "危ない文字列"', { cwd: CWD });
  assert.ok(c.args.includes('rm -rf / ; echo "危ない文字列"'));
});

test('エンジン一覧', () => {
  assert.deepStrictEqual(listEngines().sort(), ['claude', 'codex', 'gemini', 'grok']);
});
