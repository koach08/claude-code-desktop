const { app, BrowserWindow, ipcMain, Menu, dialog, shell, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');

// 検証用に起動したビルドが、本人が使っている /Applications 版と同じ領域を触らないようにする。
//
// HOME を差し替えれば ~/.claude-code-app は隔離できるが、**Electron の userData は
// HOME に追従しない**。実測で、テスト起動したビルドも本番と同じ
// ~/Library/Application Support/claude-code-desktop を --user-data-dir に使っており、
// Local Storage / Session Storage を稼働中の本番インスタンスと共有していた。
// single-instance lock を入れない設計(ariya:// を起動中インスタンスへ届けるため)なので、
// 同時に動けば本番のタブUI状態を壊しうる。
//
// あわせてウインドウのタイトルに [DEV] を出す。同じ Dock アイコンの窓が隣に湧くと、
// 使っている側には「勝手に二重起動した」ようにしか見えないため。
const IS_DEV_BUILD = !app.getPath('exe').startsWith('/Applications/');
if (IS_DEV_BUILD) {
  app.setPath('userData', `${app.getPath('userData')}-dev`);
}

// ARIYA_DATA_DIR: 確認用に別の置き場で起動する(本番の台帳・Alfred の鍵を上書きしないため。2026-11-03)
const ISOLATED_DATA = !!process.env.ARIYA_DATA_DIR;
const SESSIONS_DIR = process.env.ARIYA_DATA_DIR || path.join(os.homedir(), '.claude-code-app');
const BUFFERS_DIR = path.join(SESSIONS_DIR, 'buffers');
const CRASH_FLAG = path.join(SESSIONS_DIR, '.running');
const sessions = new Map();
const sessionBuffers = new Map();
// 各セッションについて「最後に .buf へ書いた文字列そのもの」。同一なら書き直さない。
// 長さで判定すると、バッファが上限 1MB に達して古い方から捨て始めたあと、
// 長さが 1MB のまま中身だけ変わり続けるので永久に保存されなくなる。
// 文字列は不変なので、変化が無い間は同じ実体を指すだけでメモリは増えない。
const savedBuffer = new Map();
const MAX_BUFFER = 1024 * 1024; // 1MB per session
let mainWindow = null;
let pty = null;

// ── Resolve shell env (Electron apps don't inherit shell profile) ──
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

let shellEnv = { ...process.env };
// ⚠️ Claude Code のセッションの中から起動されると(入れ替えスクリプトを Claude に走らせた時など)、
//    CLAUDECODE=1 / CLAUDE_CODE_CHILD_SESSION=1 を引き継ぎ、タブの claude が「子セッション」扱いで
//    会話を保存しなくなる(Transcript saving is off)。--resume で戻らず Fleet View にも出ない。
//    2026-09-11 に 07:02 の入れ替え以降の全タブがこれだった。エンジンに渡す環境からは必ず外す。
const CLAUDE_INHERIT_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT'];
function scrubInheritedClaudeEnv(env) {
  for (const k of CLAUDE_INHERIT_KEYS) delete env[k];
  return env;
}
scrubInheritedClaudeEnv(shellEnv);
// Grok コーディングレーンの既定モデル。grok-4.6 = xAI の現行最上位。
// TUI 内で /models から grok-build-0.1（速い・安いコーディング特化）等へ切替可。
// ⚠️ ここだけ版が固定されている。xAI には alias(latest)が無く、モデル ID を直に書くしかない
//    (2026-09-23 実測: 公式ドキュメントの現行は grok-4.6。4.7 は報道のみで ID が確認できない)。
//    だから **環境変数で上書きできる**ようにしてある。新しいのが出たら GROK_MODEL=xai/grok-4.7 を
//    入れるだけでよく、アプリを作り直さなくてよい。他のレーンは別名なので勝手に新しくなる。
const GROK_MODEL = process.env.GROK_MODEL || 'xai/grok-4.6';
// Claude Code レーンで起動時に渡すモデル。'opus[1m]' = 最新 Opus への公式エイリアス
// (CLI が現行最上位 Opus = Opus 5 を自動解決) の 1M コンテキスト版。バージョン固定に
// すると新 Opus が出るたび書き換えが要るため、エイリアス + [1m] で最新へ自動追従する。
// 上位ティア Fable 5 は輸出規制で非公開。
// 既定は最上位(Mythos クラス)。2026-09-23 に実測: `claude -p --model fable` も
// `claude-fable-5-1` も応答する。**公開停止になったのは Fable 5 で、5.1 は現役**。
// 別名で持つので、次に上位が出ても書き換え不要。
// ⚠️ 1M コンテキストが要る作業だけは opus[1m] を明示する(別名に [1m] は付かない)。
// ⚠️ 9/23 本人「勝手に Fable になってる」。既定は Opus(別名なので最新の Opus を指す)。Fable は選んだときだけ
const CLAUDE_MODEL = 'opus';
// 判定から渡してよいモデルの別名。ここに無い文字列は無視して既定に戻す
// (画面から任意の文字列が --model に入るのを防ぐ)。版は書かない=別名は常に最新を指す。
const CLAUDE_MODEL_ALLOW = new Set(['haiku', 'sonnet', 'opus', 'opus[1m]', 'fable']);
if (!IS_WIN) {
  try {
    const shell = IS_MAC ? '/bin/zsh' : '/bin/bash';
    const out = require('child_process').execSync(
      `${shell} -ilc "env"`, { encoding: 'utf-8', timeout: 10000 }
    );
    out.split('\n').forEach(line => {
      const i = line.indexOf('=');
      if (i > 0) shellEnv[line.substring(0, i)] = line.substring(i + 1);
    });
  } catch (_) {}
  scrubInheritedClaudeEnv(shellEnv);   // ログインシェル側にも入っていれば外す
}

function getPty() {
  if (!pty) pty = require('node-pty');
  return pty;
}

// 保存しておいた位置が今のディスプレイ構成に存在しないことがある(外部モニタを外した、
// 解像度を変えた等)。そのまま復元するとウインドウが画面外に出て「起動しても何も出ない」
// 状態になるので、どの表示領域とも重ならない位置は捨てて既定サイズへ戻す。
function sanitizeBounds(saved) {
  if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') return null;
  const width = Math.max(700, Math.min(Math.round(saved.width), 10000));
  const height = Math.max(450, Math.min(Math.round(saved.height), 10000));
  if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return { width, height };
  let onScreen = false;
  try {
    const { screen } = require('electron');
    onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      // タイトルバーを掴める程度に重なっていれば可とする
      return saved.x + width > a.x + 60 && saved.x < a.x + a.width - 60
          && saved.y + height > a.y + 20 && saved.y < a.y + a.height - 20;
    });
  } catch (_) { onScreen = true; }
  return onScreen ? { x: Math.round(saved.x), y: Math.round(saved.y), width, height } : { width, height };
}

function createWindow() {
  let bounds = { width: 1300, height: 850 };
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, 'window.json'), 'utf-8'));
    bounds = sanitizeBounds(saved) || bounds;
  } catch (_) {}

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 700,
    minHeight: 450,
    backgroundColor: '#ffffff',
    title: IS_DEV_BUILD ? '[DEV] Ariya Bridge 開発エージェント' : 'Ariya Bridge 開発エージェント',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 12, y: 12 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Web タブ(koach-os / claude.ai / chatgpt.com をこのアプリの中に出す)のため。
      // 本人の望みは「デスクトップアプリをいくつも開かない」(2026-09-11)
      webviewTag: true,
      // 声のライブは 50ms ごとに音量を見る。窓が後ろに回ると間引かれて区切りが崩れるので、間引かせない
      // (家事をしながら話すとき、Ariya は前面に無い)
      backgroundThrottling: false,
    },
  });
  // ⚠️ webview は中身のサイトが動く別のレンダラ。preload も node も渡さない。
  //    src が http(s) 以外(file: など)なら付けさせない。
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!/^https?:\/\//i.test(String(params.src || ''))) event.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('close', () => {
    // Save sessions + buffers BEFORE the window closes (critical for restore)
    saveSessionsSync();
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(SESSIONS_DIR, 'window.json'),
        JSON.stringify(mainWindow.getBounds())
      );
    } catch (_) {}
  });

  // Save sessions when window loses focus (crash resilience)
  mainWindow.on('blur', () => saveSessionsSync());

  // 起動中に ariya:// で叩かれた分は、タブ復元が落ち着いてから渡す
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) setTimeout(flushPendingDeepLink, 1200);
  });
}

// ── Application Menu ──
function createMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: `${app.name} について` },
        { type: 'separator' },
        { role: 'hide', label: '隠す' },
        { role: 'hideOthers', label: 'ほかを隠す' },
        { role: 'unhide', label: 'すべて表示' },
        { type: 'separator' },
        { role: 'quit', label: '終了' }
      ]
    }] : []),
    {
      label: 'ファイル',
      submenu: [
        {
          label: '新しいタブ',
          accelerator: 'CmdOrCtrl+T',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'new-tab'); }
        },
        {
          // Claude デスクトップ / Codex Desktop / ChatGPT Work で進めた会話を、このアプリのタブとして続ける
          label: '他のアプリの会話を開く…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'open-external'); }
        },
        {
          // Alfred(koach-os) / claude.ai / chatgpt.com をこのアプリの中のタブで開く
          label: 'Web をタブで開く…',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'open-web'); }
        },
        {
          // Brave のログイン(chatgpt.com/openai.com)をこのアプリの Web タブへ取り込む。
          // Google の埋め込みログイン拒否を避けるため、ログイン済みの状態をそのまま移す。
          label: 'Brave から ChatGPT のログインを取り込む',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'import-brave-chatgpt'); }
        },
        {
          label: 'タブを閉じる',
          accelerator: 'CmdOrCtrl+W',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'close-tab'); }
        },
        { type: 'separator' },
        {
          label: 'セッションを保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            saveSessionsSync();
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'saved');
          }
        },
        ...(!isMac ? [{ type: 'separator' }, { role: 'quit', label: '終了' }] : [])
      ]
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '元に戻す' },
        { role: 'redo', label: 'やり直す' },
        { type: 'separator' },
        { role: 'cut', label: '切り取り' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: '貼り付け' },
        { role: 'selectAll', label: 'すべて選択' }
      ]
    },
    {
      label: 'ツール',
      submenu: [
        {
          label: '設定...',
          accelerator: 'CmdOrCtrl+,',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'settings'); }
        },
        { type: 'separator' },
        {
          label: 'このアプリを Claude Code で編集',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'edit-app-claude'); }
        },
        {
          label: 'アプリフォルダを開く',
          click: () => { shell.openPath(path.join(__dirname)); }
        },
        { type: 'separator' },
        {
          label: 'アップデートを確認...',
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'check-update'); }
        },
      ]
    },
    {
      label: 'ウインドウ',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: 'ズーム' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: '前面に移動' }] : [])
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC: Create session ──
// Read a KEY=value entry from the user's local secrets file (non-persistent use).
function readSecretKey(name) {
  try {
    const p = path.join(os.homedir(), '.config', 'app-secrets', 'env.txt');
    const line = fs.readFileSync(p, 'utf-8').split('\n').find(l => l.trim().startsWith(name + '='));
    if (line) return line.slice(line.indexOf('=') + 1).trim();
  } catch (_) {}
  return '';
}

// 会話ID検出の実装は src/conversation-id.js に切り出してある(テストから叩くため)。
// ここが外れると再起動時に --resume が付かず会話が失われる。過去2度踏んだ穴
// (スラッグの作り方 / mtime での絞り込み)は test/conversation-id.test.js で固定した。
const { claudeProjectSlug, findConversationId: findConvIdIn, findCodexSessionId } = require('./src/conversation-id');
const { saveLedger, loadLedger, dedupeConversationIds } = require('./src/ledger');
const { inferProject, groupIntoTeams, cleanTail } = require('./src/board');
const { listExternalConversations } = require('./src/external-conversations');
const { titleSaysWaiting } = require('./src/prompt-detect');

// 生きているタブが使用中の ID を除外したうえで検索する。
function findConversationId(cwd, sinceMs) {
  const claimed = new Set();
  for (const [, s] of sessions) if (s && s.conversationId) claimed.add(s.conversationId);
  return findConvIdIn(cwd, sinceMs, { claimed });
}

// PTY の出力が来るたびに呼ぶ会話ID検出器(1.5秒スロットル)。create-session と
// switch-mode の両方から使う。switch-mode 側には以前これが無く、モードを切り替えた
// タブだけ conversationId を持たないまま = 再起動で会話を失っていた。
function makeConvIdDetector(id, mode, cwd, startMs, preset) {
  let detected = !!preset;
  let lastCheck = 0;
  return () => {
    if ((mode !== 'claude' && mode !== 'codex') || detected) return;
    const now = Date.now();
    if (now - lastCheck < 1500) return;
    lastCheck = now;
    const s = sessions.get(id);
    if (!s || s.conversationId) return;
    let found = null;
    if (mode === 'codex') {
      const claimed = new Set();
      for (const [, o] of sessions) if (o && o.conversationId) claimed.add(o.conversationId);
      found = findCodexSessionId(cwd, startMs, { claimed });
    } else {
      found = findConversationId(cwd, startMs);
    }
    if (found) { s.conversationId = found; detected = true; }
  };
}

