// 相談タブの 🎬: オンラインの動画から、セリフと画面に映るものを書き出して相談に添える。
//
// 読み方は 3 つ。どれも書き出すのは中継サーバー(koach-os の /hub/video/*)の先の Gemini。
//   1. YouTube   … URL のまま渡す。ダウンロードしない
//   2. ほかのサイト … yt-dlp で一時的に落とし、縮めて渡す。読み終えたら消す
//   3. 落とせない動画 … 本人が再生している画面を、必要な場面だけ録って渡す。読み終えたら消す
//
// ⚠️ コピー防止(DRM)は外さない。ブラウザのログイン情報(Cookie)も使わない。
// ⚠️ 外のコマンドには引数を配列で渡す(シェルを通さない)。yt-dlp は利用者の設定ファイルも読ませない
//    (設定に --exec などがあると、動画を落とすついでに何かが走るため)。

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MAX_DOWNLOAD = '500M';               // 落とす上限。縮めたあとに送る上限はサーバーと同じ 300MB
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const MAX_RECORD_SEC = 15 * 60;            // 録るのは必要な場面だけ。長くても 15 分で止める
const HUB_TIMEOUT_MS = 15 * 60 * 1000;

const MIME_BY_EXT = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

// サーバー側(video_read.py)と同じ形。公開の YouTube だけが URL のまま読める
const YOUTUBE_RE = /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/)|youtu\.be\/)[\w-]{6,}/;

function youtubeUrl(raw) {
  const s = String(raw || '').trim().replace(/^http:\/\//i, 'https://');
  return YOUTUBE_RE.test(s) ? s : null;
}

function mimeOf(file) {
  return MIME_BY_EXT[path.extname(String(file)).toLowerCase()] || null;
}

function downloadArgs(url, outTemplate) {
  return [
    '--ignore-config', '--no-playlist', '--no-warnings', '--no-progress', '--no-part',
    '-f', 'best[height<=480][ext=mp4]/best[height<=480]/worst[ext=mp4]/worst',
    '--max-filesize', MAX_DOWNLOAD,
    '-o', outTemplate,
    '--', url,
  ];
}

// 画面の文字が読める大きさは残し、動きは 1 秒 2 枚に落とす(Gemini も 1 秒 1 枚ほどで見る)
function shrinkArgs(input, output) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', input,
    '-vf', "scale='min(1280,iw)':-2,fps=2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    '-movflags', '+faststart', output,
  ];
}

// 範囲(またはウィンドウ)を選んで、映像とパソコンの音を録る。止めるのはメニューバーの停止ボタン
function recordArgs(file, maxSec = MAX_RECORD_SEC) {
  return ['-v', '-A', '-i', '-J', 'video', '-x', '-V', String(Math.min(MAX_RECORD_SEC, Math.max(5, maxSec | 0))), file];
}

function defaultRun(bin, args, { timeout = 30 * 60 * 1000, env } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function lastError(stderr) {
  const lines = String(stderr || '').trim().split('\n').filter(Boolean);
  return (lines.filter((l) => /ERROR|error/.test(l)).pop() || lines.pop() || '').slice(0, 200);
}

function firstFile(dir, prefix) {
  const f = fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).map((n) => path.join(dir, n))
    .filter((p) => fs.statSync(p).isFile() && fs.statSync(p).size > 0);
  return f[0] || null;
}

async function download(url, dir, { ytdlp = 'yt-dlp', run = defaultRun, env } = {}) {
  const r = await run(ytdlp, downloadArgs(url, path.join(dir, 'source.%(ext)s')), { env });
  const file = firstFile(dir, 'source.');
  if (!file) {
    const why = lastError(r.stderr);
    if (/DRM/i.test(why)) throw new Error('コピー防止(DRM)のある動画は落とせません');
    if (/filesize|larger than max/i.test(why)) throw new Error('動画が大きすぎて落とせません。必要な場面だけ「再生して録る」で録ってください');
    throw new Error(`この動画は落とせませんでした${why ? `(${why})` : ''}`);
  }
  return file;
}

// ffmpeg が無い Mac でも動くように、無ければ元のまま送る(大きすぎれば断る)
async function shrink(input, dir, { ffmpeg, run = defaultRun, env } = {}) {
  if (ffmpeg) {
    const out = path.join(dir, 'small.mp4');
    const r = await run(ffmpeg, shrinkArgs(input, out), { env });
    if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  }
  return input;
}

async function record(dir, { maxSec, run = defaultRun } = {}) {
  const file = path.join(dir, 'record.mov');
  await run('/usr/sbin/screencapture', recordArgs(file, maxSec), { timeout: (MAX_RECORD_SEC + 60) * 1000 });
  return fs.existsSync(file) && fs.statSync(file).size > 0 ? file : null;
}

async function hubError(res) {
  let detail = '';
  try { const j = await res.json(); detail = j && (j.detail || j.error) ? String(j.detail || j.error) : ''; } catch (_) {}
  if (res.status === 401 || res.status === 403) return '中継サーバーに入れませんでした(合言葉を確かめてください)';
  if (res.status === 404) return '中継サーバーがまだ動画を読めません(サーバーの更新が必要です)';
  return detail || `中継サーバーがエラーを返しました(HTTP ${res.status})`;
}

async function readYoutube({ hub, url, focus, fetchImpl }) {
  const res = await fetchImpl(`${hub.url}/video/youtube`, {
    method: 'POST',
    headers: { ...hub.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, focus: String(focus || '') }),
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(await hubError(res));
  return String((await res.json()).text || '');
}

// multipart を自分で組む(Electron の net.fetch に FormData を渡せない場合があるため)
function multipartBody(file, mime, focus) {
  const boundary = `----bridgework${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="focus"\r\n\r\n${String(focus || '')}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip${path.extname(file)}"\r\nContent-Type: ${mime}\r\n\r\n`, 'utf-8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  return { body: Buffer.concat([head, fs.readFileSync(file), tail]), type: `multipart/form-data; boundary=${boundary}` };
}

async function readFile({ hub, file, focus, fetchImpl }) {
  const mime = mimeOf(file);
  if (!mime) throw new Error('この形式の動画は送れません');
  if (fs.statSync(file).size > MAX_UPLOAD_BYTES) throw new Error('動画が大きすぎます(300MB まで)。必要な場面だけ録り直してください');
  const { body, type } = multipartBody(file, mime, focus);
  const res = await fetchImpl(`${hub.url}/video/file`, {
    method: 'POST',
    headers: { ...hub.headers, 'Content-Type': type },
    body,
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(await hubError(res));
  return String((await res.json()).text || '');
}

module.exports = {
  MAX_RECORD_SEC, MAX_UPLOAD_BYTES, youtubeUrl, mimeOf,
  downloadArgs, shrinkArgs, recordArgs, download, shrink, record, readYoutube, readFile, multipartBody,
};
