// 会話画面の裏で claude を1本回し続ける。端末(xterm)ではなく、Claude デスクトップと同じ
// 「吹き出し + ツールの折りたたみ」で見せるための材料をここで作る。
//
// claude -p --input-format stream-json --output-format stream-json で起こすと、
// 標準入力に1行1件の JSON で発言を流し込み、標準出力から1行1件の JSON で
// 出来事(考え中・文字の差分・ツール呼び出し・結果・費用)が返ってくる。
// プロセスは会話の間ずっと生かしておく(1発言ごとに起こすと MCP の立ち上げで毎回数秒待つ)。
//
// 決めごと(2026-11-03 実測):
//  - 許可の問い合わせは --permission-prompts host で標準出力に control_request として来る。
//    返事は control_response を標準入力へ。返さない限り claude は止まって待つ。
//  - 本人の settings.json で許可済みのものは問い合わせ自体が来ない(Write も来なかった)。
//  - 文字の差分は stream_event の content_block_delta。完成した塊は assistant でもう一度来る。
//    画面は差分で伸ばし、assistant で確定させる(差分を取りこぼしても最後に揃う)。
//
// electron に依存させないのは、ここの壊れ方をテストで押さえるため(worker-run.js と同じ理由)。

const { spawn } = require('child_process');

const KILL_GRACE_MS = 3000;

function buildClaudeArgs(opts = {}) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompts', 'host',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.resume) args.push('--resume', opts.resume);
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  return args;
}

// 1行ぶんの JSON を、画面が扱う出来事の列に直す。知らない種類は捨てる(CLI は種類を増やす)。
function normalize(m) {
  if (!m || typeof m !== 'object') return [];
  const out = [];
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') {
        out.push({ kind: 'init', sessionId: m.session_id, model: m.model || null, cwd: m.cwd || null });
      } else if (m.subtype === 'status' && m.status) {
        out.push({ kind: 'status', status: m.status });
      } else if (m.subtype === 'task_summary' && m.detail) {
        out.push({ kind: 'status', status: m.detail });
      }
      break;
    case 'stream_event': {
      const ev = m.event || {};
      if (m.parent_tool_use_id) break; // 下請け(Task)の中身までは流さない
      if (ev.type === 'content_block_start' && ev.content_block) {
        out.push({ kind: 'block-start', index: ev.index, blockType: ev.content_block.type, name: ev.content_block.name || null });
      } else if (ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'text_delta') out.push({ kind: 'text-delta', index: ev.index, text: ev.delta.text });
        else if (ev.delta.type === 'thinking_delta') out.push({ kind: 'thinking-delta', index: ev.index, text: ev.delta.thinking });
      } else if (ev.type === 'message_start') {
        out.push({ kind: 'message-start', id: ev.message && ev.message.id });
      }
      break;
    }
    case 'assistant': {
      if (m.parent_tool_use_id) break;
      const msg = m.message || {};
      for (const b of msg.content || []) {
        if (b.type === 'text') out.push({ kind: 'text', messageId: msg.id, text: b.text });
        else if (b.type === 'tool_use') out.push({ kind: 'tool-use', messageId: msg.id, id: b.id, name: b.name, input: b.input });
      }
      break;
    }
    case 'user': {
      if (m.parent_tool_use_id) break;
      const content = (m.message && m.message.content) || [];
      if (!Array.isArray(content)) break;
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        out.push({ kind: 'tool-result', id: b.tool_use_id, isError: !!b.is_error, text: toolResultText(b.content) });
      }
      break;
    }
    case 'control_request': {
      const r = m.request || {};
      if (r.subtype === 'can_use_tool') {
        out.push({ kind: 'permission', requestId: m.request_id, tool: r.tool_name, input: r.input || {}, suggestions: r.permission_suggestions || null });
      }
      break;
    }
    case 'result':
      out.push({
        kind: 'result',
        ok: !m.is_error,
        text: typeof m.result === 'string' ? m.result : '',
        costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null,
        ms: m.duration_ms || null,
        sessionId: m.session_id || null,
      });
      break;
    default:
      break;
  }
  return out;
}

function toolResultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && x.type === 'text' ? x.text : x && x.type === 'image' ? '[画像]' : '')).join('\n');
  return '';
}

