// 会話タブの画面。Claude デスクトップ / Codex デスクトップと同じく、
// 吹き出し・折りたためるツールの札・その場で押せる許可の札で見せる。
//
// 入力欄は全タブ共通の #input-area をそのまま使う(声の 🎤・波形ボタン・「このタブに渡す」が
// そこに付いているため)。ここが持つのは、タブごとの「画面」と「出来事の描き方」だけ。
//
// renderer.js の多くの場所が tab.term(xterm)を前提にしているので、同じ形の代役(term)を返す。
// write() に来た文字は、端末の色コードを外して小さな知らせとして出す。

(function (root) {
  const md = () => root.BridgeworkMarkdown;
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
    // どれだけ読んでいるか(コンテキスト)と、つながっている連携(MCP)。本人: 確認できるようにしたい
    const meter = el('div', 'chat-meter');
    pane.appendChild(meter);

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
      ctx: 0, ctxWindow: 0, model: '', outTotal: 0, mcp: null, toolCount: 0,
    };

    const kTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    const MCP_MARK = { connected: ['✓', 'ok', 'つながっています'], failed: ['✗', 'bad', 'つながりません'], 'needs-auth': ['🔑', 'warn', 'ログインが要ります'], pending: ['…', 'wait', 'つないでいる途中'], disabled: ['–', 'wait', '止めてあります'] };
    function windowFor(model) { return st.ctxWindow || (/\[1m\]|1m/i.test(model || '') ? 1000000 : 200000); }
    const countBy = (rows, k) => rows.filter((x) => x.status === k).length;
    function renderMeter() {
      const parts = [];
      if (st.ctx) {
        const w = windowFor(st.model);
        const pct = Math.min(100, Math.round((st.ctx / w) * 100));
        const lvl = pct >= 85 ? 'bad' : pct >= 60 ? 'warn' : 'ok';
        parts.push(`<span class="cm-ctx ${lvl}" title="この会話がいま読んでいる量(コンテキスト)。いっぱいに近づくと古い部分が要約されます。出力の累計 ${kTok(st.outTotal)} トークン"><span class="cm-label">コンテキスト</span><span class="cm-bar"><i style="width:${pct}%"></i></span>${kTok(st.ctx)} / ${kTok(w)}<span class="cm-pct">${pct}%</span></span>`);
      }
      if (st.mcp) {
        const ok = countBy(st.mcp, 'connected'), auth = countBy(st.mcp, 'needs-auth'), bad = countBy(st.mcp, 'failed');
        parts.push(`<button type="button" class="cm-mcp" data-act="mcp" title="連携(MCP)の今の状態を見る">🔌 連携 ✓${ok}${auth ? ` <span class="cm-warn">🔑${auth}</span>` : ''}${bad ? ` <span class="cm-bad">✗${bad}</span>` : ''}</button>`);
      } else {
        parts.push('<span class="cm-mcp-wait" title="最初に話しかけたあとに分かります">🔌 連携 —</span>');
      }
      meter.innerHTML = parts.join('');
      if (st.popOpen) drawPop();
    }
    function drawPop() {
      let pop = document.querySelector('.cm-pop');
      if (!pop) { pop = el('div', 'cm-pop'); document.body.appendChild(pop); }
      const rows = (st.mcp || []).slice().sort((a, b) => (b.status === 'connected') - (a.status === 'connected') || a.name.localeCompare(b.name));
      const order = ['connected', 'needs-auth', 'failed', 'pending', 'disabled'];
      const sum = order.map((k) => [k, countBy(rows, k)]).filter(([, n]) => n).map(([k, n]) => `${MCP_MARK[k][0]} ${MCP_MARK[k][2]} ${n}`).join(' · ');
      pop.innerHTML = `<div class="cm-pop-h">連携 <small>${rows.length}件${st.toolCount ? ` · 道具 ${st.toolCount}個` : ''}${st.mcpChecking ? ' · 確かめています…' : ''}</small><div class="cm-sum">${esc(sum)}</div></div>` +
        (rows.length ? rows.map((x) => { const [m, c, label] = MCP_MARK[x.status] || ['?', 'wait', x.status]; return `<div class="cm-row ${c}"><span class="cm-st">${m}</span><span class="cm-name">${esc(x.name.replace(/^claude\.ai /, ''))}</span><span class="cm-sts">${esc(label)}</span></div>`; }).join('') : '<div class="cm-row">連携はありません</div>') +
        '<div class="cm-pop-f">つながらない連携も、話しかけるたびに読み込みと待ち時間がかかります。使わないものは外すと速く・安くなります。ログインは端末で <code>claude</code> を開いて <code>/mcp</code> から</div>';
      // ボタンの上か下の、広い方に出す(画面の外にはみ出さない)
      const b = meter.querySelector('[data-act="mcp"]'); if (!b) return;
      const r = b.getBoundingClientRect();
      const below = window.innerHeight - r.bottom, above = r.top;
      pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
      if (below >= above) { pop.style.top = `${r.bottom + 6}px`; pop.style.bottom = ''; pop.style.maxHeight = `${below - 20}px`; }
      else { pop.style.bottom = `${window.innerHeight - r.top + 6}px`; pop.style.top = ''; pop.style.maxHeight = `${above - 20}px`; }
    }
    function closePop() { st.popOpen = false; const p = document.querySelector('.cm-pop'); if (p) p.remove(); }
    async function mcpPopover() {
      if (st.popOpen) { closePop(); return; }
      st.popOpen = true; st.mcpChecking = true; drawPop();
      // 会話の始まりの状態は古い(つなぐ途中)。開くたびに今の状態を聞く
      let asked = false;
      try { asked = api.chatMcpStatus ? await api.chatMcpStatus(sid()) : false; } catch (_) {}
      if (!asked) { st.mcpChecking = false; if (st.popOpen) drawPop(); }
    }
    meter.addEventListener('click', (e) => { if (e.target.closest('[data-act="mcp"]')) mcpPopover(); });
    document.addEventListener('mousedown', (e) => { if (st.popOpen && !e.target.closest('.cm-pop') && !e.target.closest('.chat-meter')) closePop(); });
    renderMeter();

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
        case 'init':
          if (ev.model) st.model = ev.model;
          if (ev.mcpServers) { st.mcp = ev.mcpServers; st.toolCount = ev.toolCount || 0; }
          renderMeter();
          break;
        case 'auto-model':
          note(`おまかせ: ${({ haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' })[ev.model] || ev.model} で答えます(${ev.why})`);
          break;
        case 'mcp-status':
          st.mcp = ev.mcpServers; st.mcpChecking = false;
          renderMeter();
          break;
        case 'usage':
          st.ctx = ev.context; st.outTotal += ev.output || 0;
          if (ev.model) st.model = ev.model;
          renderMeter();
          break;
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
          if (ev.contextWindow) { st.ctxWindow = ev.contextWindow; renderMeter(); }
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

  root.BridgeworkChatView = { create, toolSummary };
})(typeof self !== 'undefined' ? self : this);
