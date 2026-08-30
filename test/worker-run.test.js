const test = require('node:test');
const assert = require('node:assert');
const { runProcess } = require('../src/worker-run');

const done = (opts) => new Promise((res) => runProcess(opts, { onDone: res }));

test('普通に終わったら出力と ok を返す', async () => {
  const r = await done({ bin: '/bin/echo', args: ['やあ'], cwd: '/tmp' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.trim(), 'やあ');
  assert.strictEqual(r.killed, false);
});

test('終了コードが 0 でなければ ok は立たない', async () => {
  const r = await done({ bin: '/bin/sh', args: ['-c', 'exit 3'], cwd: '/tmp' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 3);
});

test('標準エラーも拾う', async () => {
  const r = await done({ bin: '/bin/sh', args: ['-c', 'echo だめ >&2'], cwd: '/tmp' });
  assert.ok(r.err.includes('だめ'));
});

// ここが3社リレーで見つかった穴。Node は spawn に失敗すると error と close の
// 両方を出すので、素直に書くと完了が2回飛び、あとから来る close(code=-2, err 空)
// が本当の理由 ENOENT を覆い隠す。
test('起動できないときでも、完了は1回しか流れない', async () => {
  const calls = [];
  await new Promise((res) => {
    runProcess(
      { bin: 'ariya-no-such-binary-xyz', args: [], cwd: '/tmp' },
      { onDone: (r) => { calls.push(r); setTimeout(res, 300); } },
    );
  });
  assert.strictEqual(calls.length, 1, `完了が ${calls.length} 回流れた`);
  assert.strictEqual(calls[0].ok, false);
  // 覆い隠されずに理由が残っていること。
  assert.ok(/ENOENT/.test(calls[0].err), `理由が消えている: ${calls[0].err}`);
});

test('止めたら killed が立ち、ok にはならない', async () => {
  const r = await new Promise((res) => {
    const h = runProcess({ bin: '/bin/sleep', args: ['30'], cwd: '/tmp' }, { onDone: res });
    setTimeout(() => h.cancel(), 100);
  });
  assert.strictEqual(r.killed, true);
  assert.strictEqual(r.ok, false);
});

test('時間切れでも止まる', async () => {
  const r = await done({ bin: '/bin/sleep', args: ['30'], cwd: '/tmp', timeoutMs: 150 });
  assert.strictEqual(r.killed, true);
  assert.ok(r.ms < 5000, `時間切れが効いていない: ${r.ms}ms`);
});

test('終わったあとに止めても何も起きない', async () => {
  let n = 0;
  const h = await new Promise((res) => {
    const handle = runProcess({ bin: '/bin/echo', args: ['ok'], cwd: '/tmp' },
      { onDone: () => { n++; res(handle); } });
  });
  assert.strictEqual(h.cancel(), false);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(n, 1);
});

test('出力が上限を超えたら truncated を立てる', async () => {
  const r = await done({
    bin: '/bin/sh', args: ['-c', 'for i in 1 2 3 4 5 6 7 8; do echo 0123456789; done'],
    cwd: '/tmp', maxOutput: 20,
  });
  assert.strictEqual(r.truncated, true);
});

test('出力は届いたそばから流れる', async () => {
  const chunks = [];
  await new Promise((res) => {
    runProcess({ bin: '/bin/sh', args: ['-c', 'echo あ; echo い'], cwd: '/tmp' },
      { onOutput: (d) => chunks.push(d), onDone: res });
  });
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.every((c) => c.which === 'out' || c.which === 'err'));
});

test('cwd がそのまま子プロセスに渡る', async () => {
  const r = await done({ bin: '/bin/pwd', args: [], cwd: '/tmp' });
  assert.ok(r.out.trim().endsWith('/tmp'));
});

test('1回のチャンクが上限より大きくても、上限を超えて溜めない', () => {
  // 「足す前に長さを見る」だけだと、空の状態から一気に超える。
  const chunks = [];
  return new Promise((res) => {
    runProcess({
      bin: '/bin/sh', args: ['-c', 'printf "%01000d" 0'], cwd: '/tmp', maxOutput: 100,
    }, { onOutput: (d) => chunks.push(d), onDone: (r) => {
      assert.strictEqual(r.truncated, true);
      assert.ok(r.out.length <= 100, `上限を超えて溜まった: ${r.out.length}`);
      // 画面に流すぶんは切らない(見えている出力まで欠けると分かりにくい)。
      assert.ok(chunks.some((c) => c.text.length > 100));
      res();
    } });
  });
});

// ── 孫プロセスまで落とす ──────────────────────────────────
//
// 各エンジンは実行中に MCP サーバや ripgrep や bash を子として起こす。
// 直下の1本に signal を送っても、孫は親を失って走り続ける(夜間リレーの点検で出た)。

test('止めたとき、孫プロセスも道連れにする', async () => {
  const marker = `ariya-test-grandchild-${process.pid}`;
  const alive = () => {
    try {
      return require('child_process')
        .execSync(`pgrep -f ${marker} | wc -l`, { encoding: 'utf-8' }).trim() !== '0';
    } catch { return false; }
  };
  const h = runProcess({
    // 孫として sleep を起こし、親は待つだけ
    bin: '/bin/sh', args: ['-c', `sleep 30 & echo ${marker} >/dev/null; wait`], cwd: '/tmp',
  }, { onDone: () => {} });
  await new Promise((r) => setTimeout(r, 400));
  h.cancel();
  await new Promise((r) => setTimeout(r, 4500));   // SIGKILL の追い討ちを待つ
  assert.strictEqual(alive(), false, '孫プロセスが残っている');
});
