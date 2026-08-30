// 裏方ワーカーの実行部分。子プロセスを1本回して、出力と終了を1回だけ知らせる。
//
// main.js から切り出してあるのは、ここの壊れ方がテストでしか押さえられないため。
// 実際、3社のリレーに main.js の元コードを読ませたときに出た指摘が2件とも
// ここに集まった:
//
//  1. spawn に失敗すると Node は error と close の **両方** を出す。素直に両方から
//     完了を送ると2回飛び、あとから来る close(code=-2, err 空) が本当の理由
//     (ENOENT) を覆い隠す。受け手が once で拾っていれば実害は出ないが、
//     受け手の書き方に無事を預ける形になるので送る側で畳む。
//  2. 止めるときに SIGTERM だけだと、無視する CLI が時間切れまで裏で走り続ける。
//     時間切れ側と同じ追い討ちが要る。

const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;   // 返らない CLI を溜めない
const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024;  // 暴走した出力でメモリを食わない
const KILL_GRACE_MS = 3000;                  // SIGTERM を無視する相手への追い討ち

function runProcess(opts, handlers = {}) {
  const {
    bin, args = [], cwd, env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutput = DEFAULT_MAX_OUTPUT,
    spawnImpl = spawn,
  } = opts;
  const onOutput = handlers.onOutput || (() => {});
  const onDone = handlers.onDone || (() => {});

  const startedAt = Date.now();
  const state = { out: '', err: '', killed: false, truncated: false };
  let finished = false;
  let timer = null;
  let graceTimer = null;

  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearTimeout(graceTimer);
    onDone({
      ...result,
      killed: state.killed,
      truncated: state.truncated,
      ms: Date.now() - startedAt,
      out: state.out,
      err: result.err !== undefined ? result.err : state.err,
    });
  };

  let proc;
  try {
    // 入力待ちで固まらせない。対話 CLI を非対話で回すときの定番の詰まり方。
    proc = spawnImpl(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    finish({ ok: false, code: -1, err: String(err.message || err) });
    return { cancel: () => {}, failed: true };
  }

  // 上限は「足す前に見る」だけでは守れない。1回のチャンクが上限より大きいと、
  // 空の状態から一気に超えて溜まる(テストが先に見つけた)。入る分だけ足して、
  // あふれた時点で truncated を立てる。画面に流すぶんは切らない。
  const collect = (which, buf) => {
    const text = buf.toString();
    const room = maxOutput - state[which].length;
    if (room <= 0) state.truncated = true;
    else if (text.length <= room) state[which] += text;
    else { state[which] += text.slice(0, room); state.truncated = true; }
    onOutput({ which, text });
  };
  if (proc.stdout) proc.stdout.on('data', (b) => collect('out', b));
  if (proc.stderr) proc.stderr.on('data', (b) => collect('err', b));

  const hardKill = () => {
    graceTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, KILL_GRACE_MS);
  };

  const cancel = () => {
    if (finished) return false;
    state.killed = true;
    try { proc.kill('SIGTERM'); } catch (_) {}
    hardKill();
    return true;
  };

  timer = setTimeout(() => { cancel(); }, timeoutMs);

  proc.on('close', (code) => finish({ ok: code === 0 && !state.killed, code }));
  proc.on('error', (err) => finish({ ok: false, code: -1, err: String(err.message || err) }));

  return { cancel, proc };
}

module.exports = { runProcess, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT, KILL_GRACE_MS };