// フォルダ名 → タブに出す名前 の対応表。
// 個人のプロジェクト名をソースに埋めないよう、~/.claude-code-app/project-labels.json
// に置く。無ければフォルダ名をそのまま使う。書き換えても再ビルドは要らない。
let projectLabelCache = null;
function loadProjectLabels() {
  if (projectLabelCache) return projectLabelCache;
  try {
    const raw = fs.readFileSync(path.join(SESSIONS_DIR, 'project-labels.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    projectLabelCache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    projectLabelCache = {};
  }
  return projectLabelCache;
}

// 左メニューの束ね方にも同じ表を使う。⚠️ 名前をソース(公開リポジトリ)に書かないため
ipcMain.handle('project-labels', () => loadProjectLabels());

// ── 左メニューの束ね先を、タブの中身から決める (2026-09-24) ──
// 本人: 「その他に 32 個タブが溜まって、そこから探している」。cwd だけで束ねていたのが原因
// (全タブ ~ から開くので全部その他)。判定そのものは src/project-classify.js。
// 表は 3 つとも ~/.claude-code-app/ に置く(ソースに呼び名を書かない):
//   project-labels.json   フォルダ名 → 呼び名(既存)
//   project-keywords.json 呼び名 → 言葉の配列
//   project-assign.json   会話ID → 呼び名(本人が右クリックで移したもの。必ず勝つ)
const { classifyText, readHeadTail } = require('./src/project-classify');
const classifyCache = new Map();   // conversationId -> { size, mtimeMs, result }
function readLocalJson(name) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf-8'));
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch (_) { return {}; }
}
function classifyConversation(conversationId, cwd, tabName, tables) {
  const file = path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd || os.homedir()), `${conversationId}.jsonl`);
  const st = fs.statSync(file);
  const hit = classifyCache.get(conversationId);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.tables === tables.stamp) return hit.result;
  const result = classifyText({ ...readHeadTail(fs, file), tabName }, tables);
  classifyCache.set(conversationId, { size: st.size, mtimeMs: st.mtimeMs, tables: tables.stamp, result });
  return result;
}
const GENERIC_TAB_NAMES = new Set(['Claude Code', 'Codex', 'Gemini', 'Grok', 'Terminal']);
function shortTitle(t) {
  const x = String(t || '').replace(/\s+/g, ' ').trim();
  return x.length > 22 ? x.slice(0, 22) + '…' : x;
}
ipcMain.handle('classify-tabs', () => {
  projectLabelCache = null;                      // 表を書き換えたら再起動なしで効かせる
  const labels = loadProjectLabels();
  const keywords = readLocalJson('project-keywords.json');
  const assign = readLocalJson('project-assign.json');
  const tables = { labels, keywords, stamp: JSON.stringify([labels, keywords]).length + ':' + Object.keys(keywords).join('|') };
  const out = {};
  for (const [id, s] of sessions) {
    if (!s) continue;
    const cid = s.conversationId;
    let project = null, source = null, renamed = null;
    if (cid && assign[cid]) { project = String(assign[cid]); source = 'manual'; }
    if (cid) {
      try {
        const r = classifyConversation(cid, s.cwd, s.name, tables);
        if (!project && r.project) { project = r.project; source = 'auto'; }
        // 新しいタブは「Claude Code」のまま名前が付かなかった。題名か最初の依頼から付ける
        if (GENERIC_TAB_NAMES.has(s.name)) {
          const t = shortTitle(r.aiTitle || r.firstPrompt);
          if (t && t.length >= 4) { s.name = t; renamed = t; }
        }
      } catch (_) { /* 記録がまだ無い(打ち始める前)・読めない */ }
    }
    out[id] = { project, source, name: renamed };
  }
  return out;
});

// 右クリックで束ね先を手で決める。null で「自動に戻す」
ipcMain.handle('assign-project', (_e, { sessionId, project }) => {
  const s = sessions.get(sessionId);
  if (!s || !s.conversationId) return { ok: false, error: 'まだ会話が始まっていないタブは移せません' };
  const assign = readLocalJson('project-assign.json');
  if (project) assign[s.conversationId] = String(project).slice(0, 40);
  else delete assign[s.conversationId];
  const file = path.join(SESSIONS_DIR, 'project-assign.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(assign, null, 2));
  fs.renameSync(tmp, file);
  return { ok: true };
});

// 束ね先の候補(右クリックの一覧)。フォルダの表と言葉の表に出てくる呼び名
ipcMain.handle('project-names', () => {
  projectLabelCache = null;
  const names = new Set([...Object.values(loadProjectLabels()), ...Object.keys(readLocalJson('project-keywords.json'))]);
  return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ja'));
});

// Derive a friendly, project-aware tab name from the working directory.
// Known project folders map to readable labels; otherwise the folder basename is used.
function deriveSessionName(cwd, mode) {
  const norm = String(cwd || '').replace(/\/+$/, '');
  const base = (norm === os.homedir() || !norm) ? '' : norm.split('/').pop();
  const MAP = loadProjectLabels();
  const project = MAP[base] || base;
  if (!project) {
    return mode === 'claude' ? 'Claude Code' : mode === 'codex' ? 'Codex' : mode === 'gemini' ? 'Gemini' : mode === 'grok' ? 'Grok' : 'Terminal';
  }
  const suffix = mode === 'codex' ? ' · Codex' : mode === 'gemini' ? ' · Gemini' : mode === 'grok' ? ' · Grok' : mode === 'shell' ? ' · sh' : '';
  return project + suffix;
}

// ── 会話タブ (mode 'chat', 2026-11-03) ───────────────────────────────
// 端末ではなく Claude デスクトップと同じ吹き出しで見せるタブ。裏は claude -p の stream-json
// (src/agent-session.js)。sessions には端末タブと同じ形で載せ、pty の代わりに「代役」を置く:
// write に '\r' が来たら溜めた文字を1発言として送る / '\x03' は中断。
// こうしておくと、入力欄・声の「このタブに渡す」・Alfred の /tabs/:id/input・自動保存・
// 左メニュー・台帳が、何も変えずに会話タブにも効く。
const { createClaudeSession, transcriptFromJsonl } = require('./src/agent-session');
const chatPresets = require('./src/chat-presets');
const CHARACTERS_FILE = path.join(SESSIONS_DIR, 'characters.json');

function loadExtraCharacters() {
  try {
    const rows = JSON.parse(fs.readFileSync(CHARACTERS_FILE, 'utf-8'));
    return Array.isArray(rows) ? rows.filter((c) => c && c.id && c.name) : [];
  } catch (_) { return []; }
}

function stripAnsi(s) { return String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''); }

function chatToolLine(ev) {
  const i = ev.input || {};
  const arg = i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.description || '';
  return `⏺ ${ev.name}${arg ? `(${String(arg).slice(0, 120)})` : ''}`;
}

function createChatSession(id, { cwd, name, conversationId, chat, deferred }) {
  const opts = {
    model: CLAUDE_MODEL_ALLOW.has(String((chat && chat.model) || '')) ? chat.model : 'sonnet',
    purpose: (chat && chat.purpose) || 'general',
    character: (chat && chat.character) || 'ariya',
  };
  const send = (ch, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload);
  };
  const appendBuf = (text) => {
    let buf = (sessionBuffers.get(id) || '') + text;
    if (buf.length > MAX_BUFFER) buf = buf.slice(-MAX_BUFFER);
    sessionBuffers.set(id, buf);
  };

  const sessionData = {
    pty: null,
    cwd,
    name: name || '新しい会話',
    mode: 'chat',
    chatOpts: opts,
    conversationId: conversationId || null,
    createdAt: new Date().toISOString(),
    lastOutputAt: Date.now(),
    exited: false,
    sleeping: true,
    busy: false,
    pendingPermissions: new Map(),
  };
  sessions.set(id, sessionData);
  sessionBuffers.set(id, '');

  let agent = null;
  let typed = '';

  const start = () => {
    if (agent && agent.alive) return agent;
    sessionData.sleeping = false;
    const env = { ...shellEnv };
    agent = createClaudeSession({
      bin: IS_WIN ? 'claude.cmd' : 'claude',
      cwd: sessionData.cwd,
      env,
      model: sessionData.chatOpts.model,
      resume: sessionData.conversationId || undefined,
      appendSystemPrompt: chatPresets.systemPromptFor(sessionData.chatOpts, loadExtraCharacters()),
    }, {
      onEvent: (ev) => {
        sessionData.lastOutputAt = Date.now();
        if (ev.kind === 'init' && ev.sessionId) {
          sessionData.conversationId = ev.sessionId;
        } else if (ev.kind === 'text') {
          appendBuf(`\n${ev.text}\n`);
        } else if (ev.kind === 'tool-use') {
          appendBuf(`\n${chatToolLine(ev)}\n`);
        } else if (ev.kind === 'permission') {
          sessionData.pendingPermissions.set(ev.requestId, ev);
          appendBuf(`\n⚠ 許可待ち: ${ev.tool}\n`);
        } else if (ev.kind === 'result') {
          sessionData.busy = false;
        }
        send(`chat-event-${id}`, ev);
      },
      onExit: ({ code, err }) => {
        sessionData.busy = false;
        sessionData.pendingPermissions.clear();
        // 会話そのものは終わっていない。次の発言で --resume して起こし直す
        agent = null;
        sessionData.sleeping = true;
        send(`chat-event-${id}`, { kind: 'exit', code, err: code ? stripAnsi(err || '').slice(-600) : null });
      },
    });
    return agent;
  };

  const submit = (text, images) => {
    const t = String(text || '').trim();
    if (!t && !(images && images.length)) return false;
    const a = start();
    // 最初の発言で名前を付ける(画面側と同じ規則。台帳・左メニュー・Alfred の /tabs に効かせる)
    if (sessionData.name === '新しい会話') sessionData.name = t.replace(/\s+/g, ' ').slice(0, 28);
    sessionData.busy = true;
    sessionData.lastOutputAt = Date.now();
    appendBuf(`\n› ${t}\n`);
    send(`chat-event-${id}`, { kind: 'user-text', text: t, images: (images || []).length });
    return a.send(t, images);
  };

  sessionData.chat = {
    submit,
    interrupt: () => (agent ? agent.interrupt() : false),
    respondPermission: (requestId, allow, extra) => {
      const p = sessionData.pendingPermissions.get(requestId);
      sessionData.pendingPermissions.delete(requestId);
      if (!agent) return false;
      return agent.respondPermission(requestId, allow, { updatedInput: (p && p.input) || {}, ...(extra || {}) });
    },
    // モデル・用途・キャラを変える。動いていれば止め、次の発言で同じ会話のまま起こし直す
    configure: (next) => {
      const o = sessionData.chatOpts;
      if (next.model && CLAUDE_MODEL_ALLOW.has(next.model)) o.model = next.model;
      if (next.purpose) o.purpose = next.purpose;
      if (next.character) o.character = next.character;
      if (next.cwd && fs.existsSync(next.cwd)) sessionData.cwd = next.cwd;
      if (agent) { const a = agent; agent = null; a.close(); }
      sessionData.sleeping = true;
      return { ...o, cwd: sessionData.cwd };
    },
    close: () => { if (agent) agent.close(); agent = null; },
  };

  // 端末タブ向けの呼び出し(send-input / control-server / 声の受け渡し)を受ける代役
  sessionData.pty = {
    write: (d) => {
      const s = String(d);
      if (s === '\x03' || s === '\x1b') { sessionData.chat.interrupt(); return; }
      typed += s;
      const cut = typed.lastIndexOf('\r');
      if (cut < 0) return;
      const text = typed.slice(0, cut).replace(/\r/g, '\n');
      typed = typed.slice(cut + 1);
      if (text.trim()) submit(text);
    },
    resize: () => {},
    kill: () => sessionData.chat.close(),
  };
  sessionData.wake = () => sessionData.pty;   // 発言が来るまで claude は起こさない(MCP の起動待ちを空振りさせない)

  if (conversationId) {
    const t = titleForConversation(conversationId, cwd);
    if (t && (!name || name === '新しい会話')) sessionData.name = t;
  }
  return { id, name: sessionData.name, cwd, mode: 'chat', chat: opts, restored: !!conversationId, sleeping: true, conversationId: sessionData.conversationId };
}

ipcMain.handle('chat-send', async (_e, { sessionId, text, images }) => {
  const s = sessions.get(sessionId);
  if (!s || !s.chat) return { ok: false, reason: 'no-session' };
  return { ok: !!s.chat.submit(text, images) };
});
ipcMain.handle('chat-interrupt', async (_e, { sessionId }) => {
  const s = sessions.get(sessionId);
  return { ok: !!(s && s.chat && s.chat.interrupt()) };
});
ipcMain.handle('chat-permission', async (_e, { sessionId, requestId, allow, always }) => {
  const s = sessions.get(sessionId);
  if (!s || !s.chat) return { ok: false };
  const p = s.pendingPermissions.get(requestId);
  const extra = (allow && always && p && Array.isArray(p.suggestions)) ? { updatedPermissions: p.suggestions } : {};
  return { ok: !!s.chat.respondPermission(requestId, !!allow, extra) };
});
ipcMain.handle('chat-configure', async (_e, { sessionId, ...next }) => {
  const s = sessions.get(sessionId);
  if (!s || !s.chat) return null;
  return s.chat.configure(next);
});
ipcMain.handle('chat-presets', async () => ({
  purposes: chatPresets.PURPOSES,
  characters: chatPresets.CHARACTERS.concat(loadExtraCharacters()),
  models: chatPresets.MODELS,
}));
// 再起動後・過去の会話を開いたときに、吹き出しを描き直す材料
ipcMain.handle('chat-transcript', async (_e, { conversationId, cwd }) => {
  if (!conversationId || !/^[0-9a-f-]{36}$/i.test(conversationId)) return [];
  const p = path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd || os.homedir()), `${conversationId}.jsonl`);
  try {
    const st = fs.statSync(p);
    // 長い会話は末尾だけ読む(数十MBになることがある)
    const MAX = 3 * 1024 * 1024;
    const fd = fs.openSync(p, 'r');
    const len = Math.min(st.size, MAX);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    let text = buf.toString('utf-8');
    if (st.size > MAX) text = text.slice(text.indexOf('\n') + 1);
    return transcriptFromJsonl(text);
  } catch (_) { return []; }
});

