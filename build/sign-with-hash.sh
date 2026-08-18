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

IDENTITY="33EB49F9A79CC2C3E329A3E06ACD6D909C4C8EB5"   # Developer ID Application: Koichiro Shigaki (HDSYA72T8Z) G2 / 2031-04 まで
DIR="${0:A:h:h}"
APP="${1:-$DIR/dist/mac-arm64/Ariya Bridge.app}"
ENT="$DIR/build/entitlements.mac.plist"

[ -d "$APP" ] || { echo "アプリが見つかりません: $APP"; exit 1; }
security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY" \
  || { echo "証明書 $IDENTITY がキーチェーンにありません"; exit 1; }

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
echo "署名完了: $APP"
