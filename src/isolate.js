// 書き込む作業を、元の場所から切り離す。
//
// ── なぜ要るか ──
// 声で「スライド作って」「サイト直して」と頼むと、作業員がその場所で直接書く。
// 気に入らなかったときに戻す手立てが無い。ChatGPT のエージェントが使い捨ての
// 仮想マシンでやっているのと同じことを、手元でやる。
//
// ── 2 通りある ──
//   git のリポジトリ … worktree を切る。元のブランチは無傷。差分は patch で受け取る
//   git でない場所   … 新しい作業フォルダを作り、そこを cwd にする。既存は読むだけ
//
// ⚠️ どちらもできないなら **書き込みを断る**。元の場所で直接書かせない。
//    「隔離できなかったので、そのまま書きました」がいちばん困る。
//
// ⚠️ フォルダ方式は worktree ほど固くない。cwd を移すだけなので、作業員が
//    絶対パスで元の場所へ書くのを **止められない**。git の場所ほどの保証は無い、
//    と分かったうえで使うこと。ここを黙っていると、あとで裏切られる。

const path = require('path');
const os = require('os');

const { planWorktree } = require('./worktree');

// git でない場所の成果物を置く先。⚠️ 一時領域ではなく本人の持ち物の下に置く。
//    授業のスライドが再起動で消えては困る。
function workRoot() {
  return path.join(os.homedir(), 'Koach', 'work');
}

function stampName(label, stamp) {
  const { safeLabel } = require('./worktree');
  return `${safeLabel(label, stamp)}-${stamp}`;
}

/**
 * どう切り離すかを決める。ここでは何も実行しない (呼ぶ側が git を叩く)。
 *
 * @param {object} o
 * @param {string} o.cwd        作業したい場所
 * @param {string} o.label      何の作業か (枝名・フォルダ名になる)
 * @param {boolean} o.write     書き込むか
 * @param {boolean} o.isGitRepo その場所が git のリポジトリか (呼ぶ側が調べて渡す)
 * @param {number} o.stamp
 */
function planIsolation(o) {
  const { cwd, label, write, isGitRepo, stamp = Date.now() } = o || {};
  if (!cwd) return { kind: 'refuse', reason: '作業する場所が分かりません' };
  // 読むだけなら切り離さない。元の場所をそのまま見せたほうが正確
  if (!write) return { kind: 'direct', dir: cwd };

  if (isGitRepo) {
    const plan = planWorktree(cwd, label, stamp);
    return {
      kind: 'worktree',
      dir: plan.dir,
      plan,
      note: `元のブランチは触りません。できた差分は patch で受け取ります。`,
    };
  }

  const dir = path.join(workRoot(), stampName(label, stamp));
  return {
    kind: 'folder',
    dir,
    readFrom: cwd,
    // ⚠️ この一文が保証ではないことは、上のコメントの通り
    note: `成果物は ${dir} に置きます。元のフォルダは読むだけです。`,
  };
}

/** フォルダ方式のときに、依頼文へ足す一文。⚠️ 参照元を伝えないと何も作れない。 */
function folderPreamble(readFrom, dir) {
  return [
    `参照元: ${readFrom}`,
    `作業場所: ${dir}`,
    '',
    `⚠️ 読むのは参照元、書くのは作業場所の中だけにしてください。`,
    `参照元のファイルは変更しないでください。作ったものは作業場所に置いてください。`,
    '',
  ].join('\n');
}

/** 隔離したことを本人に言う一文 (声で読める形)。 */
function spoken(iso) {
  if (iso.kind === 'worktree') return '元を触らない形で始めます。終わったら差分を見せます。';
  if (iso.kind === 'folder') return '新しい作業フォルダを作って、そこで作ります。元のフォルダは読むだけです。';
  if (iso.kind === 'refuse') return `切り離せないので、書き込む作業は始めません。${iso.reason}`;
  return '';
}

module.exports = { planIsolation, folderPreamble, workRoot, stampName, spoken };
