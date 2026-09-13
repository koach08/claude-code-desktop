#!/bin/zsh
# Ariya Bridge の Web タブ(claude.ai / chatgpt.com / 任意サイト)を、Claude Code から読む・書く・押す。
# 本人がタブの中でログインしておく。ここはその画面を借りるだけ。
#
#   web.sh list                          開いている Web タブ
#   web.sh open URL [題]                 タブで開く(同じ URL があればそれ)
#   web.sh import                        Brave の ChatGPT ログインを取り込む(画面にキーチェーンの許可が出る)
#   web.sh ask "文" [auto|chatgpt|claude] 作業に応じて ChatGPT/Claude に振って送る(auto が既定)
#   web.sh reply ID                      最後の返事(busy なら書いている途中)
#   web.sh wait ID [秒]                  返事が書き終わるまで待って出す
#   web.sh text ID [selector]            本文
#   web.sh outline ID                    押せるもの・書けるものの一覧
#   web.sh shot ID                       見た目を PNG に落としてパスを出す(Read で見る)
#   web.sh go ID URL                     移動
#   web.sh click ID "文字" | ID css:SELECTOR
#   web.sh fill ID SELECTOR "文"
#   web.sh eval ID 'js'
#   web.sh close ID
set -e
CFG="$HOME/.claude-code-app/control.json"
TOKEN=$(python3 -c "import json;print(json.load(open('$CFG'))['token'])")
PORT=$(python3 -c "import json;print(json.load(open('$CFG')).get('port',7391))")
BASE="http://127.0.0.1:$PORT"
H=(-s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
j() { python3 -c 'import json,sys; print(json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2])), ensure_ascii=False))' "$@"; }
cmd="$1"; shift || true
case "$cmd" in
  list)    curl "${H[@]}" "$BASE/web" ;;
  open)    curl "${H[@]}" -X POST "$BASE/web" -d "$(j url "$1" title "${2:-}")" ;;
  import)  curl "${H[@]}" -X POST "$BASE/web/import-brave" -d '{}' ;;
  ask)     curl "${H[@]}" -X POST "$BASE/web/ask" -d "$(j text "$1" engine "${2:-auto}")" ;;
  reply)   curl "${H[@]}" "$BASE/web/$1/reply" ;;
  wait)    id="$1"; n="${2:-120}"; i=0
           while [ $i -lt $n ]; do
             r=$(curl "${H[@]}" "$BASE/web/$id/reply")
             busy=$(printf '%s' "$r" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("1" if d.get("busy") else "0")' 2>/dev/null || echo 0)
             [ "$busy" = "0" ] && [ $i -ge 3 ] && { printf '%s' "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("text",""))'; exit 0; }
             sleep 1; i=$((i+1))
           done; echo "(時間切れ)"; printf '%s' "$r" ;;
  text)    curl "${H[@]}" "$BASE/web/$1/text?selector=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "${2:-}")" ;;
  outline) curl "${H[@]}" "$BASE/web/$1/outline" ;;
  shot)    curl "${H[@]}" "$BASE/web/$1/shot" ;;
  go)      curl "${H[@]}" -X POST "$BASE/web/$1/navigate" -d "$(j url "$2")" ;;
  click)   if [[ "$2" == css:* ]]; then curl "${H[@]}" -X POST "$BASE/web/$1/click" -d "$(j selector "${2#css:}")"
           else curl "${H[@]}" -X POST "$BASE/web/$1/click" -d "$(j text "$2")"; fi ;;
  fill)    curl "${H[@]}" -X POST "$BASE/web/$1/fill" -d "$(j selector "$2" text "$3")" ;;
  eval)    curl "${H[@]}" -X POST "$BASE/web/$1/eval" -d "$(j js "$2")" ;;
  close)   curl "${H[@]}" -X DELETE "$BASE/web/$1" ;;
  *)       sed -n 2,18p "$0"; exit 1 ;;
esac
echo
