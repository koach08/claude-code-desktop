#!/bin/zsh
# Ariya Bridge 更新スイッチオーバー (dist/mac-arm64 ビルド → /Applications)
# ⚠️ 「別の Terminal.app / iTerm」から実行してください。
#    Ariya Bridge の中から実行すると、アプリ終了と同時にこのスクリプトごと止まります。
# ⚠️ 実行するとアプリ内の Claude 会話は全て終了します。区切りのいいタイミングで。
#    conversationId のあるタブは再起動後 `claude --resume` で自動的に戻ります。
set -e

# 自分の在り処。zsh の ${0:A:h} は bash だと黙って空文字になり、SRC が
# /dist/... という有り得ないパスになる(2026-08-25 に `bash switchover.sh` で踏んだ)。
# どちらのシェルで呼ばれても同じ場所を指すよう、素の書き方で求める。
SELF="$(cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")"
HERE="$(dirname -- "$SELF")"

# --- 実行元ガード ---------------------------------------------------------
# 2026-08-23 20:06、このスクリプトを Ariya Bridge のタブ(=アプリの子プロセス)から
# 実行し、手順1でアプリを終了させた瞬間に自分ごと道連れで死んだ。ditto が途中で
# 止まり、Info.plist を欠いたバンドルが /Applications に残って起動不能になった。
# 警告コメントだけが頼りだったので、実行元を見て止める番人を置く。
ariya_ancestor() {
  local pid=$$ cmd i=0
  while [ "${pid:-0}" -gt 1 ] && [ $i -lt 60 ]; do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null)
    case "$cmd" in
      *"Ariya Bridge.app/Contents/MacOS/Ariya Bridge"*) return 0 ;;
    esac
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    i=$((i+1))
  done
  return 1
}
if [ "${SWITCHOVER_DETACHED:-0}" != "1" ] && ariya_ancestor; then
  echo "⚠ Ariya Bridge の中から実行されています。差し替えは行わず中止しました。" >&2
  echo "  手順1のアプリ終了でこのスクリプト自身が死に、バンドルが壊れます(2026-08-23 に発生)。" >&2
  echo "" >&2
  echo "  Terminal.app / iTerm から:  zsh \"$SELF\"" >&2
  echo "  タブから走らせたいときは:    nohup zsh \"$HERE/wait-and-switchover.sh\" >/dev/null 2>&1 &" >&2
  echo "    (wait-and-switchover.sh は自分を親から切り離してから差し替えます)" >&2
  exit 4
fi

SRC="$HERE/dist/mac-arm64/Ariya Bridge.app"   # このスクリプトと同じ場所の dist を見る
DST="/Applications/Ariya Bridge.app"
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [ ! -d "$SRC" ]; then echo "新ビルドが見つかりません: $SRC"; exit 1; fi

# 出発前点検: 稼働中のアプリを終了させてから新ビルドの不備に気づくのを防ぐ。
# 無人実行だと「アプリを落としただけで終わり」が一番まずい。
if [ ! -x "$SRC/Contents/MacOS/Ariya Bridge" ]; then
  echo "新ビルドの実行ファイルがありません。中止します: $SRC"; exit 1
fi
if ! codesign --verify --strict "$SRC" 2>/dev/null; then
  echo "新ビルドの署名が壊れています。中止します: $SRC"; exit 1
fi
NEWVER=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$SRC/Contents/Info.plist" 2>/dev/null)
OLDVER=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$DST/Contents/Info.plist" 2>/dev/null)
echo "点検OK: $OLDVER → $NEWVER"

echo "0) 差し替え前のタブ台帳を退避..."
BK="$HOME/.claude-code-app/sessions.backup.$(date +%Y%m%d-%H%M%S).json"
if cp "$HOME/.claude-code-app/sessions.json" "$BK" 2>/dev/null; then echo "   $BK"; else echo "   (台帳なし・スキップ)"; fi

echo "1) 実行中の Ariya Bridge を終了 (終了時にタブ台帳が保存される)..."
running() { pgrep -f "/Applications/Ariya Bridge.app/Contents/MacOS/Ariya Bridge" 2>/dev/null; }

osascript -e 'tell application "Ariya Bridge" to quit' 2>/dev/null || true
for i in {1..20}; do running >/dev/null || break; sleep 1; done

# launchd から無人で走らせると Apple Events が通らず osascript が黙って失敗しうる。
# その場合ここでまだ生きているので、SIGTERM で終了させる(Electron は台帳を保存して閉じる)。
if running >/dev/null; then
  echo "   osascript で終わらなかったので SIGTERM を送ります"
  for p in $(running); do kill "$p" 2>/dev/null || true; done
  for i in {1..20}; do running >/dev/null || break; sleep 1; done
fi

# それでも生きているならバンドルには触らない。動いているアプリを差し替えると
# 二重起動や台帳の取り合いになるので、何もせず諦める方が安全。
if running >/dev/null; then
  echo "   ⚠ アプリが終了しません。差し替えは行わず中止します (pid: $(running | tr '\n' ' '))"
  exit 3
fi
echo "   終了を確認"

echo "2) 新バンドルを展開してから差し替え..."
# 先に /Applications 内のステージングへ丸ごと展開し、出来上がりを検めてから mv で
# 入れ替える。展開の途中で落ちても現物には手を付けていないので、「起動できない
# バンドルだけが残る」状態にならない。同じボリューム内なので mv は一瞬で終わる。
STAGE="/Applications/.AriyaBridge.staging.$$"
OLD="/tmp/AriyaBridge.old.$$"
rm -rf "$STAGE"
trap 'rm -rf "$STAGE" 2>/dev/null || true' EXIT

if ! ditto "$SRC" "$STAGE"; then
  echo "   ⚠ 展開に失敗。/Applications には触れていません"
  rm -rf "$STAGE"; open "$DST" 2>/dev/null || true; exit 1
fi
if [ ! -x "$STAGE/Contents/MacOS/Ariya Bridge" ] || [ ! -f "$STAGE/Contents/Info.plist" ]; then
  echo "   ⚠ 展開結果が不完全。/Applications には触れていません"
  rm -rf "$STAGE"; open "$DST" 2>/dev/null || true; exit 1
fi

if [ -d "$DST" ]; then mv "$DST" "$OLD"; fi
if mv "$STAGE" "$DST" && [ -x "$DST/Contents/MacOS/Ariya Bridge" ]; then
  trap - EXIT
  rm -rf "$OLD"
  echo "   installed: $DST"
else
  echo "   ⚠ 差し替えに失敗。旧バンドルを戻します"
  trap - EXIT
  rm -rf "$DST"
  [ -d "$OLD" ] && mv "$OLD" "$DST"
  open "$DST"; exit 1
fi

echo "3) URL スキーム (ariya://) を LaunchServices に登録..."
"$LSREG" -f "$DST" 2>/dev/null || true
# dist/ に残るビルド成果物も同じ ariya: を主張し、OS がそちら(非起動)へ解決してしまう。
# /Applications を唯一のハンドラにするため登録解除する。
for d in "$SRC" "$(dirname "$(dirname "$SRC")")/mac/Ariya Bridge.app"; do
  [ -d "$d" ] && "$LSREG" -u "$d" 2>/dev/null || true
done

echo "4) 新アプリを起動..."
open "$DST"

echo
echo "確認:"
echo "  ・前回のタブが戻る (Claude レーンは --resume 付き)"
echo "  ・Fleet View で席をクリック →「このセッションのタブへ飛ぶ」でこのアプリが前に出る"
echo "  ・台帳を戻したいときは: $BK を ~/.claude-code-app/sessions.json に戻す"
