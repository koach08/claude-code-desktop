// 目の守り。⚠️ 画面にはパスワードも学生の成績も映る。ここが緩むと取り返しがつかない。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const screen = require('../src/screen');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screen.js'), 'utf-8');
const controlSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'control-server.js'), 'utf-8');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

function deps(over = {}) {
  const calls = { log: [], sources: 0 };
  const base = {
    readFile: () => JSON.stringify({ enabled: true }),
    log: (l) => calls.log.push(l),
    limiter: screen.createLimiter(),
    frontmost: async () => ({ app: 'Preview', title: '論文.pdf' }),
    getSources: async () => {
      calls.sources += 1;
      return [{ id: 'w:1', name: '論文.pdf', toPNG: () => Buffer.from('PNGDATA') }];
    },
  };
  return [{ ...base, ...over }, calls];
}

// ── 既定は閉じている ──
test('既定では目は閉じている', () => {
  assert.strictEqual(screen.DEFAULT_POLICY.enabled, false);
});

test('許可していなければ撮らない', async () => {
  const [d, calls] = deps({ readFile: () => { throw new Error('no file'); } });
  const r = await screen.capture(d);
  assert.match(r.error, /許可されていません/);
  assert.strictEqual(calls.sources, 0, '断るのに絵を取りにいっている');
});

test('許可してあれば撮れる', async () => {
  const [d] = deps();
  const r = await screen.capture(d);
  assert.ok(r.png_base64);
  assert.strictEqual(r.app, 'Preview');
  assert.strictEqual(r.title, '論文.pdf');
});

// ── 見せない相手 ──
test('パスワード管理のアプリは、絵を読む前に断る', async () => {
  const [d, calls] = deps({ frontmost: async () => ({ app: '1Password', title: 'Vault' }) });
  const r = await screen.capture(d);
  assert.match(r.error, /見せない約束/);
  assert.strictEqual(calls.sources, 0, '断る相手の絵を取りにいっている');
  assert.ok(calls.log.some((l) => l.includes('断り')), '断ったことが記録に残っていない');
});

test('窓の名前でも断れる', async () => {
  const [d, calls] = deps({ frontmost: async () => ({ app: 'Safari', title: 'My Password Manager' }) });
  assert.match((await screen.capture(d)).error, /見せない約束/);
  assert.strictEqual(calls.sources, 0);
});

test('前面が Alfred 自身なら、そう言って撮らない', async () => {
  const [d, calls] = deps({ frontmost: async () => ({ app: 'Safari', title: 'Koach OS — Alfred Pennyworth' }) });
  const r = await screen.capture(d);
  assert.match(r.error, /前に出して/);
  assert.strictEqual(calls.sources, 0);
});

test('前面のアプリが分からないときは撮らない', async () => {
  const [d] = deps({ frontmost: async () => ({ app: '', title: '' }) });
  assert.ok((await screen.capture(d)).error);
});

// ── どの窓か ──
test('名前がそのまま当たれば、その窓', () => {
  const r = screen.pickWindow([{ name: 'a' }, { name: '論文.pdf' }], '論文.pdf');
  assert.strictEqual(r.source.name, '論文.pdf');
});

test('一つに決まらないときは撮らない (画面全体に広げない)', () => {
  const r = screen.pickWindow([{ name: '論文 A' }, { name: '論文 B' }], '論文');
  assert.ok(r.error);
  assert.ok(!r.source);
  assert.ok(r.candidates.length >= 2);
});

test('当たる窓が無ければ撮らない', () => {
  assert.ok(screen.pickWindow([{ name: 'a' }], 'b').error);
});

test('窓の名前が空なら撮らない', () => {
  assert.ok(screen.pickWindow([{ name: 'a' }], '').error);
});

// ── 回数 ──
test('1 分あたりの回数に頭を打つ', () => {
  let t = 0;
  const lim = screen.createLimiter(() => t);
  for (let i = 0; i < 10; i += 1) assert.ok(lim.ok(10), `${i} 回目で断られた`);
  assert.ok(!lim.ok(10), '11 回目が通った');
  t += 61000;
  assert.ok(lim.ok(10), '1 分後に戻らない');
});

