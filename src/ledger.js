// タブ台帳(sessions.json)の読み書き。
//
// この1ファイルが「どの会話を --resume で戻すか」の唯一の記録なので、壊れると
// 全タブが一度に消える。以前は writeFileSync で直接上書きしていた(10秒ごと＋
// ウインドウ非アクティブのたび)。書き込み中にプロセスが落ちるとファイルが途中で
// 切れ、次回起動の JSON.parse が失敗して黙って [] が返る = 全滅する経路だった。
//
// 対策は2段構え:
//   1. 一時ファイルへ書いてから rename する(同一ファイルシステム上の rename は
//      アトミックなので、読み手は「古い完全な内容」か「新しい完全な内容」しか見ない)
//   2. 直前の内容を sessions.prev.json に残し、本体が壊れていたらそこから復帰する
const fs = require('fs');
const path = require('path');

const MAIN = 'sessions.json';
const PREV = 'sessions.prev.json';

// 台帳を安全に書く。壊れた中間状態を読み手に見せない。
function saveLedger(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const main = path.join(dir, MAIN);
  const tmp = path.join(dir, `${MAIN}.tmp`);
  const text = JSON.stringify(data, null, 2);

  // 直前の完全な内容を退避してから差し替える。
  try { if (fs.existsSync(main)) fs.copyFileSync(main, path.join(dir, PREV)); } catch (_) {}

  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, main);   // ここがアトミック
}

// 台帳を読む。本体が壊れていたら退避分から復帰する。
// 返り値の from は 'main' | 'prev' | 'none'(呼び出し側のログ用)。
function loadLedger(dir) {
  const read = (name) => {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (!Array.isArray(parsed)) throw new Error('配列ではない');
    return parsed;
  };

  try {
    const main = read(MAIN);
    // 空配列は「全タブを閉じた」という正当な状態。ここで prev に戻すと
    // 閉じたはずのタブが蘇るので、壊れている場合だけ退避分を見る。
    if (main !== undefined) return { sessions: main, from: 'main' };
  } catch (_) { /* 壊れている → prev へ */ }

  try {
    const prev = read(PREV);
    if (prev !== undefined) return { sessions: prev, from: 'prev' };
  } catch (_) {}

  return { sessions: [], from: 'none' };
}

// 同じ conversationId を複数のタブが持っている台帳を正す。
//
// 検出を mtime でやっていた頃(〜v1.5.3)のタブは、同じ cwd の別タブが喋っただけで
// その会話を「自分のもの」と誤認していた。実測で 13 タブ中 9 タブが他タブと会話を
// 共有していた。この台帳をそのまま復元すると `claude --resume <同じID>` が同時に
// 何本も走り、1つの transcript に多重書き込みが起きる。
//
// 先頭に出てきたタブが会話を引き継ぎ、以降の重複タブは会話なし(新規)で開く。
// タブ自体は消さない。消すと本人の作業面が黙って減るため。
function dedupeConversationIds(list) {
  const seen = new Set();
  const stripped = [];
  const out = list.map((s) => {
    const id = s && s.conversationId;
    if (!id) return s;
    if (!seen.has(id)) { seen.add(id); return s; }
    stripped.push({ tab: s.name || s.id, conversationId: id });
    return { ...s, conversationId: null };
  });
  return { sessions: out, stripped };
}

module.exports = { saveLedger, loadLedger, dedupeConversationIds, MAIN, PREV };
