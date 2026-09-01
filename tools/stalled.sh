#!/bin/zsh
# 止まっている案件の棚卸し。
#
# ── なぜ作ったか ──
# 「作ったが売るところまで行かず、放ったらかしになったものがある」という話が
# 出発点。感覚で数えると多いのか少ないのか分からないので、GitHub の最終 push と
# ファイル構成だけで機械的に出す。エージェントは使わない(タダで、何度でも回せる)。
#
# 見るのは3つだけ:
#   1. 何日 push が無いか
#   2. 売るための持ち物(販売文・ストア用メタデータ・LP・アプリ化の設定・ビルド済み)
#   3. 出荷の手順書やチェックリストが残っていないか
#
# 2 と 3 が揃っていて長く止まっているものは、作り終えて売る手前で止まった案件。
# 実際に回したら、公証まで通った DMG が販売文つきで4ヶ月眠っていたものが出た。
#
#   zsh tools/stalled.sh [オーナー] [停滞日数の下限]

OWNER="${1:-koach08}"
MIN_DAYS="${2:-60}"

printf "%6s  %-38s %s\n" "停滞" "リポジトリ" "売るための持ち物"
printf "%6s  %-38s %s\n" "----" "--------------------------------------" "------------------"

gh repo list "$OWNER" --limit 200 --json name,pushedAt \
  --jq '.[] | "\(.name)\t\(.pushedAt)"' | while IFS=$'\t' read -r name pushed; do
  days=$(( ( $(date +%s) - $(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$pushed" +%s) ) / 86400 ))
  [ "$days" -lt "$MIN_DAYS" ] && continue

  files=$(gh api "repos/$OWNER/$name/contents" --jq '.[].name' 2>/dev/null) || continue
  sig=""
  echo "$files" | grep -qi "gumroad"                    && sig="$sig 販売文"
  echo "$files" | grep -qi "appstore\|Info.plist\|xcodeproj" && sig="$sig ストア用"
  echo "$files" | grep -qi "landing-page\|marketing"     && sig="$sig LP"
  echo "$files" | grep -qi "electron-builder\|capacitor\|tauri" && sig="$sig アプリ化"
  echo "$files" | grep -qi "\.zip$\|\.dmg$"             && sig="$sig ビルド済み"
  echo "$files" | grep -qi "^release$\|RELEASE.md"      && sig="$sig 出荷手順"

  [ -n "$sig" ] && printf "%5d日  %-38s %s\n" "$days" "$name" "$sig"
done | sort -rn

cat <<'NOTE'

持ち物が多いほど、残っているのは作ることではなく売る手続きです。
中身を見るには:
  gh repo clone <owner>/<name> -- --depth 50
  node tools/relay.js "出荷まで具体的に何が残っているか。できているものは除く。" --cwd <clone先>

ビルド済みのものがあるなら、まず署名と公証の状態を見ること。作り直す前に、
そのまま出せる可能性がある:
  hdiutil attach -quiet -nobrowse -readonly -mountpoint /tmp/m <dmg>
  spctl -a -vvv /tmp/m/*.app     # "accepted / source=Notarized Developer ID" なら出せる
  hdiutil detach -quiet /tmp/m
NOTE
