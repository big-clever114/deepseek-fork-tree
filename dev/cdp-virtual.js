// 线上形态复刻的端到端验证：页面只渲染 6 个气泡，目标旧版在第 2 轮（要往上滚才会加载）。
// 用真鼠标点抽屉里的旧版节点 → 「切到这一版」→ 期望插件自己滚出历史、找到翻页器、把整条线切过去。
// 用法：node dev/cdp-virtual.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EDGE = fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const PORT = parseInt(process.env.DST_CDP_PORT, 10) || 9345;
const target = process.argv[2] || ('file:///' + ROOT.replace(/\\/g, '/') + '/dev/mock-virtual.html');
const profile = path.join(ROOT, 'dev', 'cdp-virtual-profile');

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
      const page = list.find(function (t) { return t.type === 'page' && /mock-virtual\.html/.test(t.url); });
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
  async function box(sel) {
    return await evl('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');' +
      'if(!e)return null;var b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,w:b.width,h:b.height};})()');
  }
  async function mouse(type, x, y) {
    await send('Input.dispatchMouseEvent', {
      type: type, x: x, y: y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseReleased' ? 1 : (type === 'mousePressed' ? 1 : 0),
      buttons: type === 'mouseReleased' ? 0 : 1
    });
  }
  async function realClick(sel) {
    const b = await box(sel);
    if (!b) throw new Error('找不到元素 ' + sel);
    await mouse('mousePressed', b.x, b.y);
    await sleep(60);
    await mouse('mouseReleased', b.x, b.y);
    return b;
  }
  async function realClickPoint(x, y) {
    await mouse('mousePressed', x, y);
    await sleep(60);
    await mouse('mouseReleased', x, y);
  }
  const status = '(function(){var s=document.querySelector("#dst-host .dst-status");return s?s.textContent:"";})()';
  const detailOpen = '(function(){var d=document.querySelector("#dst-host .dst-detail");return d&&getComputedStyle(d).display!=="none";})()';

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.bringToFront');
  await sleep(3200);
  // 0.1.14 起抽屉默认折叠：先点右侧标签展开，再跑原流程
  await evl('(function(){var t=document.querySelector("#dst-host .dst-tab");if(t&&!t.classList.contains("is-hidden"))t.click();})()');
  await sleep(500);

  const out = [];
  out.push('页面：' + await evl('JSON.stringify({host:!!document.getElementById("dst-host"),cards:document.querySelectorAll("#dst-host .dst-card").length,virt:window.__VIRT__,bubbles:window.__BUBBLES__().length})'));

  // 平移不是本次被测行为，直接对画布派发指针序列，避免"画布被卡片铺满找不到空白起手点"
  async function panCanvas(dx, dy) {
    await evl('(function(){var cv=document.querySelector("#dst-host .dst-canvas");' +
      'var r=cv.getBoundingClientRect();var x=r.left+r.width/2,y=r.top+r.height/2;' +
      'function pe(t,px,py){cv.dispatchEvent(new PointerEvent(t,{pointerId:7,pointerType:"mouse",button:0,' +
      'buttons:t==="pointerup"?0:1,clientX:px,clientY:py,bubbles:true,cancelable:true}));}' +
      'pe("pointerdown",x,y);pe("pointermove",x+' + Math.round(dx / 2) + ',y+' + Math.round(dy / 2) + ');' +
      'pe("pointermove",x+' + Math.round(dx) + ',y+' + Math.round(dy) + ');pe("pointerup",x+' + Math.round(dx) + ',y+' + Math.round(dy) + ');})()');
    await sleep(60);
  }
  async function inviewOf(id) {
    return await evl('(function(){var c=document.querySelector(\'#dst-host .dst-card[data-id="' + id + '"]\');' +
      'if(!c)return null;var cv=document.querySelector("#dst-host .dst-canvas").getBoundingClientRect();' +
      'var b=c.getBoundingClientRect();' +
      'return {x:b.left+b.width/2,y:b.top+b.height/2,inview:b.left>cv.left+4&&b.right<cv.right-4&&b.top>cv.top+4&&b.bottom<cv.bottom-4};})()');
  }
  async function bringIntoView(id, tries, stepX, stepY) {
    await evl('document.querySelector("#dst-host .dst-detail").style.display="none"');
    let v = await inviewOf(id);
    for (let zi = 0; zi < tries && v && !v.inview; zi++) {
      const cvb = await evl('(function(){var c=document.querySelector("#dst-host .dst-canvas").getBoundingClientRect();return {x:c.left+c.width/2,y:c.top+c.height/2};})()');
      await panCanvas(
        Math.round(Math.max(-stepX, Math.min(stepX, cvb.x - v.x))),
        Math.round(Math.max(-stepY, Math.min(stepY, cvb.y - v.y))));
      v = await inviewOf(id);
    }
    return v;
  }
  async function footBtnBox() {
    return await evl('(function(){var bs=document.querySelectorAll("#dst-host .dst-detail-foot .dst-btn");' +
      'for(var i=0;i<bs.length;i++){if(bs[i].textContent==="切到这一版"){var b=bs[i].getBoundingClientRect();' +
      'return {x:b.left+b.width/2,y:b.top+b.height/2};}}return null;})()');
  }

  // ⓪ 确认初始真的只有 6 个气泡，而且第 2 轮不在窗口里
  out.push('初始：' + await evl('JSON.stringify({line:window.__LINE__(),virt:window.__VIRT__,bubbles:window.__BUBBLES__().length,' +
    'hasA2:window.__BUBBLES__().some(function(t){return t.indexOf("第 2 轮回答")>=0;})})'));

  // ① 真鼠标点旧版节点 1021（a2v1）
  const v = await bringIntoView('1021', 24, 400, 400);
  out.push('旧版节点 1021 在视野里 = ' + (v ? v.inview : '找不到卡片'));
  if (!v || !v.inview) {
    out.push('无法把 1021 拖进视野，测试中止');
    console.log(out.join('\n'));
    ws.close(); child.kill();
    return;
  }
  await realClick('#dst-host .dst-card[data-id="1021"]');
  await sleep(400);
  out.push('点节点后详情面板打开 = ' + await evl(detailOpen) + '（该为 true）');
  const fb = await footBtnBox();
  out.push('「切到这一版」按钮 = ' + (fb ? '在 ' + Math.round(fb.x) + ',' + Math.round(fb.y) : '不在'));
  if (!fb) {
    console.log(out.join('\n'));
    ws.close(); child.kill();
    return;
  }

  // ② 点它 → 插件应该先往上滚加载历史，再找翻页器切换
  await realClickPoint(fb.x, fb.y);
  let st = '', line = '', virt = null;
  for (let i = 0; i < 24; i++) {
    await sleep(700);
    st = await evl(status);
    line = await evl('window.__LINE__()');
    virt = await evl('window.__VIRT__');
    if (/已跳到这条分支|切到第 .* 处时停了|页面上没找到这一版/.test(st)) break;
  }
  out.push('② 状态条：' + st);
  out.push('   页面这条线：' + line + '（目标 110,111,120,1021）');
  out.push('   虚拟列表：' + JSON.stringify(virt));
  out.push('   当前渲染的气泡：' + JSON.stringify(await evl('window.__BUBBLES__()')));
  out.push('   树上的旧版标记：' + await evl('JSON.stringify({a2v1:!!document.querySelector(\'#dst-host .dst-card[data-id="1021"].is-hiddenver\'),a2v2:!!document.querySelector(\'#dst-host .dst-card[data-id="1022"].is-hiddenver\')})'));

  const ok = /已跳到这条分支/.test(st) && /^110,111,120,1021$/.test(line) && virt && virt.loads > 0;
  out.push('结论：' + (ok ? 'PASS —— 滚动加载历史 + 翻页器切换都成立' : 'FAIL'));

  const shot = path.join(ROOT, 'dev', 'shot-virtual.png');
  const img = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shot, Buffer.from(img.data, 'base64'));
  out.push('截图：' + shot + ' ' + fs.statSync(shot).size + ' 字节');

  console.log(out.join('\n'));
  ws.close(); child.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}

main().catch(function (e) { console.error('失败：' + e.message); process.exit(1); });
