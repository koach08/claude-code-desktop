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

// 必要なときにタブごとにつなぐ連携(2026-11-06 実測: 全841ツールのうち、この3つと Canva で661個)。
// ツールの名前と説明だけで起動時に約1.5万〜2万トークン使うので、既定では切る
const CONNECTORS = {
  wordpress: { label: 'WordPress', servers: ['wordpress', 'wordpress-koach'] },
  vercel: { label: 'Vercel', servers: ['claude.ai Vercel'], plugins: ['vercel@claude-plugins-official'] },
  adobe: { label: 'Adobe', servers: ['claude.ai Adobe for creativity'] },
};
// 本人「canva は使っていないので切っていい」。Bridgework のタブでは常に切る
const ALWAYS_DENIED = ['claude.ai Canva'];

// 台帳や画面から来た値を、知っている連携だけに絞る
function cleanConnectors(list) {
  return Array.isArray(list) ? Object.keys(CONNECTORS).filter((k) => list.includes(k)) : [];
}

function connectorNote(connected) {
  const on = cleanConnectors(connected);
  const off = Object.keys(CONNECTORS).filter((k) => !on.includes(k));
  const names = (keys) => keys.map((k) => CONNECTORS[k].label).join('、');
  const parts = ['Bridgework からのお知らせ(今回の起動時点の状態です。以前の案内と食い違うときは、こちらが正しいです)。'];
  if (on.length) parts.push(`つないである連携: ${names(on)}。`);
  if (off.length) {
    parts.push(`切っている連携: ${names(off)}(トークン節約のため)。`);
    parts.push('切っている連携が必要な依頼では、別の手段で代用せず、本人に「左のタブ一覧でこのタブを右クリックし、『○○をつなぐ』を選んでください。同じ会話のまま再起動します」と伝えて待ってください。');
  }
  return parts.join('');
}

// 案内は SessionStart フックで届ける。--append-system-prompt は会話の最初に記録され、
// 再開時に渡しても無視される(実測)。フックなら再開した会話にも、最新の状態が届く
function noteHook(note) {
  const payload = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } });
  const quoted = `'${payload.replace(/'/g, `'\\''`)}'`;
  return { SessionStart: [{ hooks: [{ type: 'command', command: `printf %s ${quoted}` }] }] };
}

function claudeSettings({ pdf, connectors, platform = process.platform }) {
  const on = cleanConnectors(connectors);
  const off = Object.keys(CONNECTORS).filter((k) => !on.includes(k));
  const enabledPlugins = {};
  if (!pdf) enabledPlugins[PDF_PLUGIN] = false;
  for (const k of off) for (const p of CONNECTORS[k].plugins || []) enabledPlugins[p] = false;
  const denied = [...off.flatMap((k) => CONNECTORS[k].servers), ...ALWAYS_DENIED];
  const settings = { enabledPlugins, deniedMcpServers: denied.map((serverName) => ({ serverName })) };
  if (platform !== 'win32') settings.hooks = noteHook(connectorNote(on));   // printf を使うため
  return settings;
}

function claudeArgs({ model, conversationId, pdf, connectors }) {
  // ⚠️ --remote-control は名前を任意で取るフラグなので、次に値を置かない。先頭に置く
  const args = ['--remote-control', '--model', model, '--settings', JSON.stringify(claudeSettings({ pdf, connectors }))];
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

module.exports = { PDF_PLUGIN, CONNECTORS, cleanConnectors, connectorNote, claudeSettings, claudeArgs, canSleep, parsePs, hasWorkingChild, isAwakeWaiting };
