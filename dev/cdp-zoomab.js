// 小缩放 A/B 取证：同一份页面、同一个缩放值，先按现在的代码拍一张，
// 再在运行时把 0.1.8 的画布装扮（定死 22px 网点 + 照旧画文字）打回去拍一张。
// 只改内存里的样式，不落盘，不动产品代码。用法：node dev/cdp-zoomab.js [缩放%] [big=N]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EDGE = fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  : 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
const PORT = parseInt(process.env.DST_CDP_PORT, 10) || 9344;
const TO = process.argv[2] || '5';
const BIG = process.argv[3] || 'big=20';
const url = 'file:///' + ROOT.replace(/\\/g, '/') + '/dev/mock.html?branch=1&' + BIG + '&demo=zoom&to=' + TO;
const profile = path.join(ROOT, 'dev', 'cdp-ab-profile');
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
  // 0.1.14 起抽屉默认折叠：先展开再截画布
  await evl('(function(){var t=document.querySelector("#dst-host .dst-tab");if(t&&!t.classList.contains("is-hidden"))t.click();})()');
  await sleep(500);

  async function canvasBox() {
    return JSON.parse(await evl('(function(){var c=document.querySelector("#dst-host .dst-canvas").getBoundingClientRect();' +
      'return JSON.stringify([Math.round(c.left),Math.round(c.top),Math.round(c.width),Math.round(c.height)]);})()'));
  }
  async function shoot(file, box) {
    const p = path.join(ROOT, 'dev', file);
    const img = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: box[0], y: box[1], width: box[2], height: box[3], scale: 1 }
    });
    fs.writeFileSync(p, Buffer.from(img.data, 'base64'));
    console.log('  dev/' + file + ' ' + fs.statSync(p).size + ' 字节');
  }
  function stats(tag) {
    return evl(`(function(){var cv=document.querySelector("#dst-host .dst-canvas");
      var cs=document.querySelectorAll("#dst-host .dst-card");var cb=cv.getBoundingClientRect();
      var off=0,sub=0;for(var i=0;i<cs.length;i++){var b=cs[i].getBoundingClientRect();
      if(b.right<cb.left||b.left>cb.right||b.bottom<cb.top||b.top>cb.bottom)off++;
      if(b.width<2||b.height<2)sub++;}
      var g=getComputedStyle(cv);var m=(g.backgroundSize||'').split(' ');
      return JSON.stringify({label:document.querySelector("#dst-host .dst-zlabel").textContent,
        grid:m[0]+'×'+(m[1]||''),img:g.backgroundImage.slice(0,46),off:off,sub:sub,n:cs.length,
        dotPx:(function(){var v=g.backgroundImage.match(/([\\d.]+)px/g);return v?v.join(','):'';})()});})()`)
      .then(function (s) { const o = JSON.parse(s); console.log(tag + ' 缩放 ' + o.label + '｜网点周期 ' + o.grid +
        '｜圆点停止位 ' + o.dotPx + '｜网点图 ' + o.img + '｜' + o.n + ' 张卡：画布外 ' + o.off + '，不足 2px ' + o.sub); });
  }

  let box = await canvasBox();
  await stats('现在（0.1.9）');
  await shoot('shot-zoom5-after.png', box);

  // 把 0.1.8 的画布装扮打回去：网点定死 22px、圆点固定 1px、文字照旧画
  await evl(`(function(){var cv=document.querySelector("#dst-host .dst-canvas");
    var inn=document.querySelector("#dst-host .dst-inner");
    cv.style.backgroundImage='radial-gradient(circle, var(--dst-grid) 1px, transparent 1.4px)';
    cv.style.backgroundSize='22px 22px';cv.style.backgroundPosition='0px 0px';
    inn.classList.remove('is-mini');return 1;})()`);
  await sleep(400);
  await stats('改回 0.1.8 装扮');
  await shoot('shot-zoom5-before.png', await canvasBox());

  ws.close(); child.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { console.log('（临时目录没删掉：' + e.code + '）'); }
})().catch(function (e) { console.error('失败：' + e.message); process.exit(1); });
