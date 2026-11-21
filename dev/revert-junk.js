// 一次性脚本：把 dev/e2e-build 里的判据退回第四轮修复之前的宽松版本，用来在真扩展链路上复现"树里长出别的对话的消息"。
// 只改构建副本，dev/e2e-build.sh 每次会从 src/ 重新生成，不碰源码。
const fs = require('fs');
const p = 'dev/e2e-build/src/model.js';
let s = fs.readFileSync(p, 'utf8');
const marker = 'if (hasKey(o, PARENT_KEYS)) return true;';
const loose = [
  "var role2 = pick(o, ['role', 'message_type', 'sender', 'type']);",
  "var t2 = '';",
  'for (var ti = 0; ti < TEXT_KEYS.length; ti++) { t2 = toPlainText(o[TEXT_KEYS[ti]]); if (t2) break; }',
  'return !!(role2 || t2);'
].join('\n    ');
if (s.indexOf(marker) < 0) { console.error('MARKER NOT FOUND：源码判据已改，这个复现脚本要跟着更新'); process.exit(1); }
s = s.replace(marker, loose);
s = s.replace("var ROLE_KEYS = ['role', 'message_type', 'sender'];", "var ROLE_KEYS = ['role', 'message_type', 'sender', 'type'];");
// 只退判据还不够：新加的 settle() 兜底会把脏节点清掉，得一起关掉才是修复前的行为
s = s.replace('function isChatNode(n) {', 'function isChatNode(n) { return true; /* 退回修复前：不清理 */');
fs.writeFileSync(p, s);
console.log('已把构建副本退回旧判据 + 关掉清理（源码未动）');
