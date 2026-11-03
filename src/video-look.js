// 動画の「中身」を読む: 画面(場面の画像)と、字幕が無いときの音声(書き起こし)。
//
// なぜ要るか: 字幕だけだと、スライド・画面に映るコード・アプリの操作・図や数字が抜け落ちる。
// 本人は「動画の内容を読み込めるようにしたい」(2026-11-03)。映像を軽い画質で落とし、
// 場面が変わるところを中心に画像を切り出して、字幕と一緒に分析へ渡す。
// 字幕の無い動画は、手元の whisper.cpp で書き起こす(外に音声を送らない)。
//
// electron に依存しない。外部コマンドは run(差し替え可能)経由。
// ⚠️ 画像に映る文字も「データ」。分析側で命令として扱わない(source-analyze の SYSTEM)。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { vttToSegments, segmentsToText, defaultRun } = require('./source-fetch');

const MAX_VIDEO_SEC = 3 * 3600;   // これより長い動画は映像を落とさない(重すぎる)

function findBin(name) {
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')]) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// whisper.cpp のモデル。大きい(精度の高い)ものを優先
function findWhisperModel() {
  const dirs = [
    process.env.BRIDGEWORK_WHISPER_DIR,
    process.env.ARIYA_WHISPER_DIR,
    path.join(os.homedir(), '.cache', 'whisper'),
    path.join(os.homedir(), '.cache', 'whisper.cpp'),
    path.join(os.homedir(), 'whisper.cpp', 'models'),
    '/opt/homebrew/share/whisper-cpp',
    '/opt/homebrew/share/whisper.cpp/models',
    path.join(os.homedir(), 'Downloads'),
  ].filter(Boolean);
  const rank = ['large-v3-turbo', 'large-v3', 'large', 'medium', 'small', 'base', 'tiny'];
  let best = null;
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d); } catch (_) { continue; }
    for (const f of files) {
      if (!/^ggml-.*\.bin$/.test(f) || /for-tests/.test(f)) continue;
      const r = rank.findIndex((k) => f.includes(k));
      const score = r < 0 ? rank.length : r;
      if (!best || score < best.score) best = { path: path.join(d, f), score };
    }
  }
  return best && best.path;
}

function tools() {
  return { ffmpeg: findBin('ffmpeg'), whisper: findBin('whisper-cli'), whisperModel: findWhisperModel() };
}

