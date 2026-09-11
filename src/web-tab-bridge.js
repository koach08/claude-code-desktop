// Web タブ(claude.ai / chatgpt.com をアプリの中で開いたもの)を、外(制御窓・Claude Code)から
// 読んで操作するための橋。
//
// なぜ要るか: 本人は ChatGPT や Claude のチャットを Ariya Bridge の中で開き、そこへ
// 「作業に応じて向いているエンジンに投げる」をしたい。画面をスクショして押すより、
// webview の中で JS を走らせて入力欄に書き、返事の本文を読む方が速くて確実。
//
// ⚠️ 中で JS を走らせられる口。制御窓の合言葉(127.0.0.1 のみ・control.json)が前提。
//    書き込み(ask/eval/navigate)は control-off で止まり、control.log に残る。
//
// サイトの構造は変わる。入力欄と送信ボタンは候補を並べて順に試し、外れたら
// {ok:false, error} を返す(黙って何もしないより、外れたと分かる方がよい)。

const MAX_ASK = 20000;

function cleanText(s, max) {
  return String(s || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, max);
}

// 入力欄に書いて送る。ページの中で走る。
function askScript(text, submit) {
  return `(function(text, submit){
    const vis = (el) => !!el && el.offsetParent !== null && !el.disabled;
    const boxes = [...document.querySelectorAll('div[contenteditable="true"], textarea')].filter(vis);
    const box = boxes[boxes.length - 1];
    if (!box) return { ok: false, error: '入力欄が見つかりません' };
    box.focus();
    if (box.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    }
    if (!submit) return { ok: true, submitted: false, box: box.tagName };
    return new Promise((resolve) => setTimeout(() => {
      const cands = [
        'button[data-testid="send-button"]', 'button[data-testid="composer-speech-button"] ~ button',
        'button[aria-label*="送信"]', 'button[aria-label*="Send"]', 'button[aria-label*="送る"]',
        'form button[type="submit"]',
      ];
      for (const sel of cands) {
        const b = [...document.querySelectorAll(sel)].filter(vis).pop();
        if (b) { b.click(); return resolve({ ok: true, submitted: true, via: sel }); }
      }
      const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
      box.dispatchEvent(ev);
      resolve({ ok: true, submitted: true, via: 'Enter' });
    }, 150));
  })(${JSON.stringify(text)}, ${submit ? 'true' : 'false'})`;
}

// 最後の返事と「まだ書いている途中か」を読む。ページの中で走る。
const READ_SCRIPT = `(function(){
  const vis = (el) => !!el && el.offsetParent !== null;
  const stop = ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]', 'button[aria-label*="停止"]', 'button[aria-label*="止め"]']
    .some((s) => [...document.querySelectorAll(s)].some(vis));
  const cands = [
    '[data-message-author-role="assistant"]',            // ChatGPT
    '[data-testid="assistant-message"]', '.font-claude-message', '[data-is-streaming]', // Claude
    'article', '.message.assistant', '.assistant',
  ];
  let last = null, via = '';
  for (const s of cands) {
    const els = [...document.querySelectorAll(s)].filter(vis);
    if (els.length) { last = els[els.length - 1]; via = s; break; }
  }
  const text = last ? last.innerText : '';
  return { busy: stop, via, text: String(text || '').slice(0, 30000), title: document.title, url: location.href };
})()`;

function textScript(selector) {
  return `(function(sel){
    const el = sel ? document.querySelector(sel) : document.body;
    if (!el) return { ok: false, error: '要素がありません' };
    return { ok: true, text: String(el.innerText || '').slice(0, 60000), title: document.title, url: location.href };
  })(${JSON.stringify(selector || '')})`;
}

// どの Web タブに投げるか。engine-judge の判定を「どのチャットか」に読み替える。
//   astra → ChatGPT / claude → Claude / それ以外(codex, gemini, grok, shell) → Web には投げず、判定だけ返す
function pickWebTarget(judgement) {
  const e = judgement && judgement.engine;
  if (e === 'astra') return 'chatgpt';
  if (e === 'claude') return 'claude';
  return null;
}
function tabMatches(tab, target) {
  const u = String(tab.url || '');
  if (target === 'chatgpt') return /^https:\/\/chatgpt\.com\//.test(u);
  if (target === 'claude') return /^https:\/\/claude\.ai\//.test(u);
  return false;
}
const TARGET_URL = { chatgpt: 'https://chatgpt.com/?model=auto', claude: 'https://claude.ai/new' };
const TARGET_TITLE = { chatgpt: 'ChatGPT チャット', claude: 'Claude チャット' };

// 任意のサイト(Glexa など)を触るための汎用操作。ページの中で走る。
function clickScript(selector, text) {
  return `(function(sel, txt){
    const vis = (el) => !!el && el.offsetParent !== null;
    let el = null;
    if (sel) el = [...document.querySelectorAll(sel)].filter(vis).pop() || document.querySelector(sel);
    if (!el && txt) {
      const all = [...document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"], label, li, span, div')].filter(vis);
      el = all.find((e) => (e.innerText || e.value || '').trim() === txt) || all.find((e) => (e.innerText || e.value || '').includes(txt));
    }
    if (!el) return { ok: false, error: '押す先が見つかりません' };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, tag: el.tagName, text: String(el.innerText || el.value || '').slice(0, 80) };
  })(${JSON.stringify(selector || '')}, ${JSON.stringify(text || '')})`;
}
function fillScript(selector, text) {
  return `(function(sel, val){
    const el = document.querySelector(sel);
    if (!el) return { ok: false, error: '入力欄が見つかりません' };
    el.focus();
    if (el.isContentEditable) { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, val); }
    else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : (el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, tag: el.tagName };
  })(${JSON.stringify(selector || '')}, ${JSON.stringify(text || '')})`;
}
// 画面の中の「押せるもの・書けるもの」の一覧。スクショ無しで当たりを付けるため
const OUTLINE_SCRIPT = `(function(){
  const vis = (el) => !!el && el.offsetParent !== null;
  const out = [];
  const sel = 'a[href], button, input, select, textarea, [role="button"], [contenteditable="true"]';
  for (const el of [...document.querySelectorAll(sel)].filter(vis).slice(0, 300)) {
    const t = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const id = el.id ? '#' + el.id : '';
    const name = el.name ? '[name=' + el.name + ']' : '';
    out.push(el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : '') + id + name + (t ? ' "' + t + '"' : '') + (el.href ? ' → ' + String(el.href).slice(0, 80) : ''));
  }
  return { title: document.title, url: location.href, items: out };
})()`;

module.exports = { clickScript, fillScript, OUTLINE_SCRIPT, MAX_ASK, cleanText, askScript, READ_SCRIPT, textScript, pickWebTarget, tabMatches, TARGET_URL, TARGET_TITLE };
