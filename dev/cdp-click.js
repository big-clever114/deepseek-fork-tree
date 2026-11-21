// 用真实鼠标事件（CDP Input.dispatchMouseEvent）驱动抽屉，专门抓"合成 el.click() 抓不到的那类失效"。
// 背景：画布 pointerdown 里 setPointerCapture 会把后续 click 重定向到捕获元素上，
// 卡片自己的 click 监听就收不到了 —— 而 mock.html 里的演示是 el.click()，永远看不见这个问题。
// 用法：node dev/cdp-click.js [url]      默认 dev/mock.html?branch=1
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EDGE = fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const PORT = parseInt(process.env.DST_CDP_PORT, 10) || 9343;   // 9333 已被别的 Electron 程序占用，别硬抢
const SHOT_SUFFIX = process.env.DST_SHOT_SUFFIX || '';
const target = process.argv[2] || ('file:///' + ROOT.replace(/\\/g, '/') + '/dev/mock.html?branch=1');
const profile = path.join(ROOT, 'dev', 'cdp-profile');

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
    } catch (e) { /* Edge 还没起来 */ }
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
  async function mouse(type, x, y, button) {
    await send('Input.dispatchMouseEvent', {
      type: type, x: x, y: y, button: type === 'mouseMoved' ? 'none' : (button || 'left'),
      clickCount: type === 'mouseReleased' ? 1 : (type === 'mousePressed' ? 1 : 0),
      buttons: type === 'mouseReleased' ? 0 : (type === 'mouseMoved' ? 1 : 1)
    });
  }
  // 一次真实点击：按下→抬起，浏览器自己走命中测试和 click 重定向
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
    for (let i = 1; i <= 5; i++) { await mouse('mouseMoved', x0 + dx * i / 5, y0 + dy * i / 5); await sleep(30); }
    await mouse('mouseReleased', x0 + dx, y0 + dy);
  }
  async function realRightClick(sel) {
    const b = await box(sel);
    if (!b) throw new Error('找不到元素 ' + sel);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'right', buttons: 2, clickCount: 1 });
    await sleep(40);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'right', buttons: 0, clickCount: 1 });
    return b;
  }
  async function realClickPoint(x, y) {
    await mouse('mousePressed', x, y);
    await sleep(60);
    await mouse('mouseReleased', x, y);
  }
  const detailOpen = '(function(){var d=document.querySelector("#dst-host .dst-detail");return d&&getComputedStyle(d).display!=="none";})()';
  const transform = '(function(){return document.querySelector("#dst-host .dst-inner").style.transform;})()';
  const status = '(function(){var s=document.querySelector("#dst-host .dst-status");return s?s.textContent:"";})()';

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.bringToFront');
  await sleep(3500);   // 等抽屉建好、数据喂进来
  // 0.1.14 起抽屉默认折叠：先点右侧标签展开，再按原流程测面板
  await evl('(function(){var t=document.querySelector("#dst-host .dst-tab");if(t&&!t.classList.contains("is-hidden"))t.click();})()');
  await sleep(500);

  // 事件探针：记住每个手势真正的 target，以及浏览器有没有中途把这次拖动改成原生行为。
  // setPointerCapture 之后 click 会被"改嫁"到捕获元素上；原生文字选择会抛出 pointercancel ——
  // 这两类失效都只有真鼠标事件才暴露，mock 里的 el.click() 合成事件永远看不见。
  await evl('window.__ev=[];(function(){function cn(e){return typeof e.className==="string"?e.className:(e.getAttribute?e.getAttribute("class")||"":"");}' +
    '["pointerdown","pointerup","pointercancel","gotpointercapture","lostpointercapture","selectstart","click"].forEach(function(t){' +
    'document.addEventListener(t,function(ev){var c=ev.target.closest?ev.target.closest("#dst-host .dst-card"):null;' +
    'window.__ev.push(t+"→"+(ev.target.id||cn(ev.target).split(" ")[0]||ev.target.tagName)+(c?"[卡"+c.dataset.id+"]":""));},true);});})();');
  async function drain() {
    const v = await evl('(function(){var a=window.__ev;window.__ev=[];return a.join(" | ")+" · 选中文字"+window.getSelection().toString().length+"字";})()');
    return v || '(一个事件都没收到)';
  }
  function pan(s) {                       // 'translate(-1304.5px, -234px) scale(1)' → {x,y}
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(s || '');
    return m ? { x: +m[1], y: +m[2] } : null;
  }

  const out = [];
  out.push('页面 ' + await evl('JSON.stringify({url:location.href.slice(-28),w:innerWidth,h:innerHeight,host:!!document.getElementById("dst-host"),cards:document.querySelectorAll("#dst-host .dst-card").length,canvas:(function(){var b=document.querySelector("#dst-host .dst-canvas");return b?JSON.stringify({l:Math.round(b.getBoundingClientRect().left),t:Math.round(b.getBoundingClientRect().top),w:Math.round(b.getBoundingClientRect().width),h:Math.round(b.getBoundingClientRect().height)}):null;})()})'));

  // ⓪ 对照组：真鼠标点画布之外的「放大」按钮。它不在 canvas 里、不受 setPointerCapture 影响。
  //    这一条成立，才说明 CDP 的鼠标事件确实进了页面，后面卡片点不动才是产品的问题。
  const zb = await box('#dst-host .dst-zoom .dst-btn:last-child');
  const zBefore = await evl('(function(){return document.querySelector("#dst-host .dst-zlabel").textContent;})()');
  if (zb) {
    await mouse('mousePressed', zb.x, zb.y);
    await sleep(60);
    await mouse('mouseReleased', zb.x, zb.y);
    await sleep(250);
  }
  const zAfter = await evl('(function(){return document.querySelector("#dst-host .dst-zlabel").textContent;})()');
  out.push('⓪ 对照组（画布外的放大按钮 ' + (zb ? '位置 ' + Math.round(zb.x) + ',' + Math.round(zb.y) : '找不到') + '）：' +
    zBefore + ' → ' + zAfter + ' ⇒ 真鼠标事件' + (zBefore !== zAfter ? '能送达页面' : '根本没送达，别再怀疑产品'));
  // 顺手把缩放还原，别影响后面的坐标
  if (zBefore !== zAfter) { await realClick('#dst-host .dst-zoom .dst-btn:first-child'); await sleep(250); }

  // 画布是会平移/缩放的，只有落在画布矩形里的卡片才点得到；先挑一张在视野内的
  const pick = await evl('(function(){' +
    'var cv=document.querySelector("#dst-host .dst-canvas").getBoundingClientRect();' +
    'var cs=document.querySelectorAll("#dst-host .dst-card");' +
    'for(var i=0;i<cs.length;i++){var b=cs[i].getBoundingClientRect();' +
    'if(b.left>cv.left+4&&b.right<cv.right-4&&b.top>cv.top+4&&b.bottom<cv.bottom-4)' +
    'return {sel:"#dst-host .dst-card[data-id=\\""+cs[i].dataset.id+"\\"]",id:cs[i].dataset.id,x:b.left+b.width/2,y:b.top+b.height/2};}' +
    'return null;})()');
  if (!pick) { out.push('视野里没有完整可见的卡片'); console.log(out.join('\n')); ws.close(); child.kill(); fs.rmSync(profile, { recursive: true, force: true }); return; }
  const CARD = pick && pick.sel;
  out.push('选中卡片 ' + (pick ? pick.id + ' 位置 ' + Math.round(pick.x) + ',' + Math.round(pick.y) : '(无)'));

  // ① 真鼠标点节点 → 详情面板该开
  await evl('window.__ev=[]');
  await realClick(CARD);
  await sleep(400);
  out.push('① 真鼠标点节点后详情面板打开 = ' + await evl(detailOpen) + '（该为 true）');
  out.push('   事件轨迹：' + await drain());

  // ② 按住节点本体拖动 → 该平移满 100,60，而且不能被当成"点节点"（面板不该开）
  await evl('document.querySelector("#dst-host .dst-detail").style.display="none"');   // 先收掉面板，后面才看得出"点开了没有"
  const cb = await box(CARD);
  const p0 = pan(await evl(transform));
  await evl('window.__ev=[]');
  await realDrag(cb.x, cb.y, 100, 60);
  await sleep(250);
  const p1 = pan(await evl(transform));
  out.push('② 按住节点拖动：平移 ' + JSON.stringify(p0) + ' → ' + JSON.stringify(p1) +
    '，实际移动 ' + (p0 && p1 ? Math.round(p1.x - p0.x) + ',' + Math.round(p1.y - p0.y) : '?') + '（该 ≈ 100,60）');
  out.push('   拖完详情面板开着 = ' + await evl(detailOpen) + '（该为 false：拖动不算点击）');
  out.push('   事件轨迹：' + await drain());

  // ③ 拖动之后世界位移了，按新位置再点一次 → 该正常打开（不能因为上一回拖过就被吞）
  await evl('window.__ev=[]');
  await realClick(CARD);
  await sleep(350);
  out.push('③ 拖动后按新位置再点节点，详情面板打开 = ' + await evl(detailOpen) + '（该为 true）');
  out.push('   事件轨迹：' + await drain());

  // ④ 真鼠标点详情底部的「切到这一版」→ 该让网站跳到这条分支
  const footInfo = await evl('(function(){var bs=document.querySelectorAll("#dst-host .dst-detail-foot .dst-btn");' +
    'for(var i=0;i<bs.length;i++){if(bs[i].textContent==="切到这一版"){var b=bs[i].getBoundingClientRect();' +
    'return {第几个:i+1,x:b.left+b.width/2,y:b.top+b.height/2};}}return null;})()');
  out.push('④ 「切到这一版」按钮 = ' + JSON.stringify(footInfo));
  if (footInfo) {
    await mouse('mousePressed', footInfo.x, footInfo.y);
    await sleep(60);
    await mouse('mouseReleased', footInfo.x, footInfo.y);
    await sleep(2600);
    out.push('   点完状态条：' + await evl(status));
    out.push('   页面上这条线：' + await evl('Array.prototype.map.call(document.querySelectorAll("#chat .ds-markdown"),function(e){return e.dataset.slot;}).join(" → ")'));
  }

  const lineSel = 'Array.prototype.map.call(document.querySelectorAll("#chat .ds-markdown"),function(e){return e.dataset.slot;}).join(" → ")';
  const pagerLabel = 'Array.prototype.map.call(document.querySelectorAll("#chat .pager span"),function(e){return e.textContent;}).join(",")';
  function inviewOf(id) {
    return evl('(function(){var c=document.querySelector(\'#dst-host .dst-card[data-id="' + id + '"]\');' +
      'if(!c)return null;var cv=document.querySelector("#dst-host .dst-canvas").getBoundingClientRect();' +
      'var b=c.getBoundingClientRect();' +
      'return {x:b.left+b.width/2,y:b.top+b.height/2,inview:b.left>cv.left+4&&b.right<cv.right-4&&b.top>cv.top+4&&b.bottom<cv.bottom-4};})()');
  }
  // 画布里找一块没有卡片、也没有详情面板的空白处起手拖动。
  // .dst-detail 是 inset:0 的整层覆盖，不收起它下面根本找不到空白点。
  async function blankSpot() {
    return await evl('(function(){var cv=document.querySelector("#dst-host .dst-canvas").getBoundingClientRect();' +
      'for(var y=cv.top+8;y<cv.bottom-8;y+=10){for(var x=cv.left+8;x<cv.right-8;x+=10){var e=document.elementFromPoint(x,y);' +
      'if(e&&!e.closest("#dst-host .dst-card")&&!e.closest("#dst-host .dst-detail"))return {x:x,y:y};}}return null;})()');
  }
  async function footBtnBox() {
    return await evl('(function(){var bs=document.querySelectorAll("#dst-host .dst-detail-foot .dst-btn");' +
      'for(var i=0;i<bs.length;i++){if(bs[i].textContent==="切到这一版"){var b=bs[i].getBoundingClientRect();' +
      'return {x:b.left+b.width/2,y:b.top+b.height/2};}}return null;})()');
  }
  async function clickFootBtn(b) {
    if (!b) return;
    await mouse('mousePressed', b.x, b.y);
    await sleep(60);
    await mouse('mouseReleased', b.x, b.y);
  }
  // 真鼠标点不到画面外的卡片：按住画布空白处，把目标卡片往画布中心拖
  async function bringIntoView(id, tries, stepX, stepY) {
    await evl('document.querySelector("#dst-host .dst-detail").style.display="none"');
    let v = await inviewOf(id);
    const cvCenter = '(function(){var c=document.querySelector("#dst-host .dst-canvas").getBoundingClientRect();return {x:c.left+c.width/2,y:c.top+c.height/2};})()';
    for (let zi = 0; zi < tries && v && !v.inview; zi++) {
      const sp = await blankSpot();
      if (!sp) break;
      const cvb = await evl(cvCenter);
      await realDrag(sp.x, sp.y,
        Math.round(Math.max(-stepX, Math.min(stepX, cvb.x - v.x))),
        Math.round(Math.max(-stepY, Math.min(stepY, cvb.y - v.y))));
      await sleep(150);
      v = await inviewOf(id);
    }
    return v;
  }

  // ④½ 旧版分支：真鼠标点一条「旧版」节点 → 点「切到这一版」→ 页面整条线该换过去。
  //    这个跳转此前只用 mock 里的合成点击验过，而这正是合成点击会掩盖的那类失效。
  await evl('document.querySelector("#dst-host .dst-detail").style.display="none"');
  let jumped = false;
  for (var k = 0; k < 8 && !jumped; k++) {
    const t = await evl('(function(){var cs=document.querySelectorAll("#dst-host .dst-card.is-hiddenver");' +
      'if(!cs.length)return {none:true};var cv=document.querySelector("#dst-host .dst-canvas").getBoundingClientRect();' +
      'for(var i=0;i<cs.length;i++){var b=cs[i].getBoundingClientRect();' +
      'if(b.left>cv.left+4&&b.right<cv.right-4&&b.top>cv.top+4&&b.bottom<cv.bottom-4)' +
      'return {ready:true,id:cs[i].dataset.id,x:b.left+b.width/2,y:b.top+b.height/2};}' +
      'var b0=cs[0].getBoundingClientRect();' +
      'return {id:cs[0].dataset.id,dx:Math.round(Math.max(-170,Math.min(170,(cv.left+cv.width/2)-(b0.left+b0.width/2)))),' +
      'dy:Math.round(Math.max(-130,Math.min(130,(cv.top+cv.height/2)-(b0.top+b0.height/2))))};})()');
    if (t.none) { out.push('④½ 树上没有「旧版」节点可点（这条 mock 数据没标出旧版）'); break; }
    if (t.ready) {
      const lineBefore = await evl(lineSel);
      await realClick('#dst-host .dst-card[data-id="' + t.id + '"]');
      await sleep(400);
      const opened = await evl(detailOpen);
      const fb = await footBtnBox();
      out.push('④½ 真鼠标点旧版节点 ' + t.id + '：详情面板打开 = ' + opened + '，「切到这一版」按钮 ' + (fb ? '在' : '不在'));
      if (opened && fb) {
        await clickFootBtn(fb);
        await sleep(3200);
        out.push('   跳转前这条线：' + lineBefore);
        out.push('   跳转后这条线：' + await evl(lineSel));
        out.push('   状态条：' + await evl(status));
        jumped = true;
      } else {
        out.push('   事件轨迹：' + await drain());
      }
      break;
    }
    const sp = await blankSpot();
    if (!sp) { out.push('④½ 画布里找不到空白处起手拖动'); break; }
    await realDrag(sp.x, sp.y, t.dx, t.dy);
    await sleep(120);
  }
  if (!jumped) out.push('④½ 没能拖出旧版节点');

  // ⑤ 同一处 3 版 + 跨轮：此时页面停在 a2a 那条线，点 a3v1 要先把 u2 从 a 版切回 b 版、
  //    再把 a3 从 3/3 退到 1/3 —— 验多轮多步循环，也验「上一处切完才重新渲染出下一处」。
  let v1 = await bringIntoView('a3v1', 8, 240, 140);
  if (v1 && v1.inview) {
    const beforeLine = await evl(lineSel);
    const beforeLabel = await evl(pagerLabel);
    await realClick('#dst-host .dst-card[data-id="a3v1"]');
    await sleep(400);
    const fb2 = await footBtnBox();
    if (fb2) { await clickFootBtn(fb2); await sleep(4200); }
    out.push('⑤ 点第 1 版 a3v1：翻页器 ' + beforeLabel + ' → ' + await evl(pagerLabel) +
      '；页面这条线 ' + beforeLine + ' → ' + await evl(lineSel));
    out.push('   状态条：' + await evl(status) + '（按钮 ' + (fb2 ? '在' : '不在') + '）');
    out.push('   DOM 探针：' + await evl('JSON.stringify({msg:document.querySelectorAll("#chat .msg").length,md:document.querySelectorAll("#chat .ds-markdown").length,a3v1Hidden:!!document.querySelector(\'#dst-host .dst-card[data-id="a3v1"].is-hiddenver\'),a3v3Hidden:!!document.querySelector(\'#dst-host .dst-card[data-id="a3v3"].is-hiddenver\'),hint:document.getElementById("hint").textContent.slice(0,160)})'));
  } else {
    const dbg = await evl('(function(){var ids=Array.prototype.map.call(document.querySelectorAll("#dst-host .dst-card"),function(c){return c.dataset.id;});' +
      'var c=document.querySelector(\'#dst-host .dst-card[data-id="a3v1"]\');var cv=document.querySelector("#dst-host .dst-canvas").getBoundingClientRect();' +
      'return {ids:ids,has:!!c,rect:c?[Math.round(c.getBoundingClientRect().left),Math.round(c.getBoundingClientRect().top)]:null,canvas:[Math.round(cv.left),Math.round(cv.top),Math.round(cv.width),Math.round(cv.height)]};})()');
    out.push('⑤ a3v1 不在视野：' + JSON.stringify(dbg));
  }

  // ⑥ 右键菜单：真鼠标右键卡片 → 四项菜单 → 复制分支路径 → 置灰规则 → 滚轮/Esc 关闭
  await evl('document.querySelector("#dst-host .dst-detail").style.display="none"');
  await evl('window.__COPY__=null;try{navigator.clipboard.writeText=function(t){window.__COPY__=t;return Promise.resolve();};}catch(e){Object.defineProperty(navigator,"clipboard",{value:{writeText:function(t){window.__COPY__=t;return Promise.resolve();}},configurable:true});}');
  const menuState = '(function(){var m=document.querySelector("#dst-host .dst-menu");if(!m||getComputedStyle(m).display==="none")return null;' +
    'return {items:Array.prototype.map.call(m.querySelectorAll(".dst-menu-item"),function(b){return {t:b.textContent,d:b.disabled};}),' +
    'rect:[Math.round(m.getBoundingClientRect().left),Math.round(m.getBoundingClientRect().top)]};})()';
  const v3 = await bringIntoView('a3v3', 8, 240, 140);
  if (v3 && v3.inview) {
    await realRightClick('#dst-host .dst-card[data-id="a3v3"]');
    await sleep(200);
    out.push('⑥ 右键 a3v3：' + JSON.stringify(await evl(menuState)));
    const pb = await evl('(function(){var bs=document.querySelectorAll("#dst-host .dst-menu-item");' +
      'for(var i=0;i<bs.length;i++){if(bs[i].textContent==="复制分支路径"){var b=bs[i].getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};}}return null;})()');
    if (pb) {
      await realClickPoint(pb.x, pb.y);
      await sleep(300);
      out.push('   复制分支路径 → ' + JSON.stringify(await evl('window.__COPY__')) + '；状态条：' + await evl(status));
    }
    await bringIntoView('a3v1', 8, 240, 140);
    await realRightClick('#dst-host .dst-card[data-id="a3v1"]');
    await sleep(200);
    out.push('   右键 a3v1（当前显示版）：' + await evl('(function(){var bs=document.querySelectorAll("#dst-host .dst-menu-item");' +
      'return Array.prototype.map.call(bs,function(b){return b.textContent+":"+(b.disabled?"置灰":"可用");}).join(" / ");})()'));
    const vb = await box('#dst-host .dst-card[data-id="a3v1"]');
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vb.x, y: vb.y, deltaX: 0, deltaY: -120 });
    await sleep(150);
    out.push('   滚轮后菜单：' + await evl('(function(){var m=document.querySelector("#dst-host .dst-menu");return getComputedStyle(m).display;})()'));
    await realRightClick('#dst-host .dst-card[data-id="a3v1"]');
    await sleep(150);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(150);
    out.push('   Esc 后菜单：' + await evl('(function(){var m=document.querySelector("#dst-host .dst-menu");return getComputedStyle(m).display;})()'));
  } else {
    out.push('⑥ a3v3 不在视野，跳过右键菜单验证');
  }

  // 留图：右键菜单打开态 + 真鼠标点开的详情面板
  await realRightClick('#dst-host .dst-card[data-id="a3v1"]');
  await sleep(200);
  const shotMenu = path.join(ROOT, 'dev', 'shot-cdp-menu' + SHOT_SUFFIX + '.png');
  const imgMenu = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotMenu, Buffer.from(imgMenu.data, 'base64'));
  out.push('⑦ 截图（右键菜单）：' + shotMenu + ' ' + fs.statSync(shotMenu).size + ' 字节');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await realClick('#dst-host .dst-card[data-id="a3v1"]');
  await sleep(300);
  const shot = path.join(ROOT, 'dev', 'shot-cdp-realclick' + SHOT_SUFFIX + '.png');
  const img = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shot, Buffer.from(img.data, 'base64'));
  out.push('⑧ 截图（真鼠标点开的详情面板）：' + shot + ' ' + fs.statSync(shot).size + ' 字节');

  console.log(out.join('\n'));
  ws.close(); child.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); }
  catch (e) { console.log('（临时 profile 目录 ' + profile + ' 没能删掉：' + e.code + '，Edge 还占着，手工删即可）'); }
}

main().catch(function (e) { console.error('失败：' + e.message); process.exit(1); });
