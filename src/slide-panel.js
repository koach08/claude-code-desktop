// スライドの画面(右から出る引き出し)。
//
// 本人の流れ(2026-11-03): 情報ノートやメモ・テーマから「授業用」「発表用」「アプリ紹介」のスライドを作り、
// 見て、言葉で直して(「3枚目を短く」)、PDF にするか、そのまま全画面で発表する。
// 構成は AI、見た目はアプリのテーマ(slide-deck.js)。ここは頼む・見る・直すだけ。
//
// プレビューは sandbox の iframe(script を動かさない)。HTML 側も script を持たない。

(function (root) {
  const esc = (s) => root.BridgeworkMarkdown.escapeHtml(s);
  const SLIDE_W = 1280, SLIDE_H = 720, GAP = 8;

  function init(hooks) {
    const api = root.api;
    const panel = document.getElementById('slide-panel');
    if (!panel || !api || !api.slideMake) return null;
    const $ = (sel) => panel.querySelector(sel);

    panel.innerHTML = `
      <div class="lib-head">
        <strong>🖼 スライド</strong>
        <span class="lib-sub">情報ノート・メモから、構成とデザインまで</span>
        <span class="ct-spacer"></span>
        <button type="button" data-act="folder" title="スライドのフォルダを Finder で開く">フォルダ</button>
        <button type="button" data-act="close" title="閉じる (Esc)">✕</button>
      </div>
      <div class="lib-body">
        <section class="sl-make">
          <select id="sl-note" title="元にする情報ノート(任意)"><option value="">情報ノートを使わない</option></select>
          <textarea id="sl-topic" rows="2" placeholder="テーマ・伝えたいこと 例: 生成AIを使った英語ライティング指導の実践(初回授業の導入)"></textarea>
          <details class="sl-more"><summary>素材を貼る(原稿・メモ・論文の要旨など。任意)</summary>
            <textarea id="sl-text" rows="6" placeholder="ここに貼った文も素材にします"></textarea>
          </details>
          <div class="lib-row">
            <select id="sl-purpose" title="何に使うスライドか"></select>
            <select id="sl-count" title="枚数のめやす"><option value="5">5枚</option><option value="8" selected>8枚</option><option value="12">12枚</option><option value="16">16枚</option><option value="20">20枚</option></select>
            <select id="sl-theme" title="見た目(後から変えられます)"></select>
            <select id="sl-model" title="構成を考える頭"><option value="sonnet">Sonnet(標準)</option><option value="haiku">Haiku(速い・安い)</option><option value="opus">Opus(深く)</option></select>
          </div>
          <input id="sl-audience" type="text" placeholder="聞き手(任意) 例: 1年生 30人 / 学会の聴衆 / 中小企業の経営者" autocomplete="off" />
          <div class="lib-row"><button type="button" class="lib-primary" data-act="make">スライドを作る</button></div>
          <div class="lib-jobs"></div>
        </section>
        <section class="sl-list"></section>
        <section class="sl-detail hidden"></section>
      </div>`;

    const state = { open: false, opts: null, decks: [], current: null, jobs: new Map() };

    async function loadOptions() {
      if (state.opts) return;
      state.opts = await api.slideOptions();
      $('#sl-purpose').innerHTML = state.opts.purposes.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
      $('#sl-theme').innerHTML = state.opts.themes.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
      try {
        const p = localStorage.getItem('ariya.slide.purpose'); if (p) $('#sl-purpose').value = p;
        const t = localStorage.getItem('ariya.slide.theme'); if (t) $('#sl-theme').value = t;
      } catch (_) {}
    }
    async function loadNotes(selectId) {
      const r = await api.libList('');
      const sel = $('#sl-note');
      sel.innerHTML = '<option value="">情報ノートを使わない</option>' + (r.notes || []).slice(0, 100).map((n) => `<option value="${esc(n.id)}">${esc(n.title)}</option>`).join('');
      if (selectId) sel.value = selectId;
    }

    function jobLine(jobId, text, cls) {
      const box = $('.lib-jobs');
      let row = jobId && state.jobs.get(jobId);
      if (!row) {
        row = document.createElement('div');
        row.className = 'lib-job';
        row.innerHTML = '<span class="lj-text"></span>';
        box.prepend(row);
        if (jobId) state.jobs.set(jobId, row);
        while (box.children.length > 4) box.lastChild.remove();
      }
      row.querySelector('.lj-text').textContent = text;
      row.className = 'lib-job' + (cls ? ' ' + cls : '');
      return row;
    }

    async function make() {
      const opts = {
        noteId: $('#sl-note').value, topic: $('#sl-topic').value.trim(), text: $('#sl-text').value.trim(),
        purpose: $('#sl-purpose').value, count: Number($('#sl-count').value), theme: $('#sl-theme').value,
        model: $('#sl-model').value, audience: $('#sl-audience').value.trim(),
      };
      if (!opts.noteId && !opts.topic && !opts.text) { $('#sl-topic').focus(); return; }
      try { localStorage.setItem('ariya.slide.purpose', opts.purpose); localStorage.setItem('ariya.slide.theme', opts.theme); } catch (_) {}
      const r = await api.slideMake(opts);
      if (!r || !r.ok) { jobLine(null, `✗ ${(r && r.error) || '始められませんでした'}`, 'err'); return; }
      jobLine(r.jobId, '始めています…');
    }

    api.onSlideProgress((p) => {
      const line = jobLine(p.jobId, p.text, p.stage === 'error' ? 'err' : p.stage === 'done' ? 'ok' : '');
      if (state.current && state.current.reviseJob === p.jobId) {
        const st = $('.sd-status'); if (st) { st.textContent = p.text; st.className = 'sd-status' + (p.stage === 'error' ? ' err' : ''); }
        if (p.stage === 'done' || p.stage === 'error') { state.current.reviseJob = null; const b = $('[data-act="revise"]'); if (b) b.disabled = false; }
      }
      if (p.stage === 'done' && p.id) {
        line.dataset.id = p.id;
        if (state.open && (!state.current || state.current.id === p.id)) showDeck(p.id);
        reloadList();
      }
    });

    // ── 一覧 ──
    async function reloadList() {
      state.decks = await api.slideList();
      const box = $('.sl-list');
      if (!state.decks.length) { box.innerHTML = `<div class="lib-empty">まだスライドがありません。上でテーマや情報ノートを選んで「スライドを作る」を押すと、ここに並びます。${state.opts ? `<br><small>置き場: ${esc(state.opts.dir)}</small>` : ''}</div>`; return; }
      box.innerHTML = '<div class="lib-h">作ったスライド</div>' + state.decks.map((d) => `<div class="lib-item" data-id="${esc(d.id)}">
        <div class="li-title">🖼 ${esc(d.title)}</div>
        <div class="li-meta">${esc([`${d.count}枚`, (state.opts && (state.opts.purposes.find((p) => p.id === d.purpose) || {}).label) || '', String(d.updatedAt || '').slice(0, 10), d.pdf ? 'PDFあり' : ''].filter(Boolean).join(' · '))}</div>
      </div>`).join('');
    }

    // ── 1組 ──
    function fitPreview() {
      const wrap = $('.sd-preview'); const fr = wrap && wrap.querySelector('iframe');
      if (!fr || !state.current) return;
      const n = state.current.deck.slides.length;
      const h = n * (SLIDE_H + GAP) - GAP;
      const k = wrap.clientWidth / SLIDE_W;
      fr.style.width = `${SLIDE_W}px`; fr.style.height = `${h}px`; fr.style.transform = `scale(${k})`;
      wrap.style.height = `${Math.ceil(h * k)}px`;
    }
    async function showDeck(id) {
      const r = await api.slideRead(id);
      if (!r) return;
      const keepJob = state.current && state.current.id === id ? state.current.reviseJob : null;
      state.current = { ...r, reviseJob: keepJob };
      const themes = (state.opts && state.opts.themes) || [];
      const d = $('.sl-detail');
      d.innerHTML = `<div class="lib-row ld-bar">
          <button type="button" data-act="back">‹ 一覧</button><span class="ct-spacer"></span>
          <button type="button" class="lib-primary" data-act="present" title="別の窓で全画面。矢印キー・スペースで次へ、Esc で戻る">▶ 発表</button>
          <button type="button" data-act="pdf" title="1枚1ページの PDF に書き出して Finder で見せる">PDF</button>
          <button type="button" data-act="attach" title="構成と話す原稿を会話に添付(続きを会話で詰めるとき)">📎 会話に添付</button>
          <button type="button" data-act="reveal" title="Finder で表示">Finder</button>
          <button type="button" data-act="trash" title="ゴミ箱へ(Finder のゴミ箱から戻せます)">🗑</button>
        </div>
        <div class="sd-title">${esc(r.deck.title)} <small>${r.deck.slides.length}枚</small></div>
        <div class="sd-themes" title="見た目を変える(文はそのまま)">${themes.map((t) => `<button type="button" data-act="theme" data-theme="${esc(t.id)}" class="${t.id === r.theme ? 'on' : ''}"><i style="background:${esc(t.bg)};border-color:${esc(t.accent)}"></i>${esc(t.label)}</button>`).join('')}</div>
        <div class="sd-revise">
          <input id="sd-ask" type="text" placeholder="直してほしいこと 例: 3枚目を2つに分けて / 全体をもっとやさしい言葉で / 最後に問いを1枚" autocomplete="off" />
          <button type="button" data-act="revise" ${keepJob ? 'disabled' : ''}>直す</button>
          ${r.canUndo ? '<button type="button" data-act="undo" title="1つ前の版に戻す">↩ 戻す</button>' : ''}
        </div>
        <div class="sd-status"></div>
        <div class="sd-preview"><iframe sandbox="" title="スライドのプレビュー"></iframe></div>`;
      d.querySelector('iframe').srcdoc = r.html;
      d.classList.remove('hidden');
      $('.sl-make').classList.add('hidden'); $('.sl-list').classList.add('hidden');
      requestAnimationFrame(fitPreview);
      $('#sd-ask').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); revise(); } });
    }
    function backToList() {
      state.current = null;
      $('.sl-detail').classList.add('hidden');
      $('.sl-make').classList.remove('hidden'); $('.sl-list').classList.remove('hidden');
    }
    async function revise() {
      const c = state.current; const ask = $('#sd-ask').value.trim();
      if (!c || !ask) { $('#sd-ask').focus(); return; }
      const r = await api.slideRevise(c.id, ask, $('#sl-model').value);
      const st = $('.sd-status');
      if (!r || !r.ok) { st.textContent = `✗ ${(r && r.error) || '直せませんでした'}`; st.className = 'sd-status err'; return; }
      c.reviseJob = r.jobId; $('[data-act="revise"]').disabled = true; $('#sd-ask').value = '';
      st.textContent = '直しています…'; st.className = 'sd-status';
    }

    panel.addEventListener('click', async (e) => {
      const item = e.target.closest('.lib-item');
      if (item) { showDeck(item.dataset.id); return; }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      const act = a.dataset.act; const c = state.current;
      if (act === 'close') close();
      else if (act === 'folder') api.slideReveal(null);
      else if (act === 'make') make();
      else if (act === 'back') { backToList(); reloadList(); }
      else if (!c) return;
      else if (act === 'present') api.slidePresent(c.id);
      else if (act === 'pdf') {
        a.disabled = true; a.textContent = '書き出し中…';
        const r = await api.slidePdf(c.id);
        a.disabled = false; a.textContent = 'PDF';
        const st = $('.sd-status'); st.textContent = r && r.ok ? `PDF にしました: ${r.path}` : `✗ ${(r && r.error) || 'PDF にできませんでした'}`; st.className = 'sd-status' + (r && r.ok ? '' : ' err');
      } else if (act === 'attach') { hooks.attachToChat({ title: `スライド: ${c.deck.title}`, text: c.markdown }); close(); }
      else if (act === 'reveal') api.slideReveal(c.id);
      else if (act === 'theme') { await api.slideTheme(c.id, a.dataset.theme); showDeck(c.id); }
      else if (act === 'revise') revise();
      else if (act === 'undo') { await api.slideUndo(c.id); showDeck(c.id); }
      else if (act === 'trash') {
        if (!confirm(`「${c.deck.title}」をゴミ箱へ移します。よいですか？\n(Finder のゴミ箱から戻せます)`)) return;
        await api.slideTrash(c.id); backToList(); reloadList();
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open) close(); });
    window.addEventListener('resize', () => { if (state.open) fitPreview(); });

    // from: { noteId } 情報ノートから開いたとき、そのノートを選んだ状態にする
    async function open(from) {
      state.open = true;
      panel.classList.remove('hidden');
      document.body.classList.add('lib-open');
      await loadOptions();
      backToList();
      loadNotes(from && from.noteId);
      reloadList();
      setTimeout(() => $('#sl-topic').focus(), 30);
    }
    function close() {
      state.open = false;
      panel.classList.add('hidden');
      document.body.classList.remove('lib-open');
    }
    return { open, close, toggle: () => (state.open ? close() : open()), get isOpen() { return state.open; } };
  }

  root.BridgeworkSlides = { init };
})(typeof window !== 'undefined' ? window : globalThis);