ipcMain.handle('create-session', async (_event, { cwd, name, mode, restoreFromId, conversationId, model, deferred, chat }) => {
  const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const sessionCwd = cwd || os.homedir();
  const sessionMode = mode || 'claude';
  if (sessionMode === 'chat') {
    return createChatSession(id, { cwd: sessionCwd, name, conversationId, chat: { model, ...(chat || {}) }, deferred });
  }
  const nodePty = getPty();
  const isRestore = !!(restoreFromId || conversationId);

  let cmd, args;
  // ⚠️ 2026-09-23: ここは CLAUDE_MODEL(opus[1m]) 固定だった。つまり**タイポ直しでも
  //    毎回 Opus の 1M で開いていた**。本人の「結果的に claude code のみを使っていて
  //    トークンの上限が来そうだった」の直接の原因。判定した重さ(model)が来たらそれで開く。
  //    別名(haiku/sonnet/opus)で渡すので、エンジンが新しくなっても勝手に最新を指す。
  const claudeModel = CLAUDE_MODEL_ALLOW.has(String(model || '')) ? String(model) : CLAUDE_MODEL;
  if (sessionMode === 'claude') {
    cmd = IS_WIN ? 'claude.cmd' : 'claude';
    if (conversationId) {
      args = ['--model', claudeModel, '--resume', conversationId];
    } else {
      args = ['--model', claudeModel];
    }
  } else if (sessionMode === 'codex') {
    cmd = IS_WIN ? 'codex.cmd' : 'codex';
    // 前の会話があれば戻す(無ければ素で起動)。Claude の --resume と同じ扱い
    args = conversationId ? ['resume', conversationId] : [];
  } else if (sessionMode === 'gemini') {
    cmd = IS_WIN ? 'gemini.cmd' : 'gemini';
    args = [];
  } else if (sessionMode === 'grok') {
    // Grok コーディングレーン: Grok 専用 CLI は現行 xAI API と噛み合わない(Codex→xAI は
    // responses API 非互換、@vibe-kit/grok-cli は廃止 live-search で 410)。実績ある
    // opencode(TUI エージェント)を xAI/grok に向けて起動する。認証は XAI_API_KEY を注入。
    cmd = IS_WIN ? 'opencode.cmd' : 'opencode';
    args = ['-m', GROK_MODEL];
  } else {
    if (IS_WIN) {
      cmd = 'powershell.exe';
      args = [];
    } else {
      cmd = IS_MAC ? '/bin/zsh' : (process.env.SHELL || '/bin/bash');
      args = ['--login', '-i'];
    }
  }

  const spawnEnv = { ...shellEnv };
  if (sessionMode === 'gemini' && !spawnEnv.GEMINI_API_KEY) {
    const k = readSecretKey('GEMINI_API_KEY');
    if (k) spawnEnv.GEMINI_API_KEY = k;
  }
  if (sessionMode === 'grok' && !spawnEnv.XAI_API_KEY) {
    const k = readSecretKey('XAI_API_KEY');
    if (k) { spawnEnv.XAI_API_KEY = k; spawnEnv.GROK_API_KEY = k; }
  }
  const spawnOpts = {
    name: IS_WIN ? undefined : 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: sessionCwd,
    env: spawnEnv,
  };
  // ⚠️ 2026-10-15: 起動時の復元で全タブの claude を一斉に --resume していた。
  //    33本で約9GB、メモリ18GBの Mac でスワップが満杯になり「時々遅い」の一因(本人)。
  //    復元時に見ていないタブは眠らせておき、開いた・入力が来た時点で起こす。
  //    sessions には載せるので台帳(sessions.json)からは消えず、会話も失われない。
  const sleeping = !!(deferred && isRestore);

  // ⚠️ 再起動で復元した12本が全部「Claude Code」で、何のセッションか分からなかった(本人)。
  //    既定名のままなら、会話の最初の依頼から名前を付ける
  const GENERIC = new Set(['Claude Code', 'Codex', 'Gemini', 'Grok', 'Terminal']);
  let tabName = name || deriveSessionName(sessionCwd, sessionMode);
  if (conversationId && (!name || GENERIC.has(name))) {
    const t = titleForConversation(conversationId, sessionCwd);
    if (t) tabName = t;
  }
  const sessionData = {
    pty: null,
    cwd: sessionCwd,
    name: tabName,
    mode: sessionMode,
    conversationId: conversationId || null,
    createdAt: new Date().toISOString(),
    // ボード表示(#10)用。作業中かどうかは「直近に出力があったか」で見る。
    // Claude Code は作業中スピナーを描き続けるので、動いている限り出力が途切れない。
    lastOutputAt: Date.now(),
    exited: false,
    sleeping: true,   // 下の wake() で起こす(眠らせるタブは起こさない)
  };
  sessions.set(id, sessionData);

  // Start with empty buffer — don't replay stale old output
  sessionBuffers.set(id, '');

  // Auto-detect conversation ID by matching the .jsonl session file Claude creates
  // for this cwd. Runs for the whole session lifetime (throttled) until found — so a
  // tab whose first message comes late still gets a resumable conversationId, which is
  // what lets a restart --resume the real conversation instead of losing it.
  const sessionStartMs = Date.now();
  const detectConvId = makeConvIdDetector(id, sessionMode, sessionCwd, sessionStartMs, conversationId);

  const attach = (ptyProcess) => {
  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session-output-${id}`, data);
    }
    let buf = (sessionBuffers.get(id) || '') + data;
    if (buf.length > MAX_BUFFER) buf = buf.slice(-MAX_BUFFER);
    sessionBuffers.set(id, buf);
    { const s = sessions.get(id); if (s) s.lastOutputAt = Date.now(); }

    // Detect conversation ID from Claude's project directory (throttled to ~1.5s).
    detectConvId();
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    { const s = sessions.get(id); if (s) s.exited = true; }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session-exit-${id}`, { exitCode, signal });
    }
  });
  };

  // 眠っているタブを起こす。起きていれば何もしない
  let pendingSize = null;
  sessionData.wake = () => {
    if (!sessionData.sleeping) return sessionData.pty;
    sessionData.sleeping = false;
    const p = nodePty.spawn(cmd, args, spawnOpts);
    attach(p);
    sessionData.pty = p;
    if (pendingSize) { try { p.resize(pendingSize[0], pendingSize[1]); } catch (_) {} }
    return p;
  };
  if (sleeping) {
    // 眠っている間の代役。書き込み(本人の入力・操作窓からの入力)が来たらその場で起こす。
    // 既存の s.pty.write / resize / kill の呼び出し側はそのままで動く
    sessionData.pty = {
      write: (d) => sessionData.wake().write(d),
      resize: (c, r) => { pendingSize = [c, r]; },
      kill: () => {},
    };
  } else {
    sessionData.wake();
  }

  return { id, name: sessionData.name, cwd: sessionData.cwd, mode: sessionMode, restored: isRestore, sleeping, conversationId: sessionData.conversationId || null };
});

