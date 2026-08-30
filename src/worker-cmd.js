// タブを開かずにエンジンを走らせるための、コマンド組み立て。
//
// ── なぜ要るか ──
// これまでこのアプリがエンジンを動かす手段は nodePty.spawn だけで、つまり
// 「人間がタブを開く」以外に仕事を出す方法が無かった。判定 (engine-judge) が
// 判定したところで、渡す先が無いので人間が開き直すしかない。
// ここは各 CLI の非対話モードを1か所にまとめて、裏で走らせられるようにする。
//
// ── 既定は読み取り専用 ──
// write を明示しない限り、どのエンジンも「調べて答える」までしかできない形で
// 起動する。同じリポジトリを2つのエンジンが同時に編集して壊した事故が
// 過去に実際に起きているため、書き込みは worktree 隔離が入るまで opt-in にする。
//
// ── 共通の落とし穴(実地で踏んだもの) ──
//  - codex / gemini とも、git 外や信頼していないディレクトリで trust チェックに
//    引っかかって黙って止まる。--skip-git-repo-check / --skip-trust が要る。
//  - stdin を開けたままだと入力待ちで固まる。呼ぶ側で必ず閉じること。

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AriyaWorkerCmd = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // 読み取りだけで済む工程(下調べ・レビュー・影響追跡)で許す道具。
  const READ_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];

  const ENGINES = {
    claude: {
      bin: 'claude',
      build: (task, opts) => {
        const args = ['-p', task, '--model', opts.model || 'opus[1m]'];
        // 書き込みを許さないときは道具を明示的に絞る。既定では編集できてしまう。
        if (!opts.write) args.push('--allowed-tools', ...READ_TOOLS);
        return args;
      },
    },
    codex: {
      bin: 'codex',
      build: (task, opts) => [
        'exec', task,
        '-m', opts.model || 'gpt-5.5',
        '-C', opts.cwd,
        '--skip-git-repo-check',
        '-s', opts.write ? 'workspace-write' : 'read-only',
      ],
    },
    gemini: {
      bin: 'gemini',
      key: 'GEMINI_API_KEY',
      build: (task, opts) => [
        '-p', task,
        '-m', opts.model || 'gemini-3.7-flash',
        '--skip-trust',
        // plan = 読み取り専用。auto_edit は編集だけ自動承認(シェル実行は含まない)。
        '--approval-mode', opts.write ? 'auto_edit' : 'plan',
      ],
    },
    grok: {
      bin: 'opencode',
      key: 'XAI_API_KEY',
      // opencode には読み取り専用の指定が無い。書き込みを止める手段が無いので、
      // 隔離された作業ツリーの中でしか使わない前提にする。
      readOnlyUnsupported: true,
      build: (task, opts) => ['run', '-m', opts.model || 'xai/grok-4.6', task],
    },
  };

  // engine → 実行に必要な材料。呼ぶ側は spawn するだけでよい形にして返す。
  function buildCommand(engine, task, opts = {}) {
    const spec = ENGINES[engine];
    if (!spec) throw new Error(`未知のエンジン: ${engine}`);
    const t = String(task || '').trim();
    if (!t) throw new Error('タスクが空');
    const o = { write: false, ...opts };
    if (!o.cwd) throw new Error('cwd は必須');
    // 読み取り専用にできないエンジンを、読み取り専用のつもりで起動させない。
    // 旗を立てて返すだけだと、呼ぶ側が見落とした瞬間に「write:false のはずが
    // 書き込める」状態で走る(Codex の点検で指摘された)。ここで止める。
    // どうしても使うなら allowUnsandboxed を明示させ、承知の上だと分かる形にする。
    if (spec.readOnlyUnsupported && !o.write && !o.allowUnsandboxed) {
      throw new Error(`${engine} は読み取り専用で起動できない(隔離した作業ツリーの中でだけ使うこと)`);
    }
    return {
      engine,
      bin: spec.bin,
      args: spec.build(t, o),
      cwd: o.cwd,
      // このキーが要るなら、呼ぶ側が env に入れてから spawn する。
      needsKey: spec.key || null,
      // 読み取り専用にできないエンジンを、読み取り専用のつもりで使わせない。
      readOnlyUnsupported: !!spec.readOnlyUnsupported,
      write: !!o.write,
    };
  }

  function listEngines() { return Object.keys(ENGINES); }

  return { buildCommand, listEngines, READ_TOOLS };
});
