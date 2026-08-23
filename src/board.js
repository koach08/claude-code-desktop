// ボード表示 (#10 Phase2) の素になる判定。
//
// 「タブ = 社員」を案件ごとに束ね、いま何をしている状態かを出す。
// UI から切り離してあるのは、判定だけをテストで固定するため(electron 非依存)。
//
// 設計上の前提が2つある。どちらも実データを見て決めた:
//
//  1. 案件は cwd で束ねられない。本人は全タブを `~` から起動しているので、
//     cwd で分けると全部が1チームになる。代わりに **会話の中身に出てくる
//     リポジトリ名の最頻値** を案件とする(実測で ichimai / crypto-trader /
//     ai-studio / RIPE2026-paper 等が正しく取れる)。
//  2. 「完了」は作らない。PTY の出力からは「終わった」と「手が止まっている」を
//     区別できないため、無いものを表示しない。

// パスから拾わない語。設定ディレクトリや汎用フォルダは案件ではない。
const NOT_A_PROJECT = new Set([
  '.claude', '.config', '.cache', '.npm', '.git', 'node_modules',
  'Library', 'Desktop', 'Documents', 'Downloads', 'Applications', 'bin', 'tmp',
  'koachmedia', 'Users', 'src', 'dist', 'build', 'test', 'scratchpad',
]);

const PATH_RE = /\/Users\/[a-zA-Z0-9_.-]+\/(?:Desktop\/[^/\s"']+\/([^/\s"',):;\\]+)|([a-zA-Z0-9_.-]+))/g;

// 会話の抜粋から案件名(リポジトリ名)を推定する。
// 拾えなければ null。無理に埋めない。
function inferProject(text) {
  const hits = new Map();
  for (const m of String(text || '').matchAll(PATH_RE)) {
    let name = m[1] || m[2];
    if (!name) continue;
    // 会話ではパスを `backtick` や "quote" で囲むので、名前の前後の記号を落とす。
    // 残すのは英数字・アンダースコア・ハイフンと日本語(「コンテスト候補」のような和名の
    // ディレクトリが実在する)。
    // 末尾だけ落とす。先頭はパス区切りの直後なので記号は付かないし、落とすと
    // `.claude` が `claude` になって除外リストをすり抜ける(実データで踏んだ)。
    name = name.replace(/[^\w\u3040-\u30ff\u4e00-\u9fff-]+$/, '');
    if (!name || NOT_A_PROJECT.has(name)) continue;
    if (name.length < 2) continue;
    hits.set(name, (hits.get(name) || 0) + 1);
  }
  if (hits.size === 0) return null;
  let best = null, bestN = 0;
  for (const [name, n] of hits) if (n > bestN) { best = name; bestN = n; }
  // 1〜2回しか出てこないものは、たまたま触っただけの可能性が高い
  return bestN >= 3 ? best : null;
}

// 出力が止まってからこれだけ経ったら「作業中」ではない。
// Claude Code は作業中スピナーを描き続けるので、動いている限り出力は途切れない。
const WORKING_MS = 5000;

// 承認待ちの形。⚠️実データのサンプルが取れていないので、ここは推定で書いている。
// 実際の許可プロンプトを捕まえたら、その文面に合わせて直すこと。
// 誤検出を避けるため「出力が止まっていること」を必ず併せて条件にする。
const ASKING_RE = /(\(y\/n\)|\[y\/N\]|Do you want to |このまま進めますか|❯?\s*1\.\s*Yes)/i;

// tab: { id, name, mode, lastOutputAt, tail, exited }
function deriveState(tab, now = Date.now()) {
  if (tab.exited) return 'exited';
  const since = now - (tab.lastOutputAt || 0);
  if (since < WORKING_MS) return 'working';
  if (ASKING_RE.test(tab.tail || '')) return 'asking';
  return 'idle';
}

const STATE_LABELS = {
  working: '作業中',
  asking: '承認待ち',
  idle: '待機',
  exited: '終了',
};

// タブを案件ごとに束ねる。案件が取れなかったものは「未分類」に置く。
// 並びは「作業中を含むチームを上」「次にタブ数の多い順」。俯瞰したときに
// 動いているものが目に入るようにする。
function groupIntoTeams(tabs, now = Date.now()) {
  const withState = tabs.map((t) => ({ ...t, state: deriveState(t, now) }));
  const teams = new Map();
  for (const t of withState) {
    const key = t.project || '未分類';
    if (!teams.has(key)) teams.set(key, { project: key, tabs: [] });
    teams.get(key).tabs.push(t);
  }
  const list = [...teams.values()];
  for (const team of list) {
    team.counts = { working: 0, asking: 0, idle: 0, exited: 0 };
    for (const t of team.tabs) team.counts[t.state]++;
    team.active = team.counts.working > 0 || team.counts.asking > 0;
  }
  list.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.tabs.length !== b.tabs.length) return b.tabs.length - a.tabs.length;
    return a.project.localeCompare(b.project, 'ja');
  });
  return list;
}


// PTY の生出力から、判定に使える見える文字だけを取り出す。
// 実際のバッファは ANSI のカーソル移動・色指定・OSC(タイトル設定)が大量に混ざっており、
// 素で正規表現を当てると「1. Yes」のような並びが色コードで分断されて拾えない。
function cleanTail(raw, chars = 2000) {
  return String(raw || '')
    .slice(-chars * 4)                                   // 制御文字ぶん多めに取る
    // CSI。パラメータに < > = が入る種類(キーボードプロトコルの \x1b[>4m, \x1b[<u 等)が
    // 実バッファに大量に出るので、それらも含めて落とす。
    .replace(/\x1b\[[0-9;?<>=!]*[ -\/]*[a-zA-Z~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC (タイトル等)
    .replace(/\x1b[()][AB0]/g, '')                       // 文字集合切替
    .replace(/\x1b[=>78]/g, '')                           // カーソル保存/復帰など
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(-chars);
}

module.exports = {
  cleanTail, inferProject, deriveState, groupIntoTeams, STATE_LABELS, WORKING_MS };
