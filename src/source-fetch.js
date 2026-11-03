// オンラインの情報(YouTube の動画・チャンネル、Web ページ)を「読める文字」にして持ってくる。
//
// なぜ要るか: 本人は面白い動画や記事を見つけるたびに、字幕や本文をコピペしてチャットに
// 貼っていた(2026-11-03)。その手間をなくし、URL を渡すだけで中身を会話・分析に回せるようにする。
//
// electron に依存しない。yt-dlp の呼び出しは run(差し替え可能)経由なのでテストで偽物を渡せる。
// ⚠️ 取ってきた中身は全部「データ」。ここでは文字にするだけで、命令として扱う場所は無い。

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_TEXT = 200000;   // 1件あたりの上限(長い講義動画でも 3 時間ぶん程度は入る)

// ── URL の種類 ──
function classifyUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { return { kind: 'invalid' }; }
  if (!/^https?:$/.test(u.protocol)) return { kind: 'invalid' };
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return id ? { kind: 'yt-video', id, url: `https://www.youtube.com/watch?v=${id}` } : { kind: 'invalid' };
  }
  if (host === 'youtube.com') {
    const p = u.pathname;
    if (p === '/watch' && u.searchParams.get('v')) {
      const id = u.searchParams.get('v');
      return { kind: 'yt-video', id, url: `https://www.youtube.com/watch?v=${id}` };
    }
    let m = /^\/(shorts|live|embed)\/([\w-]{6,})/.exec(p);
    if (m) return { kind: 'yt-video', id: m[2], url: `https://www.youtube.com/watch?v=${m[2]}` };
    if (p === '/playlist' && u.searchParams.get('list')) {
      return { kind: 'yt-playlist', url: `https://www.youtube.com/playlist?list=${u.searchParams.get('list')}` };
    }
    m = /^\/(@[^/]+|channel\/[\w-]+|c\/[^/]+|user\/[^/]+)/.exec(p);
    if (m) return { kind: 'yt-channel', handle: decodeURIComponent(m[1]), url: `https://www.youtube.com/${m[1]}/videos` };
    return { kind: 'invalid' };
  }
  return { kind: 'web', url: u.toString() };
}

// ── 字幕(WebVTT)→ 時刻付きの文 ──
// 自動字幕は「前の行を繰り返しながら1語ずつ足す」形で来る。同じ行を2度出さない。
function vttToSegments(vtt) {
  const out = [];
  const recent = [];
  let start = null;
  for (const block of String(vtt || '').replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    start = lines[ti].split('-->')[0].trim().replace(/\.\d+$/, '');
    for (const raw of lines.slice(ti + 1)) {
      const line = raw.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
      if (!line || recent.includes(line)) continue;
      out.push({ t: start.replace(/^00:/, ''), text: line });
      recent.push(line);
      if (recent.length > 4) recent.shift();
    }
  }
  return out;
}

// 30 秒ごとに時刻を振った読み物にする(分析で「何分ごろ」と言えるように)
function segmentsToText(segs, every = 30) {
  const toSec = (t) => t.split(':').reduce((a, x) => a * 60 + Number(x), 0);
  let out = '';
  let mark = -Infinity;
  for (const s of segs) {
    const sec = toSec(s.t);
    if (sec - mark >= every) { out += `${out ? '\n' : ''}[${s.t}] `; mark = sec; } else out += ' ';
    out += s.text;
  }
  return out.slice(0, MAX_TEXT);
}

// ── HTML → 本文 ──
// 読み物として要る部分だけ。スクリプト・ナビ・フッターは捨てる。
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–' };
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return named[e.toLowerCase()] ?? m;
  });
}
function htmlToText(html) {
  let h = String(html || '');
  const title = decodeEntities(((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h) || [])[1] || '').trim());
  const desc = decodeEntities(((/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(h) || [])[1] || '').trim());
  h = h.replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = /<(article|main)\b[\s\S]*?<\/\1>/i.exec(h);
  if (main && main[0].length > 500) h = main[0];
  h = h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|section|blockquote|pre)>/gi, '\n').replace(/<li\b[^>]*>/gi, '・').replace(/<h([1-6])\b[^>]*>/gi, (_m, n) => '\n' + '#'.repeat(Number(n)) + ' ');
  const text = decodeEntities(h.replace(/<[^>]+>/g, ' '))
    .split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { title, description: desc, text: text.slice(0, MAX_TEXT) };
}

