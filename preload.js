const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ドロップされた File のフルパス。Electron 32 で File.path が消えたので webUtils で取る
  // (2026-09-11: 消えた後もずっと f.path を見ていて、ドロップが黙って何も起きなかった)
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ''; } },
  // クリップボードの画像をファイルに落としてパスを返す(無ければ '')
  saveClipboardImage: () => ipcRenderer.invoke('save-clipboard-image'),
  createSession: (opts) => ipcRenderer.invoke('create-session', opts || {}),
  projectLabels: () => ipcRenderer.invoke('project-labels'),
  projectsList: () => ipcRenderer.invoke('projects-list'),
  bufferArchiveList: () => ipcRenderer.invoke('buffer-archive-list'),
  bufferArchiveRead: (file) => ipcRenderer.invoke('buffer-archive-read', { file }),
  pastTabs: () => ipcRenderer.invoke('past-tabs'),
  projectCreate: (opts) => ipcRenderer.invoke('project-create', opts || {}),
  classifyTabs: () => ipcRenderer.invoke('classify-tabs'),
  assignProject: (sessionId, project) => ipcRenderer.invoke('assign-project', { sessionId, project }),
  projectNames: () => ipcRenderer.invoke('project-names'),
  switchMode: (sessionId, newMode) => ipcRenderer.invoke('switch-mode', { sessionId, newMode }),
  sendInput: (sessionId, input) => ipcRenderer.invoke('send-input', { sessionId, input }),
  wakeSession: (sessionId) => ipcRenderer.invoke('wake-session', { sessionId }),
  getTabPdf: (sessionId) => ipcRenderer.invoke('get-tab-pdf', { sessionId }),
  setTabPdf: (sessionId, on) => ipcRenderer.invoke('set-tab-pdf', { sessionId, on }),
  getTabConnectors: (sessionId) => ipcRenderer.invoke('get-tab-connectors', { sessionId }),
  setTabConnector: (sessionId, key, on) => ipcRenderer.invoke('set-tab-connector', { sessionId, key, on }),
  resizeTerminal: (sessionId, cols, rows) => ipcRenderer.invoke('resize-terminal', { sessionId, cols, rows }),
  closeSession: (sessionId) => ipcRenderer.invoke('close-session', { sessionId }),
  checkClaudeCli: () => ipcRenderer.invoke('check-claude-cli'),
  installClaudeCli: () => ipcRenderer.invoke('install-claude-cli'),
  resolveCwd: (p) => ipcRenderer.invoke('resolve-cwd', p),
  saveSessions: () => ipcRenderer.invoke('save-sessions'),
  loadSessions: () => ipcRenderer.invoke('load-sessions'),
  loadPrefs: () => ipcRenderer.invoke('load-prefs'),
  savePrefs: (prefs) => ipcRenderer.invoke('save-prefs', prefs),
  loadBuffer: (sessionId) => ipcRenderer.invoke('load-buffer', { sessionId }),
  cleanupOldBuffers: (oldIds) => ipcRenderer.invoke('cleanup-old-buffers', { oldIds }),
  logPrompt: (data) => ipcRenderer.invoke('log-prompt', data),
  loadWorkLog: () => ipcRenderer.invoke('load-work-log'),
  clearWorkLog: () => ipcRenderer.invoke('clear-work-log'),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  openAppFolder: () => ipcRenderer.invoke('open-app-folder'),
  getAppDir: () => ipcRenderer.invoke('get-app-dir'),
  scanProject: (cwd) => ipcRenderer.invoke('scan-project', { cwd }),
  checkCrash: () => ipcRenderer.invoke('check-crash'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  // AI Hub Chat API
  hubChat: (opts) => ipcRenderer.invoke('hub-chat', opts),
  hubTranscribe: (opts) => ipcRenderer.invoke('hub-transcribe', opts),
  // 音声で往復するときの返事。1 回で返る (SSE ではない)
  hubConverse: (opts) => ipcRenderer.invoke('hub-converse', opts),
  // 声のやり取り (直に叩く。遅い経路を通さない)
  voiceTranscribe: (opts) => ipcRenderer.invoke('voice-transcribe', opts),
  voiceReply: (opts) => ipcRenderer.invoke('voice-reply', opts),
  alfredVoice: (opts) => ipcRenderer.invoke('alfred-voice', opts),
  voiceKeepAwake: (on) => ipcRenderer.invoke('voice-keepawake', on),
  voiceTts: (opts) => ipcRenderer.invoke('voice-tts', opts),
  // 声のまま考えるモデル。⚠️ 返るのは数分で切れる一時鍵で、本物の鍵ではない
  realtimeToken: () => ipcRenderer.invoke('realtime-token'),
  // 声で案件を名指しするときの読み。手元のファイルにしか無い
  voiceAliases: () => ipcRenderer.invoke('voice-aliases'),
  // 音声の履歴。localStorage が消えても読めるようファイルにも残す
  saveVoiceHistory: (h) => ipcRenderer.invoke('save-voice-history', h),
  loadVoiceHistory: () => ipcRenderer.invoke('load-voice-history'),
  hubSuggestRoute: (text) => ipcRenderer.invoke('hub-suggest-route', { text }),
  suggestEngine: (task) => ipcRenderer.invoke('suggest-engine', { task }),
  boardSnapshot: () => ipcRenderer.invoke('board-snapshot'),
  // 他のアプリ(Claude デスクトップ / Codex Desktop / ChatGPT Work)の会話一覧
  listExternalConversations: () => ipcRenderer.invoke('list-external-conversations'),
  openExternal: (url) => ipcRenderer.invoke('open-external-url', url),
  loadWebTabs: () => ipcRenderer.invoke('load-web-tabs'),
  saveWebTabs: (rows) => ipcRenderer.invoke('save-web-tabs', rows),
  // Web タブを外(制御窓 → Claude Code)から読む・書く・押すための台帳と合図
  webTabAttached: (info) => ipcRenderer.send('web-tab-attached', info),
  webTabClosed: (wid) => ipcRenderer.send('web-tab-closed', { wid }),
  onOpenWebUrl: (cb) => { ipcRenderer.on('open-web-url', (_e, p) => cb(p)); },
  onCloseWebTab: (cb) => { ipcRenderer.on('close-web-tab', (_e, p) => cb(p)); },
  // Brave の ChatGPT ログインをこのアプリへ取り込む(メニューから)
  importBraveChatgpt: () => ipcRenderer.invoke('import-brave-chatgpt'),

  // 裏方ワーカー(タブを開かずにエンジンを走らせる)
  workerStart: (opts) => ipcRenderer.invoke('worker-start', opts),
  workerCancel: (jobId) => ipcRenderer.invoke('worker-cancel', { jobId }),
  workerList: () => ipcRenderer.invoke('worker-list'),
  workerEngines: () => ipcRenderer.invoke('worker-engines'),
  onWorkerOutput: (jobId, cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on(`worker-output-${jobId}`, h);
    return () => ipcRenderer.removeListener(`worker-output-${jobId}`, h);
  },
  onWorkerDone: (jobId, cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.once(`worker-done-${jobId}`, h);
    return () => ipcRenderer.removeListener(`worker-done-${jobId}`, h);
  },
  generateReleasePlan: (cwd) => ipcRenderer.invoke('generate-release-plan', { cwd }),
  openPath: (p) => ipcRenderer.invoke('open-path', { p }),
  hubProviders: () => ipcRenderer.invoke('hub-providers'),
  hubLoadConfig: () => ipcRenderer.invoke('hub-load-config'),
  hubSaveConfig: (cfg) => ipcRenderer.invoke('hub-save-config', cfg),
  onHubChunk: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('hub-chat-chunk', h);
    return () => ipcRenderer.removeListener('hub-chat-chunk', h);
  },
  onHubDone: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('hub-chat-done', h);
    return () => ipcRenderer.removeListener('hub-chat-done', h);
  },
  onHubError: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('hub-chat-error', h);
    return () => ipcRenderer.removeListener('hub-chat-error', h);
  },

  // Harness Engineering
  harnessReadClaudeMd: (cwd) => ipcRenderer.invoke('harness-read-claudemd', { cwd }),
  harnessWriteClaudeMd: (cwd, content) => ipcRenderer.invoke('harness-write-claudemd', { cwd, content }),
  harnessReadUserClaudeMd: () => ipcRenderer.invoke('harness-read-user-claudemd'),
  harnessWriteUserClaudeMd: (content) => ipcRenderer.invoke('harness-write-user-claudemd', { content }),
  harnessReadHooks: (cwd) => ipcRenderer.invoke('harness-read-hooks', { cwd }),
  harnessWriteHooks: (cwd, hooks) => ipcRenderer.invoke('harness-write-hooks', { cwd, hooks }),
  harnessReadMemory: (cwd) => ipcRenderer.invoke('harness-read-memory', { cwd }),
  harnessReadMemoryContent: (file, cwd) => ipcRenderer.invoke('harness-read-memory-content', { file, cwd }),
  harnessWriteMemory: (file, content, cwd) => ipcRenderer.invoke('harness-write-memory', { file, content, cwd }),
  harnessDeleteMemory: (file, cwd) => ipcRenderer.invoke('harness-delete-memory', { file, cwd }),
  harnessLoadProjects: () => ipcRenderer.invoke('harness-load-projects'),
  harnessSaveProjects: (projects) => ipcRenderer.invoke('harness-save-projects', projects),
  harnessPickFolder: () => ipcRenderer.invoke('harness-pick-folder'),

  onSessionOutput: (id, cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on(`session-output-${id}`, h);
    return () => ipcRenderer.removeListener(`session-output-${id}`, h);
  },
  onSessionExit: (id, cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on(`session-exit-${id}`, h);
    return () => ipcRenderer.removeListener(`session-exit-${id}`, h);
  },
  // 外部から ariya:// で開かれたときに飛んでくる (Fleet View → 該当タブ)
  onOpenSession: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('open-session', h);
    return () => ipcRenderer.removeListener('open-session', h);
  },
  onMenuAction: (cb) => {
    ipcRenderer.on('menu-action', (_e, action) => cb(action));
  },
  // 会話タブ(吹き出し表示)。裏は claude -p の stream-json
  chatSend: (sessionId, text, images, attachments) => ipcRenderer.invoke('chat-send', { sessionId, text, images, attachments }),
  // 取り込み・情報ノート
  libIngest: (opts) => ipcRenderer.invoke('lib-ingest', opts),
  libIngestText: (opts) => ipcRenderer.invoke('lib-ingest-text', opts),
  libCancel: (jobId) => ipcRenderer.invoke('lib-cancel', { jobId }),
  libList: (q) => ipcRenderer.invoke('lib-list', { q }),
  libRead: (id) => ipcRenderer.invoke('lib-read', { id }),
  libReveal: (id) => ipcRenderer.invoke('lib-reveal', { id }),
  libTrash: (id) => ipcRenderer.invoke('lib-trash', { id }),
  libUnwatch: (url) => ipcRenderer.invoke('lib-unwatch', { url }),
  libWatchToggle: (url, auto) => ipcRenderer.invoke('lib-watch-toggle', { url, auto }),
  libCheckNow: () => ipcRenderer.invoke('lib-check-now'),
  libFetchRaw: (url) => ipcRenderer.invoke('lib-fetch-raw', { url }),
  libCaps: () => ipcRenderer.invoke('lib-caps'),
  libSetGeminiKey: (key) => ipcRenderer.invoke('lib-set-gemini-key', { key }),
  chatMcpStatus: (sessionId) => ipcRenderer.invoke('chat-mcp-status', { sessionId }),
  officeOpen: () => ipcRenderer.invoke('office-open'),
  // スライド
  slideOptions: () => ipcRenderer.invoke('slide-options'),
  slideList: () => ipcRenderer.invoke('slide-list'),
  slideMake: (opts) => ipcRenderer.invoke('slide-make', opts),
  slideRevise: (id, instruction, model) => ipcRenderer.invoke('slide-revise', { id, instruction, model }),
  slideUndo: (id) => ipcRenderer.invoke('slide-undo', { id }),
  slideRead: (id) => ipcRenderer.invoke('slide-read', { id }),
  slideTheme: (id, theme) => ipcRenderer.invoke('slide-theme', { id, theme }),
  slidePdf: (id) => ipcRenderer.invoke('slide-pdf', { id }),
  slidePresent: (id) => ipcRenderer.invoke('slide-present', { id }),
  slideReveal: (id) => ipcRenderer.invoke('slide-reveal', { id }),
  slideTrash: (id) => ipcRenderer.invoke('slide-trash', { id }),
  onSlideProgress: (cb) => ipcRenderer.on('slide-progress', (_e, p) => cb(p)),
  webTabExtract: (wid) => ipcRenderer.invoke('web-tab-extract', { wid }),
  onLibProgress: (cb) => ipcRenderer.on('lib-progress', (_e, p) => cb(p)),
  chatInterrupt: (sessionId) => ipcRenderer.invoke('chat-interrupt', { sessionId }),
  chatPermission: (sessionId, requestId, allow, always) => ipcRenderer.invoke('chat-permission', { sessionId, requestId, allow, always }),
  chatConfigure: (sessionId, opts) => ipcRenderer.invoke('chat-configure', { sessionId, ...(opts || {}) }),
  chatPresets: () => ipcRenderer.invoke('chat-presets'),
  chatTranscript: (conversationId, cwd) => ipcRenderer.invoke('chat-transcript', { conversationId, cwd }),
  onChatEvent: (id, cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on(`chat-event-${id}`, h);
    return () => ipcRenderer.removeListener(`chat-event-${id}`, h);
  },
  removeListeners: (id) => {
    ipcRenderer.removeAllListeners(`session-output-${id}`);
    ipcRenderer.removeAllListeners(`session-exit-${id}`);
    ipcRenderer.removeAllListeners(`chat-event-${id}`);
  },
});
