const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { planWorktree, safeLabel, worktreeRoot } = require('../src/worktree');

test('ラベルから枝名とディレクトリを決める', () => {
  const p = planWorktree('/repo', '表示を速くしたい', 1756500000000);
  assert.strictEqual(p.branch, 'ariya/表示を速くしたい-1756500000000');
  assert.ok(p.dir.startsWith(worktreeRoot()));
  assert.ok(p.addArgs.includes('-b') && p.addArgs.includes('HEAD'));
});

test('日本語は残す(落とすと何の作業か分からなくなる)', () => {
  assert.strictEqual(safeLabel('表示を速くしたい / main.js', 1), '表示を速くしたい-main.js');
  assert.strictEqual(safeLabel('カタカナとひらがな', 1), 'カタカナとひらがな');
});

test('git が受け付けない文字は落とす', () => {
  assert.strictEqual(safeLabel('a b:c^d~e[f]g', 1), 'a-b-c-d-e-f-g');
  assert.ok(!/[\s~^:?*[\]\\]/.test(safeLabel('a ~^:?*[]\\ b', 1)));
});

test('空になったら日時で埋める', () => {
  assert.strictEqual(safeLabel('...', 99), 'run-99');
  assert.strictEqual(safeLabel('', 99), 'run-99');
  assert.strictEqual(safeLabel(null, 99), 'run-99');
});

test('長すぎるラベルは切るが、末尾に区切りを残さない', () => {
  const s = safeLabel('あ'.repeat(60), 1);
  assert.ok(s.length <= 24, `長すぎる: ${s.length}`);
  assert.ok(!/[-.]$/.test(s));
});

test('作業ツリーはリポジトリの外に作る', () => {
  // 中に作ると、そのリポジトリを読むエージェントが自分の作業ツリーを読み始める。
  const p = planWorktree('/repo/here', 'x', 1);
  assert.ok(!p.dir.startsWith('/repo/here'));
});

// 実際に git を叩いて、組み立てたコマンドが通ることまで見る。
// 使い捨てのリポジトリを一時領域に作るので、手元のリポジトリには触らない。
test('組み立てたコマンドで、実際に隔離して差分が取れる', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ariya-wt-test-'));
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf-8' });
  try {
    git(['init', '-q', '-b', 'main'], base);
    git(['config', 'user.email', 'test@example.com'], base);
    git(['config', 'user.name', 'test'], base);
    fs.writeFileSync(path.join(base, 'a.txt'), 'もとの中身\n');
    git(['add', '.'], base);
    git(['commit', '-qm', 'init'], base);

    const plan = planWorktree(base, 'テスト作業', 1756500000001);
    git(plan.addArgs, base);
    assert.ok(fs.existsSync(plan.dir), '作業ツリーができていない');

    // 隔離した側だけを書き換える
    fs.writeFileSync(path.join(plan.dir, 'a.txt'), '書き換えた\n');
    const diff = git(plan.diffArgs, plan.dir);
    assert.ok(diff.includes('書き換えた'), '差分が取れていない');

    // 元のリポジトリは無傷であること。ここが隔離の目的。
    assert.strictEqual(fs.readFileSync(path.join(base, 'a.txt'), 'utf-8'), 'もとの中身\n');
    assert.strictEqual(git(['status', '--porcelain'], base).trim(), '');

    git(plan.removeArgs, base);
    assert.ok(!fs.existsSync(plan.dir), '後片付けができていない');
    git(plan.deleteBranchArgs, base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
