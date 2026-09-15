// 書き込む作業を元の場所から切り離す判断。
// ⚠️ 「隔離できなかったので、そのまま書きました」がいちばん困る。そこを見張る。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { planIsolation, folderPreamble, workRoot, spoken } = require('../src/isolate');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

test('読むだけなら切り離さない', () => {
  const r = planIsolation({ cwd: '/repo', label: '調べる', write: false, isGitRepo: true });
  assert.strictEqual(r.kind, 'direct');
  assert.strictEqual(r.dir, '/repo');
});

test('git のリポジトリは worktree を切る', () => {
  const r = planIsolation({ cwd: '/repo', label: 'サイトを直す', write: true, isGitRepo: true, stamp: 7 });
  assert.strictEqual(r.kind, 'worktree');
  assert.match(r.plan.branch, /^ariya\//);
  assert.notStrictEqual(r.dir, '/repo', '元の場所をそのまま返している');
  assert.ok(r.plan.addArgs.includes('worktree'));
});

test('git でない場所は新しい作業フォルダにする', () => {
  const r = planIsolation({ cwd: '/Users/k/Documents/授業準備', label: '第3回スライド', write: true, isGitRepo: false, stamp: 7 });
  assert.strictEqual(r.kind, 'folder');
  assert.ok(r.dir.startsWith(workRoot()), '本人の持ち物の下に置いていない');
  assert.strictEqual(r.readFrom, '/Users/k/Documents/授業準備');
  assert.notStrictEqual(r.dir, r.readFrom);
});

test('成果物を一時領域に置かない (再起動で消えるため)', () => {
  const r = planIsolation({ cwd: '/x', label: 'スライド', write: true, isGitRepo: false, stamp: 1 });
  assert.ok(!r.dir.startsWith('/tmp'), '一時領域に置いている');
});

test('場所が分からなければ断る', () => {
  assert.strictEqual(planIsolation({ label: 'x', write: true }).kind, 'refuse');
  assert.strictEqual(planIsolation({ cwd: '', label: 'x', write: true }).kind, 'refuse');
});

test('フォルダ方式では、参照元と作業場所の両方を依頼文に書く', () => {
  const p = folderPreamble('/元', '/作業');
  assert.match(p, /\/元/);
  assert.match(p, /\/作業/);
  assert.match(p, /変更しないでください/);
});

test('何をするかを声で言える', () => {
  assert.match(spoken({ kind: 'worktree' }), /元を触らない/);
  assert.match(spoken({ kind: 'folder' }), /読むだけ/);
  assert.match(spoken({ kind: 'refuse', reason: 'だめ' }), /始めません/);
});

// ── 呼び出し側の作り ──
test('隔離に失敗したら書き込みを断っている', () => {
  const i = mainSrc.indexOf('作業ツリーを作れませんでした');
  assert.ok(i > 0, '失敗時の分岐が無い');
  const around = mainSrc.slice(i - 300, i + 200);
  assert.match(around, /return \{ ok: false/, '失敗しても続行している');
});

test('畳む前に差分を取っている', () => {
  const stage = mainSrc.indexOf('cleanup.stageArgs');
  const tidy = mainSrc.indexOf('tidyWorktree(target, cleanup)', stage);
  assert.ok(stage > 0 && tidy > stage, '差分を取る前に畳んでいる (成果物が消える)');
});

test('git を文字の連結で組み立てていない', () => {
  assert.match(mainSrc, /execFileSync\('git', args/);
  assert.ok(!/execSync\(`git /.test(mainSrc), 'git をシェル経由で叩いている');
});

test('読み取りのときは切り離さない (元の場所をそのまま見せる)', () => {
  assert.match(mainSrc, /write: !!write, isGitRepo: isGitRepo\(target\)/);
});