// 行の切れ目は data イベントの切れ目と一致しない。溜めて改行で切る。
function lineSplitter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
}

function userMessage(text, images = []) {
  const content = [];
  for (const img of images) {
    if (img && img.data && img.mediaType) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    }
  }
  content.push({ type: 'text', text });
  return { type: 'user', message: { role: 'user', content } };
}

function createClaudeSession(opts, handlers = {}) {
  const { bin = 'claude', cwd, env, spawnImpl = spawn } = opts;
  const onEvent = handlers.onEvent || (() => {});
  const onExit = handlers.onExit || (() => {});
  let reqSeq = 0;
  let exited = false;
  let sessionId = opts.resume || null;
  let stderrTail = '';

  let proc;
  try {
    proc = spawnImpl(bin, buildClaudeArgs(opts), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  } catch (err) {
    exited = true;
    setImmediate(() => onExit({ code: -1, err: String(err.message || err) }));
    return { send: () => false, respondPermission: () => false, interrupt: () => false, close: () => {}, get sessionId() { return null; }, failed: true };
  }

  const write = (obj) => {
    if (exited || !proc.stdin || proc.stdin.destroyed) return false;
    try { proc.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch (_) { return false; }
  };

  proc.stdout.on('data', lineSplitter((line) => {
    let m;
    try { m = JSON.parse(line); } catch (_) { return; }
    for (const ev of normalize(m)) {
      if (ev.kind === 'init' && ev.sessionId) sessionId = ev.sessionId;
      onEvent(ev);
    }
  }));
  if (proc.stderr) proc.stderr.on('data', (b) => { stderrTail = (stderrTail + b.toString()).slice(-2000); });

  const done = (code, err) => {
    if (exited) return;
    exited = true;
    onExit({ code, err: err || stderrTail.trim() || null, sessionId });
  };
  proc.on('close', (code) => done(code));
  proc.on('error', (err) => done(-1, String(err.message || err)));

  const signalGroup = (sig) => {
    if (proc.pid) { try { process.kill(-proc.pid, sig); return; } catch (_) {} }
    try { proc.kill(sig); } catch (_) {}
  };

  return {
    get sessionId() { return sessionId; },
    get alive() { return !exited; },
    send: (text, images) => write(userMessage(text, images)),
    respondPermission: (requestId, allow, extra = {}) => write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allow
          ? { behavior: 'allow', updatedInput: extra.updatedInput || {}, ...(extra.updatedPermissions ? { updatedPermissions: extra.updatedPermissions } : {}) }
          : { behavior: 'deny', message: extra.message || '本人が許可しませんでした' },
      },
    }),
    // 返事の途中で止める。プロセスは生かしたまま次の発言を待たせる。
    interrupt: () => write({ type: 'control_request', request_id: `ariya-${++reqSeq}`, request: { subtype: 'interrupt' } }),
    close: () => {
      if (exited) return;
      try { proc.stdin.end(); } catch (_) {}
      signalGroup('SIGTERM');
      setTimeout(() => { if (!exited) signalGroup('SIGKILL'); }, KILL_GRACE_MS).unref?.();
    },
  };
}

// 再起動後に会話画面を描き直すための読み取り。~/.claude/projects/<slug>/<id>.jsonl は
// stream-json とほぼ同じ形で1行1件残っている。違いは本人の発言(文字列)も入っていること。
// ツールの結果として差し込まれた user 行と、本人の発言を分けて出す。
function transcriptFromJsonl(text, limit = 400) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch (_) { continue; }
    if (m.isSidechain || m.isMeta) continue;
    if (m.type === 'user' && m.message) {
      const c = m.message.content;
      if (typeof c === 'string') {
        if (!c.startsWith('<')) out.push({ kind: 'user-text', text: c });
        continue;
      }
      if (Array.isArray(c) && c.some((b) => b.type === 'text') && !c.some((b) => b.type === 'tool_result')) {
        const t = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        if (t && !t.startsWith('<')) out.push({ kind: 'user-text', text: t });
        continue;
      }
    }
    if (m.type === 'user' || m.type === 'assistant') out.push(...normalize(m));
  }
  return out.slice(-limit);
}

module.exports = { createClaudeSession, buildClaudeArgs, normalize, lineSplitter, userMessage, toolResultText, transcriptFromJsonl };