// ── IPC: Switch mode (kills current, starts new) ──
ipcMain.handle('switch-mode', async (_event, { sessionId, newMode }) => {
  const old = sessions.get(sessionId);
  if (!old) return null;
  const { cwd } = old;
  const oldMeta = sessionMetaFor(sessionId);
  const oldBuf = sessionBuffers.get(sessionId);
  try { old.pty.kill(); } catch (_) {}
  sessionBuffers.delete(sessionId);
  savedBuffer.delete(sessionId);
  // モード切替では新しい ID を採番する。古い .buf は保管庫へ(捨てると切替前の画面が読み返せない)
  archiveBuffer(sessionId, 'mode-switch', oldMeta, oldBuf);
  sessions.delete(sessionId);

  const nodePty = getPty();
  let cmd, args;
  if (newMode === 'claude') {
    cmd = IS_WIN ? 'claude.cmd' : 'claude';
    args = ['--model', CLAUDE_MODEL];
  } else if (newMode === 'codex') {
    cmd = IS_WIN ? 'codex.cmd' : 'codex';
    args = [];
  } else if (newMode === 'gemini') {
    cmd = IS_WIN ? 'gemini.cmd' : 'gemini';
    args = [];
  } else if (newMode === 'grok') {
    cmd = IS_WIN ? 'opencode.cmd' : 'opencode';
    args = ['-m', GROK_MODEL];
  } else {
    if (IS_WIN) { cmd = 'powershell.exe'; args = []; }
    else { cmd = IS_MAC ? '/bin/zsh' : (process.env.SHELL || '/bin/bash'); args = ['--login', '-i']; }
  }

  // create-session と同じくエンジン別の API キーを注入(gemini/grok)。
  const switchEnv = { ...shellEnv };
  if (newMode === 'gemini' && !switchEnv.GEMINI_API_KEY) {
    const k = readSecretKey('GEMINI_API_KEY');
    if (k) switchEnv.GEMINI_API_KEY = k;
  }
  if (newMode === 'grok' && !switchEnv.XAI_API_KEY) {
    const k = readSecretKey('XAI_API_KEY');
    if (k) { switchEnv.XAI_API_KEY = k; switchEnv.GROK_API_KEY = k; }
  }

  const newId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const ptyProcess = nodePty.spawn(cmd, args, {
    name: IS_WIN ? undefined : 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: switchEnv,
  });

  // 切替後もフォルダ名から付ける(以前は 'Claude Code' 等の総称に戻り、
  // どのプロジェクトのタブか分からなくなっていた)。
  const modeName = deriveSessionName(cwd, newMode);
  sessions.set(newId, {
    pty: ptyProcess,
    cwd,
    name: modeName,
    mode: newMode,
    conversationId: null,
    lastOutputAt: Date.now(),
    exited: false,
    createdAt: new Date().toISOString(),
  });
  sessionBuffers.set(newId, '');

  const switchStartMs = Date.now();
  const detectConvId = makeConvIdDetector(newId, newMode, cwd, switchStartMs, null);

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session-output-${newId}`, data);
    }
    let buf = (sessionBuffers.get(newId) || '') + data;
    if (buf.length > MAX_BUFFER) buf = buf.slice(-MAX_BUFFER);
    sessionBuffers.set(newId, buf);
    { const s2 = sessions.get(newId); if (s2) s2.lastOutputAt = Date.now(); }
    detectConvId();
  });
  ptyProcess.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`session-exit-${newId}`, { exitCode });
    }
  });

  return { newId, name: modeName, cwd, mode: newMode };
});

ipcMain.handle('send-input', async (_e, { sessionId, input }) => {
  const s = sessions.get(sessionId);
  if (!s || !s.pty) return { ok: false, reason: 'no-session' };
  try {
    s.pty.write(input);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

ipcMain.handle('wake-session', async (_e, { sessionId }) => {
  const s = sessions.get(sessionId);
  if (s && s.wake) { try { s.wake(); } catch (_) {} }
});

ipcMain.handle('resize-terminal', async (_e, { sessionId, cols, rows }) => {
  const s = sessions.get(sessionId);
  if (s && s.pty) { try { s.pty.resize(cols, rows); } catch (_) {} }
});

ipcMain.handle('close-session', async (_e, { sessionId }) => {
  const meta = sessionMetaFor(sessionId);     // 消す前に名前・場所・会話 ID を控える
  const latest = sessionBuffers.get(sessionId);
  const s = sessions.get(sessionId);
  if (s && s.pty) { try { s.pty.kill(); } catch (_) {} sessions.delete(sessionId); }
  sessionBuffers.delete(sessionId);
  savedBuffer.delete(sessionId);
  archiveBuffer(sessionId, 'closed', meta, latest);   // タブを閉じても、画面の記録は保管庫に残す
});

// ── Check if Claude Code CLI is installed ──
ipcMain.handle('check-claude-cli', async () => {
  try {
    const whichCmd = IS_WIN
      ? 'where claude'
      : `${IS_MAC ? '/bin/zsh' : '/bin/bash'} -ilc "which claude"`;
    const result = require('child_process').execSync(
      whichCmd, { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    if (result && result.includes('claude')) {
      let version = '';
      try {
        const verCmd = IS_WIN
          ? 'claude --version'
          : `${IS_MAC ? '/bin/zsh' : '/bin/bash'} -ilc "claude --version"`;
        version = require('child_process').execSync(
          verCmd, { encoding: 'utf-8', timeout: 10000 }
        ).trim();
      } catch (_) {}
      return { installed: true, path: result, version };
    }
    return { installed: false };
  } catch {
    return { installed: false };
  }
});

// ── Install Claude Code CLI ──
ipcMain.handle('install-claude-cli', async () => {
  try {
    const installCmd = IS_WIN
      ? 'npm install -g @anthropic-ai/claude-code'
      : `${IS_MAC ? '/bin/zsh' : '/bin/bash'} -ilc "npm install -g @anthropic-ai/claude-code"`;
    require('child_process').execSync(installCmd, { encoding: 'utf-8', timeout: 120000 });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Resolve dropped path to directory ──
ipcMain.handle('resolve-cwd', async (_e, droppedPath) => {
  try {
    const stat = fs.statSync(droppedPath);
    return stat.isDirectory() ? droppedPath : path.dirname(droppedPath);
  } catch {
    return os.homedir();
  }
});

// ── Load buffer for session restore ──
ipcMain.handle('load-buffer', async (_e, { sessionId }) => {
  try {
    return fs.readFileSync(path.join(BUFFERS_DIR, `${sessionId}.buf`), 'utf-8');
  } catch { return null; }
});

// ── Clean up old buffer files after restore ──
ipcMain.handle('cleanup-old-buffers', async (_e, { oldIds }) => {
  for (const id of oldIds) {
    archiveBuffer(id, 'restart');     // 消さずに保管(会話 ID が無くても読み返せるように)
    savedBuffer.delete(id);
  }
  // 復元が終わった直後 = 生きているタブが確定した瞬間なので、ここで取りこぼしも掃除する。
  pruneOrphanBuffers();
});

// ── Get app directory (for editing this app) ──
ipcMain.handle('get-app-dir', async () => {
  return path.join(__dirname);
});

// ── Scan project directory for Builder mode ──
ipcMain.handle('scan-project', async (_e, { cwd }) => {
  const result = {
    name: path.basename(cwd),
    cwd,
    framework: null,
    language: null,
    dependencies: [],
    configs: [],
    suggestions: [],
  };

  try {
    const exists = (f) => fs.existsSync(path.join(cwd, f));
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, f), 'utf-8')); } catch { return null; } };
    const readText = (f) => { try { return fs.readFileSync(path.join(cwd, f), 'utf-8'); } catch { return ''; } };

    // ── Node.js / JavaScript ──
    if (exists('package.json')) {
      const pkg = readJson('package.json');
      if (pkg) {
        result.packageName = pkg.name;
        result.version = pkg.version;
        result.scripts = pkg.scripts ? Object.keys(pkg.scripts) : [];
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        result.dependencies = Object.keys(allDeps);

        // Framework detection
        if (allDeps['next']) { result.framework = 'Next.js'; result.language = 'JavaScript'; }
        else if (allDeps['nuxt']) { result.framework = 'Nuxt'; result.language = 'JavaScript'; }
        else if (allDeps['react']) { result.framework = 'React'; result.language = 'JavaScript'; }
        else if (allDeps['vue']) { result.framework = 'Vue'; result.language = 'JavaScript'; }
        else if (allDeps['svelte'] || allDeps['@sveltejs/kit']) { result.framework = 'Svelte'; result.language = 'JavaScript'; }
        else if (allDeps['express']) { result.framework = 'Express'; result.language = 'JavaScript'; }
        else if (allDeps['electron']) { result.framework = 'Electron'; result.language = 'JavaScript'; }

        if (allDeps['typescript'] || exists('tsconfig.json')) result.language = 'TypeScript';

        // Deployment configs
        if (exists('vercel.json')) result.configs.push('vercel');
        if (exists('netlify.toml')) result.configs.push('netlify');
        if (exists('railway.json') || exists('railway.toml')) result.configs.push('railway');
        if (exists('Dockerfile')) result.configs.push('docker');
        if (exists('docker-compose.yml') || exists('docker-compose.yaml')) result.configs.push('docker-compose');
        if (exists('capacitor.config.ts') || exists('capacitor.config.json')) result.configs.push('capacitor');
        if (exists('electron-builder.yml') || (pkg.build && pkg.build.appId)) result.configs.push('electron-builder');
        if (exists('tauri.conf.json') || exists('src-tauri')) result.configs.push('tauri');

        // Infrastructure detection
        if (allDeps['@supabase/supabase-js']) result.configs.push('supabase');
        if (allDeps['firebase'] || allDeps['firebase-admin']) result.configs.push('firebase');
        if (allDeps['stripe']) result.configs.push('stripe');
        if (allDeps['@capacitor/core']) result.configs.push('capacitor');
        if (allDeps['@prisma/client']) result.configs.push('prisma');
      }
    }

    // ── Python ──
    if (exists('requirements.txt') || exists('pyproject.toml') || exists('setup.py')) {
      result.language = result.language || 'Python';
      const req = readText('requirements.txt') + readText('pyproject.toml');
      if (req.includes('streamlit')) result.framework = result.framework || 'Streamlit';
      else if (req.includes('fastapi')) result.framework = result.framework || 'FastAPI';
      else if (req.includes('django')) result.framework = result.framework || 'Django';
      else if (req.includes('flask')) result.framework = result.framework || 'Flask';
      if (req.includes('supabase')) result.configs.push('supabase');
    }

    // ── Swift ──
    if (exists('Package.swift') || exists('.xcodeproj') || exists('.xcworkspace')) {
      result.language = result.language || 'Swift';
      result.framework = result.framework || 'Xcode';
      result.configs.push('xcode');
    }
    // ── Xcode project detection ──
    try {
      const entries = fs.readdirSync(cwd);
      for (const e of entries) {
        if (e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace')) {
          result.configs.push('xcode');
          result.language = result.language || 'Swift';
          break;
        }
      }
    } catch (_) {}

    // ── Rust ──
    if (exists('Cargo.toml')) {
      result.language = result.language || 'Rust';
      result.framework = result.framework || 'Cargo';
      const cargo = readText('Cargo.toml');
      if (cargo.includes('tauri')) result.configs.push('tauri');
    }

    // ── Go ──
    if (exists('go.mod')) {
      result.language = result.language || 'Go';
    }

    // ── Flutter / Dart ──
    if (exists('pubspec.yaml')) {
      result.language = result.language || 'Dart';
      result.framework = result.framework || 'Flutter';
    }

    // ── Build suggestions based on detected stack ──
    if (!result.framework && !result.language) {
      result.suggestions.push('empty');
    } else {
      // Web deploy
      if (['Next.js', 'React', 'Vue', 'Svelte', 'Nuxt'].includes(result.framework)) {
        result.suggestions.push('vercel', 'netlify', 'docker');
      }
      if (['Express', 'FastAPI', 'Flask', 'Django'].includes(result.framework)) {
        result.suggestions.push('railway', 'docker', 'vps');
      }
      if (result.framework === 'Streamlit') {
        result.suggestions.push('streamlit-cloud', 'docker');
      }
      // Desktop
      if (result.framework === 'Electron') {
        result.suggestions.push('electron-mac', 'electron-win', 'electron-linux');
      }
      if (['Next.js', 'React', 'Vue', 'Svelte'].includes(result.framework)) {
        result.suggestions.push('tauri-mac', 'tauri-win', 'tauri-linux', 'capacitor-ios', 'capacitor-android');
      }
      // Native
      if (result.language === 'Swift') {
        result.suggestions.push('xcode-ios', 'xcode-mac');
      }
      if (result.framework === 'Flutter') {
        result.suggestions.push('flutter-ios', 'flutter-android', 'flutter-mac', 'flutter-web');
      }
      // SaaS infra
      result.suggestions.push('supabase', 'stripe', 'auth');
    }
  } catch (_) {}

  return result;
});

// ══════════════════════════════════════
// ── AI Hub Chat API ──
// ══════════════════════════════════════
const HUB_CONFIG_FILE = path.join(SESSIONS_DIR, 'hub-config.json');
const DEFAULT_HUB_CONFIG = {
  apiUrl: 'http://localhost:3900',
  apiSecret: '',
  defaultProvider: 'openai',
};

ipcMain.handle('hub-load-config', async () => {
  try {
    if (fs.existsSync(HUB_CONFIG_FILE)) {
      return { ...DEFAULT_HUB_CONFIG, ...JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf-8')) };
    }
  } catch (_) {}
  return { ...DEFAULT_HUB_CONFIG };
});

ipcMain.handle('hub-save-config', async (_e, cfg) => {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(HUB_CONFIG_FILE, JSON.stringify(cfg, null, 2));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('hub-providers', async () => {
  const cfg = (() => {
    try {
      if (fs.existsSync(HUB_CONFIG_FILE)) {
        return { ...DEFAULT_HUB_CONFIG, ...JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf-8')) };
      }
    } catch (_) {}
    return { ...DEFAULT_HUB_CONFIG };
  })();
  try {
    const headers = {};
    if (cfg.apiSecret) headers['Authorization'] = `Bearer ${cfg.apiSecret}`;
    const res = await fetch(`${cfg.apiUrl}/providers`, { headers });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('hub-transcribe', async (_e, { audioBuffer, mimeType }) => {
  const cfg = (() => {
    try {
      if (fs.existsSync(HUB_CONFIG_FILE)) {
        return { ...DEFAULT_HUB_CONFIG, ...JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf-8')) };
      }
    } catch (_) {}
    return { ...DEFAULT_HUB_CONFIG };
  })();

  try {
    const formData = new FormData();
    formData.append('audio', new Blob([Buffer.from(audioBuffer)], { type: mimeType || 'audio/webm' }), 'audio.webm');

    const headers = {};
    if (cfg.apiSecret) headers['Authorization'] = `Bearer ${cfg.apiSecret}`;

    const res = await fetch(`${cfg.apiUrl}/transcribe`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!res.ok) {
      const err = await res.text();
      return { error: err };
    }
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
});

// ── Smart Router (Hub チャットのプロバイダ提案) ──
// タイプ中のテキストからキーワードで最適な LLM プロバイダを1つ提案する。
// 外部 API 不要のローカル判定なので、api-server が落ちていても必ず動く
// (以前は /suggest-route への fetch 依存で、サーバー停止時に無反応=機能消失していた)。
const HUB_ROUTE_RULES = [
  // Research / academic → Claude (long context, nuanced)
  { pattern: /論文|paper|研究|research|科研費|kakenhi|査読|review|執筆|draft/i, provider: 'claude', reason: '学術・研究はClaude' },
  { pattern: /英語|English|IELTS|TOEFL|発音|pronunciation|SLA|言語教育/i, provider: 'claude', reason: '言語教育はClaude' },
  { pattern: /設計|アーキテクチャ|リファクタ|architect|design|refactor/i, provider: 'claude', reason: '設計判断はClaude' },
  // Fact-checking / search / citations → Perplexity
  { pattern: /調べ|検索|search|事実|fact.?check|引用|cite|何年|いつ|統計|データ|採択率/i, provider: 'perplexity', reason: 'Web検索+引用はPerplexity' },
  { pattern: /最新|ニュース|news|トレンド|trending|今年|2026/i, provider: 'perplexity', reason: '最新情報はPerplexity' },
  { pattern: /誰|who|どこ|where|比較|compare|ランキング|ranking/i, provider: 'perplexity', reason: '事実照会はPerplexity' },
  // Uncensored / sensitive → Venice
  { pattern: /法的(に|な)|legal|著作権|copyright|訴訟|裁判|NSFW|ノーガード|本音|グレー/i, provider: 'venice', reason: 'フィルタなし相談はVenice' },
  // Quick / simple → Groq (ultra-fast, free)
  { pattern: /翻訳|translate|要約|summarize|explain|説明して|簡単に|手短に|ちょっと/i, provider: 'groq', reason: '即答はGroq（最速）' },
  { pattern: /子(供|ども)|育児|子育て|料理|レシピ|recipe|天気|weather/i, provider: 'groq', reason: '日常の質問はGroq（速い＋無料）' },
  // Long text / bulk → Gemini (free tier, 2M context)
  { pattern: /全文|全体|まとめて|一括|bulk|長い|PDF|ページ/i, provider: 'gemini', reason: '大量テキストはGemini（無料枠大）' },
];

ipcMain.handle('hub-suggest-route', async (_e, { text }) => {
  const t = String(text || '');
  for (const rule of HUB_ROUTE_RULES) {
    if (rule.pattern.test(t)) {
      return { provider: rule.provider, reason: rule.reason, auto: true };
    }
  }
  return null;
});

// ── ローカルなエンジン判別 (Claude Code / Codex / Gemini / Grok / ターミナル) ──
// 判定表と判定関数は src/engine-judge.js に切り出してある(electron 非依存)。
// テストから直接叩けるようにするためで、npm test が回帰を見張る。
const { judgeEngine } = require('./src/engine-judge');
const webBridge = require('./src/web-tab-bridge');
// Web タブ(webview)の webContents。renderer が dom-ready で {wid, wcId} を知らせてくる。
// 制御窓(control-server)から「読む・書く・押す」をするための台帳。
const webTabContents = new Map();   // wid → { wcId, url, title }
ipcMain.on('web-tab-attached', (_e, { wid, wcId, url, title }) => {
  if (wid && wcId) webTabContents.set(String(wid), { wcId: Number(wcId), url: String(url || ''), title: String(title || '') });
});
ipcMain.on('web-tab-closed', (_e, { wid }) => { webTabContents.delete(String(wid)); });
function webContentsOf(wid) {
  const rec = webTabContents.get(String(wid));
  if (!rec) return null;
  const { webContents } = require('electron');
  const wc = webContents.fromId(rec.wcId);
  if (!wc || wc.isDestroyed()) { webTabContents.delete(String(wid)); return null; }
  return wc;
}
function listWebTabsLive() {
  const out = [];
  for (const [wid, rec] of webTabContents) {
    const wc = webContentsOf(wid);
    if (!wc) continue;
    out.push({ id: wid, url: wc.getURL() || rec.url, title: wc.getTitle() || rec.title, loading: wc.isLoading() });
  }
  return out;
}
// renderer に「この URL を Web タブで開け」と頼み、attached が来るまで待つ(最長 20 秒)
function openWebTabFromMain(url, title) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve(null);
    const before = new Set(webTabContents.keys());
    for (const t of listWebTabsLive()) if (t.url === url) return resolve(t.id);
    mainWindow.webContents.send('open-web-url', { url, title: title || '' });
    const t0 = Date.now();
    const iv = setInterval(() => {
      for (const wid of webTabContents.keys()) if (!before.has(wid)) { clearInterval(iv); return resolve(wid); }
      if (Date.now() - t0 > 20000) { clearInterval(iv); resolve(null); }
    }, 200);
  });
}

ipcMain.handle('suggest-engine', async (_e, { task }) => judgeEngine(task));

// ── 裏方ワーカー: タブを開かずにエンジンを走らせる (#10 Phase2) ──────────
//
// これまで、このアプリがエンジンを動かす手段は nodePty.spawn だけだった。
// つまり仕事を出すには人間がタブを開くしかなく、せっかくの判定 (suggest-engine)
// が判定して終わっていた。ここで各 CLI の非対話モードを子プロセスで回し、
// 出力を renderer へ流す。組み立ては src/worker-cmd.js (electron 非依存)。
//
// 既定は読み取り専用。書き込みは write:true を明示したときだけ。
// 同じリポジトリを2つのエンジンが同時に編集して壊した事故が過去にあるため、
// 隔離(worktree)が入るまで書き込みは開けない。
const { buildCommand } = require('./src/worker-cmd');
// ── 音声で往復するときの返事 ──────────────────────────────────
// hub-chat は SSE を読む作りで、往復には向かない (1 文ずつ待たせたくない)。
// koach-os 側に 1 回で返す口 (/hub/converse) を置いてあるので、そちらを叩く。
ipcMain.handle('hub-converse', async (_e, { messages, context, provider, model }) => {
  const cfg = (() => {
    try {
      if (fs.existsSync(HUB_CONFIG_FILE)) {
        return { ...DEFAULT_HUB_CONFIG, ...JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf-8')) };
      }
    } catch (_) {}
    return { ...DEFAULT_HUB_CONFIG };
  })();
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiSecret) headers.Authorization = `Bearer ${cfg.apiSecret}`;
  try {
    const res = await fetch(`${cfg.apiUrl}/converse`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: messages || [],
        context: context || '',
        // 声で切り替えたぶんが最優先。指定が無ければ設定、それも無ければ Claude。
        // ⚠️ 以前ここで openai を claude に読み替えていた。Astra を指名しても
        //    Claude が答えてしまうので外した (声の相手は本人が選ぶ)。
        provider: provider || cfg.defaultProvider || 'claude',
        model: model || '',
      }),
    });
    if (!res.ok) return { ok: false, reply: 'うまく届きませんでした。', error: await res.text() };
    return await res.json();
  } catch (e) {
    return { ok: false, reply: 'うまく届きませんでした。', error: e.message };
  }
});

// ── 声のやり取り (直に叩く) ──
// ⚠️ hub を経由すると往復で約 1.5 秒延びる。実測は src/voice-net.js の頭に書いた。
//    鍵が手元にあるときは直、無いときだけ hub に落ちる。
const voiceNetMod = require('./src/voice-net');
// Alfred と同じ読みの辞書 (Mac の定時処理が koach-os から写す)。更新時刻が変わったときだけ読み直す
let yomiCache = { mtimeMs: -1, items: {} };
function loadYomi() {
  try {
    const file = path.join(SESSIONS_DIR, 'yomi.json');
    const st = fs.statSync(file);
    if (st.mtimeMs !== yomiCache.mtimeMs) {
      const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
      yomiCache = { mtimeMs: st.mtimeMs, items: (d && typeof d.items === 'object') ? d.items : {} };
    }
  } catch (_) { /* 無ければ辞書なしで読む */ }
  return yomiCache.items;
}
function voiceNet() {
  const cfg = (() => {
    try {
      if (fs.existsSync(HUB_CONFIG_FILE)) {
        return { ...DEFAULT_HUB_CONFIG, ...JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf-8')) };
      }
    } catch (_) {}
    return { ...DEFAULT_HUB_CONFIG };
  })();
  return voiceNetMod.create({
    fetchImpl: fetch,
    getKey: readSecretKey,
    getYomi: loadYomi,
    hubUrl: cfg.apiUrl,
    hubSecret: cfg.apiSecret,
  });
}

// 声で案件を名指しするときの読みの表。
// ⚠️ このリポジトリは公開してあるので、案件の名前をコードに書かない。
//    手元の ~/.claude-code-app/voice-aliases.json に置く。無ければ空で動く
//    (綴りが一致すれば当たる。読みで呼びたいときだけ書く)。
const VOICE_ALIASES_FILE = path.join(SESSIONS_DIR, 'voice-aliases.json');

ipcMain.handle('voice-aliases', async () => {
  try {
    if (!fs.existsSync(VOICE_ALIASES_FILE)) return [];
    const rows = JSON.parse(fs.readFileSync(VOICE_ALIASES_FILE, 'utf-8'));
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    return [];
  }
});

// ── 声のまま考えるモデル (Realtime) の一時鍵 ──
// ⚠️ 本物の鍵は画面に渡さない。数分で切れる一時鍵だけを渡す。
//    ⚠️ 繋いだまま黙っていると無音も課金されるので、画面側は
//    「声が出ている間だけ送る」作りにしてある (src/realtime.js)。
const REALTIME_MODEL = 'gpt-realtime-2.1';

ipcMain.handle('realtime-token', async () => {
  const key = readSecretKey('OPENAI_API_KEY');
  if (!key) return { error: 'OPENAI_API_KEY がありません' };
  const cfg = (() => {
    try {
      if (fs.existsSync(HUB_CONFIG_FILE)) {
        return { ...DEFAULT_HUB_CONFIG, ...JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf-8')) };
      }
    } catch (_) {}
    return { ...DEFAULT_HUB_CONFIG };
  })();
  const model = cfg.realtimeModel || REALTIME_MODEL;
  try {
    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: { type: 'realtime', model } }),
    });
    if (!res.ok) return { error: (await res.text()).slice(0, 200) };
    const j = await res.json();
    return { key: j.value, model, expiresAt: j.expires_at };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('voice-transcribe', async (_e, { audioBuffer, mimeType }) =>
  voiceNet().transcribe(Buffer.from(audioBuffer), mimeType));

// ── 本物の Alfred に話しかける (2026-10-15) ──
// 本人「Ariya と連携させて、家事をしながら話せるように」。Ariya の声のライブの会話を koach-os の声の頭に渡す。
// 合言葉は Mac が作業を取りに行くときと同じもの (~/.config/koach-bridge/relay.json の backend と relay_token)。
ipcMain.handle('alfred-voice', async (_e, { text, context }) => {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'koach-bridge', 'relay.json'), 'utf-8'));
  } catch (_) {
    return { ok: false, error: 'Mac の橋の設定 (relay.json) がありません' };
  }
  if (!cfg.backend || !cfg.relay_token) return { ok: false, error: 'Mac の橋の設定が足りません' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  try {
    const res = await fetch(`${String(cfg.backend).replace(/\/$/, '')}/api/bridge/alfred-voice`, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${cfg.relay_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text || '').slice(0, 2000), context: String(context || '').slice(-4000) }),
    });
    if (!res.ok) return { ok: false, error: `koach-os ${res.status}` };
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '時間切れ' : e.message };
  } finally {
    clearTimeout(timer);
  }
});

// ライブの間は Mac を眠らせない (画面は消えてよい)。切ったら戻す
let voiceAwakeId = null;
ipcMain.handle('voice-keepawake', async (_e, on) => {
  const { powerSaveBlocker } = require('electron');
  if (on && voiceAwakeId === null) voiceAwakeId = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && voiceAwakeId !== null) { try { powerSaveBlocker.stop(voiceAwakeId); } catch (_) {} voiceAwakeId = null; }
  return { on: voiceAwakeId !== null };
});

ipcMain.handle('voice-reply', async (_e, { messages, context, provider, model, tools, steps }) =>
  voiceNet().reply(messages || [], { context, provider, model, tools, steps }));

ipcMain.handle('voice-tts', async (_e, { text, voice }) => {
  const r = await voiceNet().tts(text, { voice });
  // ⚠️ Uint8Array のまま返す。base64 にすると 1.3 倍に膨らむ
  //    via はどの声が鳴ったか (elevenlabs / openai)。落ちた理由の切り分けに使う
  return r.audio ? { audio: r.audio, mime: r.mime, via: r.via } : { error: r.error || 'tts failed' };
});

// 音声の履歴。⚠️ localStorage は再インストールや退避で消えるので、
// 同じものをファイルにも残す。読むのは画面側の判断。
const VOICE_HISTORY_FILE = path.join(SESSIONS_DIR, 'voice-history.json');
const VOICE_HISTORY_MAX = 200;

ipcMain.handle('save-voice-history', async (_e, history) => {
  try {
    const rows = Array.isArray(history) ? history.slice(-VOICE_HISTORY_MAX) : [];
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(VOICE_HISTORY_FILE, JSON.stringify(rows, null, 2));
    return { ok: true, count: rows.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('load-voice-history', async () => {
  try {
    if (!fs.existsSync(VOICE_HISTORY_FILE)) return [];
    const r = JSON.parse(fs.readFileSync(VOICE_HISTORY_FILE, 'utf-8'));
    return Array.isArray(r) ? r : [];
  } catch (_) {
    return [];
  }
});

const { runProcess } = require('./src/worker-run');
const workerJobs = new Map();   // jobId -> { cancel, engine, task, cwd, write, startedAt }

// 入力欄に貼られた画像を ~/.claude-code-app/pasted/ に保存してパスを返す
ipcMain.handle('save-clipboard-image', () => {
  const img = clipboard.readImage();
  if (!img || img.isEmpty()) return '';
  const dir = path.join(os.homedir(), '.claude-code-app', 'pasted');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `paste-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  fs.writeFileSync(file, img.toPNG());
  return file;
});