function fmtT(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${String(m).padStart(2, '0')}`) + `:${String(s).padStart(2, '0')}`;
}

// 場面の時刻を選ぶ。動画を max 等分し、各区間で「場面が変わった時刻」を優先、無ければ区間の真ん中。
// 冒頭 1 秒(黒画面)と、近すぎる時刻(4 秒以内)は避ける
function pickTimes(duration, sceneTimes, max = 16) {
  const d = Number(duration) || 0;
  if (d <= 0 || max <= 0) return [];
  const n = Math.max(1, Math.min(max, Math.floor(d / 5) || 1));
  const len = d / n;
  const scenes = (sceneTimes || []).filter((t) => t >= 1 && t < d).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = i * len, b = (i + 1) * len;
    const s = scenes.find((t) => t >= a + 0.5 && t < b);
    const t = s != null ? s + 0.4 : Math.max(1, a + len / 2);   // 切り替わりの直後はブレるので少し後
    if (!out.length || t - out[out.length - 1] >= 4) out.push(Math.min(t, d - 0.5));
  }
  return out;
}

// ffmpeg の showinfo 出力から pts_time を拾う
function parseSceneTimes(stderr) {
  const out = [];
  for (const m of String(stderr || '').matchAll(/pts_time:\s*([\d.]+)/g)) out.push(Number(m[1]));
  return out;
}

// 軽い画質(480p まで)で落とす。audioOnly なら音声だけ
async function downloadMedia(url, dir, { ytdlp = 'yt-dlp', ffmpeg, run, env, audioOnly = false } = {}) {
  const args = audioOnly
    ? ['-f', 'ba/b', '-S', '+size']
    : ['-f', 'bv*+ba/b', '-S', 'res:480', '--merge-output-format', 'mp4'];
  if (ffmpeg) args.push('--ffmpeg-location', path.dirname(ffmpeg));
  args.push('--no-warnings', '--no-playlist', '--no-part', '-o', path.join(dir, 'media.%(ext)s'), url);
  const r = await run(ytdlp, args, { env, timeout: 30 * 60 * 1000 });
  const file = fs.readdirSync(dir).find((f) => f.startsWith('media.') && !f.endsWith('.part'));
  if (!file) throw new Error(`動画を落とせませんでした: ${String(r.stderr || '').trim().slice(-200)}`);
  return path.join(dir, file);
}

// 場面の画像を切り出す → [{ t(秒), label('mm:ss'), path }]
async function extractFrames(file, outDir, { ffmpeg, run, duration, max = 16, width = 768 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  // 場面の切り替わり検出は小さく・間引いて(速さのため)
  const det = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-an', '-vf', "fps=2,scale=320:-2,select='gt(scene,0.3)',showinfo", '-f', 'null', '-'], { timeout: 20 * 60 * 1000 });
  const times = pickTimes(duration, parseSceneTimes(det.stderr), max);
  const frames = [];
  for (const t of times) {
    const label = fmtT(t);
    const out = path.join(outDir, `${String(frames.length + 1).padStart(2, '0')}_${label.replace(/:/g, '')}.jpg`);
    const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '5', '-y', out], { timeout: 60000 });
    if (r.code === 0 && fs.existsSync(out)) frames.push({ t, label, path: out });
  }
  return frames;
}

// 音声を書き起こす(whisper.cpp)。字幕の無い動画用
async function transcribe(file, dir, { ffmpeg, whisper, model, run, lang } = {}) {
  const wav = path.join(dir, 'audio.wav');
  const c = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wav], { timeout: 10 * 60 * 1000 });
  if (c.code !== 0) throw new Error('音声を取り出せませんでした');
  const base = path.join(dir, 'whisper');
  const l = /^[a-z]{2}$/.test(String(lang || '')) ? lang : 'auto';
  const threads = String(Math.max(2, Math.min(8, (os.cpus() || []).length - 2)));
  const w = await run(whisper, ['-m', model, '-f', wav, '-l', l, '-t', threads, '-ovtt', '-of', base, '-np'], { timeout: 60 * 60 * 1000 });
  if (!fs.existsSync(`${base}.vtt`)) throw new Error(`書き起こせませんでした: ${String(w.stderr || '').trim().slice(-200)}`);
  return segmentsToText(vttToSegments(fs.readFileSync(`${base}.vtt`, 'utf-8')));
}

// 動画1本の「中身」を足す。src は fetchYoutubeVideo の結果(字幕・説明文つき)。
// frames: 映像を見るか / 字幕が無ければ書き起こす。作業用のフォルダは呼び出し側が消す(画像を後で保存するため)
async function lookIntoVideo(src, { frames = true, maxFrames = 16, ytdlp, run = defaultRun, env, workDir, say = () => {}, t = tools() } = {}) {
  const needAudio = !src.transcript && t.whisper && t.whisperModel;
  const wantFrames = frames && t.ffmpeg && (src.duration || 0) <= MAX_VIDEO_SEC;
  const out = { frames: [], transcript: '', notes: [] };
  if (frames && !t.ffmpeg) out.notes.push('ffmpeg が無いので映像は見ていません');
  if (frames && (src.duration || 0) > MAX_VIDEO_SEC) out.notes.push('3 時間を超える動画なので映像は見ていません');
  if (!src.transcript && !needAudio) out.notes.push('字幕が無く、書き起こしの道具(whisper.cpp とモデル)も見つからないので、話の中身は読めていません');
  if (!wantFrames && !needAudio) return out;
  say(wantFrames ? '映像を取っています…' : '音声を取っています…');
  const file = await downloadMedia(src.url, workDir, { ytdlp, ffmpeg: t.ffmpeg, run, env, audioOnly: !wantFrames });
  if (wantFrames) {
    say('場面を選んで画像にしています…');
    try { out.frames = await extractFrames(file, path.join(workDir, 'frames'), { ffmpeg: t.ffmpeg, run, duration: src.duration, max: maxFrames }); } catch (e) { out.notes.push(`場面を切り出せませんでした(${e.message})`); }
  }
  if (needAudio) {
    say('音声を書き起こしています…(長い動画は数分かかります)');
    try { out.transcript = await transcribe(file, workDir, { ffmpeg: t.ffmpeg, whisper: t.whisper, model: t.whisperModel, run, lang: src.language }); } catch (e) { out.notes.push(e.message); }
  }
  return out;
}

module.exports = { tools, findWhisperModel, pickTimes, parseSceneTimes, fmtT, downloadMedia, extractFrames, transcribe, lookIntoVideo, MAX_VIDEO_SEC };
