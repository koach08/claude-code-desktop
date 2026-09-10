// 他のアプリで進めた会話を、Ariya のタブとして開くための一覧。
//
// 本人の望み: デスクトップアプリ(Claude / Codex)を別に開くとメモリを食うので、
// 一つのアプリで全部を扱いたい。会話の記録は両方ともローカルにあるので、
//   Claude デスクトップ(Code タブ) → ~/.claude/projects/<slug>/<id>.jsonl (entrypoint=claude-desktop)
//   Codex Desktop / ChatGPT Work    → ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (originator=Codex Desktop / codex_work_desktop)
// を読んで一覧にし、選んだら `claude --resume <id>` / `codex resume <id>` でタブに起こす。
//
// ⚠️ 読めないもの: Claude Cowork(クラウド側に置かれ、ローカルに会話の記録が無い)、
//    ChatGPT の Web の会話(取り出す口が無い)。これらは一覧に出ない。
//
// fs/os は引数で受ける(テストから一時ディレクトリを渡すため)。
const fsDefault = require('fs');
const osDefault = require('os');
const path = require('path');

const HEAD_BYTES = 300 * 1024;
const HEAD_BYTES_MORE = 4 * 1024 * 1024;   // 定型(プラグイン一覧・AGENTS.md)が長く、本人の発言が先頭 300KB に無いことがある
const LIMIT = 60;

// 題は一度分かれば変わらないので、id → 題 を ~/.claude-code-app/external-titles.json に覚える。
// 100本超の記録(1本 100MB 超もある)を毎回読み直さないため。
let titleCache = null;
function cachePath(opts) { return path.join(opts.cacheDir || path.join(osDefault.homedir(), '.claude-code-app'), 'external-titles.json'); }
function loadCache(opts) {
  if (titleCache) return titleCache;
  try { titleCache = JSON.parse((opts.fs || fsDefault).readFileSync(cachePath(opts), 'utf8')) || {}; } catch (_) { titleCache = {}; }
  return titleCache;
}
function saveCache(opts) {
  try { (opts.fs || fsDefault).writeFileSync(cachePath(opts), JSON.stringify(titleCache || {})); } catch (_) { /* 書けなくても動く */ }
}

// 会話の最初の依頼(本人の言葉)から短い題を作る。貼り付けや前置きは飛ばす
function shortTitle(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.startsWith('<') || t.startsWith('/') || /^This session is being continued/.test(t) || /^Base directory for this skill/.test(t)) return null;
  t = t.replace(/^[│|─┼\s]+/, '').replace(/^[0-9a-f]{8}\s*│\s*/, '');
  if (t.length < 4) return null;
  return t.slice(0, 40) + (t.length > 40 ? '…' : '');
}

function readHead(fs, file, bytes = HEAD_BYTES) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(bytes);
  let n = 0;
  try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
  return buf.toString('utf8', 0, n);
}

// Claude 側。entrypoint が claude-desktop のもの(Ariya 自身の cli の会話は台帳で扱うので除く)
function listClaude(opts) {
  const fs = opts.fs || fsDefault;
  const home = opts.homedir || osDefault.homedir();
  const root = path.join(home, '.claude', 'projects');
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (_) { return out; }
  for (const d of dirs) {
    const dir = path.join(root, d);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const st = fs.statSync(file);
        const head = readHead(fs, file);
        const ep = /"entrypoint":"([^"]*)"/.exec(head);
        if (!ep || ep[1] !== 'claude-desktop') continue;
        let cwd = '';
        let title = null;
        for (const line of head.split('\n')) {
          if (!cwd) { const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line); if (m) cwd = JSON.parse(`"${m[1]}"`); }
          if (title || !line.includes('"type":"user"')) continue;
          let o;
          try { o = JSON.parse(line); } catch (_) { continue; }
          const c = o && o.message && o.message.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ') : '';
          title = shortTitle(text);
        }
        out.push({ engine: 'claude', id: f.replace(/\.jsonl$/, ''), cwd, title: title || '(題なし)', mtime: st.mtimeMs, app: 'Claude デスクトップ' });
      } catch (_) { /* 読めないものは飛ばす */ }
    }
  }
  return out;
}

// Codex 側。Codex Desktop / ChatGPT Work のもの。子エージェント(guardian 等)の記録は除く
function listCodex(opts) {
  const fs = opts.fs || fsDefault;
  const home = opts.homedir || osDefault.homedir();
  const root = path.join(home, '.codex', 'sessions');
  const out = [];
  const walk = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      if (depth < 3) { walk(p, depth + 1); continue; }
      if (!n.startsWith('rollout-') || !n.endsWith('.jsonl')) continue;
      try {
        const st = fs.statSync(p);
        const cache = loadCache(opts);
        const hit = cache[n];
        if (hit) {
          if (hit.skip) continue;
          out.push({ ...hit, mtime: st.mtimeMs });
          continue;
        }
        const head = readHead(fs, p);
        const lines = head.split('\n');
        const meta = JSON.parse(lines[0]);
        const m = meta && meta.payload;
        if (!m || meta.type !== 'session_meta') continue;
        if (!['Codex Desktop', 'codex_work_desktop'].includes(m.originator)) { cache[n] = { skip: true }; continue; }
        if (m.source && typeof m.source === 'object' && m.source.subagent) { cache[n] = { skip: true }; continue; }
        let title = null;
        let guardian = false;
        // 先頭 300KB に本人の発言が無ければ、もう少し先まで読む(一度だけ。結果は覚える)
        const body = st.size > HEAD_BYTES ? readHead(fs, p, Math.min(st.size, HEAD_BYTES_MORE)).split('\n').slice(1) : lines.slice(1);
        for (const line of body) {
          let o;
          try { o = JSON.parse(line); } catch (_) { continue; }
          const pl = o && o.payload;
          if (!pl) continue;
          // 本人の発言: event_msg/user_message か、response_item(role=user) の input_text。
          // どちらも定型(<recommended_plugins> / # AGENTS.md / <environment_context>)が先に積まれるので飛ばす
          const texts = [];
          if (o.type === 'event_msg' && pl.type === 'user_message') texts.push(String(pl.message || ''));
          else if (o.type === 'response_item' && pl.role === 'user' && Array.isArray(pl.content)) {
            for (const x of pl.content) if (x && x.type === 'input_text') texts.push(String(x.text || ''));
          }
          for (const text of texts) {
            // 見張り役(guardian)の子スレッドは「Codex agent history whose request action you are assessing」で始まる
            if (/^The following is the Codex agent history/.test(text)) { guardian = true; break; }
            if (/^\s*[#<]/.test(text)) continue;
            title = shortTitle(text);
            if (title) break;
          }
          if (title || guardian) break;
        }
        if (guardian) { cache[n] = { skip: true }; continue; }
        const rec = { engine: 'codex', id: m.id, cwd: m.cwd || '', title: title || '(題なし)',
          app: m.originator === 'codex_work_desktop' ? 'ChatGPT Work' : 'Codex Desktop' };
        if (title) cache[n] = rec;   // 題が取れなかったものは次回また読む
        out.push({ ...rec, mtime: st.mtimeMs });
      } catch (_) { /* 途中の行など */ }
    }
  };
  walk(root, 0);
  return out;
}

function listExternalConversations(opts = {}) {
  const all = [...listClaude(opts), ...listCodex(opts)];
  saveCache(opts);
  all.sort((a, b) => b.mtime - a.mtime);
  return all.slice(0, opts.limit || LIMIT);
}

module.exports = { listExternalConversations, listClaude, listCodex, shortTitle };
