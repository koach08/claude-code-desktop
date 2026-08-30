#!/usr/bin/env node
// 工程リレーをコマンドから回す。
//
// アプリ本体(Electron)を再起動せずに、今日から使えるようにするための入口。
// 中身は main.js の裏方ワーカーと同じ src/worker-run.js / worker-cmd.js / relay.js。
// 画面側の導線が入るのはアプリを入れ替えたときで、それを待たずに済ませる。
//
//   node tools/relay.js "タスク文"
//   node tools/relay.js "..." --cwd ~/some/repo --write
//   node tools/relay.js "..." --engines claude,gemini --no-survey
//
// 既定は読み取り専用。--write を付けたときだけ本作業が書き込める。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { runProcess } = require(path.join(ROOT, 'src/worker-run'));
const { buildCommand } = require(path.join(ROOT, 'src/worker-cmd'));
const { planRelay, buildStagePrompt } = require(path.join(ROOT, 'src/relay'));
const { planWorktree, worktreeRoot } = require(path.join(ROOT, 'src/worktree'));
const { judgeEngine } = require(path.join(ROOT, 'src/engine-judge'));

function readSecretKey(name) {
  try {
    const p = path.join(os.homedir(), '.config', 'app-secrets', 'env.txt');
    const line = fs.readFileSync(p, 'utf-8').split('\n').find((l) => l.trim().startsWith(name + '='));
    if (line) return line.slice(line.indexOf('=') + 1).trim();
  } catch (_) {}
  return '';
}

// 「入っているか」だけ見る。実際に叩けるかは走らせてみないと分からないので、
// ここで時間をかけて健診はしない(認証切れや課金停止は結果で分かる)。
function installed(bin) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

const BIN_OF = { claude: 'claude', codex: 'codex', gemini: 'gemini', grok: 'opencode' };

function parseArgs(argv) {
  const out = { task: '', cwd: process.cwd(), write: false, survey: true, review: true, engines: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--no-survey') out.survey = false;
    else if (a === '--no-review') out.review = false;
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--engines') out.engines = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else rest.push(a);
  }
  out.task = rest.join(' ').trim();
  return out;
}

// いま走らせている工程。Ctrl+C で道連れにするために保持する。
let current = null;

function runStage(engine, prompt, cwd, write, timeoutMs) {
  const spec = buildCommand(engine, prompt, { cwd, write });
  const env = { ...process.env };
  if (spec.needsKey && !env[spec.needsKey]) {
    const k = readSecretKey(spec.needsKey);
    if (k) { env[spec.needsKey] = k; if (spec.needsKey === 'XAI_API_KEY') env.GROK_API_KEY = k; }
  }
  return new Promise((res) => {
    current = runProcess({ bin: spec.bin, args: spec.args, cwd: spec.cwd, env, timeoutMs },
      { onDone: (r) => { current = null; res(r); } });
  });
}

// エンジンは独立したプロセスグループで走らせている(孫まで落とせるように)。
// その代わり端末の Ctrl+C は届かないので、こちらから明示的に止める。
// これが無いと、Ctrl+C で抜けたあともエンジンが裏で走り続ける。
process.on('SIGINT', () => {
  if (current) {
    process.stdout.write('\n止めています…\n');
    current.cancel();
    setTimeout(() => process.exit(130), 3500);   // SIGKILL の追い討ちを待つ
  } else {
    process.exit(130);
  }
});

