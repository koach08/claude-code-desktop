#!/bin/zsh
# 朝これ1本。ビルド → 署名 → /Applications へ差し替え。
#
# なぜ在るか: 本人が手順を覚える必要をなくすため。3 行のコマンドを覚えて打つのは負担で、
# 打ち間違いも起きる。ここに閉じ込めて「asa.sh を叩く」だけにする(2026-09-13)。
#
# ⚠️ 別の Terminal.app から実行すること。Ariya Bridge のタブから叩くと、アプリ終了と
#    同時に自分ごと止まる(switchover.sh 側にも番人が居るが、ここでも先に言っておく)。
# ⚠️ 実行するとアプリ内の会話は全部終わる。conversationId のあるタブは再起動後に戻る。
set -e

HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$HERE"

echo "━━━ 1/3 ビルド ━━━"
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac:dir

echo
echo "━━━ 2/3 中身の確認 ━━━"
# 差し替える前に、入れたはずのものが本当に入っているかを見る。
# 「ビルドしたのに古いまま」を何度か踏んでいるので、目で確かめられるようにする。
ASAR="$HERE/dist/mac-arm64/Ariya Bridge.app/Contents/Resources/app.asar"
if [ ! -f "$ASAR" ]; then echo "❌ ビルド結果が見つかりません: $ASAR"; exit 1; fi
TMPD=$(mktemp -d)
npx --yes @electron/asar extract-file "$ASAR" src/index.html > "$TMPD/index.html" 2>/dev/null || true
if [ -s "$TMPD/index.html" ] && grep -q "web-import-brave" "$TMPD/index.html"; then
  echo "✓ ChatGPT のログイン取り込みボタンが入っています"
else
  echo "⚠️ 取り込みボタンが見当たりません。それでも続けるなら Enter、やめるなら Ctrl+C"
  read -r _
fi
rm -rf "$TMPD"

echo
echo "━━━ 3/3 差し替え ━━━"
exec "$HERE/switchover.sh"
