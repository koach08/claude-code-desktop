// Claude タブのメモリを減らすための判定。main から使う。Electron に依存させない(テストのため)
//
// 2026-11-06 実測(連携が立ち上がった Claude タブ13本で 7.67GB):
//   1本 約590MB = PDF 連携 約300MB + Claude 本体 約190MB + WordPress 連携 約100MB
//   連携はタブごとに別プロセスで立つので、全34本が起きるとメモリ 18GB を超える。

const { isAwakeWaiting } = (() => {
  const { isAwaitingUser, titleSaysWaiting } = require('./prompt-detect');
  return { isAwakeWaiting: (raw) => isAwaitingUser(raw) || titleSaysWaiting(raw) === true };
})();

// 同期プラグインの PDF ビューア。enabledPlugins で切ると子プロセスが約400MB→94MBになる(実測)。
// deniedMcpServers では止まらなかった(実測)ので、こちらを使う
const PDF_PLUGIN = 'pdf-viewer@synced';

function claudeArgs({ model, conversationId, pdf }) {
  // ⚠️ --remote-control は名前を任意で取るフラグなので、次に値を置かない。先頭に置く
  const args = ['--remote-control', '--model', model];
  if (!pdf) args.push('--settings', JSON.stringify({ enabledPlugins: { [PDF_PLUGIN]: false } }));
  if (conversationId) args.push('--resume', conversationId);
  return args;
}

// 眠らせてよいタブか。迷ったら起こしたままにする(作業を止めるより、メモリを使うほうがまし)
function canSleep(s, { now, idleMs, activeId, id }) {
  if (s.mode !== 'claude' || s.sleeping || s.exited) return false;
  if (id === activeId) return false;                         // 見ているタブ
  if (!s.conversationId) return false;                       // 再開先が分からない
  if (now - (s.lastOutputAt || 0) < idleMs) return false;    // 作業中はスピナーの出力が途切れない
  if (isAwakeWaiting(s.rawOutput || '')) return false;       // 許可や選択の返事を待っている
  return true;
}

// 連携サーバーと、その起動役。これ以外の子プロセス(開発サーバー、裏で走るコマンド)がいるタブは
// 止めると巻き添えにするので眠らせない。知らないものは「作業中」とみなす
const IDLE_CHILD = /mcp|modelcontextprotocol|server-pdf|caffeinate/i;

function parsePs(text) {
  const kids = new Map();
  const cmds = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    cmds.set(pid, m[3]);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  return { kids, cmds };
}

function hasWorkingChild(table, pid) {
  const stack = [...(table.kids.get(pid) || [])];
  while (stack.length) {
    const p = stack.pop();
    if (!IDLE_CHILD.test(table.cmds.get(p) || '')) return true;
    stack.push(...(table.kids.get(p) || []));
  }
  return false;
}

module.exports = { PDF_PLUGIN, claudeArgs, canSleep, parsePs, hasWorkingChild, isAwakeWaiting };
