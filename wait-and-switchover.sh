#!/bin/zsh
# 走っている Claude セッションが一段落するのを待ってから switchover.sh を実行する。
#
# 「一段落」= 自分以外のどのセッションの .jsonl も QUIET_SEC 秒以上更新されていない状態。
# Claude Code は 1 ターン動くたびに .jsonl に追記するので、書きかけの Edit や実行中の
# Bash がある間はここが必ず動き続ける。止まった＝そのターンが終わって指示待ちになった、と読む。
#
# nohup で切り離して実行すること。呼び出し元 (Ariya Bridge 内の Claude) は
# switchover の途中で殺されるが、このスクリプトは生き残って最後まで進む。

# 待ち判定から除外する「自分自身」のセッションID。
#   第1引数 > $CLAUDE_CODE_SESSION_ID (Claude Code が自動で入れる) > 最後に書かれた .jsonl
# の順に決める。以前は特定IDを直書きしていたため、次のセッションから走らせると
# 既に終わったセッションを除外し、自分自身を「他人が作業中」と数えて永久に待ち続けた。
SELF_SESSION="${1:-${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}}"
if [ -z "$SELF_SESSION" ]; then
  SELF_SESSION=$(python3 -c 'import glob,os; fs=glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")); print(os.path.basename(max(fs,key=os.path.getmtime))[:-6] if fs else "")')
fi
QUIET_SEC=150            # これだけ誰も書かなければ「一段落」
POLL_SEC=20              # 見に行く間隔
MAX_WAIT_SEC=3600        # ここまで待って静かにならなければ諦める (勝手に落とさない)
DIR="${0:A:h}"
LOG="$HOME/.claude-code-app/switchover.log"

mkdir -p "$HOME/.claude-code-app"
echo "=== $(date '+%F %T') 待機開始 (self=${SELF_SESSION:-なし}, quiet=${QUIET_SEC}s, 上限=${MAX_WAIT_SEC}s) ===" >> "$LOG"

started=$(date +%s)
while true; do
  read -r idle busy <<<"$(python3 - "$SELF_SESSION" <<'PY'
import glob, os, sys, time
self_id = sys.argv[1]
now = time.time()
newest, who = 0, ''
for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')):
    if self_id in os.path.basename(f):
        continue
    try:
        m = os.path.getmtime(f)
    except OSError:
        continue
    if m <= newest:
        continue
    # 再開したセッションは別名のファイルに書き足されることがあるので、
    # 新しく見えたものは中身の sessionId でも自分自身かどうか確かめる
    try:
        with open(f, 'rb') as fh:
            fh.seek(max(0, os.path.getsize(f) - 4000))
            if self_id.encode() in fh.read():
                continue
    except OSError:
        pass
    newest, who = m, os.path.basename(os.path.dirname(f))
print(int(now - newest) if newest else 999999, who or '-')
PY
)"
  waited=$(( $(date +%s) - started ))
  echo "$(date '+%T') 直近の他セッション更新: ${idle}s前 (${busy})  経過 ${waited}s" >> "$LOG"

  if [ "$idle" -ge "$QUIET_SEC" ]; then
    echo "--- 静かになったので入れ替えを実行 ---" >> "$LOG"
    zsh "$DIR/switchover.sh" >> "$LOG" 2>&1
    rc=$?
    echo "switchover 終了コード=$rc" >> "$LOG"
    if [ $rc -eq 0 ]; then
      sleep 25
      echo "--- ariya:// の登録確認 ---" >> "$LOG"
      /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
        -dump 2>/dev/null | grep -i "ariya" | head -5 >> "$LOG"
    fi
    echo "=== $(date '+%F %T') 完了 ===" >> "$LOG"
    exit $rc
  fi

  if [ "$waited" -ge "$MAX_WAIT_SEC" ]; then
    echo "!!! ${MAX_WAIT_SEC}s 待っても静かにならないので中止。走っている作業は落としません。" >> "$LOG"
    echo "    やり直すときは: nohup zsh \"$DIR/wait-and-switchover.sh\" >/dev/null 2>&1 &" >> "$LOG"
    exit 2
  fi
  sleep "$POLL_SEC"
done
