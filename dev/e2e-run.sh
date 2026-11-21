#!/usr/bin/env bash
# 端到端验证：起本地假站 → 用真实 Edge 加载测试版扩展 → 截图 + 让页面把「诊断」报告回传落盘。
# 用法：bash dev/e2e-run.sh            （默认跑正常变体）
#       bash dev/e2e-run.sh nofetch    （跑「页面不发任何 api 请求」变体）
set -euo pipefail
cd "$(dirname "$0")/.."
VAR="${1:-normal}"
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
[ -x "$EDGE" ] || EDGE="/c/Program Files/Microsoft/Edge/Application/msedge.exe"

bash dev/e2e-build.sh

# 端口被上一轮的假站占着就复用，没占就新起一个
if ! netstat -ano | grep -q ":8123 .*LISTENING"; then
  node dev/e2e-server.js > dev/e2e-server.log 2>&1 &
  sleep 1.2
fi

Q="demo=diag"
[ "$VAR" = "nofetch" ] && Q="demo=diag&nofetch=1"
URL="http://127.0.0.1:8123/chain/a1b2c3d4-e5f6-4711-8899-aabbccddeeff?$Q"

# Edge 的 --user-data-dir / --screenshot 是按它自己的当前目录解析的，必须给绝对路径
W="$(pwd -W)"
rm -rf dev/e2e-profile "dev/shot-e2e-$VAR.png" dev/e2e-diag.json
"$EDGE" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --user-data-dir="$W/dev/e2e-profile" \
  --load-extension="$W/dev/e2e-build" \
  --window-size=1500,900 --virtual-time-budget=16000 \
  --screenshot="$W/dev/shot-e2e-$VAR.png" "$URL" > dev/edge-out.txt 2>&1 || true

echo "--- 截图 dev/shot-e2e-$VAR.png ---"
[ -f dev/shot-e2e-$VAR.png ] && ls -l dev/shot-e2e-$VAR.png || echo "没有截图输出"
echo "--- 假站访问日志（证明重抓带了鉴权头、会话 ID 被改写）---"
tail -14 dev/e2e-server.log
echo "--- 诊断报告前几行 ---"
head -c 400 dev/e2e-diag.json 2>/dev/null || echo "没有诊断报告落盘"