ipcMain.handle('worker-start', async (event, { engine, task, cwd, write, model, timeoutMs, allowUnsandboxed }) => {
  let spec;
  try {
    spec = buildCommand(engine, task, {
      cwd: cwd || os.homedir(), write: !!write, model, allowUnsandboxed: !!allowUnsandboxed,
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  const env = { ...shellEnv };
  if (spec.needsKey && !env[spec.needsKey]) {
    const k = readSecretKey(spec.needsKey);
    if (k) {
      env[spec.needsKey] = k;
      if (spec.needsKey === 'XAI_API_KEY') env.GROK_API_KEY = k;   // opencode は両方見る
    }
  }

  const jobId = `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const wc = event.sender;
  const push = (channel, payload) => { try { if (!wc.isDestroyed()) wc.send(channel, payload); } catch (_) {} };

  const handle = runProcess(
    { bin: spec.bin, args: spec.args, cwd: spec.cwd, env, timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined },
    {
      onOutput: (d) => push(`worker-output-${jobId}`, d),
      onDone: (r) => {
        workerJobs.delete(jobId);
        push(`worker-done-${jobId}`, { jobId, engine, ...r });
      },
    },
  );
  if (handle.failed) return { ok: false, error: '起動できなかった' };

  workerJobs.set(jobId, {
    cancel: handle.cancel, engine, task, cwd: spec.cwd, write: spec.write, startedAt: Date.now(),
  });
  return { ok: true, jobId, engine, bin: spec.bin, write: spec.write, cwd: spec.cwd };
});

ipcMain.handle('worker-cancel', async (_e, { jobId }) => {
  const job = workerJobs.get(jobId);
  if (!job) return { ok: false, error: 'そのジョブは走っていない' };
  return { ok: job.cancel() };
});

// どのエンジンが手元に入っているか。実際に叩けるか(認証切れ・課金停止)までは
// ここで健診しない。時間がかかるうえ、結果は走らせれば分かる。
const WORKER_BINS = { claude: 'claude', codex: 'codex', gemini: 'gemini', grok: 'opencode' };
ipcMain.handle('worker-engines', async () => {
  const out = {};
  for (const [engine, bin] of Object.entries(WORKER_BINS)) {
    try {
      execSync(IS_WIN ? `where ${bin}` : `command -v ${bin}`, { stdio: 'ignore', env: shellEnv });
      out[engine] = true;
    } catch (_) { out[engine] = false; }
  }
  return out;
});

ipcMain.handle('worker-list', async () => [...workerJobs.entries()].map(([jobId, j]) => ({
  jobId, engine: j.engine, cwd: j.cwd, write: j.write,
  task: j.task.slice(0, 120), ms: Date.now() - j.startedAt,
})));

// ── ボード表示 (#10 Phase2): タブを1案件のチームとして俯瞰する ──
//
// 案件は cwd では分けられない(本人は全タブを ~ から起動している)。
// 会話ファイルの末尾に出てくるリポジトリ名の最頻値を案件として使う。
// 会話ファイルは大きい(実測で最大130MB)ので末尾だけ読み、
// サイズと更新時刻が変わらない限り読み直さない。
// 会話の最初の依頼(本人の言葉)から、タブに付ける短い名前を作る。
// 記録は ~/.claude/projects/<slug>/<id>.jsonl。先頭 300KB だけ読む(1本 4MB を超える会話がある)。
const titleCache = new Map();
function titleForConversation(conversationId, cwd) {
  if (!conversationId) return null;
  if (titleCache.has(conversationId)) return titleCache.get(conversationId);
  let title = null;
  try {
    const file = path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd || os.homedir()), `${conversationId}.jsonl`);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(300 * 1024);
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.includes('"type":"user"')) continue;
      let d;
      try { d = JSON.parse(line); } catch (_) { continue; }
      const c = d && d.message && d.message.content;
      let text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ') : '';
      text = String(text || '').trim();
      // 貼り付けた記録・システムの前置き・スラッシュ命令は名前にしない
      if (!text || text.startsWith('<') || text.startsWith('/') || text.startsWith('This session is being continued') || text.startsWith('Base directory for this skill')) continue;
      text = text.replace(/\s+/g, ' ').replace(/^[│|─┼\s]+/, '').replace(/^[0-9a-f]{8}\s*│\s*/, '');
      if (text.length < 4) continue;
      title = text.slice(0, 22) + (text.length > 22 ? '…' : '');
      break;
    }
  } catch (_) { /* 記録が無い・読めない */ }
  titleCache.set(conversationId, title);
  return title;
}

const projectCache = new Map();   // conversationId -> { size, mtimeMs, project }
const PROJECT_TAIL_BYTES = 400 * 1024;

function projectForConversation(conversationId, cwd) {
  if (!conversationId) return null;
  try {
    const dir = path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd || os.homedir()));
    const file = path.join(dir, `${conversationId}.jsonl`);
    const st = fs.statSync(file);
    const hit = projectCache.get(conversationId);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.project;

    const len = Math.min(st.size, PROJECT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len)); } finally { fs.closeSync(fd); }

    const project = inferProject(buf.toString('utf8'));
    projectCache.set(conversationId, { size: st.size, mtimeMs: st.mtimeMs, project });
    return project;
  } catch (_) { return null; }
}

// 承認待ちの判定に使う、出力の末尾。ANSI の除去は src/board.js に寄せてある
// (実バッファで取りこぼしを潰した正規表現をここで二重管理しないため)。
function tailFor(id) {
  return cleanTail(sessionBuffers.get(id) || '');
}

// 他のアプリで進めた会話の一覧。読むだけ(開くのは create-session に conversationId を渡す)
ipcMain.handle('list-external-conversations', async () => {
  try { return { ok: true, items: listExternalConversations({ limit: 80 }) }; }
  catch (e) { return { ok: false, error: String(e && e.message || e), items: [] }; }
});

ipcMain.handle('board-snapshot', async () => {
  const tabs = [];
  for (const [id, s] of sessions) {
    tabs.push({
      id,
      name: s.name,
      mode: s.mode,
      cwd: s.cwd,
      conversationId: s.conversationId || null,
      lastOutputAt: s.lastOutputAt || 0,
      exited: !!s.exited,
      tail: tailFor(id),
      // 掃除する前の出力から読む。cleanTail は OSC を捨てるので、掃除後では
      // ツール自身の合図(Codex の "Action Required" タイトル)が消えている。
      titleWaiting: titleSaysWaiting(sessionBuffers.get(id) || ''),
      project: projectForConversation(s.conversationId, s.cwd),
    });
  }
  // tail は判定に使うだけで、画面には出さない(会話の中身が漏れるため)
  const teams = groupIntoTeams(tabs).map((t) => ({
    ...t,
    tabs: t.tabs.map(({ tail, ...rest }) => rest),
  }));
  return { teams, at: Date.now() };
});

// ── 出荷プラン生成 (#8): 配布先を自動判定し RELEASE.md を書き出す ──
ipcMain.handle('generate-release-plan', async (_e, { cwd }) => {
  try {
    const dir = cwd || os.homedir();
    const exists = (p) => { try { return fs.existsSync(path.join(dir, p)); } catch { return false; } };
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')); } catch (_) {}
    const dep = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const has = (n) => Object.keys(dep).some(k => k.includes(n));

    let channel, steps;
    if (exists('capacitor.config.ts') || exists('capacitor.config.json') || exists('ios')) {
      channel = 'iOS App Store';
      steps = `1. [自動] npm run build && npx cap sync ios\n2. [自動] Info.plist: ITSAppUsesNonExemptEncryption=false 確認\n3. [要本人] Xcode で Archive → Distribute → App Store Connect Upload\n4. [自動/事前] スクショ 6.7"(1290x2796)/6.5"(1242x2688)/iPad 12.9"(2048x2732)\n5. [要本人] App Store Connect: メタデータ・App Privacy・審査提出`;
    } else if (has('electron')) {
      const masish = JSON.stringify(pkg.build || {}).includes('mas');
      channel = masish ? 'Mac App Store' : 'Gumroad (DMG)';
      steps = masish
        ? `1. [自動] electron-builder --mac mas (3rd Party Mac Developer 署名+provisioning)\n2. [自動] .pkg 検証\n3. [要本人] Transporter/altool で App Store Connect アップロード\n4. [要本人] メタデータ・スクショ(2880x1800)・審査提出`
        : `1. [自動] electron-builder --mac (Developer ID Application 署名)\n2. [自動] notarize: xcrun notarytool submit <dmg> --keychain-profile "notarytool-profile" --wait\n3. [自動] staple: xcrun stapler staple <dmg> && spctl -a -vvv -t install <dmg>\n4. [自動] 販売文(EN/JP)生成\n5. [要本人] gumroad.com で商品作成→DMGアップロード→価格→公開`;
    } else if (exists('next.config.js') || exists('next.config.ts') || exists('vercel.json') || has('next')) {
      channel = 'Web SaaS (Vercel)';
      steps = `1. [自動] ship-check(SEO/OG/決済/本番設定)\n2. [自動] vercel --prod (webhook が不調なプロジェクトは commit 後に必須)\n3. [要本人] Stripe本番キー・Webエンドポイント確認、テストキー残留チェック\n4. [自動] Search Console/sitemap/OG 最終確認`;
    } else {
      channel = '汎用 / Gumroad(デジタル)';
      steps = `1. [自動] 成果物パッケージング(zip/pdf等)\n2. [自動] 販売文の下書き生成\n3. [要本人] gumroad.com で商品作成→アップロード→公開`;
    }

    const name = pkg.name || path.basename(dir);
    const md = `# RELEASE — ${name}\n\n配布先(自動判定): **${channel}**\n\n> GitHub push はゴールではなく途中の1ステップ。全項目 ✅ になるまで「完成」と言わない。\n> [自動]=アプリ/AIが実行 / [要本人]=Apple・Gumroad等の対話操作。\n\n## 手順\n${steps}\n\n---\n${releaseProfileLines()}- 方針: まず Gumroad で最速公開 → 売れたら App Store 追加\n`;
    const outPath = path.join(dir, 'RELEASE.md');
    fs.writeFileSync(outPath, md, 'utf-8');
    return { ok: true, path: outPath, channel };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 署名・配布に使う自分用の値。公開リポジトリに書かないよう
// ~/.claude-code-app/release-profile.json から読む。無ければその行を出さない。
function releaseProfileLines() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, 'release-profile.json'), 'utf-8'));
    const lines = [];
    if (cfg.appleTeamId) lines.push(`- Apple Team ID: ${cfg.appleTeamId} / notarytool profile: ${cfg.notaryProfile || '-'}`);
    if (cfg.privacyPolicyUrl) lines.push(`- プライバシーポリシー: ${cfg.privacyPolicyUrl}`);
    return lines.length ? lines.join('\n') + '\n' : '';
  } catch (_) {
    return '';
  }
}

