#!/bin/zsh
# Ariya Bridge 更新スイッチオーバー (dist-grok ビルド → /Applications)
# ⚠️ 「別の Terminal.app / iTerm」から実行してください。
#    Ariya Bridge の中から実行すると、アプリ終了と同時にこのスクリプトごと止まります。
# ⚠️ 実行するとアプリ内の Claude 会話は全て終了します。区切りのいいタイミングで。
set -e

SRC="/Users/koachmedia/Desktop/アプリ開発プロジェクト/claude-code-desktop/dist-grok/mac-arm64/Ariya Bridge.app"
DST="/Applications/Ariya Bridge.app"

if [ ! -d "$SRC" ]; then echo "新ビルドが見つかりません: $SRC"; exit 1; fi

echo "1) 実行中の Ariya Bridge を終了..."
osascript -e 'tell application "Ariya Bridge" to quit' 2>/dev/null || true
sleep 3

echo "2) 旧バンドルを差し替え..."
rm -rf "$DST"
ditto "$SRC" "$DST"
echo "   installed: $DST"

echo "3) 新アプリを起動..."
open "$DST"

echo "完了。エンジン切替に Grok (GK) レーンが出て、"
echo "セッション自動復元で前回のタブが戻れば成功です。"
