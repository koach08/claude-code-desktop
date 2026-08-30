# Ariya Bridge 開発エージェント

**あなたと AI の開発チームをつなぐ、デスクトップの開発エージェント。**

Ariya Bridge は Claude Code / Codex / Gemini をひとつのウィンドウで束ね、
案件ごとにエンジンを切り替え、出荷まで面倒を見るための macOS / Windows / Linux アプリです。
ターミナルに不慣れでも、GUI から AI コーディングエージェントを動かせます。

> 旧称 **Claude Code Desktop**。単一エンジンの GUI ラッパーから、
> 複数エンジンを役割分担させる「AI の開発会社」へと発展させています。
> 方針は [VISION.md](VISION.md) を参照。

![Ariya Bridge](build/icon.png)

## 特長

- **マルチエンジン** — Claude Code / Codex / Gemini / 素のターミナルをタブごとに選択・切替
- **エンジン判定** — 入力欄に打っている最中に「これは Codex 向きです」と出し、押せばそのエンジンの新規タブへ指示ごと渡す（`src/engine-judge.js` / `src/nudge.js`）
- **工程リレー** — 1 つの依頼を 下調べ → 本作業 → 点検 に分け、癖の違うエンジンへ順に渡す。タブは開かず裏で走る（`src/relay.js`）
- **タブのエンジンだけ再起動** — `Cmd+Shift+R` でアプリ全体を落とさず、そのタブのエンジンだけ入れ替え
- **タブ自動命名** — 作業フォルダ / プロジェクト名から読みやすいタブ名を自動生成
- **フォルダ D&D** — プロジェクトフォルダをドロップして、そのディレクトリでエージェントを起動
- **出荷プラン生成** — 作業フォルダの構成から配布先（iOS / Mac App Store / Gumroad / Vercel）を判定し `RELEASE.md` を書き出し
- **CLI 自動更新** — 起動時に Codex / Gemini CLI をバックグラウンドで更新
- **AI Hub** — チャット / 音声文字起こし / ルート提案を内蔵
- **Harness 編集** — CLAUDE.md・Hooks・Memory・Projects をアプリから編集
- **セッション自動保存 / 復元** — 再起動しても会話を `--resume` で復元
- **クイック承認** — Yes / No / Ctrl+C をワンクリック

## 対応プラットフォーム

| Platform | Format | Architecture |
|----------|--------|-------------|
| **macOS** | `.dmg` | Apple Silicon (M1-M4) / Intel |
| **Windows** | `.exe`（installer + portable） | x64 |
| **Linux** | `.AppImage` / `.deb` | x64 |

## 必要環境

- **Node.js** v18+（[nodejs.org](https://nodejs.org)）
- **Claude Code CLI**（`npm install -g @anthropic-ai/claude-code`）
- 任意: **Codex CLI** / **Gemini CLI**（該当レーンを使う場合）
- **Anthropic アカウント**（Pro プラン または API キー）

> 各エンジンは利用者自身のアカウントで動作します。本アプリは UI ラッパーであり、
> API キーの保存・共有は行いません。

## ビルド / 起動

```bash
git clone https://github.com/koach08/claude-code-desktop.git
cd claude-code-desktop
npm install
npm start
```

配布ビルド:

```bash
npm run build:mac    # macOS (.dmg)
npm run build:win    # Windows (.exe)
npm run build:linux  # Linux (.AppImage, .deb)
```

## キーボードショートカット

| ショートカット | 動作 |
|----------|--------|
| `Cmd+Enter` | 送信 |
| `Cmd+T` | 新規タブ |
| `Cmd+W` | タブを閉じる |
| `Cmd+Shift+R` | このタブのエンジンだけ再起動 |
| `Cmd+Shift+E` | エンジン判定 / 工程リレー |
| `Cmd+Shift+B` | 案件ボード |
| `Cmd+1-9` | タブ切替 |
| `Alt+↑↓` | 入力履歴 |

## 工程リレー

1 つの依頼を、癖の違うエンジンに順に渡します。同じものを 2 社に見せて突き合わせる
のではなく、前の工程の出力がそのまま次の工程の入力になります。

- **下調べ** → **本作業** → **点検**。本作業の担当はエンジン判定の推奨をそのまま使い、
  点検役は**別ベンダ**から選びます（同じモデルに自分の出力を点検させると、同じ道筋を
  たどって同じ見落としをするため）。
- 既定は**読み取り専用**。書き込みは worktree 隔離が入るまで opt-in です。
- 別ベンダの点検役がいなければ「点検なし」と明示します。黙って通しません。

画面からは `Cmd+Shift+E` の「リレーで回す」。アプリを再起動せずに使うには:

```bash
node tools/relay.js "依頼の文" --cwd <対象リポジトリ>
node tools/relay.js "..." --write            # 本作業だけ書き込み可
node tools/relay.js "..." --engines claude,gemini --no-survey
```

`--write` のときは、点検役に本作業の報告だけでなく**実際の差分**を渡します。
報告しか読めないと、何も書き換えていなくても「問題なし」が返るためです。

## アーキテクチャ

Electron メインプロセス（`main.js`）が各エンジンを `node-pty` で起動し、
レンダラー（`src/`）が xterm ベースの端末とサイドバー UI を提供します。
`api-server/` は補助的な API サーバーです。

判定・状態推定・工程の組み立ては `src/` の electron 非依存モジュールに切り出してあり、
`npm test`（node:test、依存なし）で回帰を固定しています。

| モジュール | 役割 |
|-----------|------|
| `engine-judge.js` | タスク文 → どのエンジンで着手するか |
| `nudge.js` | その判定を普段の入力欄に出してよいか |
| `relay.js` | 下調べ→本作業→点検 の割り当てと、工程間の受け渡し |
| `worker-cmd.js` | 各 CLI を非対話で起動するコマンド組み立て |
| `worker-run.js` | 子プロセスの実行・打ち切り・出力の取り回し |
| `board.js` | タブを案件ごとに束ねて状態を出す |
| `prompt-detect.js` | そのタブが人間の返事を待って止まっているか |
| `conversation-id.js` | 会話ファイルの特定（`--resume` の要） |
| `ledger.js` | セッション台帳の読み書き |

## ライセンス

MIT

## Author

[Language × AI Lab](https://www.language-smartlearning.com/)
