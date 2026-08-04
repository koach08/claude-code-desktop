#!/bin/zsh
# Ariya Bridge 更新スイッチオーバー (dist/mac-arm64 ビルド → /Applications)
# ⚠️ 「別の Terminal.app / iTerm」から実行してください。
#    Ariya Bridge の中から実行すると、アプリ終了と同時にこのスクリプトごと止まります。
# ⚠️ 実行するとアプリ内の Claude 会話は全て終了します。区切りのいいタイミングで。
#    conversationId のあるタブは再起動後 `claude --resume` で自動的に戻ります。
set -e

SRC="/Users/koachmedia/Desktop/アプリ開発プロジェクト/claude-code-desktop/dist/mac-arm64/Ariya Bridge.app"
DST="/Applications/Ariya Bridge.app"
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [ ! -d "$SRC" ]; then echo "新ビルドが見つかりません: $SRC"; exit 1; fi

echo "0) 差し替え前のタブ台帳を退避..."
BK="$HOME/.claude-code-app/sessions.backup.$(date +%Y%m%d-%H%M%S).json"
if cp "$HOME/.claude-code-app/sessions.json" "$BK" 2>/dev/null; then echo "   $BK"; else echo "   (台帳なし・スキップ)"; fi

echo "1) 実行中の Ariya Bridge を終了 (終了時にタブ台帳が保存される)..."
osascript -e 'tell application "Ariya Bridge" to quit' 2>/dev/null || true
for i in {1..20}; do
  pgrep -f "/Applications/Ariya Bridge.app/Contents/MacOS/Ariya Bridge" >/dev/null || break
  sleep 1
done

echo "2) 旧バンドルを差し替え..."
# rm ではなく退避。ditto が途中で failed しても「アプリが消えた」状態を作らない。
OLD="/tmp/AriyaBridge.old.$$"
if [ -d "$DST" ]; then mv "$DST" "$OLD"; fi
if ditto "$SRC" "$DST" && [ -x "$DST/Contents/MacOS/Ariya Bridge" ]; then
  rm -rf "$OLD"
  echo "   installed: $DST"
else
  echo "   ⚠ コピーに失敗。旧バンドルを戻します"
  rm -rf "$DST"
  [ -d "$OLD" ] && mv "$OLD" "$DST"
  open "$DST"; exit 1
fi

echo "3) URL スキーム (ariya://) を LaunchServices に登録..."
"$LSREG" -f "$DST" 2>/dev/null || true

echo "4) 新アプリを起動..."
open "$DST"

echo
echo "確認:"
echo "  ・前回のタブが戻る (Claude レーンは --resume 付き)"
echo "  ・Fleet View で席をクリック →「このセッションのタブへ飛ぶ」でこのアプリが前に出る"
echo "  ・台帳を戻したいときは: $BK を ~/.claude-code-app/sessions.json に戻す"
