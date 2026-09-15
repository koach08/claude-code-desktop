// 本物の git で、切り離しが効いているかを通しで見る。
// ⚠️ ここが効いていないと「気に入らなければ捨てる」が成立しない。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { planIsolation } = require('../src/isolate');

const git = (at, args) => execFileSync('git', args, { cwd: at, encoding: 'utf-8' });

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, '授業.md'), '元の中身\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'first']);
  return dir;
}

test('作業ツリーの中で書いても、元は変わらない', () => {
  const repo = makeRepo();
  const iso = planIsolation({ cwd: repo, label: '第3回スライド', write: true, isGitRepo: true, stamp: Date.now() });
  assert.strictEqual(iso.kind, 'worktree');

  fs.mkdirSync(path.dirname(iso.dir), { recursive: true });
  git(repo, iso.plan.addArgs);

  // 作業員のつもりで、既存を書き換えて、新しいファイルも足す
  fs.writeFileSync(path.join(iso.dir, '授業.md'), '作業員が書き換えた\n');
  fs.writeFileSync(path.join(iso.dir, '第3回.md'), '新しく作った\n');

  // ⚠️ 畳む前に差分を取る。add -A しないと新しいファイルが差分に入らない
  git(iso.dir, iso.plan.stageArgs);
  const diff = git(iso.dir, iso.plan.diffArgs);

  assert.match(diff, /作業員が書き換えた/, '書き換えが差分に出ていない');
  assert.match(diff, /第3回\.md/, '新しいファイルが差分に出ていない (add -A の取りこぼし)');

  // 元は無傷か
  assert.strictEqual(fs.readFileSync(path.join(repo, '授業.md'), 'utf-8'), '元の中身\n');
  assert.ok(!fs.existsSync(path.join(repo, '第3回.md')), '元に新しいファイルが漏れている');
  assert.strictEqual(git(repo, ['status', '--porcelain']).trim(), '', '元のツリーが汚れている');

  // 畳んだら、作業ツリーも枝も残らない
  git(repo, iso.plan.removeArgs);
  git(repo, iso.plan.deleteBranchArgs);
  assert.ok(!fs.existsSync(iso.dir), '作業ツリーが残っている');
  assert.ok(!git(repo, ['branch', '--list']).includes('ariya/'), '枝が残っている');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('元に未コミットの変更があっても、作業ツリーには持ち込まれない', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, '授業.md'), '書きかけ\n');   // わざと汚しておく

  const iso = planIsolation({ cwd: repo, label: 'x', write: true, isGitRepo: true, stamp: Date.now() });
  fs.mkdirSync(path.dirname(iso.dir), { recursive: true });
  git(repo, iso.plan.addArgs);

  // HEAD から切るので、書きかけは入らない
  assert.strictEqual(fs.readFileSync(path.join(iso.dir, '授業.md'), 'utf-8'), '元の中身\n');
  // 元の書きかけも無事
  assert.strictEqual(fs.readFileSync(path.join(repo, '授業.md'), 'utf-8'), '書きかけ\n');

  git(repo, iso.plan.removeArgs);
  git(repo, iso.plan.deleteBranchArgs);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('捨てるだけで元に戻る (patch を当てなければ何も起きない)', () => {
  const repo = makeRepo();
  const before = git(repo, ['rev-parse', 'HEAD']).trim();

  const iso = planIsolation({ cwd: repo, label: 'y', write: true, isGitRepo: true, stamp: Date.now() });
  fs.mkdirSync(path.dirname(iso.dir), { recursive: true });
  git(repo, iso.plan.addArgs);
  fs.writeFileSync(path.join(iso.dir, '授業.md'), 'めちゃくちゃに書き換えた\n');
  git(iso.dir, iso.plan.stageArgs);
  git(iso.dir, ['commit', '-q', '-m', 'work']);   // 作業員がコミットしても

  git(repo, iso.plan.removeArgs);
  git(repo, iso.plan.deleteBranchArgs);

  assert.strictEqual(git(repo, ['rev-parse', 'HEAD']).trim(), before, '元の HEAD が動いている');
  assert.strictEqual(fs.readFileSync(path.join(repo, '授業.md'), 'utf-8'), '元の中身\n');

  fs.rmSync(repo, { recursive: true, force: true });
});