test('撮りすぎたら断る', async () => {
  const [d] = deps({ readFile: () => JSON.stringify({ enabled: true, max_per_minute: 1 }) });
  assert.ok((await screen.capture(d)).png_base64);
  assert.match((await screen.capture(d)).error, /撮りすぎ/);
});

// ── policy の壊れ方 ──
test('壊れた policy は「全部許す」ではなく既定に落ちる', () => {
  const p = screen.loadPolicy(() => '{ これは JSON ではない');
  assert.strictEqual(p.enabled, false);
  assert.ok(p.deny_apps.includes('1Password'));
});

test('deny 一覧を空でない別物にすり替えられても、形が違えば既定に戻る', () => {
  const p = screen.loadPolicy(() => JSON.stringify({ enabled: true, deny_apps: 'none' }));
  assert.ok(Array.isArray(p.deny_apps));
  assert.ok(p.deny_apps.includes('1Password'));
});

// ── 開け方 ──
test('目を開けるには Mac のダイアログで「はい」が要る', async () => {
  let written = null;
  const asked = [];
  const r = await screen.enable({
    log: () => {}, readFile: () => '{}',
    writeFile: (_, s) => { written = s; },
    confirm: async (m) => { asked.push(m); return false; },
  }, true);
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(written, null, '断られたのに書き込んでいる');
  assert.strictEqual(asked.length, 1, 'ダイアログを出していない');
});

test('「はい」なら開く', async () => {
  let written = null;
  const r = await screen.enable({
    log: () => {}, readFile: () => '{}',
    writeFile: (_, s) => { written = s; },
    confirm: async () => true,
  }, true);
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(JSON.parse(written).enabled, true);
});

test('閉じるときは聞かない (締める側は手間をかけない)', async () => {
  let asked = 0;
  const r = await screen.enable({
    log: () => {}, readFile: () => JSON.stringify({ enabled: true }),
    writeFile: () => {}, confirm: async () => { asked += 1; return true; },
  }, false);
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(asked, 0);
});

// ── 作りそのもの ──
test('画面全体を撮る道を用意していない', () => {
  assert.ok(!/types:\s*\[[^\]]*'screen'/.test(mainSrc), "desktopCapturer に 'screen' を渡している");
  assert.match(mainSrc, /types:\s*\['window'\]/);
});

test('止め札が置いてあるときは撮らない', () => {
  const i = controlSrc.indexOf("parts[0] === 'screen' && parts.length === 1");
  const j = controlSrc.indexOf('writesBlocked()', i);
  assert.ok(i > 0 && j > i && j - i < 400, '/screen が control-off を見ていない');
});

test('絵をディスクに残していない', () => {
  assert.ok(!/writeFileSync\([^)]*png/i.test(src), '撮った絵を書き出している');
});

test('AppleScript に文字を埋め込んでいない', () => {
  // ⚠️ 窓の名前をスクリプトに差し込むと、名前の中身で別の命令になりうる
  assert.ok(!/FRONTMOST_SCRIPT[^;]*\$\{/.test(mainSrc), 'AppleScript に値を差し込んでいる');
});

test('撮ったことを知らせている', async () => {
  const told = [];
  const [d] = deps({ announce: (app, title) => told.push([app, title]) });
  await screen.capture(d);
  assert.deepStrictEqual(told, [['Preview', '論文.pdf']], '撮ったのに知らせていない');
});

test('知らせに失敗しても撮影は成立する', async () => {
  const [d] = deps({ announce: () => { throw new Error('通知が出せない'); } });
  const r = await screen.capture(d);
  assert.ok(r.png_base64, '知らせに失敗したせいで撮影ごと落ちている');
});

test('断ったときは知らせない', async () => {
  const told = [];
  const [d] = deps({ frontmost: async () => ({ app: '1Password', title: 'Vault' }),
                     announce: () => told.push(1) });
  await screen.capture(d);
  assert.deepStrictEqual(told, [], '撮っていないのに知らせている');
});

test('知らせる口を main.js が渡している', () => {
  assert.match(mainSrc, /announce:\s*\(appName, title\)/);
  assert.match(mainSrc, /画面を 1 枚見せました/);
});
