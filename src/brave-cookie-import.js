// Brave にある chatgpt.com / openai.com のログイン(cookie)を、Bridgework の Web タブ
// (persist:web)へ取り込む。Google の埋め込みログイン拒否を避けるため、「ログイン操作」を
// させるのではなく「もうログイン済みの状態」をそのまま移す。
//
// なぜこの形か: 本人は普段 Brave で ChatGPT に入っている。埋め込み窓では Google が
// ログインを弾く(2026-09-11 実証)。ログイン済み cookie を移せばログイン操作自体が要らない。
//
// ⚠️ 扱うのは本人の認証情報そのもの。守りを固くする。
//   - 実行は本人がメニューを押したときだけ(自動でやらない)
//   - Brave の鍵はキーチェーンから取る → macOS が本人に許可を聞く。ここで本人が同意する
//   - 取り込むのは chatgpt.com / openai.com のホストだけ。他のサイトの cookie は触らない
//   - 値はログに出さない(件数とホストだけ記録)
//
// Chromium(Brave も)の macOS cookie 暗号:
//   鍵 = PBKDF2-HMAC-SHA1(Safe Storage パスワード, salt="saltysalt", 1003 回, 16 byte)
//   本体 = AES-128-CBC, IV = 16 個の空白(0x20)。値は "v10" で始まる。
//   復号後の先頭 32 byte は SHA256(host_key) のドメインハッシュ(新しめの Chromium)。
//   付いていない古い形もあるので、UTF-8 として読めなければ 32 byte 落として読み直す。

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const BRAVE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser');
const HOSTS = ['chatgpt.com', 'openai.com'];   // これらのサブドメインだけ

function braveCookieDbCandidates() {
  const out = [];
  for (const prof of ['Default', 'Profile 1', 'Profile 2', 'Profile 3']) {
    const p = path.join(BRAVE_DIR, prof, 'Cookies');
    try { if (fs.statSync(p).isFile()) out.push(p); } catch (_) {}
  }
  return out;
}

// キーチェーンから Brave の Safe Storage パスワードを取る。macOS が本人に許可を聞く。
function getBraveSafeStorageKey() {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-wga', 'Brave'], (err, stdout) => {
      if (err) return reject(new Error('Brave の鍵を取れませんでした(許可されなかった可能性)'));
      const pw = String(stdout || '').trim();
      if (!pw) return reject(new Error('Brave の鍵が空でした'));
      const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
      resolve(key);
    });
  });
}

function decryptValue(encrypted, key) {
  if (!encrypted || encrypted.length === 0) return null;
  const prefix = encrypted.slice(0, 3).toString('ascii');
  if (prefix !== 'v10' && prefix !== 'v11') return null;   // 平文や未対応形式は扱わない
  const iv = Buffer.alloc(16, ' ');
  const body = encrypted.slice(3);
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    const out = Buffer.concat([d.update(body), d.final()]);
    // 新しめの Chromium は先頭 32 byte にドメインハッシュを付ける。UTF-8 で壊れていれば落とす。
    const asStr = out.toString('utf8');
    if (/[\x00-\x08\x0e-\x1f]/.test(asStr.slice(0, 4)) && out.length > 32) {
      return out.slice(32).toString('utf8');
    }
    return asStr;
  } catch (_) { return null; }
}

// SQLite を積まずに Cookies(SQLite) を読むため、sqlite3 コマンドに投げて TSV で受ける。
function readBraveCookies(dbPath) {
  return new Promise((resolve, reject) => {
    const like = HOSTS.map((h) => `host_key LIKE '%${h}'`).join(' OR ');
    const sql = `SELECT host_key, name, path, hex(encrypted_value), expires_utc, is_secure, is_httponly, samesite FROM cookies WHERE ${like};`;
    // 使用中でもコピーして読む(Brave 起動中はロックされることがある)
    const tmp = path.join(os.tmpdir(), `bridgework-brave-cookies-${Date.now()}.sqlite`);
    try { fs.copyFileSync(dbPath, tmp); } catch (e) { return reject(new Error('Brave の cookie を読めませんでした: ' + e.message)); }
    execFile('/usr/bin/sqlite3', ['-readonly', '-separator', '\t', tmp, sql], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (err) return reject(new Error('sqlite3 で読めませんでした: ' + err.message));
      const rows = [];
      for (const line of String(stdout).split('\n')) {
        if (!line) continue;
        const [host_key, name, cpath, hexval, expires_utc, is_secure, is_httponly, samesite] = line.split('\t');
        rows.push({ host_key, name, path: cpath, encrypted: Buffer.from(hexval || '', 'hex'),
          expires_utc: Number(expires_utc), is_secure: is_secure === '1', is_httponly: is_httponly === '1', samesite: Number(samesite) });
      }
      resolve(rows);
    });
  });
}

// Chromium の expires_utc(1601 起点マイクロ秒) → Unix 秒
function chromeTimeToUnixSec(us) {
  if (!us || us <= 0) return undefined;   // セッション cookie
  return Math.floor(us / 1e6 - 11644473600);
}
const SAMESITE = { 0: 'no_restriction', 1: 'lax', 2: 'strict', '-1': undefined };

// Electron の session に cookie を入れる。ses は session.fromPartition('persist:web')。
async function importInto(ses, key, rows, log) {
  let ok = 0, skip = 0;
  for (const r of rows) {
    const value = decryptValue(r.encrypted, key);
    if (value == null) { skip++; continue; }
    const host = r.host_key.replace(/^\./, '');
    const url = `${r.is_secure ? 'https' : 'http'}://${host}${r.path || '/'}`;
    const det = {
      url, name: r.name, value, path: r.path || '/',
      secure: r.is_secure, httpOnly: r.is_httponly,
      sameSite: SAMESITE[r.samesite] || 'unspecified',
      expirationDate: chromeTimeToUnixSec(r.expires_utc),
    };
    if (r.host_key.startsWith('.')) det.domain = r.host_key;
    try { await ses.cookies.set(det); ok++; }
    catch (e) { skip++; if (log) log(`skip ${host} ${r.name}: ${e.message}`); }
  }
  return { ok, skip, total: rows.length };
}

// まとめて実行。deps.session は electron の session、log は文字列を受ける関数。
async function importBraveChatgpt(deps) {
  const { session, log } = deps;
  const dbs = braveCookieDbCandidates();
  if (dbs.length === 0) throw new Error('Brave の cookie が見つかりません(Brave をインストール/ログインしていますか)');
  const key = await getBraveSafeStorageKey();
  const ses = session.fromPartition('persist:web');
  let all = [];
  for (const db of dbs) {
    try { const rows = await readBraveCookies(db); all = all.concat(rows); } catch (e) { if (log) log(String(e.message)); }
  }
  if (all.length === 0) throw new Error('chatgpt.com / openai.com の cookie が Brave にありません');
  const r = await importInto(ses, key, all, log);
  if (log) log(`brave import: set=${r.ok} skip=${r.skip} total=${r.total}`);
  return r;
}

module.exports = { importBraveChatgpt, decryptValue, chromeTimeToUnixSec, braveCookieDbCandidates, HOSTS };
