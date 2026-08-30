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
