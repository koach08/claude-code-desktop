// 他のアプリの会話一覧。読める形と読めない形を固定する。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listExternalConversations } = require('../src/external-conversations');

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ext-')); }
function claudeFile(h, slug, id, entrypoint, firstUser) {
  const dir = path.join(h, '.claude', 'projects', slug); fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { type: 'system', entrypoint, cwd: '/w/' + slug },
    { type: 'user', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } },
    { type: 'user', message: { role: 'user', content: firstUser } },
  ];
  fs.writeFileSync(path.join(dir, id + '.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function codexFile(h, day, id, originator, source, userTexts) {
  const dir = path.join(h, '.codex', 'sessions', ...day.split('/')); fs.mkdirSync(dir, { recursive: true });
  const rows = [{ type: 'session_meta', payload: { id, cwd: '/w/c', originator, source, base_instructions: { text: 'y'.repeat(30000) } } }];
  for (const t of userTexts) rows.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] } });
  fs.writeFileSync(path.join(dir, `rollout-${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('Claude デスクトップの会話は出て、cli(Ariya 自身)の会話は出ない。題は本人の最初の依頼', () => {
  const h = home();
  claudeFile(h, 'a', 'c1', 'claude-desktop', 'スライドの型を作って');
  claudeFile(h, 'a', 'c2', 'cli', 'これは出ない');
  const l = listExternalConversations({ homedir: h, cacheDir: h });
  assert.deepStrictEqual(l.map((x) => x.id), ['c1']);
  assert.strictEqual(l[0].title, 'スライドの型を作って');
  assert.strictEqual(l[0].cwd, '/w/a');
});

test('Codex は Desktop/Work の本体スレッドだけ。定型と見張り役の子スレッドは除く', () => {
  const h = home();
  codexFile(h, '2026/09/10', 'x1', 'Codex Desktop', 'vscode', ['<recommended_plugins>...</recommended_plugins>', '# AGENTS.md instructions', 'polymarket の自動売買を作りたい']);
  codexFile(h, '2026/09/10', 'x2', 'Codex Desktop', { subagent: { other: 'guardian' } }, ['The following is the Codex agent history whose request action you are assessing']);
  codexFile(h, '2026/09/10', 'x3', 'codex-tui', undefined, ['Ariya のタブ(台帳で扱う)']);
  codexFile(h, '2026/09/10', 'x4', 'codex_work_desktop', 'vscode', ['もしもし？']);
  const l = listExternalConversations({ homedir: h, cacheDir: h });
  assert.deepStrictEqual(l.map((x) => x.id).sort(), ['x1', 'x4']);
  assert.strictEqual(l.find((x) => x.id === 'x1').title, 'polymarket の自動売買を作りたい');
  assert.strictEqual(l.find((x) => x.id === 'x4').app, 'ChatGPT Work');
});