ipcMain.handle('open-path', async (_e, { p }) => { try { shell.openPath(p); } catch (_) {} });

ipcMain.handle('hub-chat', async (_e, { provider, model, messages, system, temperature }) => {
  const cfg = (() => {
    try {
      if (fs.existsSync(HUB_CONFIG_FILE)) {
        return { ...DEFAULT_HUB_CONFIG, ...JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf-8')) };
      }
    } catch (_) {}
    return { ...DEFAULT_HUB_CONFIG };
  })();

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiSecret) headers['Authorization'] = `Bearer ${cfg.apiSecret}`;

  try {
    const res = await fetch(`${cfg.apiUrl}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider, model, messages, system, temperature }),
    });

    if (!res.ok) {
      const err = await res.text();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hub-chat-error', { error: err });
      }
      return;
    }

    // Read SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);

        if (data === '[DONE]') {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('hub-chat-done', {});
          }
          return;
        }

        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('hub-chat-error', { error: parsed.error });
            }
            return;
          }
          if (parsed.content && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('hub-chat-chunk', { content: parsed.content });
          }
        } catch (_) {}
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hub-chat-done', {});
    }
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hub-chat-error', { error: e.message });
    }
  }
});

// ── 自分で立てるプロジェクト (2026-09-24) ─────────────────────────────
// 本人: 「ChatGPT や Claude のように、プロジェクトを自分で立ち上げてコンテクストを共有したい」
// ChatGPT/Claude のプロジェクトの中身は「名前・指示・資料」。Ariya ではそれを 1 つのフォルダに置く:
//   指示 = CLAUDE.md(Claude Code が読む)。Codex は AGENTS.md、Gemini は GEMINI.md を自分で読むので、
//          同じ中身を指す別名(シンボリックリンク)を置く。Claude 限定のプロジェクトには置かない
//          (置くと他社のエンジンにも指示の中身が渡る)。
//   資料 = フォルダの中の「資料/」。
// ⚠️ プロジェクト名はこのソース(公開リポジトリ)に書かない。一覧は ~/.claude-code-app/projects.json。
//    「下ごしらえ」画面のプロジェクト一覧と**同じ表・同じ形({name, path})**にする。二つの画面で同じものが見えるように。
//    (PROJECTS_FILE は下の Harness の節で宣言している。呼ばれるのは起動後なので順番は問題ない)
function readProjects() {
  try {
    const d = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
    return Array.isArray(d) ? d.filter(x => x && x.name && x.path) : [];
  } catch (_) { return []; }
}
function writeProjects(list) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2) + '\n', 'utf-8');
}
function safeProjectName(name) {
  // フォルダ名に使えない字を落とす。日本語は残す
  return String(name || '').trim().replace(/[\/\\:*?"<>|\x00-\x1f]/g, '').replace(/^\.+/, '').slice(0, 60);
}
ipcMain.handle('projects-list', () => readProjects());
ipcMain.handle('project-create', (_e, { name, dir, instructions, claudeOnly }) => {
  const nm = safeProjectName(name);
  if (!nm) return { ok: false, error: '名前を入れてください' };
  const list = readProjects();
  if (list.some(x => x.name === nm)) return { ok: false, error: 'その名前のプロジェクトはもうあります' };
  const home = os.homedir();
  const target = path.resolve(dir && String(dir).trim() ? String(dir).trim().replace(/^~(?=\/|$)/, home) : path.join(home, 'Projects', nm));
  // ⚠️ ホームの外やホームそのものには作らない(指示ファイルを変な場所に撒かない)
  if (!target.startsWith(home + path.sep) || target === home) return { ok: false, error: 'ホームの中のフォルダにしてください' };
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(target, '資料'), { recursive: true });
    const cm = path.join(target, 'CLAUDE.md');
    const text = String(instructions || '').trim();
    if (text) {
      // 既にある指示は消さない。上に足す
      const prev = fs.existsSync(cm) ? fs.readFileSync(cm, 'utf-8') : '';
      fs.writeFileSync(cm, prev ? `${text}\n\n${prev}` : `${text}\n`, 'utf-8');
    } else if (!fs.existsSync(cm)) {
      fs.writeFileSync(cm, `# ${nm}\n\n(このプロジェクトの会話で、毎回 AI に伝えておくこと)\n`, 'utf-8');
    }
    if (!claudeOnly) {
      for (const alias of ['AGENTS.md', 'GEMINI.md']) {
        const ap = path.join(target, alias);
        if (!fs.existsSync(ap)) { try { fs.symlinkSync('CLAUDE.md', ap); } catch (_) { /* 作れなくても Claude は動く */ } }
      }
    }
    list.push({ name: nm, path: target, claudeOnly: !!claudeOnly, created: new Date().toISOString() });
    writeProjects(list);
    // 左メニューの束ね方にも入れる(フォルダ名 → 呼び名)
    try {
      const lp = path.join(SESSIONS_DIR, 'project-labels.json');
      const labels = fs.existsSync(lp) ? JSON.parse(fs.readFileSync(lp, 'utf-8')) : {};
      const base = path.basename(target);
      if (!labels[base]) { labels[base] = nm; fs.writeFileSync(lp, JSON.stringify(labels, null, 2) + '\n', 'utf-8'); projectLabelCache = null; }
    } catch (_) { /* 束ね方に入らなくても、プロジェクトの一覧からは開ける */ }
    return { ok: true, project: list[list.length - 1] };
  } catch (e) {
    return { ok: false, error: `作れませんでした: ${String(e.message || e).slice(0, 120)}` };
  }
});

// ── Harness Engineering: CLAUDE.md ──
ipcMain.handle('harness-read-claudemd', async (_e, { cwd }) => {
  const filePath = path.join(cwd, 'CLAUDE.md');
  try {
    if (fs.existsSync(filePath)) {
      return { exists: true, content: fs.readFileSync(filePath, 'utf-8') };
    }
    return { exists: false, content: '' };
  } catch { return { exists: false, content: '' }; }
});

