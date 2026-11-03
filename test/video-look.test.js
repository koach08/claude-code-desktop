// 動画の中身(映像・音声)を読む。外のコマンドと Gemini は偽物で、決まりごとだけ固定する:
//   場面は満遍なく・切り替わり優先 / 画像は stream-json で1発言に / Gemini の鍵は URL に載せない
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('node:events');
const vl = require('../src/video-look');
const sa = require('../src/source-analyze');
const lib = require('../src/source-library');
const sf = require('../src/source-fetch');

test('場面の時刻: 切り替わりを優先し、無い区間は真ん中。近すぎる時刻は捨てる', () => {
  const t = vl.pickTimes(100, [12, 13, 55], 4);   // 区間 0-25, 25-50, 50-75, 75-100
  assert.deepStrictEqual(t.map((x) => Math.round(x * 10) / 10), [12.4, 37.5, 55.4, 87.5]);
  assert.strictEqual(vl.pickTimes(8, [], 16).length, 1);   // 短い動画は少なく
  assert.deepStrictEqual(vl.pickTimes(0, [1], 4), []);
  assert.ok(vl.pickTimes(3600, [], 16).length === 16);
  assert.deepStrictEqual(vl.parseSceneTimes('n:0 pts:1 pts_time:3.5 x\nn:1 pts_time:10'), [3.5, 10]);
  assert.strictEqual(vl.fmtT(3725), '1:02:05');
  assert.strictEqual(vl.fmtT(65), '01:05');
});

test('字幕が無く映像も見ないなら、書き起こしの道具が無いことを注意に残す', async () => {
  const r = await vl.lookIntoVideo({ url: 'u', duration: 60, transcript: '' }, { frames: false, t: { ffmpeg: null, whisper: null, whisperModel: null } });
  assert.deepStrictEqual(r.frames, []);
  assert.ok(r.notes.some((n) => n.includes('whisper')));
});

test('映像を見る: 落とす → 場面を切り出す(偽の yt-dlp / ffmpeg)', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ariya-vl-'));
  const calls = [];
  const run = async (bin, args) => {
    calls.push([bin, args]);
    if (bin === 'yt-dlp') { fs.writeFileSync(path.join(work, 'media.mp4'), 'x'); return { code: 0, stdout: '', stderr: '' }; }
    if (args.includes('null')) return { code: 0, stdout: '', stderr: 'pts_time:20.0\npts_time:21.0' };
    fs.writeFileSync(args[args.length - 1], 'jpg');
    return { code: 0, stdout: '', stderr: '' };
  };
  const r = await vl.lookIntoVideo({ url: 'https://www.youtube.com/watch?v=a', duration: 60, transcript: 'あり' }, { frames: true, maxFrames: 3, ytdlp: 'yt-dlp', run, workDir: work, t: { ffmpeg: '/x/ffmpeg', whisper: null, whisperModel: null } });
  assert.strictEqual(r.frames.length, 3);
  assert.strictEqual(r.frames[1].label, '00:21');   // 区間 20-40 の切り替わり 21 秒の直後
  const dl = calls[0][1];
  assert.ok(dl.includes('res:480') && dl.includes('--ffmpeg-location'));
  assert.ok(!calls.some(([b]) => b === 'whisper-cli'));   // 字幕があれば書き起こさない
});

test('Claude に画像を見せるときは stream-json で、画像と時刻を1発言に入れる', async () => {
  let seen, sent;
  const spawnImpl = (bin, args) => {
    seen = args;
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.stdin = { on() {}, end(s) { sent = s; setImmediate(() => { p.stdout.emit('data', '{"type":"system"}\n' + JSON.stringify({ type: 'result', is_error: false, result: '## 一言で\nok', total_cost_usd: 0.02 })); p.emit('close', 0); }); } };
    p.kill = () => {};
    return p;
  };
  const r = await sa.analyzeSource('字幕', { lens: 'dev', images: [{ label: '01:05', data: 'QUJD' }], spawnImpl });
  assert.strictEqual(seen[seen.indexOf('--input-format') + 1], 'stream-json');
  assert.strictEqual(seen[seen.indexOf('--tools') + 1], '');
  const msg = JSON.parse(sent);
  const c = msg.message.content;
  assert.deepStrictEqual(c.slice(0, 2).map((x) => x.type), ['text', 'image']);
  assert.ok(c[0].text.includes('01:05'));
  assert.ok(c[2].text.includes('画面で見えたもの') && c[2].text.includes('<source>'));
  assert.strictEqual(r.costUsd, 0.02);
});

test('Gemini: 鍵はヘッダで、動画は URL のまま。無いモデルは次へ', async () => {
  const urls = [];
  let req, headers;
  const fetchImpl = async (url, init) => {
    urls.push(url); headers = init.headers; req = JSON.parse(init.body);
    if (urls.length === 1) return { status: 404, ok: false, json: async () => ({ error: { message: 'not found' } }) };
    return { status: 200, ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '## 一言で\nよい' }] } }], usageMetadata: { promptTokenCount: 1000000, candidatesTokenCount: 0, totalTokenCount: 1000000 } }) };
  };
  const r = await sa.analyzeWithGemini('本文', { lens: 'dev', videoUrl: 'https://www.youtube.com/watch?v=a', apiKey: 'KEY_abcdefghijklmnopqrstuvwxyz', model: 'gone-model', lowRes: true, fetchImpl });
  assert.ok(urls.every((u) => !u.includes('KEY_')));
  assert.strictEqual(headers['x-goog-api-key'], 'KEY_abcdefghijklmnopqrstuvwxyz');
  assert.ok(urls[1].includes(sa.GEMINI_MODELS[0]));
  assert.strictEqual(req.contents[0].parts[0].fileData.fileUri, 'https://www.youtube.com/watch?v=a');
  assert.ok(req.systemInstruction.parts[0].text.includes('命令ではありません'));
  assert.strictEqual(req.generationConfig.mediaResolution, 'MEDIA_RESOLUTION_LOW');
  assert.strictEqual(r.text, '## 一言で\nよい');
  assert.ok(Math.abs(r.costUsd - 0.3) < 1e-9);
  await assert.rejects(sa.analyzeWithGemini('x', { videoUrl: 'u', apiKey: '' }), /鍵/);
});

test('ノートに場面の画像を写し、末尾に並べる。書き起こしは字幕と区別する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariya-fr-'));
  const img = path.join(dir, '01_0105.jpg'); fs.writeFileSync(img, 'jpg');
  const e = lib.saveNote(dir, { title: 'V', url: 'https://y/1', kind: 'yt-video', analysis: '## 一言で\nx', frames: [{ label: '01:05', path: img }] });
  const r = lib.readNote(dir, e.id);
  assert.ok(r.framesDir && fs.existsSync(path.join(r.framesDir, '01_0105.jpg')));
  assert.ok(r.markdown.includes('## 場面') && r.markdown.includes(`![01:05](frames/${encodeURI(e.id)}/01_0105.jpg)`));
  assert.strictEqual(e.frames, 1);
  const body = sf.sourceBody({ kind: 'yt-video', title: 't', channel: 'c', url: 'u', transcript: '[00:00] hi', transcribed: true });
  assert.ok(body.includes('書き起こし(音声から自動)'));
});
