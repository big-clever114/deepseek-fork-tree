// 只改测试构建：放开两处「正式版故意收紧」的地方，其余逻辑一字不动。
//   1) capture.js 的主机过滤：从「仅 deepseek.com」放开到本机回环，否则本地假站抓不到任何请求。
//   2) content.js 的诊断预览：正式版只在状态栏显示前 500 字，测试版显示全文，好让假站把整份报告回传给验证脚本。
const fs = require('fs');
const path = require('path');

function patch(rel, from, to, label) {
  const p = path.join(__dirname, 'e2e-build', 'src', rel);
  const s = fs.readFileSync(p, 'utf8');
  if (s.indexOf(from) === -1) {
    console.error('[' + label + '] 没找到目标写法，' + rel + ' 变了，请同步改这个补丁');
    process.exit(1);
  }
  fs.writeFileSync(p, s.replace(from, to));
  console.log('[' + label + '] 已打补丁');
}

patch('capture.js', '/deepseek\\.com$/', '/(?:deepseek\\.com$|127\\.0\\.0\\.1$|localhost$)/', '主机过滤放开 127.0.0.1');
patch('content.js', 'text.slice(0, 500)', 'text', '诊断报告输出全文');
