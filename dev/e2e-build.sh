#!/usr/bin/env bash
# 生成一份只作用于本地假站的测试版扩展（正式 manifest 只匹配 chat.deepseek.com，不动）。
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dev/e2e-build
mkdir -p dev/e2e-build/src
cp src/*.js src/*.css dev/e2e-build/src/
# 测试构建：把匹配域换成本机假站（正式 manifest 只匹配 chat.deepseek.com），并补一条跨扩展读剪贴板的权限
node -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const ORIGIN="http://127.0.0.1:8123/*";
m.content_scripts.forEach(function (cs) { cs.matches=[ORIGIN]; });
m.host_permissions=[ORIGIN,"chrome-extension://*"];
fs.writeFileSync("dev/e2e-build/manifest.json",JSON.stringify(m,null,2));
'
node dev/e2e-patch.js
echo "built dev/e2e-build"
