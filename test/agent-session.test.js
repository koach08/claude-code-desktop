// 会話タブの裏(claude -p の stream-json)の読み書き。
// 実物の claude を起こさずに、行の切れ目・出来事の変換・許可の返事の形を固定する。
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { normalize, lineSplitter, buildClaudeArgs, transcriptFromJsonl, createClaudeSession } = require('../src/agent-session');

test('起動引数: stream-json の入出力と、許可の問い合わせを host で受ける', () => {
  const a = buildClaudeArgs({ model: 'sonnet', resume: 'abc', appendSystemPrompt: 'x' });
  for (const k of ['-p', '--input-format', '--output-format', '--include-partial-messages', '--permission-prompts']) assert.ok(a.includes(k), k);
  assert.deepStrictEqual(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 2), ['--resume', 'abc']);
  assert.ok(!buildClaudeArgs({}).includes('--resume'));
});

test('行の切れ目は data の切れ目と一致しない', () => {
  const got = [];
  const feed = lineSplitter((l) => got.push(l));
  feed('{"a":'); feed('1}\n{"b"'); feed(':2}\n\n');
  assert.deepStrictEqual(got, ['{"a":1}', '{"b":2}']);
});

test('出来事の変換: 文字の差分・完成文・ツール・結果・許可', () => {
  assert.deepStrictEqual(normalize({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', cwd: '/x' })[0], { kind: 'init', sessionId: 's1', model: 'm', cwd: '/x' });
  assert.strictEqual(normalize({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'こん' } } })[0].text, 'こん');
  const a = normalize({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
  assert.deepStrictEqual(a.map((e) => e.kind), ['text', 'tool-use']);
  const r = normalize({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] } });
  assert.deepStrictEqual(r[0], { kind: 'tool-result', id: 't1', isError: false, text: 'ok' });
  const p = normalize({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm x' } } });
  assert.strictEqual(p[0].kind, 'permission');
  assert.strictEqual(p[0].requestId, 'r1');
  assert.strictEqual(normalize({ type: 'result', is_error: false, result: 'done', total_cost_usd: 0.01, duration_ms: 5 })[0].costUsd, 0.01);
  // 下請け(Task)の中身は親の画面に混ぜない
  assert.deepStrictEqual(normalize({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'sub' }] } }), []);
  assert.deepStrictEqual(normalize({ type: 'whatever' }), []);
});

test('過去の会話の読み直し: 本人の発言とツールの結果を分ける・内部の差し込みは出さない', () => {
  const lines = [
    { type: 'user', message: { role: 'user', content: '調べて' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/a' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'body' }] } },
    { type: 'assistant', message: { id: 'b', content: [{ type: 'text', text: '結果です' }] } },
    { type: 'user', isSidechain: true, message: { content: 'sub' } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\nnot json\n';
  const ev = transcriptFromJsonl(lines);
  assert.deepStrictEqual(ev.map((e) => e.kind), ['user-text', 'tool-use', 'tool-result', 'text']);
});

function fakeProc() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.written = [];
  p.stdin = { destroyed: false, write: (s) => { p.written.push(JSON.parse(s)); return true; }, end: () => {} };
  p.pid = 0;
  p.kill = () => {};
  return p;
}

test('発言を送り、許可に返事をし、session_id を覚える', () => {
  const proc = fakeProc();
  const events = [];
  const s = createClaudeSession({ spawnImpl: () => proc }, { onEvent: (e) => events.push(e) });
  s.send('やあ');
  assert.deepStrictEqual(proc.written[0], { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'やあ' }] } });
  proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }) + '\n'));
  assert.strictEqual(s.sessionId, 'sess-1');
  s.respondPermission('r1', true, { updatedInput: { command: 'ls' } });
  assert.deepStrictEqual(proc.written[1].response.response, { behavior: 'allow', updatedInput: { command: 'ls' } });
  s.respondPermission('r2', false);
  assert.strictEqual(proc.written[2].response.response.behavior, 'deny');
  s.interrupt();
  assert.strictEqual(proc.written[3].request.subtype, 'interrupt');
  assert.strictEqual(events[0].kind, 'init');
});

test('落ちたら1回だけ知らせ、その後の送信は失敗を返す', () => {
  const proc = fakeProc();
  const exits = [];
  const s = createClaudeSession({ spawnImpl: () => proc }, { onExit: (e) => exits.push(e) });
  proc.emit('error', new Error('ENOENT'));
  proc.emit('close', -2);
  assert.strictEqual(exits.length, 1);
  assert.match(exits[0].err, /ENOENT/);
  assert.strictEqual(s.send('x'), false);
  assert.strictEqual(s.alive, false);
});
