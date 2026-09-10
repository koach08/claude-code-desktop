// 画面で読む <script> が、画面と同じ条件で全部読めること。
//
// ⚠️ <script> はグローバルを共有する。裸の `const API` が 2 本あると 2 本目が
//    SyntaxError で落ち、その後ろで window に載るはずのものが載らない。
//    実際にそれで「💬 を押しても何も起きない」になった。node のテストは
//    require で 1 本ずつ読むので気づけない。ここは画面と同じ順で、
//    require も module も無い状態で読む。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf-8');
const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])
  .filter((s) => !s.includes('node_modules'));   // xterm は DOM が要るので対象外

function browserLike() {
  const win = {
    addEventListener() {}, removeEventListener() {},
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {}, console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  win.window = win;
  win.globalThis = win;
  return vm.createContext(win);
}

test('画面の <script> は、画面と同じ順・同じ条件で全部読める', () => {
  const ctx = browserLike();
  for (const s of srcs) {
    const file = path.join(root, 'src', s);
    assert.ok(fs.existsSync(file), `無いファイルを読んでいる: ${s}`);
    try {
      vm.runInContext(fs.readFileSync(file, 'utf-8'), ctx, { filename: s });
    } catch (e) {
      assert.fail(`${s} が読み込みで落ちる: ${e.name}: ${e.message}`);
    }
  }
});

test('声まわりの部品が全部 window に載る', () => {
  const ctx = browserLike();
  for (const s of srcs) {
    if (s === 'renderer.js') break;   // renderer は DOM を触るのでここまで
    vm.runInContext(fs.readFileSync(path.join(root, 'src', s), 'utf-8'), ctx, { filename: s });
  }
  for (const k of ['VoiceTurn', 'VoiceCommand', 'VoiceVad', 'RealtimeTools', 'Realtime', 'VoiceChat']) {
    assert.ok(ctx[k], `${k} が画面に載っていない`);
  }
});
