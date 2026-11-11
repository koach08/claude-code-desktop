const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const v = require('../src/video-read');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'video-read-test-'));
const hub = { url: 'https://hub.example/api/hub', headers: { Authorization: 'Bearer x' } };
const jsonRes = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('YouTube の URL だけを URL のまま渡す(http は https に直す)', () => {
  assert.strictEqual(v.youtubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.strictEqual(v.youtubeUrl(' http://youtu.be/dQw4w9WgXcQ '), 'https://youtu.be/dQw4w9WgXcQ');
  assert.strictEqual(v.youtubeUrl('https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ'), null);
  assert.strictEqual(v.youtubeUrl('https://vimeo.com/123456'), null);
});

test('yt-dlp は設定ファイルを読ませず、URL は -- の後ろに置く', () => {
  const a = v.downloadArgs('-x--exec=rm', '/tmp/o.%(ext)s');
  assert.ok(a.includes('--ignore-config'));
  assert.strictEqual(a[a.length - 2], '--');
  assert.strictEqual(a[a.length - 1], '-x--exec=rm');
  assert.ok(a.includes('--no-playlist'));
});

test('録画は映像とパソコンの音を録り、長さは 5 秒〜15 分に収める', () => {
  const a = v.recordArgs('/tmp/r.mov', 99999);
  assert.ok(a.includes('-v') && a.includes('-A') && a.includes('-i'));
  assert.strictEqual(a[a.indexOf('-V') + 1], String(v.MAX_RECORD_SEC));
  const b = v.recordArgs('/tmp/r.mov', 1);
  assert.strictEqual(b[b.indexOf('-V') + 1], '5');
});

test('落とせたらそのファイル、落とせなければ分かる言葉で失敗する', async () => {
  const dir = tmp();
  const ok = await v.download('https://vimeo.com/1', dir, {
    run: async (bin, args) => { fs.writeFileSync(path.join(dir, 'source.mp4'), 'x'); return { code: 0, stdout: '', stderr: '' }; },
  });
  assert.strictEqual(ok, path.join(dir, 'source.mp4'));
  const dir2 = tmp();
  await assert.rejects(v.download('https://x.example/1', dir2, { run: async () => ({ code: 1, stdout: '', stderr: 'ERROR: This video is DRM protected' }) }), /コピー防止/);
  await assert.rejects(v.download('https://x.example/1', dir2, { run: async () => ({ code: 1, stdout: '', stderr: 'ERROR: Unsupported URL' }) }), /落とせませんでした.*Unsupported/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});

test('ffmpeg が無いか失敗したら元のまま送る', async () => {
  const dir = tmp();
  const src = path.join(dir, 'source.mp4');
  fs.writeFileSync(src, 'x');
  assert.strictEqual(await v.shrink(src, dir, { ffmpeg: null }), src);
  assert.strictEqual(await v.shrink(src, dir, { ffmpeg: '/bin/ffmpeg', run: async () => ({ code: 1 }) }), src);
  const out = await v.shrink(src, dir, { ffmpeg: '/bin/ffmpeg', run: async (bin, args) => { fs.writeFileSync(args[args.length - 1], 'y'); return { code: 0 }; } });
  assert.strictEqual(out, path.join(dir, 'small.mp4'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('録画をやめたら null', async () => {
  const dir = tmp();
  assert.strictEqual(await v.record(dir, { run: async () => ({ code: 0 }) }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('YouTube は合言葉つきで URL と知りたいことを送る', async () => {
  let seen;
  const text = await v.readYoutube({
    hub, url: 'https://youtu.be/dQw4w9WgXcQ', focus: '数字だけ',
    fetchImpl: async (url, opts) => { seen = { url, opts }; return jsonRes(200, { ok: true, text: '## 概要' }); },
  });
  assert.strictEqual(text, '## 概要');
  assert.strictEqual(seen.url, 'https://hub.example/api/hub/video/youtube');
  assert.strictEqual(seen.opts.headers.Authorization, 'Bearer x');
  assert.deepStrictEqual(JSON.parse(seen.opts.body), { url: 'https://youtu.be/dQw4w9WgXcQ', focus: '数字だけ' });
});

test('ファイルは multipart で、形式と知りたいことを添えて送る', async () => {
  const dir = tmp();
  const f = path.join(dir, 'small.mp4');
  fs.writeFileSync(f, 'VIDEOBYTES');
  let seen;
  await v.readFile({ hub, file: f, focus: '画面の文字', fetchImpl: async (url, opts) => { seen = { url, opts }; return jsonRes(200, { text: 'ok' }); } });
  assert.strictEqual(seen.url, 'https://hub.example/api/hub/video/file');
  assert.match(seen.opts.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  const body = seen.opts.body.toString('utf-8');
  assert.ok(body.includes('name="focus"\r\n\r\n画面の文字'));
  assert.ok(body.includes('filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\nVIDEOBYTES'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('形式が分からない・大きすぎるものは送らない', async () => {
  const dir = tmp();
  const exe = path.join(dir, 'a.exe');
  fs.writeFileSync(exe, 'x');
  await assert.rejects(v.readFile({ hub, file: exe, focus: '', fetchImpl: async () => { throw new Error('送ってはいけない'); } }), /形式/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('サーバーの断りは分かる言葉にする', async () => {
  const call = (status, body) => v.readYoutube({ hub, url: 'https://youtu.be/dQw4w9WgXcQ', focus: '', fetchImpl: async () => jsonRes(status, body) });
  await assert.rejects(call(401, {}), /合言葉/);
  await assert.rejects(call(404, {}), /サーバーの更新/);
  await assert.rejects(call(429, { detail: '動画を読むは今日の上限 (30) に届きました' }), /上限/);
  await assert.rejects(call(502, { detail: 'この動画は読めません (非公開…)' }), /非公開/);
});