ipcMain.handle('harness-write-claudemd', async (_e, { cwd, content }) => {
  try {
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), content, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('harness-read-user-claudemd', async () => {
  const filePath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  try {
    if (fs.existsSync(filePath)) {
      return { exists: true, content: fs.readFileSync(filePath, 'utf-8') };
    }
    return { exists: false, content: '' };
  } catch { return { exists: false, content: '' }; }
});

ipcMain.handle('harness-write-user-claudemd', async (_e, { content }) => {
  const dir = path.join(os.homedir(), '.claude');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), content, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Harness Engineering: Hooks (settings.json) ──
ipcMain.handle('harness-read-hooks', async (_e, { cwd }) => {
  const projectSettings = path.join(cwd, '.claude', 'settings.json');
  const userSettings = path.join(os.homedir(), '.claude', 'settings.json');
  const result = { project: null, user: null };
  try {
    if (fs.existsSync(projectSettings)) {
      const data = JSON.parse(fs.readFileSync(projectSettings, 'utf-8'));
      result.project = data.hooks || null;
    }
  } catch (_) {}
  try {
    if (fs.existsSync(userSettings)) {
      const data = JSON.parse(fs.readFileSync(userSettings, 'utf-8'));
      result.user = data.hooks || null;
    }
  } catch (_) {}
  return result;
});

ipcMain.handle('harness-write-hooks', async (_e, { cwd, hooks }) => {
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  try {
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    let data = {};
    try { data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch (_) {}
    data.hooks = hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Harness Engineering: Memory ──
// 記憶ファイルの実体は ~/.claude/projects/<slug(cwd)>/memory/ にある。
// 旧実装は ~/.claude/memory を見ていたが、そのディレクトリは存在しない。
// 読み出しは常に空、保存は誰も読まない場所に落ちる、という壊れ方をしていた。
function resolveMemoryDir(cwd) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const home = path.join(base, claudeProjectSlug(os.homedir()), 'memory');
  const candidates = [];
  if (cwd) candidates.push(path.join(base, claudeProjectSlug(cwd), 'memory'));
  candidates.push(home);
  candidates.push(path.join(os.homedir(), '.claude', 'memory')); // 旧配置(あれば拾う)
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return home; // どれも無ければホーム側に作る
}

// ファイル名は呼び出し側から来るので、ディレクトリの外へ出ないことを確かめる。
function memoryFilePath(dir, file) {
  const name = path.basename(String(file || ''));
  if (!name || !name.endsWith('.md')) return null;
  return path.join(dir, name);
}

ipcMain.handle('harness-read-memory', async (_e, arg) => {
  const memoryDir = resolveMemoryDir(arg && arg.cwd);
  const result = [];
  try {
    if (!fs.existsSync(memoryDir)) return result;
    const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(memoryDir, file), 'utf-8');
        // 新形式は metadata: の下にインデントして type: が来るので行頭固定では拾えない。
        const nameMatch = content.match(/^[ \t]*name:\s*(.+)$/m);
        const typeMatch = content.match(/^[ \t]*type:\s*(.+)$/m);
        const descMatch = content.match(/^[ \t]*description:\s*(.+)$/m);
        result.push({
          file,
          name: nameMatch ? nameMatch[1].trim() : file.replace('.md', ''),
          type: typeMatch ? typeMatch[1].trim() : 'unknown',
          description: descMatch ? descMatch[1].trim() : '',
        });
      } catch (_) {}
    }
  } catch (_) {}
  result.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return result;
});

ipcMain.handle('harness-read-memory-content', async (_e, { file, cwd }) => {
  const fp = memoryFilePath(resolveMemoryDir(cwd), file);
  if (!fp) return { content: '', error: 'invalid file' };
  try {
    return { content: fs.readFileSync(fp, 'utf-8') };
  } catch (e) {
    return { content: '', error: e.message };
  }
});

ipcMain.handle('harness-write-memory', async (_e, { file, content, cwd }) => {
  const dir = resolveMemoryDir(cwd);
  const fp = memoryFilePath(dir, file);
  if (!fp) return { success: false, error: 'invalid file' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, content, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('harness-delete-memory', async (_e, { file, cwd }) => {
  const fp = memoryFilePath(resolveMemoryDir(cwd), file);
  if (!fp) return { success: false, error: 'invalid file' };
  try {
    fs.unlinkSync(fp);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Harness Engineering: Projects ──
const PROJECTS_FILE = path.join(SESSIONS_DIR, 'projects.json');

ipcMain.handle('harness-load-projects', async () => {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
    }
  } catch (_) {}
  return [];
});

ipcMain.handle('harness-save-projects', async (_e, projects) => {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('harness-pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ── Persistence ──
// タブ復元が終わるまで台帳を書かない。
//
// 起動直後は sessions がまだ空(または復元途中)なのに、blur / close / before-quit が
// 来ると saveSessionsSync が走り、前回の台帳を空で上書きしてしまう。別アプリに
// フォーカスがある状態で起動するだけで blur は飛ぶので、これは日常的に起きる。
// 実機で再現済み: 起動 → 台帳が [] になる → 前回のタブが全部消える。
//
// 復元し終えた renderer が save-sessions を呼んだ時点で解禁する。
// 復元自体が失敗して永久に呼ばれない事故もありうるので、保険で60秒後にも解禁する。
let ledgerWritable = false;
setTimeout(() => {
  if (!ledgerWritable) { ledgerWritable = true; console.log('[sessions] 復元完了の合図が来ないまま60秒経ったので保存を解禁'); }
}, 60000);

function saveSessionsSync() {
  if (!ledgerWritable) return;   // 復元前の上書きを防ぐ
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.mkdirSync(BUFFERS_DIR, { recursive: true });
    const data = [];
    for (const [id, s] of sessions) {
      data.push({ id, name: s.name, cwd: s.cwd, mode: s.mode, conversationId: s.conversationId || null, ...(s.chatOpts ? { chat: s.chatOpts } : {}), createdAt: s.createdAt, savedAt: new Date().toISOString() });
    }
    saveLedger(SESSIONS_DIR, data);
    // 出力バッファは「前回保存から中身が変わったタブ」だけ書く。
    // 以前は 10 秒ごと + ウインドウが非アクティブになるたびに、全タブ分(1タブ最大1MB)を
    // 同期書き込みしていた。タブが多いと毎回数MBをメインスレッドで書くことになり、
    // 体感の引っかかりと無駄な書き込みを生んでいた。
    for (const [id, buf] of sessionBuffers) {
      if (savedBuffer.get(id) === buf) continue;
      fs.writeFileSync(path.join(BUFFERS_DIR, `${id}.buf`), buf, 'utf-8');
      savedBuffer.set(id, buf);
    }
    for (const id of [...savedBuffer.keys()]) {
      if (!sessionBuffers.has(id)) savedBuffer.delete(id);
    }
  } catch (_) {}
}

// ── 画面の記録を消さずに保管する (2026-09-25) ────────────────────────
// 本人: 「今開いているタブも過去のものも、再起動後に resume できるように」「会話 ID が無くても読み返せるように」
// それまで .buf を 4 か所で消していた(タブを閉じる・エンジン切替・再起動後の掃除・外からの閉じる)。
// Claude の会話は ~/.claude/projects に記録が残るので戻れるが、端末タブや ID の無い会話は読み返せなくなっていた。
// → 消す代わりに buffers/archive/ へ移し、名前・場所・会話 ID を横に置く。左メニューの「過去の画面」から読む。
// 容量の上限: 新しい順に 1500 件かつ 2GB まで残し、それより古いものから捨てる(自分で作った写しなので上限を置く)。
const ARCHIVE_DIR = path.join(BUFFERS_DIR, 'archive');
function sessionMetaFor(id) {
  const live = sessions.get(id);
  if (live) return { name: live.name, cwd: live.cwd, mode: live.mode, conversationId: live.conversationId || null };
  for (const f of ['sessions.json', 'sessions.prev.json']) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
      const rows = Array.isArray(d) ? d : (d.sessions || []);
      const r = rows.find(x => x && x.id === id);
      if (r) return { name: r.name, cwd: r.cwd, mode: r.mode, conversationId: r.conversationId || null };
    } catch (_) { /* 次の表を見る */ }
  }
  return { name: '', cwd: '', mode: '', conversationId: null };
}
function archiveBuffer(id, why, meta, latest) {
  const src = path.join(BUFFERS_DIR, `${id}.buf`);
  // ディスクの .buf は 10 秒ごとにしか書かれない。手元に最新の中身があれば先に書く(閉じる直前の分を落とさない)
  if (typeof latest === 'string' && latest) {
    try { fs.mkdirSync(BUFFERS_DIR, { recursive: true }); fs.writeFileSync(src, latest, 'utf-8'); } catch (_) {}
  }
  try {
    const st = fs.statSync(src);
    if (!st.size) { fs.unlinkSync(src); return; }
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const base = `${new Date().toISOString().replace(/[:.]/g, '-')}_${id}`;
    fs.renameSync(src, path.join(ARCHIVE_DIR, `${base}.buf`));
    const m = { id, ...(meta || sessionMetaFor(id)), why, bytes: st.size, lastWrite: st.mtime.toISOString(), archivedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(ARCHIVE_DIR, `${base}.json`), JSON.stringify(m, null, 2));
  } catch (_) { /* 元が無ければ何もしない */ }
}
function pruneArchive() {
  try {
    const files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.buf')).sort().reverse();
    let total = 0;
    files.forEach((f, i) => {
      const p = path.join(ARCHIVE_DIR, f);
      try { total += fs.statSync(p).size; } catch (_) {}
      if (i >= 1500 || total > 2 * 1024 * 1024 * 1024) {
        try { fs.unlinkSync(p); fs.unlinkSync(p.replace(/\.buf$/, '.json')); } catch (_) {}
      }
    });
  } catch (_) {}
}
ipcMain.handle('buffer-archive-list', () => {
  try {
    return fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 400).map(f => {
      try { return { file: f.replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf-8')) }; }
      catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { return []; }
});
// 過去のタブ(バックアップに残っている一覧)のうち、会話の記録がまだあって今は開いていないもの。
// 本人「過去のものも含めて resume できるように」。バックアップは再起動のたびに sessions.backup.*.json に残っている
ipcMain.handle('past-tabs', () => {
  const open = new Set([...sessions.values()].map(x => x.conversationId).filter(Boolean));
  const seen = new Map();
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter(f => /^sessions\.(backup\..+|prev|rescue.*)\.json$/.test(f)); } catch (_) {}
  for (const f of files) {
    let rows = [];
    try { const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8')); rows = Array.isArray(d) ? d : (d.sessions || []); } catch (_) { continue; }
    for (const r of rows) {
      const cid = r && r.conversationId;
      if (!cid || open.has(cid)) continue;
      const when = r.savedAt || r.createdAt || '';
      const prev = seen.get(cid);
      if (!prev || String(when) > String(prev.when)) seen.set(cid, { conversationId: cid, name: r.name || '', cwd: r.cwd || '', mode: r.mode || 'claude', when });
    }
  }
  // Claude の会話は記録が残っているものだけ(戻れないものを並べない)
  const projRoot = path.join(os.homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projRoot); } catch (_) {}
  const exists = (cid) => dirs.some(d => fs.existsSync(path.join(projRoot, d, `${cid}.jsonl`)));
  return [...seen.values()].filter(x => x.mode !== 'claude' || exists(x.conversationId))
    .sort((a, b) => String(b.when).localeCompare(String(a.when))).slice(0, 300);
});

ipcMain.handle('buffer-archive-read', (_e, { file }) => {
  // ⚠️ 名前だけ受け取り、保管庫の外は読まない
  const base = path.basename(String(file || ''));
  if (!/^[\w.-]+$/.test(base)) return { ok: false, error: '名前が不正です' };
  try { return { ok: true, text: fs.readFileSync(path.join(ARCHIVE_DIR, `${base}.buf`), 'utf-8') }; }
  catch (_) { return { ok: false, error: '見つかりません' }; }
});

// どのタブからも参照されていない .buf を捨てる。
// タブを閉じれば close-session が消すが、クラッシュや強制終了で復元前に落ちると
// 消し損ねが残り続ける。実測で 497 件中 479 件(62MB)が到達不能なゴミだった。
// 呼ぶのは「復元が終わったあと」だけ。起動直後に呼ぶと、これから復元に使う
// 前世代の .buf まで消してしまう。
function pruneOrphanBuffers() {
  try {
    const keep = new Set(sessions.keys());
    if (keep.size === 0) return;   // 復元前や終了処理中は何もしない
    let n = 0, bytes = 0;
    for (const f of fs.readdirSync(BUFFERS_DIR)) {
      if (!f.endsWith('.buf')) continue;
      if (keep.has(f.slice(0, -4))) continue;
      const p = path.join(BUFFERS_DIR, f);
      try { bytes += fs.statSync(p).size; archiveBuffer(f.slice(0, -4), 'orphan'); n++; } catch (_) {}
    }
    if (n) console.log(`[buffers] 孤児 ${n} 件 (${(bytes / 1048576).toFixed(1)}MB) を保管庫へ`);
    pruneArchive();
  } catch (_) {}
}
ipcMain.handle('save-sessions', async () => {
  // renderer が復元を終えて最初に呼ぶのがここ。以降は通常どおり保存してよい。
  ledgerWritable = true;
  saveSessionsSync();
});
ipcMain.handle('load-sessions', async () => {
  const { sessions: saved, from } = loadLedger(SESSIONS_DIR);
  // 本体が壊れていて退避分から戻したときは、黙って全滅させずに残す。
  if (from === 'prev') console.log(`[sessions] 台帳が壊れていたので前回分から復帰 (${saved.length} タブ)`);
  // 古い台帳には同じ会話を掴んだタブが複数入っていることがある(v1.5.3 以前の検出ミス)。
  // そのまま復元すると同じ会話に claude が多重に --resume される。
  const { sessions: fixed, stripped } = dedupeConversationIds(saved);
  for (const s of stripped) console.log(`[sessions] 会話の重複を解除: ${s.tab} → 新規で開く (${s.conversationId.slice(0, 8)} は先頭のタブが継承)`);
  return fixed;
});

// ── Crash detection ──
ipcMain.handle('check-crash', async () => {
  try {
    if (fs.existsSync(CRASH_FLAG)) return true;
  } catch (_) {}
  return false;
});

function setCrashFlag() {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(CRASH_FLAG, new Date().toISOString());
  } catch (_) {}
}

function clearCrashFlag() {
  try { fs.unlinkSync(CRASH_FLAG); } catch (_) {}
}

// ── Work Log (track prompts for crash recovery) ──
const WORKLOG_FILE = path.join(SESSIONS_DIR, 'work-log.json');
const MAX_LOG_ENTRIES = 200;

function loadWorkLog() {
  try {
    if (fs.existsSync(WORKLOG_FILE)) return JSON.parse(fs.readFileSync(WORKLOG_FILE, 'utf-8'));
  } catch (_) {}
  return [];
}

function saveWorkLogEntry(entry) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const log = loadWorkLog();
    log.push(entry);
    if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
    fs.writeFileSync(WORKLOG_FILE, JSON.stringify(log, null, 2));
  } catch (_) {}
}

ipcMain.handle('log-prompt', async (_e, { sessionId, prompt, sessionName, cwd }) => {
  saveWorkLogEntry({
    sessionId,
    sessionName: sessionName || 'unknown',
    cwd: cwd || '',
    prompt,
    timestamp: new Date().toISOString(),
  });
});

ipcMain.handle('load-work-log', async () => loadWorkLog());

ipcMain.handle('clear-work-log', async () => {
  try { fs.writeFileSync(WORKLOG_FILE, '[]'); } catch (_) {}
});

// ── Prefs (UI mode etc.) ──
const PREFS_FILE = path.join(SESSIONS_DIR, 'prefs.json');
// ── Web タブ (koach-os / claude.ai / chatgpt.com をこの中で開く) ──
// prefs.json は save-prefs が丸ごと書き換えるので、混ぜずに別ファイルに持つ。
const WEB_TABS_FILE = path.join(SESSIONS_DIR, 'web-tabs.json');
ipcMain.handle('open-external-url', async (_e, url) => {
  if (!/^https?:\/\//i.test(String(url || ''))) return false;
  try { await shell.openExternal(String(url)); return true; } catch { return false; }
});
// Brave のログイン(chatgpt.com/openai.com)をこのアプリの Web タブ(persist:web)へ取り込む。
// キーチェーン許可の確認は macOS が本人に出す。値はここだけで扱い、外へ出さない。
ipcMain.handle('import-brave-chatgpt', async () => {
  try {
    const { session } = require('electron');
    const braveImport = require('./src/brave-cookie-import');
    const r = await braveImport.importBraveChatgpt({
      session,
      log: (line) => { try { fs.appendFileSync(path.join(SESSIONS_DIR, 'brave-import.log'), `${new Date().toISOString()} ${line}\n`); } catch (_) {} },
    });
    // ⚠️ `...r` を展開すると r.ok(取り込めた件数) が ok:true を数値で上書きし、
    //    0 件のとき成功なのに失敗扱いになる。名前を分けて返す。
    return { ok: true, set: r.ok, skip: r.skip, total: r.total };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});
ipcMain.handle('load-web-tabs', async () => {
  try {
    const rows = JSON.parse(fs.readFileSync(WEB_TABS_FILE, 'utf-8'));
    return Array.isArray(rows) ? rows.filter((r) => r && /^https?:\/\//i.test(String(r.url || ''))) : [];
  } catch { return []; }
});
ipcMain.handle('save-web-tabs', async (_e, rows) => {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const clean = (Array.isArray(rows) ? rows : [])
      .filter((r) => r && /^https?:\/\//i.test(String(r.url || '')))
      .map((r) => ({ id: String(r.id || ''), url: String(r.url).slice(0, 2000), title: String(r.title || '').slice(0, 200) }));
    fs.writeFileSync(WEB_TABS_FILE, JSON.stringify(clean, null, 2));
  } catch (_) {}
});

ipcMain.handle('load-prefs', async () => {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8')); } catch { return {}; }
});
ipcMain.handle('save-prefs', async (_e, prefs) => {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch (_) {}
});

// ── Settings ──
const SETTINGS_FILE = path.join(SESSIONS_DIR, 'settings.json');
const DEFAULT_SETTINGS = {
  fontSize: 14,
  autoSaveInterval: 10,
  doubleEnterDelay: 500,
  autoUpdateClis: true,
};

ipcMain.handle('load-settings', async () => {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    return { ...DEFAULT_SETTINGS, ...data };
  } catch { return { ...DEFAULT_SETTINGS }; }
});

ipcMain.handle('save-settings', async (_e, settings) => {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (_) {}
});

// ── CLI auto-update (codex / gemini), throttled to once per 24h ──
const CLI_UPDATE_STAMP = path.join(SESSIONS_DIR, 'cli-update.json');
function autoUpdateClisInBackground() {
  try {
    let settings;
    try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) }; }
    catch { settings = { ...DEFAULT_SETTINGS }; }
    if (!settings.autoUpdateClis) return;

    let last = 0;
    try { last = JSON.parse(fs.readFileSync(CLI_UPDATE_STAMP, 'utf-8')).ts || 0; } catch (_) {}
    if (Date.now() - last < 24 * 60 * 60 * 1000) return; // 1日1回まで
    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); fs.writeFileSync(CLI_UPDATE_STAMP, JSON.stringify({ ts: Date.now() })); } catch (_) {}

    const { exec } = require('child_process');
    const run = (label, cmd) => exec(cmd, { env: shellEnv, timeout: 180000 }, (err) => {
      const msg = `[cli-update] ${label}: ${err ? 'skip/err (' + (err.message || '').split('\n')[0] + ')' : 'up to date'}`;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cli-update-log', msg);
    });
    // Codex は専用 update サブコマンド、Gemini は npm グローバル更新。無ければ静かに失敗。
    run('codex', 'codex update');
    run('gemini', 'npm install -g @google/gemini-cli@latest');
  } catch (_) {}
}

// ── Open app folder in Finder/Explorer ──
ipcMain.handle('open-app-folder', async () => {
  shell.openPath(path.join(__dirname));
});

// ── Auto-Update (git-based for dev, GitHub API for packaged) ──
function getSourceDir() {
  const appDir = path.join(__dirname);
  // Packaged Electron: __dirname is inside .asar (a file, not a directory).
  // Electron patches fs to work with asar paths, but child_process does NOT —
  // execSync with cwd pointing through .asar causes ENOTDIR.
  if (appDir.includes('.asar')) return null;
  try {
    fs.accessSync(path.join(appDir, '.git'), fs.constants.R_OK);
    return appDir;
  } catch (_) {
    return null;
  }
}

ipcMain.handle('check-update', async () => {
  const sourceDir = getSourceDir();

  if (sourceDir) {
    // Dev mode: use git
    try {
      execSync('git fetch origin', { cwd: sourceDir, encoding: 'utf-8', timeout: 15000 });
      const status = execSync('git status -uno --porcelain -b', { cwd: sourceDir, encoding: 'utf-8', timeout: 5000 });
      const behind = status.includes('behind');
      let remoteLog = '';
      if (behind) {
        // 比較先は origin/main 固定ではなく「今のブランチの追跡先」(@{u})。
        // 作業ブランチにいるときに main の差分を出してしまうのを防ぐ。
        try {
          remoteLog = execSync('git log HEAD..@{u} --oneline -10', { cwd: sourceDir, encoding: 'utf-8', timeout: 5000 }).trim();
        } catch (_) {}
      }
      return { updateAvailable: behind, changes: remoteLog };
    } catch (e) {
      return { updateAvailable: false, error: e.message };
    }
  }

  // Packaged app: check GitHub releases via API
  try {
    const https = require('https');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
    const currentVersion = pkg.version;
    const repoUrl = (pkg.repository && pkg.repository.url) || '';
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (!match) return { updateAvailable: false, error: 'リポジトリURL未設定' };

    const [, owner, repo] = match;
    const data = await new Promise((resolve, reject) => {
      https.get(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
        headers: { 'User-Agent': 'claude-code-desktop' }
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          if (res.statusCode === 200) resolve(JSON.parse(body));
          else reject(new Error(`GitHub API: ${res.statusCode}`));
        });
      }).on('error', reject);
    });

    const latestTag = (data.tag_name || '').replace(/^v/, '');
    // semver比較: 更新ありは latest > current のときだけ。
    // (GitHub最新releaseが実体より古い場合にダウングレードを"更新"と誤表示するのを防ぐ)
    const isNewer = (a, b) => {
      const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
      const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
      }
      return false;
    };
    const updateAvailable = !!latestTag && isNewer(latestTag, currentVersion);
    return {
      updateAvailable,
      changes: updateAvailable ? `${currentVersion} → ${latestTag}\n${data.body || ''}`.trim() : '',
      latestVersion: latestTag,
      currentVersion,
      downloadUrl: data.html_url || '',
    };
  } catch (e) {
    return { updateAvailable: false, error: e.message };
  }
});

