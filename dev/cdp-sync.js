// 「同步本页」去重验证：连点两次同步、再给气泡加上渲染差异（思考提示），节点数都不该变。
// 用法：node dev/cdp-sync.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EDGE = fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const PORT = parseInt(process.env.DST_CDP_PORT, 10) || 9346;
const target = 'file:///' + ROOT.replace(/\\/g, '/') + '/dev/mock.html';
const profile = path.join(ROOT, 'dev', 'cdp-sync-profile');

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function main() {
  fs.rmSync(profile, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1920,900', '--force-device-scale-factor=1',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, target
  ], { stdio: 'ignore' });

  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find(function (t) { return t.type === 'page' && /mock\.html/.test(t.url); });
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch (e) {}
  }
  if (!ws) { child.kill(); throw new Error('连不上 CDP'); }
  await new Promise(function (r, j) { ws.onopen = r; ws.onerror = j; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = function (ev) {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  function send(method, params) {
    const id = ++seq;
    return new Promise(function (resolve, reject) {
      pending.set(id, function (m) { m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result); });
      ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }
  async function evl(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常：' + JSON.stringify(r.exceptionDetails.text));
    return r.result.value;
  }
  async function realClick(sel) {
    const b = await evl('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');' +
      'if(!e)return null;var b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};})()');
    if (!b) throw new Error('找不到元素 ' + sel);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0 });
  }

  const cards = '(function(){return document.querySelectorAll("#dst-host .dst-card").length;})()';
  const stats = '(function(){var s=document.querySelector("#dst-host .dst-stats");return s?s.textContent:"";})()';

  await send('Runtime.enable');
  await send('Page.enable');
  for (let i = 0; i < 40; i++) {
    const n = await evl(cards);
    if (n > 0) break;
    await sleep(300);
  }

  // 0.1.14 起抽屉默认折叠：同步按钮在面板里，先展开
  await evl('(function(){var t=document.querySelector("#dst-host .dst-tab");if(t&&!t.classList.contains("is-hidden"))t.click();})()');
  await sleep(500);

  const base = { cards: await evl(cards), stats: await evl(stats) };
  console.log('初始：' + JSON.stringify(base));

  await realClick('#dst-host button[data-act="sync"]');
  await sleep(1200);
  const after1 = { cards: await evl(cards), stats: await evl(stats) };
  console.log('第一次点「同步本页」后：' + JSON.stringify(after1) + '（节点数该不变）');

  // 模拟线上差异：渲染后多一行「已深度思考（用时…）」+ 底部按钮文字
  await evl('(function(){var bs=document.querySelectorAll(".ds-markdown");' +
    'for(var i=0;i<bs.length;i++){if(bs[i].textContent.length>80){' +
    'var t=document.createElement("div");t.textContent="已深度思考（用时 3 秒）";' +
    'bs[i].insertBefore(t,bs[i].firstChild);' +
    'var f=document.createElement("div");f.textContent="复制 重新生成";bs[i].appendChild(f);return true;}}return false;})()');
  await realClick('#dst-host button[data-act="sync"]');
  await sleep(1200);
  const after2 = { cards: await evl(cards), stats: await evl(stats) };
  console.log('给气泡加渲染差异后再同步：' + JSON.stringify(after2) + '（节点数该仍不变）');

  const pass = after1.cards === base.cards && after2.cards === base.cards;
  console.log('结论：' + (pass ? 'PASS —— 同一条消息没有被重复收进树' : 'FAIL —— 节点数从 ' + base.cards + ' 变成了 ' + after2.cards));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(ROOT, 'dev', 'shot-sync.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('截图：' + out);
  ws.close();
  child.kill();
  if (!pass) process.exitCode = 1;
}

main().catch(function (e) { console.error('失败：' + e.message); process.exit(1); });
