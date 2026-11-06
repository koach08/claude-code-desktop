const test = require('node:test');
const assert = require('node:assert');
const { claudeArgs, canSleep, parsePs, hasWorkingChild, PDF_PLUGIN } = require('../src/tab-sleep');

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

test('PDF を入れたタブは --settings を付けない', () => {
  const a = claudeArgs({ model: 'opus', conversationId: null, pdf: true });
  assert.deepStrictEqual(a, ['--remote-control', '--model', 'opus']);
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
