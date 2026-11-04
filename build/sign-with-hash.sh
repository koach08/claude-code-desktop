#!/bin/zsh
# dist のアプリを Developer ID で署名する（ハッシュ指定）。
#
# なぜ electron-builder に任せないか:
#   login キーチェーンに同じ Developer ID 証明書が2重登録されており、名前で引くと
#   codesign が "ambiguous" で落ちる。electron-builder は identity にハッシュを渡しても
#   内部で証明書名に解決し直して codesign へ渡すため、設定側では回避できない。
#   ハッシュを直接 codesign に渡せば重複があっても一意に決まる（実証済み）。
#
# なぜ署名するか:
#   アドホック署名だとリビルドのたびに署名が変わり、macOS の TCC が別アプリとみなして
#   Desktop 等の許可を毎回リセットする。Developer ID なら Designated Requirement が
#   固定されるので、入れ替えても許可が残る。
set -e

# 署名に使う証明書のハッシュ。公開リポジトリに自分の名前と証明書を書かないよう、
# ~/.claude-code-app/signing-identity(1行) か環境変数 SIGN_IDENTITY から読む。
#   security find-identity -v -p codesigning   で確認できる。
IDENTITY="${SIGN_IDENTITY:-$(cat "$HOME/.claude-code-app/signing-identity" 2>/dev/null)}"
[ -n "$IDENTITY" ] || {
  echo "署名に使う証明書が指定されていません。"
  echo "  security find-identity -v -p codesigning   で出たハッシュを"
  echo "  ~/.claude-code-app/signing-identity に1行で書くか、SIGN_IDENTITY に入れてください。"
  exit 1
}
DIR="${0:A:h:h}"
APP="${1:-$DIR/dist/mac-arm64/Bridgework.app}"
ENT="$DIR/build/entitlements.mac.plist"

[ -d "$APP" ] || { echo "アプリが見つかりません: $APP"; exit 1; }
security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY" \
  || { echo "証明書 $IDENTITY がキーチェーンにありません"; exit 1; }

# Desktop が iCloud 同期だと FinderInfo などの属性が付き、xattr -cr で消しても付き直して
# codesign が "resource fork, Finder information, or similar detritus not allowed" で落ちる(2026-11-04)。
# パスの指定がなければ iCloud の外へ属性なしで写し、そちらに署名する。switchover.sh はそちらを使う。
STAGE_DIR=""
if [ -z "${1:-}" ]; then
  STAGE_DIR="$HOME/Library/Caches/Bridgework-build"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  ditto --norsrc --noextattr --noqtn "$APP" "$STAGE_DIR/Bridgework.app"
  APP="$STAGE_DIR/Bridgework.app"
fi

sign() { codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$IDENTITY" "$@"; }

echo "1) ネイティブモジュール / dylib を署名 (内側から)..."
find "$APP" \( -name "*.node" -o -name "*.dylib" -o -name "*.so" \) -print0 \
  | while IFS= read -r -d '' f; do sign "$f"; done

echo "2) Helper アプリを署名..."
find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.app" -print0 \
  | while IFS= read -r -d '' f; do sign "$f"; done

echo "3) フレームワークを署名..."
find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.framework" -print0 \
  | while IFS= read -r -d '' f; do sign "$f"; done

echo "4) 本体を署名..."
sign "$APP"

echo "5) 検証..."
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dvvv "$APP" 2>&1 | grep -E "^(Authority|TeamIdentifier|Signature|CodeDirectory v)" | sed 's/^/   /'
if [ -n "$STAGE_DIR" ]; then touch "$STAGE_DIR/.signed"; fi
echo "署名完了: $APP"
