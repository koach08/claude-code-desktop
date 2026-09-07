// 外から Ariya Bridge を操作するための受け口。
//
// なぜ要るか: タブの操作は全部 ipcMain にあり、アプリの中からしか届かない。
// 音声や MCP から操作したいので、localhost だけに開いた小さな窓を作る。
//
// ⚠️ ここは端末に文字を流し込める窓。守りを先に書く。
//   - 127.0.0.1 にだけ束ねる。外からは繋がらない
//   - 合言葉を要る。~/.claude-code-app/control.json に 0600 で置き、起動ごとに作り直す
//   - 制御文字を落とす。Ctrl-C やエスケープを送り込めないようにする
//   - 長さに上限。1 回 4000 文字まで
//   - 止める札。~/.claude-code-app/control-off があれば書き込みを全部断る
//   - 書き込みは全部 control.log に残す
//
// 依存を足さない (node の http だけ)。electron-builder の荷物を増やさないため。

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.claude-code-app');
const TOKEN_FILE = path.join(DIR, 'control.json');
const OFF_FLAG = path.join(DIR, 'control-off');
const LOG_FILE = path.join(DIR, 'control.log');
const PORT = 7391;
const MAX_INPUT = 4000;

// 端末に流してよい文字。改行とタブ以外の制御文字は落とす。
// Ctrl-C(0x03) や ESC(0x1b) を送れると、外から中断や画面操作ができてしまう。
function sanitize(s) {
  return String(s || '')
    .slice(0, MAX_INPUT)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function log(line) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch (_) {}
}

function writesBlocked() {
  try { return fs.existsSync(OFF_FLAG); } catch (_) { return false; }
}

// deps で本体の中身を受け取る。main.js を読まないと動かない作りにしない
// (テストから差し替えられるようにするため)。
function startControlServer(deps) {
  const {
    sessions,            // Map<id, {pty, name, cwd, mode, exited, lastOutputAt}>
    sessionBuffers,      // Map<id, string>
    closeSession,        // async (id) => void
    runWorker,           // async ({engine, task, cwd, write, model, timeoutMs}) => {ok, jobId}
    workerResult,        // (jobId) => {done, output, code} | null
  } = deps;

  const token = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ port: PORT, token }, null, 2), { mode: 0o600 });
    fs.chmodSync(TOKEN_FILE, 0o600);
  } catch (e) {
    log(`token 書き込み失敗: ${e.message}`);
    return null;
  }

  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    // 合言葉。無い・違うなら中身を一切見ない
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (auth !== token) return send(res, 401, { error: '合言葉が違います' });

    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const parts = u.pathname.split('/').filter(Boolean);
    const isWrite = req.method !== 'GET';

    if (isWrite && writesBlocked()) {
      return send(res, 423, { error: '書き込みを止めてあります (~/.claude-code-app/control-off)' });
    }

    let body = {};
    if (isWrite) {
      const raw = await new Promise((resolve) => {
        let b = ''; req.on('data', (c) => { b += c; if (b.length > 200000) req.destroy(); });
        req.on('end', () => resolve(b));
      });
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { return send(res, 400, { error: 'JSON が読めません' }); }
    }

    try {
      // 生きているか
      if (req.method === 'GET' && parts[0] === 'health') {
        return send(res, 200, { ok: true, tabs: sessions.size, writes: !writesBlocked() });
      }

      // タブ一覧
      if (req.method === 'GET' && parts[0] === 'tabs' && parts.length === 1) {
        const out = [];
        for (const [id, s] of sessions.entries()) {
          out.push({
            id, name: s.name || '', cwd: s.cwd || '', mode: s.mode || '',
            exited: !!s.exited,
            idle_sec: s.lastOutputAt ? Math.round((Date.now() - s.lastOutputAt) / 1000) : null,
          });
        }
        return send(res, 200, { tabs: out });
      }

      // 画面の末尾
      if (req.method === 'GET' && parts[0] === 'tabs' && parts[2] === 'tail') {
        const buf = sessionBuffers.get(parts[1]);
        if (buf === undefined) return send(res, 404, { error: 'そのタブはありません' });
        const n = Math.min(parseInt(u.searchParams.get('lines') || '30', 10) || 30, 200);
        const lines = String(buf)
          // eslint-disable-next-line no-control-regex
          .replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '')
          .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        return send(res, 200, { tail: lines.slice(-n).join('\n') });
      }

      // 入力を送る。⚠️ ここが一番危ない口
      if (req.method === 'POST' && parts[0] === 'tabs' && parts[2] === 'input') {
        const s = sessions.get(parts[1]);
        if (!s || !s.pty) return send(res, 404, { error: 'そのタブはありません' });
        const text = sanitize(body.text);
        if (!text) return send(res, 400, { error: 'text が空です' });
        // submit を明示したときだけ改行を足す。既定では入れるだけで実行しない
        s.pty.write(body.submit ? `${text}\r` : text);
        log(`input ${parts[1]} submit=${!!body.submit} len=${text.length}`);
        return send(res, 200, { ok: true, submitted: !!body.submit, length: text.length });
      }

      // タブを開く口は出していない。create-session の中身を外から呼ぶには
      // electron の内部 API に触ることになり、版が上がると黙って壊れる。
      // 開くのは手でよい。

      // タブを閉じる
      if (req.method === 'DELETE' && parts[0] === 'tabs' && parts[1]) {
        await closeSession(parts[1]);
        log(`close ${parts[1]}`);
        return send(res, 200, { ok: true });
      }

      // タブを開かずにエンジンを走らせる
      if (req.method === 'POST' && parts[0] === 'worker' && parts.length === 1) {
        const r = await runWorker({
          engine: body.engine || 'claude',
          task: String(body.task || ''),
          cwd: body.cwd || os.homedir(),
          write: !!body.write,
          model: body.model || '',
          timeoutMs: Number(body.timeoutMs) || 600000,
        });
        log(`worker ${r && r.jobId} engine=${body.engine} write=${!!body.write}`);
        return send(res, 200, r);
      }

      // 走らせた結果
      if (req.method === 'GET' && parts[0] === 'worker' && parts[1]) {
        const r = workerResult(parts[1]);
        if (!r) return send(res, 404, { error: 'そのジョブはありません' });
        return send(res, 200, r);
      }

      return send(res, 404, { error: `知らない口です: ${req.method} ${u.pathname}` });
    } catch (e) {
      log(`error ${u.pathname}: ${e.message}`);
      return send(res, 500, { error: String(e.message || e) });
    }
  });

  // ⚠️ 127.0.0.1 にだけ束ねる。0.0.0.0 にすると同じ Wi-Fi の誰でも端末を叩ける
  server.listen(PORT, '127.0.0.1', () => {
    log(`listening on 127.0.0.1:${PORT}`);
  });
  server.on('error', (e) => log(`listen 失敗: ${e.message}`));

  return server;
}

module.exports = { startControlServer, sanitize, PORT, TOKEN_FILE, OFF_FLAG };
