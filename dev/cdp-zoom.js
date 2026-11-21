// 小缩放取证：真滚轮缩到指定百分比，然后把画布那块区域**放大截图**，
// 看清"缩到 5% 以下时画面上到底是什么"。用法：node dev/cdp-zoom.js [目标%] [big=N] [放大倍数]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EDGE = fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const PORT = parseInt(process.env.DST_CDP_PORT, 10) || 9334;
const TO = process.argv[2] || '5';
const BIG = process.argv[3] || 'big=120';
const MAG = parseFloat(process.argv[4] || '6');
const url = 'file:///' + ROOT.replace(/\\/g, '/') + '/dev/mock.html?branch=1&' + BIG + '&demo=zoom&to=' + TO;
const profile = path.join(ROOT, 'dev', 'cdp-zoom-profile');
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function main() {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1920,900', '--force-device-scale-factor=1',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, url
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

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(4000);
  // 0.1.14 起抽屉默认折叠：先展开，量到的画布才在屏幕里
  await evl('(function(){var t=document.querySelector("#dst-host .dst-tab");if(t&&!t.classList.contains("is-hidden"))t.click();})()');
  await sleep(500);

  async function measure() {
    const geo = await evl('(function(){var h=document.getElementById("dst-host");' +
      'var cv=document.querySelector("#dst-host .dst-canvas");' +
      'var cs=document.querySelectorAll("#dst-host .dst-card");' +
      'var cb=cv.getBoundingClientRect(),u=null,off=0,vis=0;' +
      'for(var i=0;i<cs.length;i++){var b=cs[i].getBoundingClientRect();' +
      'if(b.right<cb.left||b.left>cb.right||b.bottom<cb.top||b.top>cb.bottom)off++;else vis++;' +
      'if(!u)u={l:b.left,t:b.top,r:b.right,b:b.bottom};' +
      'u.l=Math.min(u.l,b.left);u.t=Math.min(u.t,b.top);u.r=Math.max(u.r,b.right);u.b=Math.max(u.b,b.bottom);}' +
      'var st=document.querySelector("#dst-host .dst-status").getBoundingClientRect();' +
      'var hd=document.querySelector("#dst-host .dst-panel").getBoundingClientRect();' +
      'return JSON.stringify({label:document.querySelector("#dst-host .dst-zlabel").textContent,' +
      'grid:cv.style.backgroundSize||getComputedStyle(cv).backgroundSize,' +
      'mini:document.querySelector("#dst-host .dst-inner").classList.contains("is-mini"),' +
      'canvas:[Math.round(cb.left),Math.round(cb.top),Math.round(cb.width),Math.round(cb.height)],' +
      'tree:[Math.round(u.r-u.l),Math.round(u.b-u.t)],treeAt:[Math.round(u.l),Math.round(u.t)],' +
      'cards:cs.length,outside:off,inside:vis,' +
      'header:[Math.round(hd.left),Math.round(hd.top),Math.round(hd.width),Math.round(hd.height)],' +
      'statusTop:Math.round(st.top),hostBottom:Math.round(h.getBoundingClientRect().bottom),' +
      'inner:document.querySelector("#dst-host .dst-inner").style.transform});})()');
    return JSON.parse(geo);
  }

  function report(tag, g) {
    console.log(tag + ' 缩放 ' + g.label + '｜网点 ' + g.grid + (g.mini ? '｜文字已隐' : '｜文字仍画') +
      '｜画布 ' + g.canvas.join(',') + '｜树占位 ' + g.tree.join('×') + ' @' + g.treeAt.join(','));
    console.log('    卡片 ' + g.cards + ' 张：在画布内 ' + g.inside + '，完全在画布外 ' + g.outside);
    console.log('    抽屉表头 ' + g.header.join(',') + '｜状态条 top=' + g.statusTop + ' 抽屉底=' + g.hostBottom + '（窗口高 900）');
    console.log('    transform=' + g.inner);
  }

  async function shoot(name, box, scale) {
    const p = path.join(ROOT, 'dev', name);
    const img = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: box[0], y: box[1], width: box[2], height: box[3], scale: scale }
    });
    fs.writeFileSync(p, Buffer.from(img.data, 'base64'));
    console.log('    截图 dev/' + name + ' ' + fs.statSync(p).size + ' 字节');
  }

  let g = await measure();
  report('①滚到目标', g);
  await shoot('tmp-zoomfull-' + TO.replace(/\./g, '_') + '.png', g.canvas, 1);

  // ② 继续往下滚到滚不动为止：验证"大树也能看到全景"
  await evl(`(function(){var cv=document.querySelector("#dst-host .dst-canvas");
    var lab=document.querySelector("#dst-host .dst-zlabel");
    var r=cv.getBoundingClientRect();
    var cx=r.left+r.width/2, cy=r.top+r.height/2;
    var prev=Infinity,n=0;
    while(n++<600){var cur=parseFloat(lab.textContent);
      if(cur>=prev-0.0001)break;prev=cur;
      cv.dispatchEvent(new WheelEvent("wheel",{deltaY:100,clientX:cx,clientY:cy,bubbles:true,cancelable:true}));}
    return n;})()`);
  await sleep(300);
  g = await measure();
  report('②滚到下限', g);
  await shoot('tmp-zoomfloor-' + BIG.replace(/[^a-z0-9]/gi, '') + '.png', g.canvas, 1);

  // 放大截图：只拍画布正中一块，MAG 倍
  const shot = 'tmp-zoommag-' + TO.replace(/\./g, '_') + '.png';
  const w = Math.round(g.canvas[2] / 2.2), h = Math.round(g.canvas[3] / 2.2);
  await shoot(shot, [g.canvas[0] + (g.canvas[2] - w) / 2, g.canvas[1] + (g.canvas[3] - h) / 2, w, h], MAG);

  ws.close(); child.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { console.log('（临时目录没删掉：' + e.code + '）'); }
})().catch(function (e) { console.error('失败：' + e.message); process.exit(1); });
