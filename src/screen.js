// 目 — 「いま見ている窓」を 1 枚だけ撮って渡す。
//
// なぜ要るか: 声で話せるようになっても、Alfred は画面が見えない。
// 「この図なに」「このエラーどう直す」が言えないので、結局こちらが文字にしていた。
//
// ⚠️ ここは **いちばん危ない口** になりうる。画面にはパスワードも学生の成績も
//    未公開の研究も映る。だから作りを先に決める:
//
//   - **窓 1 つだけ。画面全部を撮る口は作らない。** 呼び出し方を増やせば済む話ではなく、
//     そもそも用意しない (あると、いつか使う)
//   - **既定は閉じている。** 開けるのは Mac に出るダイアログを本人が押したときだけ。
//     画面 (ブラウザ) の「はい」では開かない。乗っ取られた画面は目の前のボタンを押せない
//   - 見せないアプリの一覧を持つ (パスワード管理・キーチェーンなど)。**撮る前に**断る
//   - 回数に上限
//   - 撮ったら必ず「どのアプリのどの窓か」を control.log に残す
//   - 絵はディスクに残さない。渡したら捨てる
//
// Electron と osascript は外から渡す (deps)。判断の側だけを机上で試せるようにするため。

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.claude-code-app');
const POLICY_FILE = path.join(DIR, 'screen-policy.json');

// ⚠️ enabled: false が既定。緩める側だけ手間をかける
const DEFAULT_POLICY = {
  enabled: false,
  // 撮らないアプリ。前面がこれなら、絵を読む前に断る
  deny_apps: [
    '1Password', '1Password 7', '1Password 8', 'Bitwarden', 'Keychain Access',
    'キーチェーンアクセス', 'Passwords', 'パスワード', 'Authy', 'KeePassXC',
  ],
  // 窓の名前にこれが入っていたら断る。⚠️ 効かせすぎると使えなくなるので最小限
  deny_titles: ['1password', 'keychain', 'キーチェーン', 'パスワードを入力', 'password manager'],
  max_width: 1600,        // これより大きい絵は縮める (金と時間の両方に効く)
  max_per_minute: 10,
};

function loadPolicy(readFile) {
  const read = readFile || ((p) => fs.readFileSync(p, 'utf-8'));
  let saved = {};
  try { saved = JSON.parse(read(POLICY_FILE)) || {}; } catch (_) { /* 初回、または壊れている */ }
  const p = { ...DEFAULT_POLICY };
  for (const k of Object.keys(DEFAULT_POLICY)) {
    if (saved[k] !== undefined && typeof saved[k] === typeof DEFAULT_POLICY[k]) p[k] = saved[k];
  }
  // ⚠️ 壊れた policy を「全部許す」に倒さない。既定 (狭い側) に落ちる
  if (!Array.isArray(p.deny_apps)) p.deny_apps = DEFAULT_POLICY.deny_apps;
  if (!Array.isArray(p.deny_titles)) p.deny_titles = DEFAULT_POLICY.deny_titles;
  return p;
}

function savePolicy(policy, writeFile) {
  const write = writeFile || ((p, s) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, s, { mode: 0o600 });
  });
  write(POLICY_FILE, JSON.stringify(policy, null, 2));
}

/** 撮ってはいけない相手か。理由を返す (空なら撮ってよい)。 */
function denied(appName, windowTitle, policy) {
  const app = String(appName || '').toLowerCase();
  const title = String(windowTitle || '').toLowerCase();
  if (!app) return '前面のアプリが分かりません';
  for (const bad of policy.deny_apps) {
    if (app === String(bad).toLowerCase()) return `${bad} は見せない約束です`;
  }
  for (const bad of policy.deny_titles) {
    if (title.includes(String(bad).toLowerCase())) return 'この窓は見せない約束です';
  }
  return '';
}

/** 1 分あたりの回数。⚠️ 状態を外に持たせる (テストから時計を渡せるように)。 */
function createLimiter(now) {
  const clock = now || (() => Date.now());
  const seen = [];
  return {
    ok(limit) {
      const t = clock();
      while (seen.length && t - seen[0] > 60000) seen.shift();
      if (seen.length >= limit) return false;
      seen.push(t);
      return true;
    },
    get count() { return seen.length; },
  };
}

/**
 * どの窓を撮るか決める。
 *
 * ⚠️ 一つに決まらないときは **撮らない**。画面全部に広げたり、当てずっぽうで
 *    別の窓を撮ったりしない。見せたい窓を前に出してもらうほうが安全で、速い。
 */
