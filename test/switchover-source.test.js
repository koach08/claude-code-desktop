// 入れ替えで使う版の選び方(2026-11-04)
// iCloud 同期の Desktop では dist に署名できないので、iCloud の外で署名した版を入れる。
// ただし dist を作り直したあとの古い署名済み版を、誤って入れてはいけない
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const script = fs.readFileSync(path.join(__dirname, '..', 'switchover.sh'), 'utf-8');
const snippet = script.split('# --- 入れる版を選ぶ ---')[1].split('# --- ここまで ---')[0];

function pick({ signed, signedAgeSec }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchover-'));
  try {
    const asarDir = path.join(root, 'dist/mac-arm64/Bridgework.app/Contents/Resources');
    fs.mkdirSync(asarDir, { recursive: true });
    fs.writeFileSync(path.join(asarDir, 'app.asar'), '');
    const stage = path.join(root, 'Library/Caches/Bridgework-build');
    fs.mkdirSync(stage, { recursive: true });
    if (signed) {
      const stamp = path.join(stage, '.signed');
      fs.writeFileSync(stamp, '');
      const t = Date.now() / 1000 + (signedAgeSec < 0 ? 60 : -60);
      fs.utimesSync(stamp, t, t);
    }
    const out = execFileSync('bash', ['-c', `${snippet}\nprintf %s "$SRC"`], { env: { ...process.env, HERE: root, HOME: root } }).toString();
    return out.slice(root.length + 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('dist より新しく署名済みなら、iCloud の外の版を入れる', () => {
  assert.strictEqual(pick({ signed: true, signedAgeSec: -1 }), 'Library/Caches/Bridgework-build/Bridgework.app');
});

test('dist を作り直したあとの古い署名済み版は使わない', () => {
  assert.strictEqual(pick({ signed: true, signedAgeSec: 1 }), 'dist/mac-arm64/Bridgework.app');
});

test('署名が終わっていなければ dist を見る', () => {
  assert.strictEqual(pick({ signed: false }), 'dist/mac-arm64/Bridgework.app');
});
