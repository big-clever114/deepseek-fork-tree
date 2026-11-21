// 抽屉外壳四项行为验证（0.1.14）：
// ① 进页面默认折叠  ② 折叠时左边缘的拖拽热区失效（不会在页面中间"抓空气"）
// ③ 右侧折叠标签能贴着屏幕右边缘上下拖  ④ 展开时把页面挤到左边，并且能切回原来的浮层
// 用法：node dev/cdp-shell.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EDGE = fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const PORT = parseInt(process.env.DST_CDP_PORT, 10) || 9347;
const target = 'file:///' + ROOT.replace(/\\/g, '/') + '/dev/mock.html';
const profile = path.join(ROOT, 'dev', 'cdp-shell-profile');

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
  async function realDrag(x0, y0, dx, dy) {
    await mouse('mousePressed', x0, y0);
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', x0 + dx * i / 6, y0 + dy * i / 6); await sleep(30); }
    await mouse('mouseReleased', x0 + dx, y0 + dy);
  }

  const state = `(function(){
    var host=document.getElementById('dst-host');
    if(!host)return null;
    var p=host.querySelector('.dst-panel'), t=host.querySelector('.dst-tab'), g=host.querySelector('.dst-grip');
    var pr=p.getBoundingClientRect(), tr=t.getBoundingClientRect(), gr=g.getBoundingClientRect();
    var mb=host.querySelector('[data-act="mode"]');
    return {open:p.classList.contains('is-open'), tabHidden:t.classList.contains('is-hidden'),
      panelLeft:Math.round(pr.left), tabTop:Math.round(tr.top),
      gripPE:getComputedStyle(g).pointerEvents,
      gripX:Math.round(gr.left+gr.width/2), gripY:Math.round(gr.top+gr.height/2),
      htmlMargin:getComputedStyle(document.documentElement).marginRight,
      hostW:Math.round(host.getBoundingClientRect().width),
      modeLabel:mb?mb.textContent.trim():'', vw:innerWidth};
  })()`;
  const hitAt = function (x, y) {
    return `(function(){var h=document.getElementById('dst-host');var e=document.elementFromPoint(${x},${y});` +
      `return e?{tag:e.tagName,cls:(typeof e.className==='string'?e.className:''),inHost:h.contains(e)}:null;})()`;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.bringToFront');

  // file:// 页面没有 chrome.storage（真实扩展里才有）。这里用 localStorage 做一个同语义的替身，
  // 才能在 mock 上验证「刷新后还记得标签位置 / 铺开方式」。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: '(function(){var NS="__dstshim__:";' +
      'window.chrome=window.chrome||{};' +
      'window.chrome.runtime=window.chrome.runtime||{lastError:null,onMessage:{addListener:function(){},removeListener:function(){}}};' +
      'window.chrome.storage=window.chrome.storage||{local:{' +
      'get:function(keys,cb){var out={};if(keys===null||keys===undefined){' +
      'for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k.indexOf(NS)===0){try{out[k.slice(NS.length)]=JSON.parse(localStorage.getItem(k));}catch(e){}}}}' +
      'else{(Array.isArray(keys)?keys:[keys]).forEach(function(k){var v=localStorage.getItem(NS+k);if(v!==null){try{out[k]=JSON.parse(v);}catch(e){}}});}' +
      'setTimeout(function(){cb&&cb(out);},0);},' +
      'set:function(o,cb){Object.keys(o).forEach(function(k){localStorage.setItem(NS+k,JSON.stringify(o[k]));});setTimeout(function(){cb&&cb();},0);},' +
      'remove:function(keys,cb){(Array.isArray(keys)?keys:[keys]).forEach(function(k){localStorage.removeItem(NS+k);});setTimeout(function(){cb&&cb();},0);}' +
      '}};})();'
  });
  await send('Page.reload');
  await sleep(3400);

  const out = [];
  let fail = 0;
  function check(name, ok, detail) {
    out.push((ok ? '  PASS ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
    if (!ok) fail++;
  }

  // ① 默认折叠
  const s0 = await evl(state);
  out.push('① 进页面默认状态：' + JSON.stringify(s0));
  check('默认折叠（面板没展开）', s0.open === false);
  check('折叠标签可见', s0.tabHidden === false);
  check('未展开时页面没有被挤（margin-right 0）', parseFloat(s0.htmlMargin) === 0, s0.htmlMargin);

  // ② 折叠时拖拽热区失效
  const hit = await evl(hitAt(s0.gripX, s0.gripY));
  out.push('② 折叠时左边缘点 ' + s0.gripX + ',' + s0.gripY + ' 命中：' + JSON.stringify(hit));
  check('拖拽条 pointer-events:none', s0.gripPE === 'none', s0.gripPE);
  check('那一点落到底下的页面而不是抽屉', !!hit && hit.inHost === false, JSON.stringify(hit));
  await realDrag(s0.gripX, s0.gripY, -140, 0);
  await sleep(300);
  const s0b = await evl(state);
  check('折叠时按住左边缘拖不会改宽度', s0b.hostW === s0.hostW, s0.hostW + ' → ' + s0b.hostW);
  check('折叠时按住左边缘拖不会展开', s0b.open === false);

  // ③ 标签贴着右边缘上下拖
  const tb = await box('#dst-host .dst-tab');
  await realDrag(tb.x, tb.y, 0, 170);
  await sleep(300);
  const s1 = await evl(state);
  const dy = s1.tabTop - s0.tabTop;
  out.push('③ 标签拖动后 top：' + s0.tabTop + ' → ' + s1.tabTop + '（Δ' + dy + '）');
  check('标签跟着鼠标往下走了约 170px', Math.abs(dy - 170) <= 12, 'Δ' + dy);
  check('拖标签不会顺手把抽屉打开', s1.open === false);
  check('标签仍在屏幕内', s1.tabTop > 0 && s1.tabTop < 900 - 40, 'top=' + s1.tabTop);

  // 拖完再正常点一下标签 → 打开
  await realClick('#dst-host .dst-tab');
  await sleep(400);
  const s2 = await evl(state);
  out.push('③b 点标签展开：' + JSON.stringify({ open: s2.open, modeLabel: s2.modeLabel, htmlMargin: s2.htmlMargin, hostW: s2.hostW }));
  check('点标签能展开', s2.open === true);
  check('默认是「挤开」模式', s2.modeLabel === '挤开', s2.modeLabel);

  // ④ 挤开 vs 浮层
  check('挤开时页面收窄的宽度 = 抽屉宽度', Math.abs(parseFloat(s2.htmlMargin) - s2.hostW) <= 1, s2.htmlMargin + ' vs ' + s2.hostW);
  await realClick('#dst-host [data-act="mode"]');
  await sleep(400);
  const s3 = await evl(state);
  out.push('④ 切到浮层：' + JSON.stringify({ open: s3.open, modeLabel: s3.modeLabel, htmlMargin: s3.htmlMargin }));
  check('切到「浮层」后页面恢复原宽', parseFloat(s3.htmlMargin) === 0, s3.htmlMargin);
  check('切模式不会收起抽屉', s3.open === true);
  await realClick('#dst-host [data-act="mode"]');
  await sleep(400);
  const s4 = await evl(state);
  check('再切回「挤开」页面又被挤开', Math.abs(parseFloat(s4.htmlMargin) - s4.hostW) <= 1, s4.htmlMargin);

  // 收起 → 页面恢复
  await realClick('#dst-host [data-act="close"]');
  await sleep(400);
  const s5 = await evl(state);
  out.push('⑤ 收起后：' + JSON.stringify({ open: s5.open, htmlMargin: s5.htmlMargin, tabHidden: s5.tabHidden }));
  check('收起后页面宽度恢复', parseFloat(s5.htmlMargin) === 0, s5.htmlMargin);
  check('收起后标签重新出现', s5.tabHidden === false);

  // ⑦ 模拟线上会话页：整屏根层 + 根层内部再套一层 fixed;inset:0（根层收窄了，里面这层仍按视口算）
  await evl('(function(){var k=document.getElementById("chat");k.style.position="fixed";' +
    'k.style.inset="0";k.style.width="100vw";k.style.height="100vh";' +
    'var d=document.createElement("div");d.id="dst-test-inner";' +
    'd.style.cssText="position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;";k.appendChild(d);})()');
  await realClick('#dst-host .dst-tab');
  await sleep(500);
  const s5b = await evl('(function(){var k=document.getElementById("chat");var c=getComputedStyle(k);' +
    'var inner=document.getElementById("dst-test-inner");' +
    'return {rootW:Math.round(k.getBoundingClientRect().width),innerW:Math.round(inner.getBoundingClientRect().width),' +
    'vw:innerWidth,cw:document.documentElement.clientWidth,maxW:c.maxWidth,pad:c.paddingLeft+' + "'/'" + '+c.paddingRight,' +
    'hostW:Math.round(document.getElementById("dst-host").getBoundingClientRect().width)};})()');
  out.push('⑦ 模拟线上整屏根层 + 内层 fixed：' + JSON.stringify(s5b));
  check('整屏根层被收到抽屉左边', Math.abs(s5b.rootW - (s5b.vw - s5b.hostW)) <= 2, s5b.rootW + ' vs ' + (s5b.vw - s5b.hostW));
  check('根层内部再套的 fixed;inset:0 也被收口', Math.abs(s5b.innerW - (s5b.vw - s5b.hostW)) <= 2, s5b.innerW + ' vs ' + (s5b.vw - s5b.hostW));
  await realClick('#dst-host [data-act="close"]');
  await sleep(300);

  // ⑥ 刷新后：仍然默认折叠，且记住标签位置 / 铺开方式
  await send('Page.reload');
  await sleep(3400);
  const s6 = await evl(state);
  out.push('⑥ 刷新后：' + JSON.stringify(s6));
  check('刷新后仍然默认折叠', s6 && s6.open === false);
  check('刷新后标签位置被记住', s6 && Math.abs(s6.tabTop - s5.tabTop) <= 14, (s6 ? s6.tabTop : '?') + ' vs ' + s5.tabTop);
  check('刷新后铺开方式被记住（挤开）', s6 && s6.modeLabel === '挤开', s6 && s6.modeLabel);

  await realClick('#dst-host .dst-tab');
  await sleep(400);
  const s7 = await evl(state);
  check('刷新后展开仍然挤开页面', Math.abs(parseFloat(s7.htmlMargin) - s7.hostW) <= 1, s7.htmlMargin);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(ROOT, 'dev', 'shot-shell.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  out.push('截图：' + file);

  console.log(out.join('\n'));
  console.log(fail ? ('结论：FAIL —— ' + fail + ' 项不成立') : '结论：PASS —— 四项行为都成立');
  ws.close();
  child.kill();
  if (fail) process.exitCode = 1;
}

main().catch(function (e) { console.error('失败：' + e.message); process.exit(1); });