// ── yt-dlp ──
function defaultRun(bin, args, { timeout = 180000, env } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

// 字幕の言語を1つだけ選ぶ。翻訳字幕をまとめて取ると 429 で止められるため(2026-11-03 実測)
function pickSubtitle(meta, prefer = ['ja', 'en']) {
  const subs = Object.keys(meta.subtitles || {}).filter((k) => k !== 'live_chat');
  const autos = Object.keys(meta.automatic_captions || {});
  const lang = String(meta.language || '').split('-')[0];
  const order = [...new Set([lang, ...prefer].filter(Boolean))];
  for (const l of order) {
    const hit = subs.find((k) => k === l || k.startsWith(l + '-'));
    if (hit) return { lang: hit, auto: false };
  }
  // 自動字幕は「元の言語」のものだけ(-orig が元。無ければ同名)
  for (const l of order) {
    if (autos.includes(`${l}-orig`)) return { lang: `${l}-orig`, auto: true };
    if (l === lang && autos.includes(l)) return { lang: l, auto: true };
  }
  const orig = autos.find((k) => k.endsWith('-orig'));
  return orig ? { lang: orig, auto: true } : null;
}

async function fetchYoutubeVideo(url, { ytdlp = 'yt-dlp', run = defaultRun, tmpRoot = os.tmpdir(), env } = {}) {
  const r = await run(ytdlp, ['-J', '--no-warnings', '--no-playlist', url], { env });
  if (r.code !== 0) throw new Error(`動画の情報を取れませんでした: ${tail(r.stderr)}`);
  const meta = JSON.parse(r.stdout);
  const info = {
    kind: 'yt-video', id: meta.id, url: meta.webpage_url || url, title: meta.title || '',
    channel: meta.channel || meta.uploader || '', channelUrl: meta.channel_url || '',
    published: fmtDate(meta.upload_date), duration: meta.duration || 0, language: String(meta.language || '').split('-')[0],
    description: String(meta.description || '').slice(0, 5000),
    chapters: (meta.chapters || []).map((c) => ({ t: fmtSec(c.start_time), title: c.title })),
  };
  const pick = pickSubtitle(meta);
  if (!pick) return { ...info, transcript: '', note: '字幕がありません(説明文だけで分析します)' };
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'ariya-yt-'));
  try {
    const args = ['--skip-download', pick.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', pick.lang, '--sub-format', 'vtt', '--no-warnings', '--no-playlist', '-o', path.join(dir, '%(id)s.%(ext)s'), url];
    const s = await run(ytdlp, args, { env });
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.vtt'));
    if (!file) return { ...info, transcript: '', note: `字幕を取れませんでした(${tail(s.stderr, 120)})` };
    const segs = vttToSegments(fs.readFileSync(path.join(dir, file), 'utf-8'));
    return { ...info, transcript: segmentsToText(segs), subtitleLang: pick.lang, autoSubtitle: pick.auto };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// チャンネル・再生リストの新しい順 n 本(中身は取らない。一覧だけ)
async function listYoutubeVideos(url, n = 5, { ytdlp = 'yt-dlp', run = defaultRun, env } = {}) {
  const r = await run(ytdlp, ['--flat-playlist', '-J', '--no-warnings', '--playlist-end', String(Math.max(1, Math.min(50, n))), url], { env });
  if (r.code !== 0) throw new Error(`一覧を取れませんでした: ${tail(r.stderr)}`);
  const d = JSON.parse(r.stdout);
  return {
    title: String(d.title || '').replace(/ - (Videos|動画)$/, ''),
    channelId: d.channel_id || '',
    channelUrl: d.channel_url || url,
    videos: (d.entries || []).filter((e) => e && e.id).map((e) => ({
      id: e.id, title: e.title || '', url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
      duration: e.duration || 0,
    })),
  };
}

async function fetchWebPage(url, { fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', 'accept-language': 'ja,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`ページを取れませんでした(HTTP ${res.status})`);
  const type = String(res.headers.get('content-type') || '');
  if (!/text\/html|text\/plain|application\/xhtml/.test(type)) throw new Error(`読める形式ではありません(${type || '不明'})`);
  const body = (await res.text()).slice(0, 5 * 1024 * 1024);
  if (/text\/plain/.test(type)) return { kind: 'web', url: res.url || url, title: url, description: '', text: body.slice(0, MAX_TEXT) };
  const h = htmlToText(body);
  return { kind: 'web', url: res.url || url, ...h };
}

// 種類を見て取りに行く(単体)。チャンネルは listYoutubeVideos を使う
async function fetchSource(url, opts = {}) {
  const c = classifyUrl(url);
  if (c.kind === 'yt-video') return fetchYoutubeVideo(c.url, opts);
  if (c.kind === 'web') return fetchWebPage(c.url, opts);
  if (c.kind === 'invalid') throw new Error('URL として読めません');
  throw new Error('チャンネル・再生リストは一覧から1本ずつ取り込みます');
}

// 分析・会話に渡す本文(元データ)。見出し + 本文
function sourceBody(src) {
  if (src.kind === 'yt-video') {
    const parts = [`動画: ${src.title}`, `チャンネル: ${src.channel}`, src.published ? `公開日: ${src.published}` : '', `URL: ${src.url}`];
    if (src.chapters && src.chapters.length) parts.push('チャプター:\n' + src.chapters.map((c) => `  [${c.t}] ${c.title}`).join('\n'));
    if (src.description) parts.push(`説明文:\n${src.description}`);
    const label = src.transcribed ? '書き起こし(音声から自動)' : `字幕${src.autoSubtitle ? '(自動生成)' : ''}`;
    parts.push(src.transcript ? `${label}:\n${src.transcript}` : `(${src.note || '字幕なし'})`);
    return parts.filter(Boolean).join('\n\n');
  }
  return [`ページ: ${src.title || src.url}`, `URL: ${src.url}`, src.description ? `概要: ${src.description}` : '', src.text].filter(Boolean).join('\n\n');
}

function fmtDate(d) { const s = String(d || ''); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : ''; }
function fmtSec(n) { n = Math.floor(n || 0); const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`; }
function tail(s, n = 300) { return String(s || '').trim().split('\n').filter((l) => /ERROR|error/.test(l)).pop()?.slice(0, n) || String(s || '').trim().slice(-n); }

// Web タブ(webview)で今見ているページから本文を読む。ページの中で走る。
// ログインが要るページや JS で描くページも、本人が見ている状態のまま読める。選択中の文があればそれを優先
const PAGE_EXTRACT_SCRIPT = `(function(){
  const sel = String(window.getSelection ? window.getSelection() : '').trim();
  const pick = () => {
    for (const s of ['article', 'main', '[role="main"]', '#content', '.content']) {
      const el = document.querySelector(s);
      if (el && (el.innerText || '').trim().length > 400) return el;
    }
    return document.body;
  };
  const el = pick();
  const desc = (document.querySelector('meta[name="description"]') || {}).content || '';
  return { title: document.title, url: location.href, description: desc, selection: sel.slice(0, ${MAX_TEXT}), text: String((el && el.innerText) || '').slice(0, ${MAX_TEXT}) };
})()`;

module.exports = { PAGE_EXTRACT_SCRIPT, defaultRun, classifyUrl, vttToSegments, segmentsToText, htmlToText, pickSubtitle, fetchYoutubeVideo, listYoutubeVideos, fetchWebPage, fetchSource, sourceBody, MAX_TEXT };
