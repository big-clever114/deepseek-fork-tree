(function () {
  'use strict';
  if (window.__DST_CONTENT__) return;
  window.__DST_CONTENT__ = true;

  var DST = window.__DST__;
  var STORE = 'dst:chat:';
  // 线上实测有 698 条消息的会话：400 条会把最早的历史截掉，断链后树里会冒出「父节点不在本次返回里」的分组
  var MAX_NODES = 1000;
  var MAX_TEXT = 6000;

  var state = {
    chatId: null,
    nodes: [],
    token: null,
    lastUrls: [],
    parseErrors: [],
    captureHits: 0,
    fieldHints: null,
    shapes: {},
    candidates: {},
    fragTypes: {},
    currentMessageId: null,
    origin: '',
    // 页面自己这次 history 请求到底给没给消息（给的是几百字节的缓存空包时不算）
    gotHistoryApi: false
  };

  var drawer = DST.drawer.create({
    onLocate: locate,
    onReveal: reveal,
    onRefetch: refetch,
    onSync: syncFromDom,
    onDiag: diagnostics
  });
  document.documentElement.appendChild(drawer.host);

  // ---------- 工具 ----------
  function norm(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function obj(k, v) { var o = {}; o[k] = v; return o; }
  function apiPath(u) { var m = /\/api\/[^?\s]*/.exec(u || ''); return m ? m[0] : ''; }
  function extVersion() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; }
  }
  function chatIdFromUrl(u) { var m = /[?&](?:chat_session_id|chat_id|cid|session_id)=([0-9a-zA-Z_-]{6,})/.exec(u || ''); return m ? m[1] : null; }
  function chatIdFromPage() {
    var m = location.pathname.match(/\/(?:chain|s|c)\/([0-9a-zA-Z_-]{6,})/);
    return m ? m[1] : null;
  }

  function serialize(n, textCap, reasonCap) {
    return {
      id: n.id, parentId: n.parentId || '', role: n.role,
      text: String(n.text || '').slice(0, textCap || MAX_TEXT),
      reasoning: String(n.reasoning || '').slice(0, reasonCap || 2000),
      ts: n.ts || 0, hidden: n.hidden === undefined ? null : n.hidden,
      hiddenSrc: n.hiddenSrc || '', source: n.source || 'api'
    };
  }

  function cachePayload(textCap, reasonCap, cap) {
    var list = state.nodes.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); })
      .slice(0, cap).map(function (n) { return serialize(n, textCap, reasonCap); });
    return { chatId: state.chatId, updatedAt: Date.now(), nodes: list };
  }

  function setCache(payload, next) {
    try {
      chrome.storage.local.set(obj(STORE + state.chatId, payload), function () {
        // 配额错误不会同步抛出，只在 lastError 里；不读它就会静默地一直存不进去
        var err = chrome.runtime.lastError;
        if (err) next(String(err.message || err));
      });
    } catch (e) { next(String((e && e.message) || e)); }
  }

  // 别的会话的缓存只是兜底，配额不够时先让它们腾地方
  function pruneOtherChats(keepKey, cb) {
    try {
      chrome.storage.local.get(null, function (all) {
        var keys = Object.keys(all || {}).filter(function (k) {
          return k.indexOf(STORE) === 0 && k !== keepKey;
        });
        if (!keys.length) { cb(); return; }
        keys.sort(function (a, b) {
          return ((all[a] && all[a].updatedAt) || 0) - ((all[b] && all[b].updatedAt) || 0);
        });
        try { chrome.storage.local.remove(keys.slice(0, Math.max(1, keys.length - 2)), function () { cb(); }); }
        catch (e) { cb(); }
      });
    } catch (e) { cb(); }
  }

  function save() {
    if (!state.chatId) return;
    var key = STORE + state.chatId;
    // 逐级降级：整份 → 清别的会话后再试 → 只存正文前 2000 字（保住结构）→ 只留最近 300 条
    setCache(cachePayload(MAX_TEXT, 2000, MAX_NODES), function (err) {
      // 不是配额问题（比如扩展上下文失效）就别动别的会话
      if (!/quota/i.test(err || '')) return;
      pruneOtherChats(key, function () {
        setCache(cachePayload(MAX_TEXT, 2000, MAX_NODES), function () {
          setCache(cachePayload(2000, 400, MAX_NODES), function () {
            setCache(cachePayload(MAX_TEXT, 2000, 300), function () {});
          });
        });
      });
    });
  }

  function render() {
    drawer.load({ nodes: state.nodes, chatId: state.chatId, statusBase: statusBase() });
  }
  function statusBase() {
    var head = state.chatId ? ('会话 ' + state.chatId.slice(0, 10) + '…') : '未识别会话';
    var src = state.origin ? ('来源：' + state.origin) : '来源：暂无';
    return head + ' · ' + src + ' · 拦截到 ' + state.captureHits + ' 个接口返回。点节点看全文。';
  }

  function addNodes(incoming, chatId, origin) {
    var cid = chatId || state.chatId;
    if (!cid) return;
    if (cid !== state.chatId) {
      // SPA 里切了会话：不能把两条对话的消息并成一棵树
      state.nodes = [];
      state.chatId = cid;
      state.gotHistoryApi = false;
    }
    state.nodes = DST.model.merge(state.nodes, incoming);
    state.origin = origin || state.origin;
    settle();
    save();
    render();
  }

  // 每次数据变化后统一收口：剔除混进来的非消息节点，再按当前指针重算「哪条是旧版」
  function settle() {
    var before = state.nodes.length;
    state.nodes = state.nodes.filter(DST.model.isChatNode);
    if (state.nodes.length !== before) state.pruned = (state.pruned || 0) + (before - state.nodes.length);
    DST.model.markActiveChain(state.nodes, state.currentMessageId);
  }

  // ---------- 接收注入层抓到的数据 ----------
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__dst !== 1 || d.channel !== '__dst_capture__' || !d.rec) return;
    handle(d.rec);
  });

  // 一份接口/流式返回 → 记结构证据 + 能认出的节点就并进树
  function absorb(text, key, originTag, cid, status) {
    var ing = DST.model.ingest(text);
    if (ing.error) { state.parseErrors.push(ing.error + ' @' + key); return 0; }
    var payload = ing.payload;
    state.shapes[key] = { bytes: text.length, status: status, nodes: ing.nodes.length, lines: (DST.model.shape(payload) || []).slice(0, 110) };
    state.candidates[key] = DST.model.candidates(payload) || [];
    state.currentMessageId = ing.currentMessageId || state.currentMessageId;
    if (ing.nodes.length && /history_messages/.test(key)) state.gotHistoryApi = true;
    if (ing.nodes.length) {
      // fragment 类型直方图只在确认是对话返回时统计，否则配置项的 type 会混进来
      countFragTypes(payload);
      state.fieldHints = ing.nodes[0].fieldHints;
      addNodes(ing.nodes, cid || ing.chatId || state.chatId, originTag || key);
    }
    return ing.nodes.length;
  }

  // 线上正文藏在 fragments[] 里，靠 type 区分「回答正文 / 思考链 / 检索引用」。
  // 诊断只报这些类型标签本身（形如 text、reasoning_content），不含块内容。
  function countFragTypes(payload) {
    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 8) return;
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) walk(node[i], depth + 1);
        return;
      }
      if (typeof node.type === 'string' && /^[a-z][a-z0-9_]{0,28}$/i.test(node.type) &&
        (node.content !== undefined || node.text !== undefined)) {
        state.fragTypes = state.fragTypes || {};
        state.fragTypes[node.type] = (state.fragTypes[node.type] || 0) + 1;
        return;
      }
      for (var k in node) { if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k], depth + 1); }
    })(payload, 0);
  }

  // 流式返回（重新生成 / 编辑重发 / 正常回答）：整包里就是刚诞生的那一版，字段名最真实
  function absorbSse(body, key, status) {
    var parts = DST.model.ssePayloads(body);
    state.sseChunks = (state.sseChunks || 0) + parts.length;
    if (!parts.length) return 0;
    var text = JSON.stringify(parts);
    var n = absorb(text, key + ' [sse]', '流式 ' + key, state.chatId, status);
    if (!n) state.parseErrors.push('SSE 拆出 ' + parts.length + ' 段但没认出消息 @' + key);
    return n;
  }

  function handle(rec) {
    state.captureHits = rec.hits || state.captureHits;
    var path = apiPath(rec.url) || rec.url;
    state.lastUrls.unshift({ url: path, method: rec.method, status: rec.status, kind: rec.kind, bytes: (rec.body || '').length, nodes: 0, at: rec.at });
    state.lastUrls = state.lastUrls.slice(0, 25);

    if (rec.kind === 'token') { if (rec.token) state.token = rec.token; return; }
    if (rec.kind === 'diag') {
      state.captureStats = rec.stats;
      state.storageKeys = rec.storageKeys;
      state.authHeaderNames = rec.authHeaderNames;
      state.pageHasToken = rec.hasToken;
      state.lastHistoryUrl = rec.lastHistoryUrl;
      return;
    }
    if (rec.kind === 'refetch-fail') {
      drawer.setStatus('重新抓取失败：' + rec.reason + '\n→ 说明注入层没能复用页面自己的历史请求，请把「诊断」内容发我。');
      return;
    }
    if (rec.kind === 'stream') {
      var hint = null;
      try { hint = JSON.parse(rec.reqBody || '{}'); } catch (e) {}
      state.lastPrompt = hint && (hint.parent_message_id || hint.parentId) ? { parentId: String(hint.parent_message_id || hint.parentId), at: rec.at } : state.lastPrompt;
      return;
    }
    if (!rec.body) return;

    var n = rec.kind === 'sse'
      ? absorbSse(rec.body, path, rec.status)
      : absorb(rec.body, path + ' [' + rec.kind + ']', path, chatIdFromUrl(rec.url), rec.status);
    var entry = state.lastUrls.filter(function (r) { return r.url === path && r.at === rec.at; })[0];
    if (entry) entry.nodes = n;
    if (rec.kind === 'refetch') {
      drawer.setStatus(n
        ? ('重新抓取成功：认出 ' + n + ' 条消息（HTTP ' + rec.status + '、' + rec.body.length + ' 字节）。')
        : ('重新抓取拿到 HTTP ' + rec.status + '、' + rec.body.length + ' 字节，但认不出消息结构。点「诊断」把内容发我——报告里已带上真实字段清单。'));
    }
  }

  function askPage(msg) { try { window.postMessage(msg, '*'); } catch (e) {} }
  askPage({ __dstCmd: 'token' });

  // ---------- 本地缓存恢复 + SPA 切会话 ----------
  var lastHref = location.href;
  function restore() {
    var cid = chatIdFromPage();
    if (!cid) { render(); return; }
    if (cid === state.chatId) return;
    state.chatId = cid;
    state.nodes = [];
    state.gotHistoryApi = false;
    try {
      chrome.storage.local.get(STORE + cid, function (r) {
        var e = r && r[STORE + cid];
        if (!e || !e.nodes || !e.nodes.length) return;
        state.nodes = e.nodes;
        settle();
        if (state.pruned) save();   // 老版本污染进来的节点，这次一并从本地存储清掉
        state.origin = '本地缓存 ' + new Date(e.updatedAt).toLocaleString();
        render();
      });
    } catch (e) {}
  }
  restore();
  setInterval(function () {
    if (location.href !== lastHref) { lastHref = location.href; restore(); }
    if (!drawer.host.parentElement || !drawer.host.parentElement.contains(drawer.host)) document.documentElement.appendChild(drawer.host);
    applyTheme();
  }, 900);
  var autoRefetched = {};
  setTimeout(function () {
    // 不能拿「本地缓存里有没有节点」当条件：缓存一恢复 nodes 就非空，自动重抓会永远不再触发，
    // 页面自己那次 history 命中缓存空包时树就一直停在旧缓存上（多设备新增的消息看不到）
    if (!state.chatId || autoRefetched[state.chatId] || state.gotHistoryApi) return;
    autoRefetched[state.chatId] = true;
    // 线上实测：页面自己那次 history_messages 常常命中客户端缓存、只回几百字节。
    // 所以不用等用户点，页面加载后自动去掉缓存参数重抓一次。
    refetch();
  }, 3500);

  function applyTheme() {
    var dark = false;
    try {
      var cls = document.documentElement.className + ' ' + document.body.className;
      if (/\bdark\b|theme-dark|dark-mode/i.test(cls)) dark = true;
      if (!dark) {
        var bg = getComputedStyle(document.body).backgroundColor || getComputedStyle(document.documentElement).backgroundColor;
        var m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(bg || '');
        if (m) dark = (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 < 110;
      }
    } catch (e) {}
    drawer.host.classList.toggle('dst-dark', dark);
  }
  applyTheme();

  // ---------- 主动抓取（交给页面上下文去做，好复用 DeepSeek 自己的鉴权头）----------
  function refetch() {
    if (!state.chatId) { drawer.setStatus('还没识别到会话 ID：先在网页里点开一条对话。'); return; }
    drawer.setStatus('正在用页面自己的鉴权信息重新请求完整历史（去掉缓存参数、要全量版本）…');
    askPage({ __dstCmd: 'refetch', chatId: state.chatId });
    setTimeout(function () {
      if (!state.nodes.length) drawer.setStatus('重新抓取没回数据。点「诊断」把内容发我——里面会带上真实接口结构，我照着改。');
    }, 4000);
  }

  // ---------- 页面气泡扫描 ----------
  // 线上实测（诊断）：一条消息 = 一个 .ds-message 容器（里面再分正文 / 思考块）。
  // 有 .ds-message 就只认它 —— 否则 [class*="message"] 会把消息列表、整轮包裹层也当气泡，
  // 整段对话被读成一条，文字前缀永远对不上。
  var BUBBLE_PRIMARY = '[class*="ds-message"],[id^="msg-container-"],[data-message-id]';
  var BUBBLE_LOOSE = '[id^="msg-container-"],[data-message-id],[class*="message-content"],[class*="chat-content"],[class*="markdown"]';

  function bubbleCandidates() {
    var primary = document.querySelectorAll(BUBBLE_PRIMARY);
    if (primary.length) return primary;
    return document.querySelectorAll(BUBBLE_LOOSE);
  }

  function domBubbles() {
    var all = [];
    var nodes = bubbleCandidates();
    for (var i = 0; i < nodes.length; i++) {
      var e = nodes[i];
      if (!e || !e.isConnected) continue;
      if (drawer.host && drawer.host.contains(e)) continue;
      var t = norm(e.innerText);
      // 不能设最短长度：线上实测有人就发一个字符（"1"、"2"）
      if (!t) continue;
      if (e.offsetHeight > 9000 || e.offsetHeight === 0) continue;
      all.push({ el: e, text: t });
    }
    // 只留最外层，避免同一条消息被拆成好几个
    return all.filter(function (a, idx) {
      return !all.some(function (b, j) { return j < idx && b.el !== a.el && b.el.contains(a.el); });
    });
  }

  function guessRole(el) {
    // 线上实测：一条消息的外层只有 ds-message + 一堆哈希 class，
    // 角色写在内层（如 ds-assistant-message-main-content），所以要连后代一起看
    var chain = '';
    var n = el;
    for (var i = 0; i < 6 && n; i++) { chain += ' ' + (n.className || '') + ' ' + (n.id || ''); n = n.parentElement; }
    if (/assistant|ds-answer|bot|reply/i.test(chain)) return 'assistant';
    if (/user|self|query|human|owner/i.test(chain)) return 'user';
    // 角色标记可能埋在很深的地方：只扫前 60 个后代会漏，直接按特征类查一次
    try {
      if (el.querySelector('[class*="assistant-message"],[class*="ds-answer"]')) return 'assistant';
      if (el.querySelector('[class*="user-message"],[class*="ds-query"]')) return 'user';
    } catch (e) {}
    return 'unknown';
  }

  function syncFromDom() {
    var bubbles = domBubbles();
    if (!bubbles.length) { drawer.setStatus('页面上没识别到消息气泡（DeepSeek 换了 DOM 结构）。'); return; }
    var tree = DST.model.buildTree(state.nodes);
    var known = {}, knownCanon = [];
    tree.ordered.forEach(function (n) {
      if (n.virtual) return;
      known[norm(n.text).slice(0, 160)] = n;
      var c = canon(n.text);
      if (c) knownCanon.push({ node: n, c: c });
    });
    var leaf = null;
    tree.ordered.forEach(function (n) { if (n.onActivePath && !n.virtual) leaf = n; });
    var added = 0, matched = 0, fresh = [];
    bubbles.forEach(function (b) {
      var key = b.text.slice(0, 160);
      if (known[key]) { matched++; return; }
      // 渲染后的文字和接口原文常有差异（markdown 符号、思考提示、按钮文字），
      // 精确前缀对不上时按规范化分数再认一次，别把同一条消息重复收进树
      var cb = canon(b.text), best = null, bestScore = 0;
      for (var i = 0; i < knownCanon.length; i++) {
        var s = scoreCanon(cb, knownCanon[i].c);
        if (s > bestScore) { bestScore = s; best = knownCanon[i].node; }
      }
      if (bestScore >= 0.86) { matched++; return; }
      var node = {
        id: 'dom:' + hash(key), parentId: leaf ? leaf.id : '', role: guessRole(b.el),
        text: b.text, reasoning: '', ts: Date.now() + added, hidden: null, source: 'dom'
      };
      known[key] = node;
      knownCanon.push({ node: node, c: cb });
      leaf = node;
      added++;
      fresh.push(node);
    });
    if (fresh.length) addNodes(fresh, state.chatId, state.origin || '页面抓取');
    drawer.setStatus('页面抓取：' + bubbles.length + ' 个气泡，' + matched + ' 个已在树里，新增 ' + added + ' 个（挂在当前对话末尾，角色按容器 class 猜，可能不准）。');
  }

  // ---------- 文字对位 ----------
  // 页面上的文字是渲染后的：markdown 符号没了、上面可能挂一行「已深度思考（用时…）」、
  // 底下挂着「复制 / 重新生成」，而节点文字是接口原文。直接前缀比对在线上会大面积落空，
  // 所以两边先规范化，再按「包含 + 最长公共前缀」打分。
  function canon(s) {
    return String(s || '')
      .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/已(?:深度)?思考[（(]用时[^）)]*[）)]/g, '')
      .replace(/已阅读\s*\d+\s*个网页/g, '')
      .replace(/已搜索到\s*\d+\s*个网页/g, '')
      .replace(/内容由\s*AI\s*生成[，,]\s*请仔细甄别/g, '')
      .replace(/[`*_~#>|]/g, '')
      .replace(/复制|重新生成|编辑|分享|引用|朗读|停止生成|继续生成/g, '')
      .replace(/\s+/g, '');
  }

  function scoreCanon(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    // 太短的正文（"1"、"好"）只能整串相等，做包含判断会把所有气泡都配上
    if (a.length < 6 || b.length < 6) return 0;
    var k = Math.min(b.length, 50);
    if (a.indexOf(b.slice(0, k)) >= 0) return b.length <= k ? 1 : 0.92;
    var n = 0, max = Math.min(a.length, b.length, 200);
    while (n < max && a.charAt(n) === b.charAt(n)) n++;
    return n / Math.min(b.length, 50);
  }

  function textScore(domText, nodeText) {
    return scoreCanon(canon(domText), canon(nodeText));
  }

  // ---------- 定位 ----------
  function findDomFor(node) {
    var byId = null;
    try {
      byId = document.querySelector('#msg-container-' + (window.CSS && CSS.escape ? CSS.escape(node.id) : node.id))
        || document.querySelector('[data-message-id="' + String(node.id).replace(/"/g, '') + '"]');
    } catch (e) {}
    if (byId) return byId;
    if (!canon(node.text)) return null;
    var bubbles = domBubbles(), best = null, bestScore = 0;
    for (var i = 0; i < bubbles.length; i++) {
      var s = textScore(bubbles[i].text, node.text);
      if (s > bestScore) { bestScore = s; best = bubbles[i]; }
    }
    return bestScore >= 0.72 ? best.el : null;
  }

  function flash(el) {
    try {
      el.style.setProperty('outline', '2px solid ' + (drawer.host.classList.contains('dst-dark') ? '#1bd96a' : '#00af5c'), 'important');
      el.style.setProperty('outline-offset', '3px', 'important');
      el.style.setProperty('transition', 'outline-color 400ms ease', 'important');
      setTimeout(function () { el.style.removeProperty('outline'); el.style.removeProperty('outline-offset'); }, 2200);
    } catch (e) {}
  }

  function locateEl(node) {
    var el = findDomFor(node);
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    flash(el);
    return el;
  }

  function locate(node) {
    var el = findDomFor(node);
    if (el) {
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
      flash(el);
      var same = sameText(el, node);
      drawer.setStatus(same ? '已定位到页面上这一版并高亮。' : '已定位到那一处气泡，但页面当前显示的是同位置的另一版（这一版没显示出来）。');
      return el;
    }
    // 线上实测：DeepSeek 只把最近几轮留在 DOM 里，更早的消息要往上滚才会加载出来
    drawer.setStatus('这一版还没在页面上渲染出来，正在往上滚加载更早的历史…');
    seek(function () { var e2 = findDomFor(node); return e2 ? { el: e2 } : null; }, function (hit) {
      if (!hit) {
        drawer.setStatus('页面上找不到这一版——它可能在更早的历史里，而 DeepSeek 目前没把它渲染出来。用「切到这一版」可以按分支切过去。');
        return;
      }
      try { hit.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
      flash(hit.el);
      var same = sameText(hit.el, node);
      drawer.setStatus(same ? '已定位到页面上这一版并高亮。' : '已定位到那一处气泡，但页面当前显示的是同位置的另一版（这一版没显示出来）。');
    }, '正在往上滚加载更早的历史');
    return null;
  }

  // ---------- 驱动 DeepSeek 自己的版本切换按钮 ----------
  // 线上 DOM 形态我没法凭空猜，所以这里按"三条互不依赖的线索"找，命中一条就用：
  // ①形如 2/3 的文字标签 + 同一行里另外两个可点元素；②标签在按钮自己肚子里；
  // ③两个带 aria-label/title 写着"上一…/下一…"的按钮（这时根本没有文字标签）。
  // 每条都要求结果仍落在**这一条消息的容器里**，否则会抓到隔壁消息的翻页器。
  var PREV_RE = /(prev|previous|before|上一|前一处|上一个|前一个)/i;
  var NEXT_RE = /(next|after|下一|后一处|下一个|后一个)/i;

  function isClickable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (/^(button|a|summary)$/i.test(el.tagName)) return true;
    if (el.getAttribute('role') === 'button') return true;
    if (/^btn|button|clickable|cursor-pointer/i.test(String(el.className || ''))) return true;
    if (el.tabIndex >= 0 && !/^(body|html)$/i.test(el.tagName)) return true;
    // 线上翻页器的箭头是普通 div、类名全是哈希，只有 cursor:pointer 这一个线索
    try { if (getComputedStyle(el).cursor === 'pointer') return true; } catch (e) {}
    return false;
  }

  function clickableSelfOrParent(el, within) {
    var n = el;
    for (var i = 0; i < 4 && n && within.contains(n); i++) {
      if (isClickable(n)) return n;
      n = n.parentElement;
    }
    return null;
  }

  function labelOf(el) {
    return String(el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-label')) || '');
  }

  // 元素自己的文字（不含后代的图标/装饰）就是 "n / m"
  function isVersionLabel(el) {
    var t = String(el.textContent || '').replace(/[\u200b\u200c\u200d]/g, '').trim();
    if (!/^\d{1,3}\s*\/\s*\d{1,3}$/.test(t)) return false;
    return t.length <= 12;
  }

  // 只留最深的那一层：外层容器的文字也可能正好是 "2/3"，不剔掉就会把一个标签数成两个
  function versionLabelsIn(root) {
    var all = root.querySelectorAll('*'), hits = [];
    for (var i = 0; i < all.length; i++) if (isVersionLabel(all[i])) hits.push(all[i]);
    return hits.filter(function (el) {
      return !hits.some(function (o) { return o !== el && el.contains(o); });
    });
  }

  // 在"只属于这一条消息"的范围里，把 n/m 标签两侧的可点元素配成上一版/下一版
  function pagerAround(label, scope) {
    // ① 同一行里的兄弟（mock 与多数实现）
    var row = label.parentElement, btns = [];
    if (row) {
      for (var j = 0; j < row.children.length; j++) {
        var c = row.children[j];
        if (c === label) continue;
        var b = clickableSelfOrParent(c, scope);
        if (b && btns.indexOf(b) < 0) btns.push(b);
      }
    }
    if (btns.length >= 2) return { prev: btns[0], next: btns[btns.length - 1], label: label, how: 'label-row' };
    // ② 标签自己被包在可点元素里（‹ 2/3 › 整颗可点）
    var self = clickableSelfOrParent(label, scope);
    if (self && self.parentElement) {
      var sib = [];
      for (var k = 0; k < self.parentElement.children.length; k++) {
        var s = self.parentElement.children[k];
        if (s === self) continue;
        var sb = clickableSelfOrParent(s, scope);
        if (sb && sib.indexOf(sb) < 0) sib.push(sb);
      }
      if (sib.length >= 2) return { prev: sib[0], next: sib[sib.length - 1], label: label, how: 'label-button-siblings' };
    }
    // ③ 结构更绕：按文档顺序取标签前后最近的可点元素
    var cands = scope.querySelectorAll('[role="button"],button,a,[tabindex]');
    var before = null, after = null;
    for (var m = 0; m < cands.length; m++) {
      var el = cands[m];
      if (el === label || label.contains(el) || el.contains(label) || !isClickable(el)) continue;
      var pos = label.compareDocumentPosition(el);
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) before = el;          // el 在标签前面
      else if ((pos & Node.DOCUMENT_POSITION_FOLLOWING) && !after) after = el;
    }
    if (before && after) return { prev: before, next: after, label: label, how: 'order' };
    // ④ 线上真实形态（诊断 pagerSample.parentClass = "_17e14c5 _6fbd7d4"）：标签两边是普通 div，
    //    没有 role / tabindex，类名是哈希，只有 cursor:pointer。在标签附近三层里扫一遍取最前 / 最后。
    var near = label.parentElement;
    for (var h = 0; h < 3 && near && near !== document.body; h++) {
      var kids = near.querySelectorAll('*'), hits = [];
      for (var q = 0; q < kids.length && q < 160; q++) {
        var kk = kids[q];
        if (kk === label || label.contains(kk) || kk.contains(label)) continue;
        if (isClickable(kk)) hits.push(kk);
      }
      hits = hits.filter(function (x) {
        return !hits.some(function (y) { return y !== x && x.contains(y); });
      });
      if (hits.length >= 2) {
        return { prev: hits[0], next: hits[hits.length - 1], label: label, how: 'near-' + h };
      }
      near = near.parentElement;
    }
    return null;
  }

  function findPager(container) {
    if (!container) return null;
    // 从气泡往上找"最近的、且只含一个版本标签"的容器。
    // 一旦某层出现第二个 n/m 标签，说明已经爬进包含多条消息的区域 —— 立刻停，
    // 否则会把隔壁消息的翻页器当成这一条的（mock 上实测就抓到过 a3v3 的 3/3）。
    var n = container;
    for (var up = 0; up < 6 && n && n !== document.body; up++) {
      var labels = versionLabelsIn(n);
      if (labels.length > 1) return null;
      if (labels.length === 1) return pagerAround(labels[0], n);
      n = n.parentElement;
    }
    // ④ 完全没有 "n/m" 文字：只在气泡自己往上 3 层内按 aria-label / title 找
    var scope = container;
    for (var hop = 0; hop < 3 && scope; hop++) {
      var cands = scope.querySelectorAll('[aria-label],[title],[data-label],[role="button"],button,a');
      var prev = null, next = null;
      for (var m = 0; m < cands.length; m++) {
        var el = cands[m];
        var lab = labelOf(el) + ' ' + String(el.textContent || '').trim();
        var click = isClickable(el) ? el : clickableSelfOrParent(el, scope);
        if (!click) continue;
        if (!prev && PREV_RE.test(lab)) prev = click;
        else if (!next && NEXT_RE.test(lab)) next = click;
      }
      if (prev && next && prev !== next) return { prev: prev, next: next, label: null, how: 'aria' };
      scope = scope.parentElement;
    }
    return null;
  }

  // 翻页器常常是悬停才挂出来的：先把指针"移"到这条消息上再找一次
  function hover(el) {
    if (!el) return;
    var r;
    try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
    var x = r ? r.left + r.width / 2 : 0, y = r ? r.top + r.height / 2 : 0;
    var P = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'].forEach(function (t) {
      try {
        el.dispatchEvent(new (t.indexOf('pointer') === 0 ? P : MouseEvent)(t, {
          bubbles: t.indexOf('enter') < 0, cancelable: true, view: window,
          clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true
        }));
      } catch (e) {}
    });
  }

  function tap(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { el.focus(); } catch (e) {}
    var r;
    try { r = el.getBoundingClientRect(); } catch (e) { r = { left: 0, top: 0, width: 0, height: 0 }; }
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    // 元素不在视口里时，合成事件的坐标会落到画面外，组件库的命中判断直接不认
    if (r.width === 0 || r.height === 0 || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      var sc = scrollableAncestor(el);
      if (sc) {
        try {
          var sb = el.getBoundingClientRect(), cb = sc.getBoundingClientRect();
          if (sc === document.scrollingElement || sc === document.documentElement || sc === document.body) {
            window.scrollBy(0, sb.top - cb.top - cb.height / 2);
          } else {
            sc.scrollTop += sb.top - cb.top - cb.height / 2;
          }
        } catch (e) {}
        try { r = el.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; } catch (e) {}
      }
    }
    var hasPointer = typeof PointerEvent === 'function';
    // 只发 MouseEvent 是不够的：组件库（Radix / Floating UI 那一类）听的是 pointerdown/pointerup，
    // 少了 pointer 事件就是"点了没反应"，而且它们会看 clientX/clientY 做命中判断。
    function fire(Tag, type, extra) {
      if (!Tag) return;
      var p = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      if (extra) for (var k in extra) p[k] = extra[k];
      try { el.dispatchEvent(new Tag(type, p)); } catch (e) {}
    }
    var P = hasPointer ? PointerEvent : null;
    var pextra = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
    fire(P, 'pointerover', pextra);
    fire(P, 'pointerenter', pextra);
    fire(P, 'pointerdown', pextra);
    fire(MouseEvent, 'mousedown', { button: 0, buttons: 1 });
    fire(P, 'pointerup', pextra);
    fire(MouseEvent, 'mouseup', { button: 0, buttons: 0 });
    fire(MouseEvent, 'click', { button: 0, buttons: 0 });
  }

  function sameText(el, node) {
    return !!el && textScore(el.innerText, node.text) >= 0.9;
  }

  // 同一处（同父同角色）共有几版，按 versionIndex 排好；只有 1 版时不需要切
  function siblingsOf(node, tree) {
    var kids = (node.parentId && tree.byId[node.parentId] ? tree.byId[node.parentId].children : tree.roots)
      .filter(function (c) { return c.role === node.role && !c.virtual; })
      .sort(function (a, b) { return (a.versionIndex || 0) - (b.versionIndex || 0); });
    return kids;
  }

  // ---------- 让页面把这一处渲染出来 ----------
  // 线上实测：22 条消息的会话，DOM 里只有最近 6 个气泡；更早的要么没加载、要么被卸载。
  // 所以「找不到气泡」不能直接判死 —— 先把消息列表往上滚，让 DeepSeek 去取更早的历史；
  // 再往下滚，因为切完分支后页面可能停在上面，下面新一轮还没渲染。
  function scrollableAncestor(el) {
    var n = el;
    for (var i = 0; i < 14 && n && n.nodeType === 1; i++) {
      var cs = null;
      try { cs = getComputedStyle(n); } catch (e) {}
      var oy = cs ? (cs.overflowY || cs.overflow) : '';
      if (/auto|scroll|overlay/i.test(oy || '') && n.scrollHeight > n.clientHeight + 24) return n;
      n = n.parentElement;
    }
    var se = document.scrollingElement || document.documentElement;
    if (se && se.scrollHeight > se.clientHeight + 24) return se;
    return null;
  }

  function scrollByDir(sc, dir) {
    try {
      var page = sc === document.scrollingElement || sc === document.documentElement || sc === document.body;
      var view = page ? (window.innerHeight || document.documentElement.clientHeight) : sc.clientHeight;
      var top = page ? (window.scrollY || document.documentElement.scrollTop || 0) : sc.scrollTop;
      var max = page
        ? Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - view
        : sc.scrollHeight - sc.clientHeight;
      // 一次跳到底/顶只够让虚拟列表加载一页；之后位置没变就再也触发不了。
      // 所以按视口高度分步滚，滚到贴边后再"顶"一下，逼列表继续取更早的历史。
      var step = Math.max(240, Math.floor((view || 600) * 0.85));
      var next = dir === 'up' ? Math.max(0, top - step) : Math.min(max, top + step);
      if (next === top) next = dir === 'up' ? 0 : max;
      if (page) window.scrollTo(0, next); else sc.scrollTop = next;
      sc.dispatchEvent(new Event('scroll'));
      // 有些实现只在滚轮事件里才去取更早的历史
      sc.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dir === 'up' ? -720 : 720, deltaMode: 0, bubbles: true, cancelable: true
      }));
    } catch (e) {}
  }

  // 虚拟滚动列表里气泡数恒为 6，但滚一下窗口里的内容会换。
  // 只比数量会把「换了一批」误判成「没滚动」，于是提前放弃 —— 这里比首尾气泡的文字。
  function bubbleSig() {
    var bs = domBubbles(), a = bs[0], b = bs[bs.length - 1];
    return bs.length + '|' + (a ? a.text.slice(0, 20) : '') + '|' + (b ? b.text.slice(-20) : '');
  }

  // 有些实现把「加载更早的消息」做成列表顶部的一个按钮，滚动不触发，得点它
  var MORE_RE = /^(加载更多|查看更多|查看更早|更早的消息|展开更多|加载更早|显示更多|load more|show more|show earlier|view earlier|earlier messages)/i;

  function loadMoreCtl(sc) {
    try {
      var els = sc.querySelectorAll('button,[role="button"],[class*="load"],[class*="more"]');
      for (var i = 0; i < els.length && i < 40; i++) {
        var t = norm(els[i].innerText || els[i].textContent);
        if (t.length <= 14 && MORE_RE.test(t)) return els[i];
      }
      // 线上不少控件是哈希类名的 div，没有 role / button：按"短文本 + 可点"再扫一遍
      var all = sc.querySelectorAll('div,span,a,p');
      for (var j = 0; j < all.length && j < 800; j++) {
        var e = all[j];
        if (e.children.length > 1) continue;
        var tx = norm(e.textContent);
        if (tx.length > 14 || !MORE_RE.test(tx)) continue;
        var ctl = isClickable(e) ? e : clickableSelfOrParent(e, sc);
        if (ctl) return ctl;
      }
    } catch (e) {}
    return null;
  }

  function seek(find, cb, note) {
    var hit = find();
    if (hit) { cb(hit); return; }
    var first = domBubbles()[0];
    var sc = scrollableAncestor(first && first.el);
    if (!sc) { cb(null); return; }
    var round = 0, stalled = 0, dir = 'up', sig = bubbleSig();
    function tick() {
      if (round++ >= 24) { cb(null); return; }
      var more = loadMoreCtl(sc);
      if (more) tap(more);
      if (note) drawer.setStatus(note + '（第 ' + round + ' 次，' + (dir === 'up' ? '往上' : '往下') + '滚）');
      scrollByDir(sc, dir);
      setTimeout(function () {
        var hit2 = find();
        if (hit2) { cb(hit2); return; }
        var now = bubbleSig();
        if (now === sig) stalled++; else { stalled = 0; sig = now; }
        if (dir === 'up' && stalled >= 4) { dir = 'down'; stalled = 0; }
        if (dir === 'down' && stalled >= 4) { cb(null); return; }
        tick();
      }, 700);
    }
    tick();
  }

  // 页面上这一处渲染的是哪一版。线上「编辑过的提问 / 重新生成的回答」文字常常只差一个结尾，
  // 所以给组里每一版都打一次分，只有「最高分明显领先第二名」才敢认定。
  function probeGroup(sibs) {
    var found = [];
    for (var i = 0; i < sibs.length; i++) {
      var el = findDomFor(sibs[i]);
      if (!el) continue;
      found.push({ node: sibs[i], el: el, score: textScore(el.innerText, sibs[i].text) });
    }
    if (!found.length) return null;
    found.sort(function (a, b) { return b.score - a.score; });
    var best = found[0], second = found[1];
    var confident = best.score >= 0.9 &&
      (!second || (second.el !== best.el && best.score - second.score >= 0.12));
    return { anchorEl: best.el, shown: confident ? best.node : null, confident: confident, score: best.score, hits: found.length };
  }

  function parseVerLabel(t) {
    var m = /^(\d{1,3})\s*\/\s*(\d{1,3})$/.exec(String(t || '').replace(/\s+/g, ' ').trim());
    return m ? { idx: Number(m[1]), total: Number(m[2]) } : null;
  }

  // 翻页器 + 它现在显示的是第几版（"3 / 3"）。标签是页面自己给的「当前第几版」，
  // 比拿文字去猜稳得多 —— 文字认不出来时全靠它。
  function pagerInfo(anchorEl) {
    var pager = findPager(anchorEl);
    if (!pager) return null;
    var lab = pager.label ? parseVerLabel(pager.label.textContent) : null;
    if (!lab) {
      var scopes = [pager.prev && pager.prev.parentElement, pager.next && pager.next.parentElement];
      for (var i = 0; i < scopes.length && !lab; i++) {
        if (!scopes[i]) continue;
        var ls = versionLabelsIn(scopes[i]);
        if (ls.length === 1) lab = parseVerLabel(ls[0].textContent);
      }
    }
    return { pager: pager, idx: lab ? lab.idx : null, total: lab ? lab.total : null };
  }

  function reveal(node) {
    var tree = DST.model.buildTree(state.nodes);
    var chain = [], n = node, hop = 0;
    while (n && !n.virtual && hop++ < 400) { chain.unshift(n); n = n.parentId ? tree.byId[n.parentId] : null; }
    var jobs = [];
    chain.forEach(function (c) { var s = siblingsOf(c, tree); if (s.length > 1) jobs.push({ want: c, sibs: s }); });
    if (!jobs.length) { locate(node); drawer.setStatus('这条线每一处都只有 1 个版本，页面上已经是它了。'); return; }

    var at = 0, moved = 0, taps = 0;
    var maxTaps = Math.max(40, jobs.length * 10);
    var trace = state.revealTrace = { total: jobs.length, at: 0, moved: 0, bubbles: domBubbles().length };

    function bail(why) {
      trace.at = at; trace.moved = moved; trace.reason = why;
      trace.sibs = jobs[at] ? jobs[at].sibs.map(function (s) { return s.id; }) : null;
      trace.bubbles = domBubbles().length;
      locateEl(node);
      drawer.setStatus('切到第 ' + Math.min(at + 1, jobs.length) + '/' + jobs.length + ' 处时停了：' + why +
        '。已改动的 ' + moved + ' 处保留。点「诊断」把内容发我，我照着线上真实结构改。');
    }

    function finish() {
      trace.at = at; trace.moved = moved;
      seek(function () { var el = findDomFor(node); return el ? { el: el } : null; }, function (hit) {
        if (hit && sameText(hit.el, node)) {
          // 页面确实停在这一版了：本地指针跟着改，树上过期的「旧版」标记按新路径重算，
          // 否则接口那批 is_not_last_displayed 会一直把刚切过去的版本画成旧版
          state.currentMessageId = node.id;
          DST.model.markActiveChain(state.nodes, node.id, true);
          save();
          render();
          try { hit.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
          flash(hit.el);
          trace.ok = true;
          drawer.setStatus('已跳到这条分支：改了 ' + moved + ' 处版本，已定位到这一版。');
        } else if (hit) {
          try { hit.el.scrollIntoView({ block: 'center' }); } catch (e) {}
          flash(hit.el);
          drawer.setStatus('已把 ' + moved + ' 处版本切过去；页面上这一处显示的是同位置的另一版（DeepSeek 没重渲染下面这条线），这一支在树里看。');
        } else {
          drawer.setStatus('整条线已按这一支切了 ' + moved + ' 处版本，但页面上没找到这一版自己的气泡（可能还没渲染出来）；树里已按这一支标记。');
        }
      }, '切换完成，正在把这一版滚进视野');
    }

    function nextJob() {
      if (at >= jobs.length) { finish(); return; }
      var job = jobs[at];
      seek(function () { return probeGroup(job.sibs); }, function (probe) {
        if (!probe) {
          trace.at = at + 1;
          trace.sibs = job.sibs.map(function (s) { return s.id; });
          trace.bubbles = domBubbles().length;
          bail('这一处页面上找不到气泡，往上滚也没把它加载出来');
          return;
        }
        switchJob(job, probe);
      }, '正在把第 ' + (at + 1) + '/' + jobs.length + ' 处滚进视野');
    }

    function switchJob(job, probe) {
      var hoverTries = 0, clicksHere = 0, lastSig = '', sameSig = 0, useLabel = true;

      function done() { at++; nextJob(); }

      function textPath(p) {
        // 没有可用的 n/m 标签（或标签和树里的版本数对不上）：只能靠文字认出现在是哪一版
        if (!p.confident || !p.shown) {
          bail('认不出页面当前显示的是哪一版（气泡文字对不上，也没有可用的 n/m 标签）');
          return;
        }
        var target = job.want.versionIndex || 0;
        var cur = p.shown.versionIndex || 0;
        if (cur === target) { done(); return; }
        step(cur < target ? 'next' : 'prev', p);
      }

      function step(dir, p) {
        if (clicksHere++ > 12) { bail('点了 12 次版本按钮都没走到目标那一版（顺序可能和树里的对不上）'); return; }
        var info = pagerInfo(p.anchorEl);
        if (!info) { bail('找不到版本切换按钮（形如 ‹ 2/3 ›）'); return; }
        if (info.idx && info.total) trace.label = info.idx + ' / ' + info.total;
        trace.how = info.pager.how;
        drawer.setStatus('第 ' + (at + 1) + '/' + jobs.length + ' 处：切到第 ' + ((job.want.versionIndex || 0) + 1) + ' 版…');
        tap(dir === 'next' ? info.pager.next : info.pager.prev);
        setTimeout(tick, 520);
      }

      function decide(p) {
        if (p.confident && p.shown && p.shown.id === job.want.id) { moved++; done(); return; }
        var info = pagerInfo(p.anchorEl);
        if (!info) {
          if (hoverTries++ < 3) { hover(p.anchorEl); setTimeout(tick, 450); return; }
          bail('找不到版本切换按钮（形如 ‹ 2/3 ›）');
          return;
        }
        if (info.idx && info.total) trace.label = info.idx + ' / ' + info.total;
        trace.how = info.pager.how;

        var target = job.want.versionIndex || 0;
        var curIdx = (info.idx && info.total === job.sibs.length) ? info.idx - 1 : null;

        // 点了按钮却什么都没变（标签停在原处、文字也没换）：先 hover 再试，连续三次就报死
        var sig = (info.idx || 0) + '/' + (info.total || 0) + '|' + (p.shown ? p.shown.id : '?') + '|' + p.score.toFixed(2);
        if (sig === lastSig) sameSig++; else { sameSig = 0; lastSig = sig; }
        if (sameSig >= 3) {
          if (hoverTries++ < 2) { hover(p.anchorEl); setTimeout(tick, 450); return; }
          bail('点了版本按钮页面没反应（标签一直停在 ' + (info.idx || '?') + ' / ' + (info.total || '?') + '）');
          return;
        }

        if (useLabel && curIdx !== null) {
          if (curIdx === target) {
            if (!p.confident || (p.shown && p.shown.id === job.want.id)) { if (clicksHere) moved++; done(); return; }
            // 标签说到位了、文字却说不是这一版：标签顺序和树里的顺序不一致，改用文字逐步逼近
            useLabel = false;
            textPath(p);
            return;
          }
          step(curIdx < target ? 'next' : 'prev', p);
          return;
        }
        textPath(p);
      }

      function tick() {
        if (taps++ > maxTaps) { bail('累计点了 ' + taps + ' 次还没对上，版本按钮大概不在我猜的位置'); return; }
        var p = probeGroup(job.sibs);
        if (!p) {
          if (hoverTries++ < 2) { setTimeout(tick, 500); return; }
          // 切完一版页面可能整段重渲染，这一处的气泡暂时不在 DOM 里
          seek(function () { return probeGroup(job.sibs); }, function (p2) {
            if (!p2) { bail('切换后这一处气泡从页面上消失了'); return; }
            decide(p2);
          }, '正在重新找到第 ' + (at + 1) + ' 处');
          return;
        }
        decide(p);
      }

      decide(probe);
    }

    drawer.setStatus('正在按轮次点 DeepSeek 自己的版本按钮（这一支要改 ' + jobs.length + ' 处）…');
    nextJob();
  }

  // ---------- 诊断 ----------
  function shapeReport() {
    var out = {};
    Object.keys(state.shapes).forEach(function (p) {
      var s = state.shapes[p];
      var lines = s.lines || [];
      var cap = /history|message|thread|completions/i.test(p) ? 60 : 14;
      out[p] = { bytes: s.bytes, status: s.status, nodes: s.nodes, lines: lines.slice(0, cap), truncated: lines.length > cap };
    });
    return out;
  }

  // 只描述结构、不含聊天文字：翻页器/滚动容器的真实长相，下次再对不上时一眼能看出来
  function chainOf(el, depth) {
    var out = [], n = el;
    for (var i = 0; i < depth && n && n.nodeType === 1; i++) {
      var cs = null;
      try { cs = getComputedStyle(n); } catch (e) {}
      out.push({
        tag: n.tagName.toLowerCase(),
        cls: String(n.className || '').split(/\s+/).slice(0, 2).join(' '),
        role: n.getAttribute('role') || '',
        tab: n.getAttribute('tabindex') || '',
        cursor: cs ? cs.cursor : ''
      });
      n = n.parentElement;
    }
    return out;
  }

  // 「挤开」到底推没推动页面：把页面外壳真实的定位/尺寸交给诊断，省得靠猜
  function shellReport() {
    function d(e) {
      if (!e) return null;
      var c = getComputedStyle(e), r = e.getBoundingClientRect();
      return { tag: e.tagName.toLowerCase(), cls: String(e.className || '').slice(0, 50),
        pos: c.position, w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left),
        mw: c.maxWidth };
    }
    var body = document.body;
    var out = { html: d(document.documentElement), body: d(body), kids: [], fixed: [] };
    for (var i = 0; i < body.children.length && i < 6; i++) out.kids.push(d(body.children[i]));
    var queue = [], checked = 0;
    for (var k = 0; k < body.children.length; k++) queue.push(body.children[k]);
    while (queue.length && checked < 400) {
      var e = queue.shift();
      checked++;
      if (e.id === 'dst-host' || e.tagName === 'SCRIPT' || e.tagName === 'STYLE') continue;
      var c = getComputedStyle(e);
      if (c.position === 'fixed') {
        var r = e.getBoundingClientRect();
        if (r.width > window.innerWidth * 0.7 && r.height > window.innerHeight * 0.4) {
          out.fixed.push(d(e));
          continue;                       // 只报整屏那层本身，不往下钻
        }
      }
      for (var j = 0; j < e.children.length && j < 8; j++) queue.push(e.children[j]);
    }
    var st = document.getElementById('dst-push-style');
    out.pushCss = st ? st.textContent.slice(0, 200) : '(无)';
    out.htmlMargin = getComputedStyle(document.documentElement).marginRight;
    out.vw = window.innerWidth;
    return out;
  }

  function domReport() {
    var bubbles = domBubbles();
    var roles = {};
    bubbles.forEach(function (b) { roles[guessRole(b.el)] = (roles[guessRole(b.el)] || 0) + 1; });
    var marks = {};
    try {
      var els = document.querySelectorAll('[id^="msg-container-"],[data-message-id],[class*="ds-markdown"],[class*="message"]');
      for (var i = 0; i < els.length && i < 200; i++) {
        var cn = String(els[i].className || '').split(/\s+/).filter(function (c) { return c && !/^dst-/.test(c); });
        (cn.concat(els[i].id ? ['#' + els[i].id.split(/[-_]/)[0] + '-…'] : []))
          .forEach(function (c) { marks[c] = (marks[c] || 0) + 1; });
      }
    } catch (e) {}
    var top = Object.keys(marks).sort(function (a, b) { return marks[b] - marks[a]; }).slice(0, 18);
    var pager = null, pagers = [];
    try {
      var all = document.querySelectorAll('*');
      for (var j = 0; j < all.length && pagers.length < 3; j++) {
        var t = (all[j].textContent || '').trim();
        if (all[j].children.length === 0 && /^\d{1,3}\s*\/\s*\d{1,3}$/.test(t)) {
          if (!pager) pager = { text: t, parentClass: String(all[j].parentElement && all[j].parentElement.className || '') };
          pagers.push({ text: t, chain: chainOf(all[j].parentElement, 4) });
        }
      }
    } catch (e) {}
    var scroll = null;
    try {
      var s = scrollableAncestor(bubbles[0] && bubbles[0].el);
      if (s) scroll = { tag: s.tagName.toLowerCase(), cls: String(s.className || '').slice(0, 80), h: s.scrollHeight, ch: s.clientHeight, top: Math.round(s.scrollTop) };
    } catch (e) {}
    return {
      bubbles: bubbles.length,
      roles: roles,
      bodyChars: norm(document.body.innerText).length,
      classes: top.reduce(function (a, k) { a[k] = marks[k]; return a; }, {}),
      pagerSample: pager,
      pagers: pagers,
      scroll: scroll,
      shell: shellReport(),
      bubbleInfo: bubbles.slice(0, 8).map(function (b) {
        var pg = null;
        try { var pi = pagerInfo(b.el); if (pi && pi.idx) pg = pi.idx + ' / ' + pi.total; } catch (e) {}
        return { len: b.text.length, role: guessRole(b.el), cls: String(b.el.className || '').split(/\s+/).slice(0, 2).join(' '), pager: pg };
      })
    };
  }

  function diagnostics() {
    askPage({ __dstCmd: 'diag' });
    setTimeout(function () {
      var info = {
        ext: 'DeepSeek 分叉树 ' + extVersion(),
        page: location.href,
        chatId: state.chatId,
        nodes: state.nodes.length,
        pruned: state.pruned || 0,
        emptyText: state.nodes.filter(function (n) { return !String(n.text || '').trim(); }).length,
        currentMessageId: state.currentMessageId,
        fragTypes: state.fragTypes,
        hiddenTrue: state.nodes.filter(function (n) { return n.hidden === true; }).length,
        hiddenNull: state.nodes.filter(function (n) { return n.hidden == null; }).length,
        roles: state.nodes.reduce(function (a, n) { a[n.role] = (a[n.role] || 0) + 1; return a; }, {}),
        sources: state.nodes.reduce(function (a, n) { a[n.source] = (a[n.source] || 0) + 1; return a; }, {}),
        fieldHints: state.fieldHints,
        origin: state.origin,
        pageHasToken: state.pageHasToken,
        authHeaderNames: state.authHeaderNames,
        storageKeys: state.storageKeys,
        lastHistoryUrl: state.lastHistoryUrl,
        dom: domReport(),
        shapes: shapeReport(),
        candidates: state.candidates,
        sseChunks: state.sseChunks || 0,
        captureStats: state.captureStats,
        lastUrls: state.lastUrls.slice(0, 18),
        parseErrors: state.parseErrors.slice(0, 5)
      };
      var text = JSON.stringify(info, null, 1);
      drawer.setStatus('诊断信息（' + text.length + ' 字，只含结构和字节数、不含任何聊天文字）已尝试复制到剪贴板，粘给我即可：\n' + text.slice(0, 500) + (text.length > 500 ? '…' : ''));
      try { navigator.clipboard.writeText(text); } catch (e) {}
    }, 320);
  }

  // ---------- 开关 ----------
  // 抽屉每次进页面都默认折叠（宽度 / 标签位置 / 铺开方式由 drawer.js 自己恢复）
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === 'dst:toggle') drawer.toggle();
    });
  } catch (e) {}

  document.addEventListener('keydown', function (ev) {
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.code === 'KeyD') { ev.preventDefault(); drawer.toggle(); }
    if (ev.key === 'Escape') { var d = drawer.host.querySelector('.dst-detail'); if (d) d.style.display = 'none'; }
  });
})();
