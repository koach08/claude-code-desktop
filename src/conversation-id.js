// Claude Code の会話ファイル(~/.claude/projects/<slug>/<conversationId>.jsonl)を
// 探して、タブに紐づく conversationId を割り出す。
//
// ここが外れると再起動時に `claude --resume` が付かず、会話がそのまま失われる。
// 過去に2度落とし穴を踏んでいるので、両方の再発をテストで固定してある:
//   (1) スラッグの作り方   … '/' だけ置換していて日本語パスで一致しなかった
//   (2) 絞り込みの基準     … mtime で見ていて複数タブが同じ会話を掴んだ
//
// fs/os を引数で受けるのは、テストから一時ディレクトリを渡せるようにするため。
const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code が projects/ 以下に作るディレクトリ名の作り方。
// パス中の「英数字以外」を全て '-' に置き換える。'/' だけを置換する実装だと、
// 日本語を含むパス(例: Desktop/アプリ開発プロジェクト/xxx)で一致しない。
function claudeProjectSlug(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

// この cwd で「sinceMs 以降に作られた」会話ファイルを探して ID を返す。
//
// 絞り込みは mtime ではなく birthtime(作成時刻)。mtime だと、同じ cwd の別タブが
// 喋っているだけでその会話ファイルが「最近更新された」と見え、複数のタブが同一の
// conversationId を掴む。実測で 12 タブ中 3 タブが同じ ID を共有し、同じ会話に
// claude が二重に --resume して接続していた(同一ファイルへ二重書き込み)。
// 併せて、既に生きているタブが使用中の ID は候補から除外する。
//
// opts.claimed  : 使用中の conversationId の集合(Set)
// opts.homedir  : ~/.claude/projects を探す起点(テスト用)
function findConversationId(cwd, sinceMs, opts = {}) {
  const claimed = opts.claimed || new Set();
  const home = opts.homedir || os.homedir();

  // 旧スラッグ('/'だけ置換)でも探す。過去に作られたディレクトリを拾うため。
  const keys = [...new Set([claudeProjectSlug(cwd), String(cwd || '').replace(/\//g, '-')])];
  for (const key of keys) {
    const projectDir = path.join(home, '.claude', 'projects', key);
    try {
      if (!fs.existsSync(projectDir)) continue;
      const files = fs.readdirSync(projectDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const st = fs.statSync(path.join(projectDir, f));
          // birthtime 非対応のファイルシステムでは mtime に退避する
          return { name: f, born: st.birthtimeMs || st.mtimeMs };
        })
        .filter((f) => f.born >= sinceMs - 2000)
        .filter((f) => !claimed.has(f.name.replace(/\.jsonl$/, '')))
        .sort((a, b) => b.born - a.born);
      if (files.length > 0) return files[0].name.replace(/\.jsonl$/, '');
    } catch (_) {}
  }
  return null;
}

module.exports = { claudeProjectSlug, findConversationId };
