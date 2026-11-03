// 情報ノート: 取り込んで分析したものを Markdown で1件1ファイルに置く棚。
//
// 置き場は普通のフォルダ(既定 ~/Documents/Bridgework情報ノート)。アプリの中に閉じ込めないのは、
// 会話タブの Claude Code がそのまま読めるように(「情報ノートの○○を元に機能案を出して」)、
// また Finder・Obsidian・Notion への持ち出しもできるようにするため。
//
//   <dir>/2026-11-03_動画のタイトル.md   … 分析(頭に YAML の見出し)
//   <dir>/raw/2026-11-03_動画のタイトル.txt … 元データ(字幕・本文)
//   <dir>/.ariya/index.json                … 一覧(画面の検索用。消えても .md から作り直せる)
//   <dir>/.ariya/watch.json                … 見張るチャンネル

const fs = require('fs');
const path = require('path');

const INDEX = path.join('.ariya', 'index.json');
const WATCH = path.join('.ariya', 'watch.json');

function ensureDir(dir) {
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.ariya'), { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, '# Bridgework 情報ノート\n\nBridgework の「取り込む」で集めた動画・ページの分析です。1件1ファイル。元データ(字幕・本文)は raw/ にあります。\n会話タブで「情報ノートの○○を読んで」と頼むと、Claude がここを読みます。\n');
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return fallback; }
}
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ファイル名にできない文字を落とす。日本語はそのまま
function slugify(s, max = 60) {
  const t = String(s || '').normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|#^[\]{}]/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ').trim()
    .slice(0, max).trim();
  return t || 'untitled';
}

function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function uniqueName(dir, base) {
  let name = `${base}.md`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base} (${i}).md`;
  return name;
}

function yamlStr(v) { return JSON.stringify(String(v == null ? '' : v)); }

// 1件を保存する。entry は一覧に載る形
// frames: [{ label('mm:ss'), path }] 動画の場面の画像。frames/<id>/ に写し、ノートの末尾に並べる
function saveNote(dir, { src, kind, title, url, analysis, raw, lens, focus, costUsd, summary, tags, extra, frames }) {
  ensureDir(dir);
  const date = today();
  const file = uniqueName(dir, `${date}_${slugify(title || url)}`);
  const id = file.replace(/\.md$/, '');
  const meta = {
    title: title || url, url: url || '', kind: kind || (src && src.kind) || 'web',
    channel: (src && src.channel) || '', published: (src && src.published) || '',
    fetched: new Date().toISOString(), lens: lens || '', focus: focus || '',
    tags: tags || [], ...(extra || {}),
  };
  const head = ['---', ...Object.entries(meta).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map(yamlStr).join(', ')}]` : yamlStr(v)}`), '---', ''].join('\n');
  const link = raw ? `\n\n---\n元データ: [raw/${id}.txt](raw/${encodeURI(id)}.txt)${meta.url ? ` ・ 出典: ${meta.url}` : ''}\n` : (meta.url ? `\n\n---\n出典: ${meta.url}\n` : '\n');
  let scenes = '';
  if (Array.isArray(frames) && frames.length) {
    const fdir = path.join(dir, 'frames', id);
    fs.mkdirSync(fdir, { recursive: true });
    const lines = [];
    for (const f of frames) {
      const name = path.basename(f.path);
      try { fs.copyFileSync(f.path, path.join(fdir, name)); } catch (_) { continue; }
      lines.push(`![${f.label}](frames/${encodeURI(id)}/${encodeURI(name)})`);
    }
    if (lines.length) scenes = `\n\n## 場面\n\n${lines.join('\n')}`;
  }
  fs.writeFileSync(path.join(dir, file), `${head}# ${meta.title}\n\n${String(analysis || '').trim()}${scenes}${link}`);
  if (raw) fs.writeFileSync(path.join(dir, 'raw', `${id}.txt`), String(raw));
  const entry = { id, file, ...meta, summary: summary || '', costUsd: costUsd || 0, hasRaw: !!raw, frames: scenes ? frames.length : 0 };
  const index = readJson(path.join(dir, INDEX), []);
  index.unshift(entry);
  writeJsonAtomic(path.join(dir, INDEX), index.slice(0, 5000));
  return entry;
}

function listNotes(dir, { q, limit = 300 } = {}) {
  let rows = readJson(path.join(dir, INDEX), []);
  // 手で消された .md は一覧から落とす
  rows = rows.filter((r) => r && r.file && fs.existsSync(path.join(dir, r.file)));
  if (q) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    rows = rows.filter((r) => {
      const hay = [r.title, r.channel, r.summary, (r.tags || []).join(' '), r.url].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  return rows.slice(0, limit);
}

function findByUrl(dir, url) {
  if (!url) return null;
  return listNotes(dir, { limit: 5000 }).find((r) => r.url === url && r.kind !== 'digest') || null;
}

// id は画面から来る。ファイル名としてだけ使い、棚の外を指させない
function safeId(id) {
  const s = path.basename(String(id || ''));
  if (!s || s.startsWith('.') || s !== String(id)) return null;
  return s;
}
function readNote(dir, id) {
  const s = safeId(id); if (!s) return null;
  const md = path.join(dir, `${s}.md`);
  if (!fs.existsSync(md)) return null;
  const rawFile = path.join(dir, 'raw', `${s}.txt`);
  return {
    id: s, path: md,
    markdown: fs.readFileSync(md, 'utf-8'),
    raw: fs.existsSync(rawFile) ? fs.readFileSync(rawFile, 'utf-8') : '',
    rawPath: fs.existsSync(rawFile) ? rawFile : null,
    framesDir: fs.existsSync(path.join(dir, 'frames', s)) ? path.join(dir, 'frames', s) : null,
  };
}
function removeFromIndex(dir, id) {
  const index = readJson(path.join(dir, INDEX), []);
  writeJsonAtomic(path.join(dir, INDEX), index.filter((r) => r.id !== id));
}

// ── 見張るチャンネル ──
function loadWatches(dir) { return readJson(path.join(dir, WATCH), []); }
function saveWatches(dir, rows) { ensureDir(dir); writeJsonAtomic(path.join(dir, WATCH), rows); }
function upsertWatch(dir, w) {
  const rows = loadWatches(dir);
  const i = rows.findIndex((r) => r.url === w.url);
  const next = { seen: [], lens: 'dev', auto: true, ...(i >= 0 ? rows[i] : {}), ...w };
  if (i >= 0) rows[i] = next; else rows.push(next);
  saveWatches(dir, rows);
  return next;
}
function removeWatch(dir, url) { saveWatches(dir, loadWatches(dir).filter((r) => r.url !== url)); }
// 一覧のうち、まだ見ていない動画(新しい順のまま)
function unseen(watch, videos) {
  const seen = new Set(watch.seen || []);
  return videos.filter((v) => !seen.has(v.id));
}

module.exports = { ensureDir, slugify, today, saveNote, listNotes, findByUrl, readNote, removeFromIndex, safeId, loadWatches, saveWatches, upsertWatch, removeWatch, unseen };
