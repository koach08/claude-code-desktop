// 書き込みを伴うリレーのための、作業ツリー隔離。
//
// ── なぜ要るか ──
// 同じリポジトリを2つのエンジンが同時に編集して壊した事故が過去に起きている
// (同じ会話IDを掴んだ2タブが、同じファイルを別実装で二重に直しかけた)。
// リレーは工程を順に回すので同時編集は起きにくいが、本作業が何をどこまで
// 書き換えたのかを、元のブランチを汚さずに見せる必要がある。
//
// git worktree で本作業だけを別ディレクトリに閉じ込める。人間が見て通すまで、
// 元のブランチには何も起きない。
//
// ここはコマンドの組み立てと後片付けの手順だけを持つ(実行は呼び側)。
// git を実際に叩く部分をテストに巻き込まないため。

const path = require('path');
const os = require('os');

// 作業ツリーは一時領域に置く。リポジトリの中に作ると、そのリポジトリを
// 見に行くエージェントが自分の作業ツリーを読み始めて話がこじれる。
function worktreeRoot() {
  return path.join(os.tmpdir(), 'ariya-worktrees');
}

// ラベルは枝名とディレクトリ名になる。git が受け付けない文字を落とす。
// 日本語は残す。落とすと「表示を速くしたい / main.js」が "main.js" だけになり、
// あとから何の作業か分からなくなる(実際そうなった)。
// 空になったら日時で埋める(名前が無いより、意味の薄い名前のほうがまし)。
// 長さは 24 字まで。依頼文をそのまま入れると patch のファイル名が読めなくなる。
const LABEL_KEEP = /[\w.\-\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\uff66-\uff9f]/;
function safeLabel(label, stamp) {
  const s = [...String(label || '')]
    .map((ch) => (LABEL_KEEP.test(ch) ? ch : '-'))
    .join('')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 24)
    .replace(/[-.]+$/, '');
  return s || `run-${stamp}`;
}

// repo: 対象リポジトリの絶対パス。stamp: 呼び側が渡す時刻(テストを固定するため)。
function planWorktree(repo, label, stamp = Date.now()) {
  if (!repo) throw new Error('repo は必須');
  const name = `${safeLabel(label, stamp)}-${stamp}`;
  const dir = path.join(worktreeRoot(), name);
  const branch = `ariya/${name}`;
  return {
    repo,
    dir,
    branch,
    // 現在の HEAD から枝を切る。作業ツリーは作りたてなので -b でよい。
    addArgs: ['worktree', 'add', '-b', branch, dir, 'HEAD'],
    // 後片付け。--force は「中に未コミットの変更が残っていても畳む」ため。
    // 畳む前に差分を取り終えている前提で呼ぶ。
    removeArgs: ['worktree', 'remove', '--force', dir],
    // 枝は残しても意味が薄いので消す。差分は patch として別に保存してある。
    deleteBranchArgs: ['branch', '-D', branch],
    // 中で何が起きたかを取る。--no-color は読ませる相手が機械のため。
    diffArgs: ['diff', '--no-color', 'HEAD'],
    statusArgs: ['status', '--porcelain'],
  };
}

// 作業ツリーで出た変更を、元のリポジトリへ当てるための patch を作る手順。
// マージではなく patch にするのは、人間が中身を見てから当てられるようにするため。
function planPatch(plan, outDir) {
  const file = path.join(outDir || worktreeRoot(), `${path.basename(plan.dir)}.patch`);
  return { file, args: ['diff', '--no-color', 'HEAD'] };
}

module.exports = { planWorktree, planPatch, safeLabel, worktreeRoot };
