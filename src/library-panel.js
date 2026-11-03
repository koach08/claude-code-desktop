// 情報ノートの画面(右から出る引き出し)。
//
// 本人の流れ(2026-11-03): 面白い動画・記事を見つける → コピペでチャットに貼る、をやめて、
// URL を渡すだけで「取り込む → 読み解く → ノートに置く → 会話に添付する」までをここで済ませる。
// YouTube はチャンネルごと取り込めて、見張っておけば新着も自動でノートになる。
//
// renderer.js の中身には触らず、hooks で「会話に添付」「Web タブで開く」だけ借りる。

(function (root) {
  const md = () => root.BridgeworkMarkdown;
  const esc = (s) => md().escapeHtml(s);
  const KIND_ICON = { 'yt-video': '▶️', web: '🌐', digest: '🧭' };
  const LENSES = [
    { id: 'dev', label: '🛠 アプリ開発' }, { id: 'research', label: '📚 研究' },
    { id: 'ship', label: '🚀 販売・集客' }, { id: 'general', label: '💬 なんでも' },
  ];

  function init(hooks) {
    const api = root.api;
    const panel = document.getElementById('lib-panel');
    if (!panel || !api || !api.libList) return null;
    const $ = (sel) => panel.querySelector(sel);

    panel.innerHTML = `
      <div class="lib-head">
        <strong>📥 情報ノート</strong>
        <span class="lib-sub">YouTube・Web を取り込んで、使える形に</span>
        <span class="ct-spacer"></span>
        <button type="button" data-act="folder" title="情報ノートのフォルダを Finder で開く">フォルダ</button>
        <button type="button" data-act="close" title="閉じる (Esc)">✕</button>
      </div>
      <div class="lib-body">
        <section class="lib-ingest">
          <input id="lib-url" type="text" placeholder="YouTube の動画・チャンネル・再生リスト、Web ページの URL" autocomplete="off" spellcheck="false" />
          <div class="lib-row">
            <select id="lib-lens" title="どの観点で読み解くか">${LENSES.map((l) => `<option value="${l.id}">${esc(l.label)}</option>`).join('')}</select>
            <select id="lib-count" title="チャンネル・再生リストから新しい順に何本"><option value="3">3本</option><option value="5" selected>5本</option><option value="10">10本</option><option value="20">20本</option></select>
            <select id="lib-model" title="読み解く頭"><option value="sonnet">Sonnet(標準)</option><option value="haiku">Haiku(速い・安い)</option><option value="opus">Opus(深く)</option></select>
            <select id="lib-video" title="動画の中身(映像)をどう読むか。字幕の無い動画は、どれでも手元で音声を書き起こします"><option value="gemini">🎬 Gemini が映像ごと見る</option><option value="frames">🖼 場面の画像を Claude が見る</option><option value="off">字幕だけ</option></select>
            <label class="lib-watch" title="このチャンネルを見張り、新着を自動でノートにする(6時間ごと・1回3本まで)"><input id="lib-watch" type="checkbox" /> 新着を見張る</label>
          </div>
          <div class="lib-row lib-gkey hidden">
            <input id="lib-gkey" type="password" placeholder="Gemini の API キー(aistudio.google.com/apikey で作れます)" autocomplete="off" spellcheck="false" />
            <button type="button" data-act="save-gkey" title="このアプリ専用の .env(~/.config/bridgework/.env)に保存します">保存</button>
          </div>
          <input id="lib-focus" type="text" placeholder="特に知りたいこと(任意) 例: 授業で使える AI ツール / 個人開発の集客" autocomplete="off" />
          <div class="lib-row">
            <button type="button" class="lib-primary" data-act="ingest">取り込んで分析</button>
            <button type="button" data-act="attach-raw" title="分析せず、字幕・本文をそのまま会話に添付">分析せず会話に添付</button>
          </div>
          <div class="lib-jobs"></div>
        </section>
        <section class="lib-watches"></section>
        <section class="lib-notes">
          <div class="lib-row"><input id="lib-q" type="search" placeholder="ノートを検索(タイトル・チャンネル・タグ)" /><button type="button" data-act="reload" title="一覧を読み直す">↻</button></div>
          <div class="lib-list"></div>
        </section>
        <section class="lib-detail hidden"></section>
      </div>`;

    const state = { notes: [], watches: [], dir: '', jobs: new Map(), open: false, caps: null };

    // ── 取り込み欄 ──
    const urlIn = $('#lib-url');
    const syncKind = () => {
      const v = urlIn.value.trim();
      const isList = /youtube\.com\/(@|channel\/|c\/|user\/|playlist)/.test(v);
      const isChannel = /youtube\.com\/(@|channel\/|c\/|user\/)/.test(v);
      const isYt = /youtube\.com\/|youtu\.be\//.test(v);
      $('#lib-count').style.display = isList ? '' : 'none';
      $('.lib-watch').style.display = isChannel ? '' : 'none';
      $('#lib-video').style.display = isYt ? '' : 'none';
      const needKey = isYt && $('#lib-video').value === 'gemini' && state.caps && !state.caps.gemini;
      $('.lib-gkey').classList.toggle('hidden', !needKey);
    };
    // 映像の読み方は前回の選び方を覚える(この端末だけ)
    try { const v = localStorage.getItem('ariya.lib.video'); if (v) $('#lib-video').value = v; } catch (_) {}
    $('#lib-video').addEventListener('change', () => { try { localStorage.setItem('ariya.lib.video', $('#lib-video').value); } catch (_) {} syncKind(); });
    async function loadCaps() {
      try { state.caps = await api.libCaps(); } catch (_) { state.caps = null; }
      const opt = $('#lib-video option[value="gemini"]');
      if (state.caps) opt.textContent = state.caps.gemini ? '🎬 Gemini が映像ごと見る' : '🎬 Gemini が映像ごと見る(鍵が要ります)';
      syncKind();
    }
    async function saveGeminiKey() {
      const k = $('#lib-gkey').value.trim();
      if (!k) { $('#lib-gkey').focus(); return; }
      const r = await api.libSetGeminiKey(k);
      $('#lib-gkey').value = '';
      if (!r || !r.ok) { jobLine(null, `✗ ${(r && r.error) || '保存できませんでした'}`, 'err'); return; }
      jobLine(null, 'Gemini の鍵を保存しました(このアプリ専用の .env)', 'ok');
      loadCaps();
    }
    function videoChoice() {
      const v = $('#lib-video').value;
      // 鍵が無いまま Gemini を選んでいたら、場面の画像で読む(止めない)
      return v === 'gemini' && state.caps && !state.caps.gemini ? 'frames' : v;
    }
    urlIn.addEventListener('input', syncKind);
    urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ingest(); } });
    syncKind();

    async function ingest() {
      const url = urlIn.value.trim();
      if (!url) { urlIn.focus(); return; }
      const r = await api.libIngest({
        url, lens: $('#lib-lens').value, focus: $('#lib-focus').value.trim(), model: $('#lib-model').value,
        count: Number($('#lib-count').value), watch: $('#lib-watch').checked, video: videoChoice(),
      });
      if (!r || !r.ok) { jobLine(null, `✗ ${(r && r.error) || '始められませんでした'}`, 'err'); return; }
      urlIn.value = ''; $('#lib-watch').checked = false; syncKind();
      jobLine(r.jobId, '始めています…');
    }
    async function attachRaw() {
      const url = urlIn.value.trim();
      if (!url) { urlIn.focus(); return; }
      if (/youtube\.com\/(@|channel\/|c\/|user\/|playlist)/.test(url)) { jobLine(null, 'チャンネルは「取り込んで分析」で。添付は動画1本・ページ1枚ずつです', 'err'); return; }
      const line = jobLine(`raw_${Date.now()}`, '中身を取っています…');
      const r = await api.libFetchRaw(url);
      if (!r || !r.ok) { line.set(`✗ ${(r && r.error) || '取れませんでした'}`, 'err'); return; }
      hooks.attachToChat({ title: r.title, url: r.url, text: r.text });
      line.set(`📎 会話に添付しました: ${r.title}`, 'ok');
      urlIn.value = '';
    }

    function jobLine(jobId, text, cls) {
      const box = $('.lib-jobs');
      let row = jobId && state.jobs.get(jobId);
      if (!row) {
        row = document.createElement('div');
        row.className = 'lib-job';
        row.innerHTML = '<span class="lj-text"></span><span class="lj-bar"><i></i></span>' + (jobId && !String(jobId).startsWith('raw_') ? '<button type="button" class="lj-stop" title="止める">止める</button>' : '');
        box.prepend(row);
        if (jobId) state.jobs.set(jobId, row);
        const stop = row.querySelector('.lj-stop');
        if (stop) stop.addEventListener('click', () => { api.libCancel(jobId); stop.disabled = true; });
        row.set = (t, c) => { row.querySelector('.lj-text').textContent = t; row.className = 'lib-job' + (c ? ' ' + c : ''); };
        while (box.children.length > 6) box.lastChild.remove();
      }
      row.set(text, cls);
      return row;
    }

    // main からの進み具合
    api.onLibProgress((p) => {
      if (p.jobId) {
        const row = jobLine(p.jobId, p.text, p.stage === 'error' ? 'err' : p.stage === 'done' ? 'ok' : p.stage === 'warn' ? 'warn' : '');
        if (p.total) row.querySelector('.lj-bar i').style.width = `${Math.round(((p.done || 0) / p.total) * 100)}%`;
        if (p.stage === 'done' || p.stage === 'error') {
          const stop = row.querySelector('.lj-stop'); if (stop) stop.remove();
          row.querySelector('.lj-bar i').style.width = '100%';
          state.jobs.delete(p.jobId);
          if (p.stage === 'done' && p.entry && state.open) showNote(p.entry.id);
        }
      } else if (p.stage === 'watch-done' || p.fromWatch) {
        if (p.fromWatch) hooks.badge && hooks.badge(1);
        if (p.stage === 'watch-done' && state.open) jobLine(null, p.text, p.added ? 'ok' : '');
      }
      if (p.entry || p.stage === 'watch-done') { if (state.open) reload(); }
    });

    // ── 見張り ──
    function renderWatches() {
      const box = $('.lib-watches');
      if (!state.watches.length) { box.innerHTML = ''; return; }
      box.innerHTML = `<div class="lib-h">👀 見張っているチャンネル <button type="button" data-act="check" title="今すぐ新着を確認">今すぐ確認</button></div>` +
        state.watches.map((w, i) => `<div class="lib-wrow" data-i="${i}">
          <label title="自動で新着をノートにする"><input type="checkbox" data-act="auto" ${w.auto !== false ? 'checked' : ''}/> ${esc(w.title || w.url)}</label>
          <small>${esc((LENSES.find((l) => l.id === w.lens) || {}).label || '')}${w.checkedAt ? ` · 確認 ${esc(new Date(w.checkedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}` : ''}</small>
          <button type="button" data-act="unwatch" title="見張りをやめる(ノートは消えません)">やめる</button></div>`).join('');
    }

    // ── 一覧 ──
    function renderList() {
      const box = $('.lib-list');
      if (!state.notes.length) {
        box.innerHTML = `<div class="lib-empty">まだノートがありません。上に YouTube やページの URL を貼って「取り込んで分析」を押すと、ここに並びます。<br><small>置き場: ${esc(state.dir)}</small></div>`;
        return;
      }
      box.innerHTML = state.notes.map((n) => `<div class="lib-item" data-id="${esc(n.id)}">
        <div class="li-title">${KIND_ICON[n.kind] || '📄'} ${esc(n.title)}</div>
        <div class="li-meta">${esc([n.channel, n.published || (n.fetched || '').slice(0, 10), (LENSES.find((l) => l.id === n.lens) || {}).label].filter(Boolean).join(' · '))}</div>
        ${n.summary ? `<div class="li-sum">${esc(n.summary)}</div>` : ''}
        ${(n.tags || []).length ? `<div class="li-tags">${n.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
      </div>`).join('');
    }

    let qTimer = null;
    async function reload() {
      const r = await api.libList($('#lib-q').value.trim());
      state.notes = r.notes || []; state.watches = r.watches || []; state.dir = r.dir || '';
      renderWatches(); renderList();
    }
    $('#lib-q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(reload, 200); });

    // ── 1件の中身 ──
    // 頭の決まりごと(frontmatter)と、場面の画像の並び(上に画像で出す)を除いた本文
    function noteBody(markdown) {
      return String(markdown || '').replace(/^---\n[\s\S]*?\n---\n/, '').replace(/\n## 場面\n\n(?:!\[[^\]]*\]\(frames\/[^)]*\)\n?)+/, '\n');
    }
    let current = null;
    async function showNote(id) {
      const r = await api.libRead(id);
      if (!r) return;
      current = { id, ...r, entry: state.notes.find((n) => n.id === id) };
      const body = noteBody(r.markdown);
      const fm = (k) => { const m = new RegExp(`^${k}: (".*")$`, 'm').exec(r.markdown); try { return m ? JSON.parse(m[1]) : ''; } catch (_) { return ''; } };
      current.url = fm('url');
      current.title = fm('title') || (current.entry && current.entry.title) || id;
      const d = $('.lib-detail');
      d.innerHTML = `<div class="lib-row ld-bar">
          <button type="button" data-act="back">‹ 一覧</button><span class="ct-spacer"></span>
          <button type="button" class="lib-primary" data-act="attach-note" title="この分析を会話に添付">📎 会話に添付</button>
          ${r.raw ? '<button type="button" data-act="attach-full" title="元の字幕・本文も一緒に添付">＋元データも</button>' : ''}
          ${hooks.makeSlides ? '<button type="button" data-act="slides" title="このノートを元にスライドを作る">🖼 スライドに</button>' : ''}
          ${current.url ? '<button type="button" data-act="open-src" title="元の動画・ページをアプリ内のブラウザで開く">🌐 元を開く</button>' : ''}
          <button type="button" data-act="reveal" title="Finder で表示">Finder</button>
          <button type="button" data-act="trash" title="ゴミ箱へ(Finder のゴミ箱から戻せます)">🗑</button>
        </div>
        ${(r.frames || []).length ? `<div class="ld-frames" title="場面をクリックすると、その時刻から動画を開きます">${r.frames.map((f) => `<figure data-act="frame" data-t="${esc(f.label)}"><img src="${esc(f.src)}" alt="${esc(f.label)} の場面" loading="lazy"><figcaption>${esc(f.label)}</figcaption></figure>`).join('')}</div>` : ''}
        <div class="md ld-md">${md().render(body)}</div>`;
      d.classList.remove('hidden');
      $('.lib-notes').classList.add('hidden');
      $('.lib-ingest').classList.add('hidden');
      $('.lib-watches').classList.add('hidden');
    }
    function backToList() {
      current = null;
      $('.lib-detail').classList.add('hidden');
      for (const s of ['.lib-notes', '.lib-ingest', '.lib-watches']) $(s).classList.remove('hidden');
    }

    panel.addEventListener('click', async (e) => {
      const item = e.target.closest('.lib-item');
      if (item) { showNote(item.dataset.id); return; }
      const a = e.target.closest('[data-act]');
      if (!a) {
        const link = e.target.closest('a[href]');
        if (link) { e.preventDefault(); const href = link.getAttribute('href'); if (/^https?:/.test(href)) hooks.openWeb(href); }
        return;
      }
      const act = a.dataset.act;
      if (act === 'close') close();
      else if (act === 'folder') api.libReveal(null);
      else if (act === 'ingest') ingest();
      else if (act === 'attach-raw') attachRaw();
      else if (act === 'reload') reload();
      else if (act === 'check') { jobLine(null, '新着を確認しています…'); api.libCheckNow(); }
      else if (act === 'unwatch' || act === 'auto') {
        const w = state.watches[Number(a.closest('.lib-wrow').dataset.i)];
        if (!w) return;
        if (act === 'unwatch') await api.libUnwatch(w.url); else await api.libWatchToggle(w.url, a.checked);
        reload();
      } else if (act === 'back') backToList();
      else if (current && (act === 'attach-note' || act === 'attach-full')) {
        const body = noteBody(current.markdown);
        const text = act === 'attach-full' && current.raw ? `${body}\n\n--- 元データ ---\n${current.raw}` : body;
        const title = current.title;
        hooks.attachToChat({ title: `ノート: ${title}`, url: current.url, text, note: current.path });
        close();
      } else if (current && act === 'open-src') { hooks.openWeb(current.url); close(); }
      else if (act === 'save-gkey') saveGeminiKey();
      else if (current && act === 'slides') hooks.makeSlides(current.id);
      else if (current && act === 'frame' && current.url) {
        const sec = String(a.dataset.t || '').split(':').reduce((x, n) => x * 60 + Number(n), 0);
        hooks.openWeb(current.url + (current.url.includes('?') ? '&' : '?') + `t=${sec}s`); close();
      } else if (current && act === 'reveal') api.libReveal(current.id);
      else if (current && act === 'trash') {
        if (!confirm(`「${current.title}」をゴミ箱へ移します。よいですか？\n(Finder のゴミ箱から戻せます)`)) return;
        await api.libTrash(current.id);
        backToList(); reload();
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open) close(); });

    function open(prefill) {
      state.open = true;
      panel.classList.remove('hidden');
      document.body.classList.add('lib-open');
      hooks.badge && hooks.badge(0);
      backToList();
      if (prefill) { urlIn.value = prefill; syncKind(); }
      reload(); loadCaps();
      setTimeout(() => urlIn.focus(), 30);
    }
    function close() {
      state.open = false;
      panel.classList.add('hidden');
      document.body.classList.remove('lib-open');
    }
    // Web タブの「ノートにする」から。観点・頭・知りたいことは引き出しで今選んでいるもの
    async function ingestFromWeb({ url, title, text, youtube }) {
      open();
      const opts = { lens: $('#lib-lens').value, focus: $('#lib-focus').value.trim(), model: $('#lib-model').value, video: videoChoice() };
      const r = youtube ? await api.libIngest({ url, ...opts, count: 1 }) : await api.libIngestText({ url, title, text, ...opts });
      if (r && r.ok) jobLine(r.jobId, '始めています…'); else jobLine(null, `✗ ${(r && r.error) || '始められませんでした'}`, 'err');
    }
    return { open, close, ingestFromWeb, toggle: () => (state.open ? close() : open()), get isOpen() { return state.open; } };
  }

  root.BridgeworkLibrary = { init };
})(typeof window !== 'undefined' ? window : globalThis);
