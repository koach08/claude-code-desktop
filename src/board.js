// ボード表示 (#10 Phase2) の素になる判定。
//
// 「タブ = 社員」を案件ごとに束ね、いま何をしている状態かを出す。
// UI から切り離してあるのは、判定だけをテストで固定するため(electron 非依存)。
//
// 設計上の前提が2つある。どちらも実データを見て決めた:
//
//  1. 案件は cwd で束ねられない。本人は全タブを `~` から起動しているので、
//     cwd で分けると全部が1チームになる。代わりに **会話の中身に出てくる
//     リポジトリ名の最頻値** を案件とする(実データで検証済み)。
//  2. 「完了」は作らない。PTY の出力からは「終わった」と「手が止まっている」を
//     区別できないため、無いものを表示しない。

const path = require('path');
const os = require('os');
const { cleanTail, isAwaitingUser } = require('./prompt-detect');

// ホームディレクトリ名(= ログイン名)は案件ではない。特定の名前をコードに
// 書かずに済むよう環境から取る。
const HOME_NAME = path.basename(os.homedir());

// パスから拾わない語。設定ディレクトリや汎用フォルダは案件ではない。
const NOT_A_PROJECT = new Set([
  '.claude', '.config', '.cache', '.npm', '.git', 'node_modules',
  'Library', 'Desktop', 'Documents', 'Downloads', 'Applications', 'bin', 'tmp',
  'Users', 'src', 'dist', 'build', 'test', 'scratchpad',
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
    if (!name || name === HOME_NAME || NOT_A_PROJECT.has(name)) continue;
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

// 「人間の返事待ち」の判定は src/prompt-detect.js に寄せた(renderer と共通)。
// 誤検出を避けるため「出力が止まっていること」を必ず併せて条件にする。

// tab: { id, name, mode, lastOutputAt, tail, exited }
function deriveState(tab, now = Date.now()) {
  if (tab.exited) return 'exited';
  const since = now - (tab.lastOutputAt || 0);
  if (since < WORKING_MS) return 'working';
  if (isAwaitingUser(tab.tail || '')) return 'asking';
  return 'idle';
}

const STATE_LABELS = {
  working: '作業中',
  asking: 'あなた待ち',
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


module.exports = {
  cleanTail, inferProject, deriveState, groupIntoTeams, STATE_LABELS, WORKING_MS };
