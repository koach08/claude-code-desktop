const test = require('node:test');
const assert = require('node:assert');
const { claudeArgs, claudeSettings, connectorNote, cleanConnectors, canSleep, parsePs, hasWorkingChild, PDF_PLUGIN } = require('../src/tab-sleep');

const NOW = 10_000_000;
const IDLE = 30 * 60 * 1000;
const opts = { now: NOW, idleMs: IDLE, activeId: 'viewing', id: 'a' };
const idleTab = { mode: 'claude', sleeping: false, exited: false, conversationId: 'c1', lastOutputAt: NOW - IDLE - 1, rawOutput: '' };

test('PDF を切ったタブは plugin を無効にして起動し、--remote-control を先頭に置く', () => {
  const a = claudeArgs({ model: 'opus', conversationId: 'c1', pdf: false });
  assert.strictEqual(a[0], '--remote-control');
  assert.strictEqual(a[1], '--model');
  const settings = JSON.parse(a[a.indexOf('--settings') + 1]);
  assert.strictEqual(settings.enabledPlugins[PDF_PLUGIN], false);
  assert.strictEqual(a[a.indexOf('--resume') + 1], 'c1');
});

test('PDF を入れたタブは plugin を無効にしない', () => {
  const s = claudeSettings({ pdf: true, connectors: [] });
  assert.strictEqual(PDF_PLUGIN in s.enabledPlugins, false);
});

const deniedOf = (s) => s.deniedMcpServers.map((d) => d.serverName);

test('既定では WordPress・Vercel・Adobe・Canva を切る', () => {
  const s = claudeSettings({ pdf: false, connectors: [] });
  assert.deepStrictEqual(deniedOf(s).sort(), ['claude.ai Adobe for creativity', 'claude.ai Canva', 'claude.ai Vercel', 'wordpress', 'wordpress-koach'].sort());
  assert.strictEqual(s.enabledPlugins['vercel@claude-plugins-official'], false);
});

test('つないだ連携だけ外れ、ほかは切ったまま', () => {
  const s = claudeSettings({ pdf: false, connectors: ['wordpress'] });
  assert.strictEqual(deniedOf(s).includes('wordpress'), false);
  assert.strictEqual(deniedOf(s).includes('wordpress-koach'), false);
  assert.strictEqual(deniedOf(s).includes('claude.ai Vercel'), true);
});

test('Vercel をつなぐとプラグインも戻る', () => {
  const s = claudeSettings({ pdf: false, connectors: ['vercel'] });
  assert.strictEqual('vercel@claude-plugins-official' in s.enabledPlugins, false);
  assert.strictEqual(deniedOf(s).includes('claude.ai Vercel'), false);
});

test('全部つないでも Canva は切ったまま', () => {
  const s = claudeSettings({ pdf: false, connectors: ['wordpress', 'vercel', 'adobe'] });
  assert.deepStrictEqual(deniedOf(s), ['claude.ai Canva']);
});

test('知らない連携名は捨てる', () => {
  assert.deepStrictEqual(cleanConnectors(['wordpress', 'canva', '__proto__', 1]), ['wordpress']);
  assert.deepStrictEqual(cleanConnectors('wordpress'), []);
  assert.deepStrictEqual(cleanConnectors(null), []);
});

test('案内は今の状態を伝え、つないだ連携を切っているとは言わない', () => {
  const note = connectorNote(['wordpress']);
  assert.match(note, /つないである連携: WordPress。/);
  assert.match(note, /切っている連携: Vercel、Adobe/);
  assert.match(note, /右クリック/);
  const all = connectorNote(['wordpress', 'vercel', 'adobe']);
  assert.doesNotMatch(all, /切っている連携:/);
});

test('案内のフックは、シェルを通しても JSON のまま出る', () => {
  const { execFileSync } = require('child_process');
  const s = claudeSettings({ pdf: false, connectors: [], platform: 'darwin' });
  const out = execFileSync('/bin/sh', ['-c', s.hooks.SessionStart[0].hooks[0].command]).toString();
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.strictEqual(parsed.hookSpecificOutput.additionalContext, connectorNote([]));
});

test('Windows では printf のフックを付けない', () => {
  assert.strictEqual('hooks' in claudeSettings({ pdf: false, connectors: [], platform: 'win32' }), false);
});

test('しばらく出力のない Claude タブは眠らせてよい', () => {
  assert.strictEqual(canSleep(idleTab, opts), true);
});

test('眠らせないタブ', () => {
  const cases = {
    '別のエンジン': { mode: 'codex' },
    'チャットタブ': { mode: 'chat' },
    'すでに休止中': { sleeping: true },
    '終了済み': { exited: true },
    '再開先の会話がない': { conversationId: null },
    '直近に出力あり': { lastOutputAt: NOW - 1000 },
    '選択肢の返事待ち': { rawOutput: '\n❯ 1. Yes, proceed\n  2. No\n' },
    '許可の返事待ち': { rawOutput: 'Do you want to proceed?\n 1. Yes\n 2. No\n' },
  };
  for (const [label, change] of Object.entries(cases)) {
    assert.strictEqual(canSleep({ ...idleTab, ...change }, opts), false, label);
  }
});

test('見ているタブは眠らせない', () => {
  assert.strictEqual(canSleep(idleTab, { ...opts, activeId: 'a' }), false);
});

test('連携サーバーだけなら作業中ではない', () => {
  const t = parsePs([
    '100 1 claude --remote-control',
    '101 100 npm exec @modelcontextprotocol/server-pdf --stdio',
    '102 101 node /x/.bin/mcp-pdf-server --stdio',
    '103 100 node /x/wp-mcp/dist/bin/wp-mcp.js',
  ].join('\n'));
  assert.strictEqual(hasWorkingChild(t, 100), false);
});

test('連携以外の子プロセスがあれば作業中とみなす', () => {
  const t = parsePs([
    '100 1 claude',
    '103 100 node /x/wp-mcp.js',
    '104 100 /bin/zsh -c npm run dev',
    '105 104 node next dev',
  ].join('\n'));
  assert.strictEqual(hasWorkingChild(t, 100), true);
});

test('連携の下で別のコマンドが動いていても作業中とみなす', () => {
  const t = parsePs(['100 1 claude', '101 100 node wp-mcp.js', '102 101 python3 long_job.py'].join('\n'));
  assert.strictEqual(hasWorkingChild(t, 100), true);
});

test('子プロセスがなければ作業中ではない', () => {
  assert.strictEqual(hasWorkingChild(parsePs('100 1 claude'), 100), false);
});
