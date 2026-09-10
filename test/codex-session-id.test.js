// Codex のタブが再起動で毎回まっさらになっていた件。会話IDを記録から拾えることを固定する。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findCodexSessionId } = require('../src/conversation-id');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-id-'));
}
function write(home, day, name, payload) {
  const dir = path.join(home, '.codex', 'sessions', ...day.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const big = 'x'.repeat(20000);   // 実物の1行目は base_instructions で数十KB ある
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ type: 'session_meta', payload: { ...payload, base_instructions: { text: big } } }) + '\n{"type":"x"}\n');
}

test('Ariya のタブ(codex-tui)で、同じ cwd の一番新しい会話を返す', () => {
  const home = tmpHome();
  const now = new Date(2026, 8, 10, 12, 0, 0).getTime();
  write(home, '2026/09/10', 'rollout-a.jsonl', { id: 'aaa', cwd: '/w/x', originator: 'codex-tui' });
  write(home, '2026/09/10', 'rollout-b.jsonl', { id: 'bbb', cwd: '/w/y', originator: 'codex-tui' });
  write(home, '2026/09/10', 'rollout-c.jsonl', { id: 'ccc', cwd: '/w/x', originator: 'Codex Desktop' });
  assert.strictEqual(findCodexSessionId('/w/x', now - 60000, { homedir: home, now }), 'aaa');
  assert.strictEqual(findCodexSessionId('/w/y/', now - 60000, { homedir: home, now }), 'bbb');
  assert.strictEqual(findCodexSessionId('/w/z', now - 60000, { homedir: home, now }), null);
});

test('生きているタブが使っている ID は除く', () => {
  const home = tmpHome();
  const now = Date.now();
  write(home, `${new Date(now).getFullYear()}/${String(new Date(now).getMonth() + 1).padStart(2, '0')}/${String(new Date(now).getDate()).padStart(2, '0')}`, 'rollout-a.jsonl', { id: 'aaa', cwd: '/w', originator: 'codex-tui' });
  assert.strictEqual(findCodexSessionId('/w', now - 60000, { homedir: home, now, claimed: new Set(['aaa']) }), null);
});