(async () => {
  const opt = parseArgs(process.argv.slice(2));
  if (!opt.task) {
    console.error('使い方: node tools/relay.js "タスク文" [--cwd <path>] [--write] [--engines a,b] [--no-survey] [--no-review]');
    process.exit(1);
  }
  const cwd = path.resolve(opt.cwd.replace(/^~/, os.homedir()));

  const available = (opt.engines || ['claude', 'codex', 'gemini']).filter((e) => {
    const ok = BIN_OF[e] && installed(BIN_OF[e]);
    if (!ok) console.error(`  (${e} は見つからないので外します)`);
    return ok;
  });

  const judge = judgeEngine(opt.task);
  const plan = planRelay(opt.task, judge, available, {
    write: opt.write, survey: opt.survey, review: opt.review,
  });
  if (!plan.ok) { console.error('計画を立てられません:', plan.error); process.exit(1); }

  console.log(`判定: ${judge.label} (${judge.confidence}) — ${judge.reason}`);
  console.log(`計画: ${plan.steps.map((s) => `${s.label}=${s.engine}`).join(' → ')}`
    + (opt.write ? '  [本作業は書き込み可]' : '  [読み取り専用]'));
  if (plan.unreviewed) console.log('※ 別会社の点検役がいません。点検なしで進みます。');
  console.log(`場所: ${cwd}\n`);

  // 書き込む回は、本作業を隔離した作業ツリーの中でやらせる。
  // 元のブランチには何も起きない。人間が差分を見て、当てるかどうかを決める。
  const git = (args, at) => execSync(`git ${args}`, { cwd: at, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  let wt = null;
  if (opt.write) {
    try {
      wt = planWorktree(cwd, opt.task, Date.now());
      fs.mkdirSync(worktreeRoot(), { recursive: true });
      git(wt.addArgs.join(' '), cwd);
      console.log(`隔離: ${wt.dir}\n枝  : ${wt.branch}\n`);
    } catch (e) {
      // 隔離できないなら書き込ませない。元のリポジトリで直接書かせるより、
      // 断って人間に判断してもらうほうがよい。
      console.error(`作業ツリーを作れませんでした: ${String(e.message || e).split('\n')[0]}`);
      console.error('(git リポジトリでないか、既に同名の枝があります) --write を外して回してください。');
      process.exit(1);
    }
  }
  // 本作業と点検は隔離側で走らせる。点検は書き換わったファイルも読める。
  const workCwd = wt ? wt.dir : cwd;
  const extra = {};

  const prior = [];
  for (const step of plan.steps) {
    if (step.stage === 'review' && wt) {
      let d = '';
      try { d = git(wt.diffArgs.join(' '), wt.dir) + git(wt.statusArgs.join(' '), wt.dir); } catch (_) {}
      extra.diff = d.slice(0, 60000);
      extra.expectedWrite = true;
    }
    const prompt = buildStagePrompt(step, opt.task, prior, extra);
    process.stdout.write(`── ${step.label} / ${step.engine} … `);
    // 何も出ないまま何分も待たされると、動いているのか固まったのか分からない。
    const t0 = Date.now();
    const tick = setInterval(() => process.stdout.write(`${Math.round((Date.now() - t0) / 1000)}秒 `), 30000);
    const at = (step.stage === 'survey') ? cwd : workCwd;
    const r = await runStage(step.engine, prompt, at, !step.read, step.timeoutMs);
    clearInterval(tick);
    const out = (r.out || '').trim();
    console.log(`${r.ok ? 'ok' : (r.killed ? '時間切れ' : '失敗')} ${Math.round(r.ms / 1000)}秒`);
    if (!r.ok) {
      console.log((r.err || '').trim().slice(0, 600));
      // 下調べや点検が落ちても本作業は続ける。落ちた工程は無かったことにする。
      if (step.stage === 'work') { console.log('\n本作業が落ちたので中止します。'); process.exit(1); }
      continue;
    }
    console.log(out + '\n');
    prior.push({ stage: step.stage, engine: step.engine, out });
  }

  if (plan.unreviewed) console.log('※ 点検を通していません。結果はそのつもりで扱ってください。');

  // 隔離の後始末。差分は patch に落としてから畳む。畳むより先に取ること。
  if (wt) {
    let patch = '';
    try { patch = git(wt.diffArgs.join(' '), wt.dir); } catch (_) {}
    if (patch.trim()) {
      const dir = path.join(os.homedir(), '.claude-code-app', 'patches');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${path.basename(wt.dir)}.patch`);
      fs.writeFileSync(file, patch);
      console.log(`\n書き換えは元のブランチには入っていません。差分はここです:\n  ${file}`);
      console.log(`当てるなら: git apply "${file}"   (中身を読んでから)`);
    } else {
      console.log('\n作業ツリーに差分はありませんでした(何も書き換えていません)。');
    }
    try { git(wt.removeArgs.join(' '), cwd); git(wt.deleteBranchArgs.join(' '), cwd); } catch (_) {}
  }
})();
