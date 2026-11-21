// 端到端验证用的本地假站。刻意 1:1 复刻 2026-10-31 线上诊断实测到的五个坑：
//   1) 页面自己带 cache_version 请求 history_messages → 只回几百字节的「缓存已最新」桩，biz_data.chat_messages 是空数组；
//   2) 气泡数据来自 /cached-copy.json（冒充浏览器 IndexedDB 副本，不在 /api/ 下，劫持层看不见）；
//   3) 页面记录下来的那次历史请求，URL 里的会话 ID 是**上一条对话**的 —— 复刻「重抓抓到别的会话」；
//   4) 没有 Authorization 头就当成未登录，返回空的 biz_data —— 复刻「必须复用页面自己的鉴权头」;
//   5) /api/v0/client/settings 回一堆 {id:number, type:'REQUEST', content:'提示词模板'} 的配置项 ——
//      复刻第四轮线上事故：宽判据把配置读成消息，id 还和真实 message_id 撞号，树里长出别的对话的分支。
// 只有去掉缓存参数、带 show_all=true、且会话 ID 换成当前对话、且带上鉴权头的那一次，才会拿到全量历史。
// 另外 /api/v0/chat/regenerate 回 text/event-stream，用来验流式摄取那条路。
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8123;
const load = function (name) {
  return new Function(fs.readFileSync(path.join(__dirname, 'fixture.js'), 'utf8') + '; return ' + name + ';')();
};
const LIVE = load('FIXTURE_LIVE');
const SSE = load('FIXTURE_SSE');
const SETTINGS = load('FIXTURE_SETTINGS');
const CHAT_ID = 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff';   // 假页 URL 里的当前对话
const STALE_ID = '79d6eb2e-df9f-4f0c-be3c-e0d31a17ec2d';  // 页面最后一次发历史请求用的（上一条对话）

function envelope(messages, sessionId) {
  const j = JSON.parse(JSON.stringify(LIVE));
  j.data.biz_data.chat_messages = messages;
  j.data.biz_data.chat_session.id = sessionId;
  j.data.biz_data.chat_session.current_message_id = messages.length ? messages[messages.length - 1].message_id : 0;
  return JSON.stringify(j);
}

function fullMessages() {
  return LIVE.data.biz_data.chat_messages;
}

http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const auth = req.headers.authorization || '';
  console.log(new Date().toISOString().slice(11, 23), req.method, req.url, auth ? '[auth ' + auth.length + ']' : '[no auth]');

  if (u.pathname === '/e2e-page.html' || u.pathname.indexOf('/chain/') === 0) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'e2e-page.html')));
    return;
  }
  if (u.pathname === '/report' && req.method === 'POST') {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      fs.writeFileSync(path.join(__dirname, 'e2e-diag.json'), body);
      console.log('  ↳ 诊断报告已存 dev/e2e-diag.json（' + body.length + ' 字）');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    return;
  }
  if (u.pathname === '/cached-copy.json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(envelope(fullMessages(), CHAT_ID));
    return;
  }
  if (u.pathname === '/api/v0/chat/regenerate' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(SSE);
    return;
  }
  if (u.pathname === '/api/v0/client/settings') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(SETTINGS));
    return;
  }
  if (u.pathname.indexOf('/api/') === 0) {
    const asked = u.searchParams.get('chat_session_id') || '';
    const wantsAll = u.searchParams.get('show_all') === 'true' || !u.searchParams.has('cache_version');
    let payload;
    if (!auth) payload = envelope([], asked);                                   // 没鉴权头 = 未登录，给空历史
    else if (asked !== CHAT_ID) payload = envelope([], asked);                  // 会话 ID 不对 = 那条对话没有内容
    else if (!wantsAll) payload = envelope([], asked);                          // 命中客户端缓存 = 几百字节的桩
    else payload = envelope(fullMessages(), asked);                             // 这才是插件要的那一次
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(payload);
    return;
  }
  res.writeHead(404);
  res.end('not found');
}).listen(PORT, '127.0.0.1', function () { console.log('e2e server http://127.0.0.1:' + PORT + '/chain/' + CHAT_ID); });
