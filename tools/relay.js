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

function runStage(engine, prompt, cwd, write, timeoutMs) {
  const spec = buildCommand(engine, prompt, { cwd, write });
  const env = { ...process.env };
  if (spec.needsKey && !env[spec.needsKey]) {
    const k = readSecretKey(spec.needsKey);
    if (k) { env[spec.needsKey] = k; if (spec.needsKey === 'XAI_API_KEY') env.GROK_API_KEY = k; }
  }
  return new Promise((res) => {
    runProcess({ bin: spec.bin, args: spec.args, cwd: spec.cwd, env, timeoutMs }, { onDone: res });
  });
}

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

  // 点検に渡す差分。本作業が書き込む回だけ、前後で git の状態を比べて取る。
  // 自己申告だけを点検させると、何も書き換えていなくても「問題なし」が返る。
  const gitDiff = () => {
    try {
      return execSync('git diff HEAD 2>/dev/null; git status --porcelain 2>/dev/null',
        { cwd, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
    } catch { return ''; }
  };
  const before = opt.write ? gitDiff() : '';
  const extra = {};

  const prior = [];
  for (const step of plan.steps) {
    if (step.stage === 'review' && opt.write) {
      const after = gitDiff();
      // 走らせる前から出ていた差分は、この回の成果ではない。
      extra.diff = after === before ? '' : after.slice(0, 60000);
      extra.expectedWrite = true;
    }
    const prompt = buildStagePrompt(step, opt.task, prior, extra);
    process.stdout.write(`── ${step.label} / ${step.engine} … `);
    // 何も出ないまま何分も待たされると、動いているのか固まったのか分からない。
    const t0 = Date.now();
    const tick = setInterval(() => process.stdout.write(`${Math.round((Date.now() - t0) / 1000)}秒 `), 30000);
    const r = await runStage(step.engine, prompt, cwd, !step.read, step.timeoutMs);
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
})();