function pickWindow(sources, frontTitle) {
  const live = (sources || []).filter((s) => s && s.name);
  if (!live.length) return { error: '窓が見つかりません' };
  const want = String(frontTitle || '').trim();
  if (!want) return { error: '前面の窓の名前が取れません。窓を一つ前に出してください' };

  const exact = live.filter((s) => s.name === want);
  if (exact.length === 1) return { source: exact[0] };
  if (exact.length > 1) return { error: '同じ名前の窓が複数あります', candidates: exact.map((s) => s.name).slice(0, 5) };

  const loose = live.filter((s) => s.name.includes(want) || want.includes(s.name));
  if (loose.length === 1) return { source: loose[0] };
  if (loose.length > 1) return { error: 'どの窓か一つに決まりません', candidates: loose.map((s) => s.name).slice(0, 5) };
  return { error: `「${want}」に当たる窓が見つかりません` };
}

/** koach-os 自身が前面のとき。撮っても意味がないので、そう言う。 */
function isSelf(appName, windowTitle) {
  const t = `${appName || ''} ${windowTitle || ''}`.toLowerCase();
  return /koach\s*os|alfred pennyworth|ariya bridge|claude code desktop/.test(t);
}

/**
 * 1 枚撮る。
 * deps: { getSources, frontmost, log, limiter, readFile }
 *   getSources: async ({width}) => [{id, name, toPNG(): Buffer}]
 *   frontmost:  async () => ({app, title})
 */
async function capture(deps) {
  const policy = loadPolicy(deps.readFile);
  if (!policy.enabled) {
    return { error: '画面を見ることは、まだ許可されていません。Ariya のメニューか /screen/enable で一度だけ許可してください' };
  }
  if (!deps.limiter.ok(policy.max_per_minute)) {
    return { error: '続けて撮りすぎです。少し待ってください' };
  }

  let front;
  try { front = await deps.frontmost(); } catch (e) { return { error: `前面の窓が分かりません: ${e.message}` }; }
  const appName = (front && front.app) || '';
  const title = (front && front.title) || '';

  // ⚠️ 絵を読む前に断る。断る相手の中身は 1 ピクセルも取らない
  const why = denied(appName, title, policy);
  if (why) {
    deps.log(`screen 断り app=${appName} 理由=${why}`);
    return { error: why };
  }
  if (isSelf(appName, title)) {
    return { error: 'いま前面にあるのは Alfred の画面です。見てほしい窓を前に出してから、もう一度どうぞ' };
  }

  let sources;
  try { sources = await deps.getSources({ width: policy.max_width }); }
  catch (e) { return { error: `画面を撮れませんでした: ${e.message}。画面収録の許可が要ります` }; }

  const picked = pickWindow(sources, title);
  if (picked.error) {
    deps.log(`screen 断り app=${appName} 理由=${picked.error}`);
    return { error: picked.error, candidates: picked.candidates };
  }

  let png;
  try { png = picked.source.toPNG(); } catch (e) { return { error: `絵にできませんでした: ${e.message}` }; }
  if (!png || !png.length) return { error: '空の絵が返りました' };
  if (png.length > 8_000_000) return { error: '絵が大きすぎます' };

  deps.log(`screen 撮影 app=${appName} 窓=${title} bytes=${png.length}`);
  // ⚠️ ディスクに書かない。ここで返して終わり
  return { png_base64: png.toString('base64'), app: appName, title, bytes: png.length };
}

/**
 * 目を開ける。⚠️ Mac のダイアログを本人が押したときだけ。
 * deps: { confirm: async (msg) => boolean, log, readFile, writeFile }
 */
async function enable(deps, on) {
  if (on) {
    const agreed = await deps.confirm(
      '画面を見せることを許可しますか。\n\n'
      + '許可すると、声で頼んだときにだけ「いま前面にある窓」を 1 枚撮って Alfred に見せます。\n'
      + '画面全体は撮りません。パスワード管理のアプリは撮りません。撮ったことは記録に残ります。',
    );
    if (!agreed) {
      deps.log('screen 許可されませんでした');
      return { enabled: false, spoken: 'やめました。' };
    }
  }
  const policy = loadPolicy(deps.readFile);
  policy.enabled = !!on;
  savePolicy(policy, deps.writeFile);
  deps.log(`screen enabled=${!!on}`);
  return { enabled: !!on, spoken: on ? '画面を見られるようにしました。' : '画面を見るのをやめました。' };
}

module.exports = {
  POLICY_FILE, DEFAULT_POLICY,
  loadPolicy, savePolicy, denied, createLimiter, pickWindow, isSelf, capture, enable,
};
