// 会話タブの画面。Claude デスクトップ / Codex デスクトップと同じく、
// 吹き出し・折りたためるツールの札・その場で押せる許可の札で見せる。
//
// 入力欄は全タブ共通の #input-area をそのまま使う(声の 🎤・波形ボタン・「このタブに渡す」が
// そこに付いているため)。ここが持つのは、タブごとの「画面」と「出来事の描き方」だけ。
//
// renderer.js の多くの場所が tab.term(xterm)を前提にしているので、同じ形の代役(term)を返す。
// write() に来た文字は、端末の色コードを外して小さな知らせとして出す。

(function (root) {
  const md = () => root.AriyaMarkdown;
  const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  const TOOL_LABEL = {
    Bash: 'コマンド', Read: '読む', Write: '書く', Edit: '直す', MultiEdit: '直す', Glob: '探す', Grep: '探す',
    WebFetch: 'ページを読む', WebSearch: '検索', Task: '下請け', Agent: '下請け', TodoWrite: 'やること', NotebookEdit: 'ノート',
  };

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  const esc = (s) => md().escapeHtml(s);

  function toolSummary(name, input) {
    const i = input || {};
    if (name && name.startsWith('mcp__')) {
      const parts = name.split('__');
      return { label: parts.slice(-1)[0].replace(/[-_]/g, ' '), arg: i.query || i.subject || i.title || i.q || '' , service: parts[1] || '' };
    }
    const arg = i.command || i.file_path || i.notebook_path || i.path || i.pattern || i.url || i.query || i.description || i.prompt || '';
    return { label: TOOL_LABEL[name] || name, arg: String(arg), service: '' };
  }

  function create(opts) {
    const { session, api, character, onBusy, onTitle, speakDefault } = opts;
    const sid = () => opts.getSessionId();

    const pane = el('div', 'pane chat');
    const scroller = el('div', 'chat-scroll');
    const list = el('div', 'chat-list');
    scroller.appendChild(list);
    const statusLine = el('div', 'chat-statusline');
    pane.appendChild(scroller);
    pane.appendChild(statusLine);

    const st = {
      busy: false,
      streaming: new Map(),   // ブロック番号 → { el, raw }
      tools: new Map(),       // tool_use_id → 札
      perms: new Map(),
      speak: !!speakDefault,
      lastAssistantText: '',
      empty: true,
      rafPending: new Set(),
      character,
    };

    // ── 空のときの「今日は何をしますか」 ──
    const welcome = el('div', 'chat-welcome');
    pane.appendChild(welcome);
    function renderWelcome() {
      const c = st.character;
      welcome.innerHTML = `
        <div class="cw-avatar" style="background:${esc(c.color)}">${esc(c.initial)}</div>
        <h2>${esc(c.name)}です。今日は何をしますか？</h2>
        <p class="cw-sub">下の入力欄に書くか、🎤 で話しかけてください。用途を選ぶと、使う連携と確認の仕方が変わります。</p>
        <div class="cw-purposes"></div>`;
      const box = welcome.querySelector('.cw-purposes');
      for (const p of (opts.presets && opts.presets.purposes) || []) {
        const b = el('button', 'cw-purpose' + (session.chat && session.chat.purpose === p.id ? ' active' : ''),
          `<span class="cwp-icon">${esc(p.icon)}</span><span class="cwp-label">${esc(p.label)}</span><span class="cwp-hint">${esc(p.hint)}</span>`);
        b.addEventListener('click', () => opts.onPurpose && opts.onPurpose(p.id));
        box.appendChild(b);
      }
    }
    renderWelcome();
    const setEmpty = (v) => { st.empty = v; pane.classList.toggle('is-empty', v); };
    setEmpty(true);

    const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    const stick = (force) => { if (force || atBottom()) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; }); };

    function setBusy(v, label) {
      st.busy = v;
      pane.classList.toggle('busy', v);
      statusLine.innerHTML = v ? `<span class="dots"><i></i><i></i><i></i></span> ${esc(label || '考えています…')}` : '';
      if (onBusy) onBusy(v);
    }

    function avatar() {
      const c = st.character;
      return `<div class="msg-av" style="background:${esc(c.color)}" title="${esc(c.name)}">${esc(c.initial)}</div>`;
    }

    function addUser(text, extra, attachments) {
      setEmpty(false);
      const row = el('div', 'msg user');
      const chips = (attachments || []).map((a) => `<span class="att-chip" title="${esc(a.url || '')}">📎 ${esc(a.title || a.url || '資料')}</span>`).join('');
      const bubble = el('div', 'bubble', esc(text).replace(/\n/g, '<br>') + (extra ? `<div class="msg-extra">${esc(extra)}</div>` : '') + (chips ? `<div class="msg-atts">${chips}</div>` : ''));
      row.appendChild(bubble);
      list.appendChild(row);
      stick(true);
    }

    function newAssistantBlock() {
      setEmpty(false);
      const row = el('div', 'msg assistant');
      row.innerHTML = avatar();
      const body = el('div', 'md');
      const tools = el('div', 'msg-tools');
      tools.innerHTML = `<button class="mt-btn" data-act="copy" title="コピー">⧉</button><button class="mt-btn" data-act="speak" title="読み上げる">🔊</button>`;
      const wrap = el('div', 'msg-body');
      wrap.appendChild(body);
      wrap.appendChild(tools);
      row.appendChild(wrap);
      list.appendChild(row);
      const block = { el: body, raw: '', row };
      tools.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.act === 'copy') navigator.clipboard.writeText(block.raw).catch(() => {});
        if (b.dataset.act === 'speak') speak(block.raw, true);
      });
      return block;
    }

    function paint(block) {
      if (st.rafPending.has(block)) return;
      st.rafPending.add(block);
      requestAnimationFrame(() => {
        st.rafPending.delete(block);
        block.el.innerHTML = md().render(block.raw);
        stick();
      });
    }

    function toolCard(ev) {
      setEmpty(false);
      const s = toolSummary(ev.name, ev.input);
      const card = el('details', 'tool-card');
      card.innerHTML = `<summary><span class="tc-state"></span><span class="tc-label">${esc(s.service ? s.service + ' · ' : '')}${esc(s.label)}</span><span class="tc-arg">${esc(s.arg.slice(0, 160))}</span></summary>
        <div class="tc-body"><pre class="tc-input">${esc(JSON.stringify(ev.input || {}, null, 2).slice(0, 4000))}</pre><pre class="tc-result"></pre></div>`;
      // ツールは返事の流れの中に、直前の吹き出しの下へ並べる
      list.appendChild(card);
      st.tools.set(ev.id, card);
      stick();
      return card;
    }

    function permissionCard(ev) {
      setEmpty(false);
      const s = toolSummary(ev.tool, ev.input);
      const card = el('div', 'perm-card');
      const detail = ev.input && (ev.input.command || ev.input.file_path || ev.input.url) ? (ev.input.command || ev.input.file_path || ev.input.url) : JSON.stringify(ev.input || {}).slice(0, 400);
      card.innerHTML = `<div class="pc-title">⚠ ${esc(st.character.name)}が「${esc(s.label)}」をしてよいか聞いています</div>
        <pre class="pc-detail">${esc(String(detail).slice(0, 1200))}</pre>
        <div class="pc-actions">
          <button class="pc-btn allow">許可</button>
          ${ev.suggestions ? '<button class="pc-btn always">今後も許可</button>' : ''}
          <button class="pc-btn deny">やめて</button>
        </div>`;
      const done = (label) => { card.classList.add('done'); card.querySelector('.pc-actions').innerHTML = `<span class="pc-done">${esc(label)}</span>`; };
      card.querySelector('.allow').addEventListener('click', () => { api.chatPermission(sid(), ev.requestId, true, false); done('許可しました'); });
      const al = card.querySelector('.always');
      if (al) al.addEventListener('click', () => { api.chatPermission(sid(), ev.requestId, true, true); done('今後も許可しました'); });
      card.querySelector('.deny').addEventListener('click', () => { api.chatPermission(sid(), ev.requestId, false, false); done('止めました'); });
      list.appendChild(card);
      st.perms.set(ev.requestId, card);
      stick(true);
      if (opts.onAttention) opts.onAttention('approval');
    }

    function note(text, kind) {
      const n = el('div', 'chat-note' + (kind ? ' ' + kind : ''), esc(text));
      list.appendChild(n);
      stick();
    }

    let audio = null;
    async function speak(text, force) {
      if (!text || (!st.speak && !force) || !api.voiceTts) return;
      try {
        const plain = text.replace(/```[\s\S]*?```/g, '(コードは画面で)').replace(/[#*`>|]/g, '').slice(0, 1200);
        const r = await api.voiceTts({ text: plain, voice: st.character.voice || undefined });
        if (!r || !r.audio) return;
        if (audio) { try { audio.pause(); } catch (_) {} }
        const url = URL.createObjectURL(new Blob([r.audio], { type: r.mime || 'audio/mpeg' }));
        audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        audio.play().catch(() => {});
      } catch (_) {}
    }

    function handle(ev, live = true) {
      switch (ev.kind) {
        case 'user-text':
          addUser(ev.text, ev.images ? `画像 ${ev.images} 枚` : '', ev.attachments);
          if (live) setBusy(true);
          break;
        case 'message-start':
          st.streaming.clear();
          break;
        case 'block-start':
          if (ev.blockType === 'text') st.streaming.set(ev.index, newAssistantBlock());
          else if (ev.blockType === 'thinking' && live) setBusy(true, '考えています…');
          else if (ev.blockType === 'tool_use' && live) setBusy(true, `${toolSummary(ev.name, {}).label} を使っています…`);
          break;
        case 'text-delta': {
          let b = st.streaming.get(ev.index);
          if (!b) { b = newAssistantBlock(); st.streaming.set(ev.index, b); }
          b.raw += ev.text;
          paint(b);
          if (live) setBusy(true, '書いています…');
          break;
        }
        case 'text': {
          // 差分で伸ばしてきた塊を、完成した文で確定させる
          let b = null;
          for (const [k, v] of st.streaming) { if (!v.final) { b = v; st.streaming.delete(k); break; } }
          if (!b) b = newAssistantBlock();
          b.raw = ev.text; b.final = true;
          b.el.innerHTML = md().render(b.raw);
          st.lastAssistantText = ev.text;
          stick();
          break;
        }
        case 'tool-use':
          if (!st.tools.has(ev.id)) toolCard(ev);
          break;
        case 'tool-result': {
          const card = st.tools.get(ev.id);
          if (card) {
            card.classList.add(ev.isError ? 'err' : 'ok');
            card.querySelector('.tc-result').textContent = (ev.text || '').slice(0, 6000);
          }
          break;
        }
        case 'permission':
          permissionCard(ev);
          setBusy(true, 'あなたの許可を待っています');
          break;
        case 'status':
          if (live && st.busy && ev.status && ev.status !== 'requesting') setBusy(true, ev.status);
          break;
        case 'result':
          setBusy(false);
          if (live) {
            if (ev.costUsd != null || ev.ms) {
              const secs = ev.ms ? `${Math.round(ev.ms / 100) / 10}秒` : '';
              statusLine.innerHTML = `<span class="done-meta">${esc(secs)}${ev.costUsd != null ? ` · $${ev.costUsd.toFixed(3)}` : ''}</span>`;
            }
            speak(st.lastAssistantText);
            if (opts.onAttention) opts.onAttention('done');
          }
          break;
        case 'exit':
          setBusy(false);
          if (ev.err) note(`止まりました: ${ev.err}`, 'error');
          break;
        default: break;
      }
      if (onTitle && ev.kind === 'user-text' && live) onTitle(ev.text);
    }

    // Alfred(koach-os)への問い合わせ。会話の流れとは別の札として出す(Claude 側の記録には入らない)
    function alfredCard(question) {
      setEmpty(false);
      const card = el('div', 'alfred-card');
      card.innerHTML = `<div class="ac-head">🎩 Alfred に聞いています</div><div class="ac-q">${esc(question)}</div><div class="ac-a md"><span class="dots"><i></i><i></i><i></i></span></div>`;
      list.appendChild(card);
      stick(true);
      return {
        done: (r) => {
          const ok = r && r.ok && r.spoken;
          card.querySelector('.ac-head').textContent = ok ? '🎩 Alfred の答え' : '🎩 Alfred に届きませんでした';
          card.querySelector('.ac-a').innerHTML = ok ? md().render(String(r.spoken)) : esc((r && r.error) || '不明');
          if (ok && Array.isArray(r.tools) && r.tools.length) {
            card.insertAdjacentHTML('beforeend', `<div class="ac-tools">使ったもの: ${esc(r.tools.join('、'))}</div>`);
          }
          if (ok) speak(String(r.spoken));
          stick(true);
        },
      };
    }

    async function loadTranscript(conversationId, cwd) {
      if (!conversationId) return;
      const rows = await api.chatTranscript(conversationId, cwd);
      if (!rows || !rows.length) return;
      for (const ev of rows) handle(ev, false);
      note('— ここまでが前回の会話です —', 'divider');
      stick(true);
    }

    // xterm の代役。renderer.js の既存の呼び出し(write/scroll/focus/dispose)をそのまま受ける
    const term = {
      cols: 120, rows: 30, options: {},
      buffer: { active: { viewportY: 0, baseY: 0, type: 'normal' } },
      write: (s) => { const t = String(s).replace(ANSI, '').replace(/[│┌└─┐┘]+/g, '').trim(); if (t) note(t); },
      clear: () => { list.innerHTML = ''; setEmpty(true); },
      scrollToBottom: () => stick(true),
      scrollToLine: () => {},
      focus: () => { const ta = document.getElementById('prompt-input'); if (ta) ta.focus(); },
      dispose: () => { if (audio) { try { audio.pause(); } catch (_) {} } },
      open: () => {}, loadAddon: () => {}, onData: () => {},
    };

    pane.addEventListener('click', (e) => {
      const b = e.target.closest('.code-copy');
      if (b) {
        const code = b.parentElement.querySelector('code');
        navigator.clipboard.writeText(code ? code.textContent : '').then(() => { b.textContent = 'コピーしました'; setTimeout(() => { b.textContent = 'コピー'; }, 1200); }).catch(() => {});
      }
      const a = e.target.closest('a[href]');
      if (a) { e.preventDefault(); if (api.openExternal) api.openExternal(a.href); }
    });

    return {
      pane, term,
      fit: { fit: () => {} },
      handle, loadTranscript, note, alfredCard,
      get lastAssistantText() { return st.lastAssistantText; },
      get busy() { return st.busy; },
      setSpeak: (v) => { st.speak = !!v; },
      get speakOn() { return st.speak; },
      setCharacter: (c) => { st.character = c; renderWelcome(); },
      refreshWelcome: () => renderWelcome(),
      stopAudio: () => { if (audio) { try { audio.pause(); } catch (_) {} } },
    };
  }

  root.AriyaChatView = { create, toolSummary };
})(typeof self !== 'undefined' ? self : this);