ipcMain.handle('apply-update', async () => {
  const sourceDir = getSourceDir();

  if (sourceDir) {
    // Dev mode: git pull
    try {
      // 変更が無いのに git stash を打つと何も積まれないまま pop が走り、
      // 無関係な古い stash を取り出してしまう。積んだときだけ戻す。
      const dirty = execSync('git status --porcelain', { cwd: sourceDir, encoding: 'utf-8', timeout: 10000 }).trim() !== '';
      if (dirty) execSync('git stash push -m "ariya-auto-update"', { cwd: sourceDir, encoding: 'utf-8', timeout: 10000 });
      // origin/main 固定だと作業ブランチに main を流し込んでしまう。追跡先から早送りのみ。
      execSync('git pull --ff-only', { cwd: sourceDir, encoding: 'utf-8', timeout: 30000 });
      if (dirty) { try { execSync('git stash pop', { cwd: sourceDir, encoding: 'utf-8', timeout: 10000 }); } catch (_) {} }
      try {
        const diff = execSync('git diff HEAD~1 --name-only', { cwd: sourceDir, encoding: 'utf-8', timeout: 5000 });
        if (diff.includes('package.json') || diff.includes('package-lock.json')) {
          execSync('npm install', { cwd: sourceDir, encoding: 'utf-8', timeout: 120000 });
        }
      } catch (_) {}
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Packaged app: open GitHub releases page for manual download
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  const repoUrl = (pkg.repository && pkg.repository.url) || '';
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (match) {
    shell.openExternal(`https://github.com/${match[1]}/${match[2]}/releases/latest`);
    return { success: true, openedBrowser: true };
  }
  return { success: false, error: 'リポジトリURL未設定' };
});

ipcMain.handle('restart-app', async () => {
  // Save all sessions and buffers before exit — app.exit() bypasses lifecycle events
  saveSessionsSync();
  clearCrashFlag();
  // Kill PTY processes cleanly
  for (const [, s] of sessions) { try { s.pty.kill(); } catch (_) {} }
  app.relaunch();
  app.exit(0);
});

// ── Get app info ──
ipcMain.handle('get-app-info', async () => {
  let gitHash = '';
  const srcDir = getSourceDir();
  if (srcDir) {
    try { gitHash = execSync('git rev-parse --short HEAD', { cwd: srcDir, encoding: 'utf-8', timeout: 3000 }).trim(); } catch (_) {}
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  return { version: pkg.version, gitHash, electronVersion: process.versions.electron, nodeVersion: process.versions.node };
});

// ── Deep link (ariya://) ──
// 外部ツール (Fleet View など) から「このセッションのタブを開いて」と呼ばれる入口。
//   ariya://resume?session=<Claude Code の sessionId>&cwd=<作業フォルダ>&name=<表示名>
//   ariya://new?cwd=<作業フォルダ>&mode=<claude|codex|gemini|grok|shell>
// macOS は起動済みインスタンスに open-url を届けるので single-instance lock は使わない
// (入れると開発用の `npm start` が黙って起動しなくなる)。
const DEEP_LINK_SCHEME = 'ariya';
const DEEP_LINK_MODES = ['claude', 'codex', 'gemini', 'grok', 'shell'];
let pendingDeepLink = null;

function parseDeepLink(url) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (u.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  // ariya://resume?… は hostname に、ariya:///resume?… は pathname に出る
  const action = (u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
  const q = u.searchParams;
  const cwd = q.get('cwd') || '';
  const mode = (q.get('mode') || 'claude').toLowerCase();
  const req = {
    action,
    cwd,
    mode: DEEP_LINK_MODES.includes(mode) ? mode : 'claude',
    name: q.get('name') || '',
    conversationId: q.get('session') || q.get('conversationId') || '',
  };
  if (action === 'resume') return req.conversationId ? req : null;
  if (action === 'new') return req;
  return null;
}

function handleDeepLink(url) {
  const req = parseDeepLink(url);
  if (!req) return;
  if (!app.isReady()) { pendingDeepLink = req; return; }
  if (!mainWindow || mainWindow.isDestroyed()) { pendingDeepLink = req; createWindow(); return; }
  // 呼ばれたら前に出る (Dock から探させない)
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  try { app.focus({ steal: true }); } catch (_) {}
  deliverDeepLink(req);
}

function deliverDeepLink(req) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (req.action === 'resume') {
    // 同じ会話のタブが既にあるなら、新しく起こさずそのタブへ切り替える
    for (const [id, s] of sessions) {
      if (s.conversationId && s.conversationId === req.conversationId) {
        mainWindow.webContents.send('open-session', { ...req, action: 'focus', sessionId: id });
        return;
      }
    }
  }
  mainWindow.webContents.send('open-session', req);
}

function flushPendingDeepLink() {
  if (!pendingDeepLink) return;
  const req = pendingDeepLink;
  pendingDeepLink = null;
  deliverDeepLink(req);
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// ── 外から操作するための窓 ────────────────────────────────────
// 音声や MCP からタブを操作したい。ipcMain はアプリの中からしか届かないので、
// localhost だけに開いた小さな HTTP の窓を立てる。守りは src/control-server.js 側。
//
// ⚠️ 端末に文字を流し込める窓なので、止め方を先に用意しておく:
//    ~/.claude-code-app/control-off を作れば書き込みが全部断られる (再起動は要らない)。
//
// タブを開く口は出していない。create-session の中身を外から呼ぶには electron の
// 内部 API に触ることになり、版が上がると黙って壊れるため。開くのは手でよい。
const { startControlServer } = require('./src/control-server');
let controlServer = null;

// 窓から走らせた裏方ワーカーの出力を溜める。renderer へ送る経路とは別に持つ
// (窓から呼ばれたときは、見ている画面が無いこともあるため)。
const controlJobs = new Map();
const CONTROL_JOB_MAX = 40;

function startControl() {
  // 確認用の起動では窓口を開かない(鍵ファイル control.json とポートを本番と取り合うため)
  if (ISOLATED_DATA) return;
  try {
    controlServer = startControlServer({
      sessions,
      sessionBuffers,

      // Web タブ(claude.ai / chatgpt.com / 任意サイト)を読む・書く・押す
      web: {
        list: () => listWebTabsLive(),
        open: (url, title) => openWebTabFromMain(url, title),
        eval: async (wid, js) => {
          const wc = webContentsOf(wid);
          if (!wc) throw new Error('その Web タブはありません');
          return wc.executeJavaScript(js, true);
        },
        navigate: async (wid, url) => {
          const wc = webContentsOf(wid);
          if (!wc) throw new Error('その Web タブはありません');
          await wc.loadURL(url);
          return { ok: true, url: wc.getURL() };
        },
        shot: async (wid) => {
          const wc = webContentsOf(wid);
          if (!wc) throw new Error('その Web タブはありません');
          const img = await wc.capturePage();
          const dir = path.join(SESSIONS_DIR, 'shots');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${String(wid).replace(/[^\w.-]/g, '_')}.png`);
          fs.writeFileSync(file, img.toPNG());
          const sz = img.getSize();
          return { ok: true, file, width: sz.width, height: sz.height };
        },
        close: (wid) => {
          if (!webTabContents.has(String(wid)) || !mainWindow || mainWindow.isDestroyed()) return false;
          mainWindow.webContents.send('close-web-tab', { wid: String(wid) });
          return true;
        },
        // Brave のログイン取り込み(制御窓からも起こせるように)。中身は ipcMain と同じ道具。
        importBrave: async () => {
          try {
            const { session } = require('electron');
            const braveImport = require('./src/brave-cookie-import');
            const r = await braveImport.importBraveChatgpt({
              session,
              log: (line) => { try { fs.appendFileSync(path.join(SESSIONS_DIR, 'brave-import.log'), `${new Date().toISOString()} ${line}\n`); } catch (_) {} },
            });
            return { ok: true, set: r.ok, skip: r.skip, total: r.total };
          } catch (e) { return { ok: false, error: String(e.message || e) }; }
        },
        judge: (task) => judgeEngine(task),
        bridge: webBridge,
      },

      closeSession: async (id) => {
        const meta = sessionMetaFor(id);
        const latest = sessionBuffers.get(id);
        const s = sessions.get(id);
        if (s && s.pty) { try { s.pty.kill(); } catch (_) {} sessions.delete(id); }
        sessionBuffers.delete(id);
        savedBuffer.delete(id);
        archiveBuffer(id, 'closed', meta, latest);
      },

      runWorker: async ({ engine, task, cwd, write, model, timeoutMs }) => {
        let spec;
        try {
          spec = buildCommand(engine, task, { cwd: cwd || os.homedir(), write: !!write, model });
        } catch (err) {
          return { ok: false, error: String(err.message || err) };
        }
        const env = { ...shellEnv };
        if (spec.needsKey && !env[spec.needsKey]) {
          const k = readSecretKey(spec.needsKey);
          if (k) {
            env[spec.needsKey] = k;
            if (spec.needsKey === 'XAI_API_KEY') env.GROK_API_KEY = k;
          }
        }
        const jobId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const job = { done: false, output: '', engine, task, startedAt: Date.now() };
        controlJobs.set(jobId, job);
        // 溜めすぎない。古いものから捨てる
        while (controlJobs.size > CONTROL_JOB_MAX) {
          controlJobs.delete(controlJobs.keys().next().value);
        }
        const handle = runProcess(
          {
            bin: spec.bin, args: spec.args, cwd: spec.cwd, env,
            timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined,
          },
          {
            // ⚠️ runProcess は {which, text} を渡す。文字列扱いすると [object Object] が並ぶ(実測)
            onOutput: (d) => { job.output = (job.output + (typeof d === 'string' ? d : (d && d.text) || '')).slice(-200000); },
            onDone: (r) => { job.done = true; job.code = r.code; job.ms = Date.now() - job.startedAt; },
          },
        );
        if (handle.failed) { controlJobs.delete(jobId); return { ok: false, error: '起動できなかった' }; }
        job.cancel = handle.cancel;
        return { ok: true, jobId, engine, bin: spec.bin, write: spec.write, cwd: spec.cwd };
      },

      workerResult: (jobId) => {
        const j = controlJobs.get(jobId);
        if (!j) return null;
        return {
          done: j.done, code: j.code, ms: j.ms, engine: j.engine,
          output: j.output.slice(-20000),
        };
      },
    });
  } catch (e) {
    console.error('control server failed:', e.message);
  }
}

// ── Lifecycle ──
let timer;
// Web タブの中で開くポップアップ(Google ログインなど)は、同じ保存領域(persist:web)の
// 小窓で開く。外のブラウザに飛ばすとログインが戻ってこない。
// Google のログインは UA に "Ariya Bridge/1.7.7" や "Electron/32" が混じっていると
// 「このブラウザまたはアプリは安全でない可能性があります」で弾く(2026-09-11 に実際に出た)。
// renderer 側の置換は "Ariya Bridge" の空白を跨げず、productName が残っていた。
// ここで Chrome と同じ名乗りに揃え、persist:web の全リクエスト(ポップアップ含む)に効かせる。
function chromeLikeUA() {
  return String(app.userAgentFallback || '')
    .replace(new RegExp(' ?' + app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[\\d.]+'), '')
    .replace(/ ?claude-code-desktop\/[\d.]+/, '')
    .replace(/ ?Electron\/[\d.]+/, '');
}
function setupWebSession() {
  const ua = chromeLikeUA();
  const ses = session.fromPartition('persist:web');
  ses.setUserAgent(ua);
  // Client Hints も Chrome と同じ並びにする(UA だけ揃えても brands で見抜かれることがある)
  const m = /Chrome\/(\d+)/.exec(ua); const major = m ? m[1] : '128';
  const brands = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not;A=Brand";v="99"`;
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    if ('sec-ch-ua' in h || 'Sec-CH-UA' in h) { delete h['sec-ch-ua']; h['Sec-CH-UA'] = brands; }
    cb({ requestHeaders: h });
  });
}
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  try { contents.setUserAgent(chromeLikeUA()); } catch (_) {}
  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:\/\//i.test(url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520, height: 720, autoHideMenuBar: true,
        webPreferences: { partition: 'persist:web', nodeIntegration: false, contextIsolation: true, sandbox: true },
      },
    };
  });
});

app.whenReady().then(() => {
  setCrashFlag();
  // ⚠️ 開発版(npm start)で登録すると、ariya:// を開くアプリが開発版にすり替わる。ビルドした版だけ
  if (app.isPackaged) { try { app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME); } catch (_) {} }
  try { setupWebSession(); } catch (e) { console.error('web session:', e.message); }
  createWindow();
  createMenu();
  timer = setInterval(saveSessionsSync, 10000);
  setTimeout(autoUpdateClisInBackground, 8000); // 起動を邪魔しないよう遅延実行
  startControl();  // 外から操作するための窓 (127.0.0.1 のみ)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => {
  // Save sessions if not already saved by window-all-closed (e.g. Cmd+Q path)
  if (!sessionsSavedOnClose) {
    saveSessionsSync();
    sessionsSavedOnClose = true;
  }
  clearCrashFlag();
  if (timer) clearInterval(timer);
  try { if (controlServer) controlServer.close(); } catch (_) {}
});
let sessionsSavedOnClose = false;

app.on('window-all-closed', () => {
  // Save sessions to disk BEFORE clearing in-memory data
  if (!sessionsSavedOnClose) {
    saveSessionsSync();
    sessionsSavedOnClose = true;
  }
  for (const [, s] of sessions) { try { s.pty.kill(); } catch (_) {} }
  // pty だけ畳んで裏方ワーカーを素通りしていた。エンジンは MCP サーバなどを
  // 子として起こすので、放っておくとアプリを閉じたあとも孫が走り続ける。
  for (const [, j] of workerJobs) { try { j.cancel(); } catch (_) {} }
  workerJobs.clear();
  sessions.clear();
  sessionBuffers.clear();
  clearCrashFlag();
  app.quit();
});
