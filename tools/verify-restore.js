#!/usr/bin/env node
// 再起動のあとに「タブが戻ったか」と「会話が続きから再開できるか」を **別々に** 見る。
//
// この 2 つは別の話。タブが 19 個並んでも、会話 ID の無いタブは新しい会話として
// 立ち上がっているだけで、続きにはなっていない。並んで見えるので混同しやすい。
//
// 使い方:
//   再起動の前: node tools/verify-restore.js snapshot
//   再起動の後: node tools/verify-restore.js check
//
// snapshot は ~/.claude-code-app/restore-snapshot.json に置く。

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.claude-code-app');
const SESSIONS = path.join(DIR, 'sessions.json');
const SNAP = path.join(DIR, 'restore-snapshot.json');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

function readTabs() {
  return JSON.parse(fs.readFileSync(SESSIONS, 'utf-8'));
}

// 会話ファイルの場所と最終更新。会話が「続いた」かはここで見る。
function transcriptOf(cid) {
  if (!cid) return null;
  let found = null;
  for (const d of fs.readdirSync(PROJECTS)) {
    const p = path.join(PROJECTS, d, `${cid}.jsonl`);
    try {
      const st = fs.statSync(p);
      found = { path: p, size: st.size, mtime: st.mtimeMs };
    } catch (_) { /* 無ければ次 */ }
  }
  return found;
}

function snapshot() {
  const tabs = readTabs();
  const rows = tabs.map((t) => {
    const cid = t.conversationId || '';
    const tr = transcriptOf(cid);
    const buf = path.join(DIR, 'buffers', `${t.id}.buf`);
    let bufSize = 0;
    try { bufSize = fs.statSync(buf).size; } catch (_) {}
    return {
      id: t.id, name: t.name || '', cwd: t.cwd || '', mode: t.mode || '',
      conversationId: cid,
      transcript: tr ? { size: tr.size, mtime: tr.mtime } : null,
      bufSize,
    };
  });
  const snap = { at: Date.now(), count: rows.length, tabs: rows };
  fs.writeFileSync(SNAP, JSON.stringify(snap, null, 2));
  const withId = rows.filter((r) => r.conversationId).length;
  console.log(`控えました: ${rows.length} 個`);
  console.log(`  会話IDあり ${withId} 個 / なし ${rows.length - withId} 個`);
  console.log(`  ${SNAP}`);
  console.log('');
  console.log('⚠️ 会話IDの無いタブは、再起動すると新しい会話として立ち上がります。');
  console.log('   タブが並ぶことと、会話が続くことは別です。');
  return 0;
}

function check() {
  if (!fs.existsSync(SNAP)) {
    console.error('控えがありません。先に snapshot を走らせてください。');
    return 1;
  }
  const before = JSON.parse(fs.readFileSync(SNAP, 'utf-8'));
  const after = readTabs();
  const afterById = new Map(after.map((t) => [t.id, t]));

  // ── 1. タブが戻ったか ────────────────────────────────────
  console.log('■ 1. タブが戻ったか');
  const missing = before.tabs.filter((b) => !afterById.has(b.id));
  const added = after.filter((a) => !before.tabs.some((b) => b.id === a.id));
  console.log(`  前 ${before.count} 個 → 後 ${after.length} 個`);
  if (missing.length) {
    console.log(`  ✖ 戻らなかった ${missing.length} 個:`);
    for (const m of missing) console.log(`      ${m.id}  ${m.name}`);
  } else {
    console.log('  ✔ 全部戻りました');
  }
  if (added.length) console.log(`  ＋ 増えた ${added.length} 個`);

  // ── 2. 会話が続きから再開できたか ────────────────────────
  console.log('');
  console.log('■ 2. 会話が続きから再開できたか（タブが戻ったことと別に見る）');
  let resumed = 0; let fresh = 0; let lost = 0;
  for (const b of before.tabs) {
    const a = afterById.get(b.id);
    if (!a) continue;
    const cid = a.conversationId || '';
    if (!b.conversationId) {
      // もともと ID が無い＝続きにはならない
      if (cid) { console.log(`  ＋ ${b.id.slice(-9)} 新しく ID が付きました (${cid.slice(0, 8)})`); }
      fresh++;
      continue;
    }
    if (cid !== b.conversationId) {
      console.log(`  ✖ ${b.id.slice(-9)} 会話が別のものに変わりました`);
      lost++;
      continue;
    }
    const tr = transcriptOf(cid);
    if (!tr) {
      console.log(`  ✖ ${b.id.slice(-9)} 会話ファイルが見つかりません`);
      lost++;
      continue;
    }
    // 再開して喋っていれば、ファイルが伸びているか更新されている
    const grew = b.transcript && (tr.size > b.transcript.size || tr.mtime > b.transcript.mtime);
    console.log(`  ✔ ${b.id.slice(-9)} 同じ会話に繋がっています`
                + `${grew ? '（再開後に伸びています）' : '（まだ喋っていません）'}`);
    resumed++;
  }
  console.log('');
  console.log(`  続きから再開できた: ${resumed} 個`);
  console.log(`  もともと ID が無く、新しい会話になった: ${fresh} 個`);
  if (lost) console.log(`  ✖ 失われた: ${lost} 個`);

  // ── 3. 中身は残っているか ────────────────────────────────
  console.log('');
  console.log('■ 3. 端末の記録は残っているか（会話が新しくても、何をしていたかは読める）');
  let kept = 0; let shrunk = 0;
  for (const b of before.tabs) {
    const p = path.join(DIR, 'buffers', `${b.id}.buf`);
    let size = 0;
    try { size = fs.statSync(p).size; } catch (_) {}
    if (size >= b.bufSize * 0.5) kept++;
    else { shrunk++; console.log(`  ✖ ${b.id.slice(-9)} 記録が減りました ${b.bufSize} → ${size}`); }
  }
  console.log(`  残っている ${kept} 個 / 減った ${shrunk} 個`);

  return (missing.length || lost) ? 1 : 0;
}

const cmd = process.argv[2];
if (cmd === 'snapshot') process.exit(snapshot());
else if (cmd === 'check') process.exit(check());
else {
  console.log('使い方: node tools/verify-restore.js snapshot | check');
  process.exit(2);
}
