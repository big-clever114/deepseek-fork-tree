(function () {
  'use strict';
  if (window.__DST_CONTENT__) return;
  window.__DST_CONTENT__ = true;

  var DST = window.__DST__;
  var STORE = 'dst:chat:';
  var MAX_NODES = 400;
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
    origin: ''
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
  function persist(k, v) { try { chrome.storage.local.set(obj(k, v)); } catch (e) {} }
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

  function serialize(n) {
    return {
      id: n.id, parentId: n.parentId || '', role: n.role,
      text: String(n.text || '').slice(0, MAX_TEXT),
      reasoning: String(n.reasoning || '').slice(0, 2000),
      ts: n.ts || 0, hidden: n.hidden === undefined ? null : n.hidden,
      hiddenSrc: n.hiddenSrc || '', source: n.source || 'api'
    };
  }

  function save() {
    if (!state.chatId) return;
    var list = state.nodes.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).slice(0, MAX_NODES).map(serialize);
    persist(STORE + state.chatId, { chatId: state.chatId, updatedAt: Date.now(), nodes: list });
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
    if (state.nodes.length || !state.chatId || autoRefetched[state.chatId]) return;
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
  function domBubbles() {
    var sel = '[id^="msg-container-"],[data-message-id],[class*="message-content"],[class*="chat-content"],[class*="markdown"],[class*="message"]';
    var all = [];
    var nodes = document.querySelectorAll(sel);
    for (var i = 0; i < nodes.length; i++) {
      var e = nodes[i];
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
    try {
      var kids = el.querySelectorAll('*');
      for (var j = 0; j < Math.min(kids.length, 60); j++) chain += ' ' + (kids[j].className || '');
    } catch (e) {}
    if (/assistant|ds-answer|bot|reply/i.test(chain)) return 'assistant';
    if (/user|self|query|human|owner/i.test(chain)) return 'user';
    return 'unknown';
  }

  function syncFromDom() {
    var bubbles = domBubbles();
    if (!bubbles.length) { drawer.setStatus('页面上没识别到消息气泡（DeepSeek 换了 DOM 结构）。'); return; }
    var tree = DST.model.buildTree(state.nodes);
    var known = {};
    tree.ordered.forEach(function (n) { known[norm(n.text).slice(0, 160)] = n; });
    var leaf = null;
    tree.ordered.forEach(function (n) { if (n.onActivePath && !n.virtual) leaf = n; });
    var added = 0, matched = 0, fresh = [];
    bubbles.forEach(function (b) {
      var key = b.text.slice(0, 160);
      if (known[key]) { matched++; return; }
      var node = {
        id: 'dom:' + hash(key), parentId: leaf ? leaf.id : '', role: guessRole(b.el),
        text: b.text, reasoning: '', ts: Date.now() + added, hidden: null, source: 'dom'
      };
      known[key] = node;
      leaf = node;
      added++;
      fresh.push(node);
    });
    if (fresh.length) addNodes(fresh, state.chatId, state.origin || '页面抓取');
    drawer.setStatus('页面抓取：' + bubbles.length + ' 个气泡，' + matched + ' 个已在树里，新增 ' + added + ' 个（挂在当前对话末尾，角色按容器 class 猜，可能不准）。');
  }

  // ---------- 定位 ----------
  function findDomFor(node) {
    var byId = null;
    try {
      byId = document.querySelector('#msg-container-' + (window.CSS && CSS.escape ? CSS.escape(node.id) : node.id))
        || document.querySelector('[data-message-id="' + node.id.replace(/"/g, '') + '"]');
    } catch (e) {}
    if (byId) return byId;
    var key = norm(node.text).slice(0, 160);
    if (!key) return null;
    var bubbles = domBubbles();
    for (var i = 0; i < bubbles.length; i++) {
      if (bubbles[i].text.slice(0, key.length) === key) return bubbles[i].el;
    }
    return null;
  }

  function flash(el) {
    try {
      el.style.setProperty('outline', '2px solid ' + (drawer.host.classList.contains('dst-dark') ? '#8699ff' : '#4d6bfe'), 'important');
      el.style.setProperty('outline-offset', '3px', 'important');
      el.style.setProperty('transition', 'outline-color 400ms ease', 'important');
      setTimeout(function () { el.style.removeProperty('outline'); el.style.removeProperty('outline-offset'); }, 2200);
    } catch (e) {}
  }

  function locate(node) {
    var el = findDomFor(node);
    if (!el) {
      drawer.setStatus('页面上找不到这一版——DeepSeek 同一处只显示一个版本，其它版本只在数据里。用「复制全文」或「切到这一版」。');
      return null;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(el);
    var same = norm(el.innerText).slice(0, 160) === norm(node.text).slice(0, 160);
    drawer.setStatus(same ? '已定位到页面上这一版并高亮。' : '已定位到那一处气泡，但页面当前显示的是同位置的另一版（这一版没显示出来）。');
    return el;
  }

  // ---------- 驱动 DeepSeek 自己的版本切换按钮 ----------
  function findPager(container) {
    var n = container;
    for (var up = 0; up < 5 && n; up++) {
      var label = null;
      var kids = n.querySelectorAll('*');
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (/^\s*\d+\s*\/\s*\d+\s*$/.test(k.textContent || '') && k.children.length === 0) { label = k; break; }
      }
      if (!label) { n = n.parentElement; continue; }
      var row = label.parentElement;
      var btns = row ? Array.prototype.filter.call(row.children, function (c) { return c !== label; }) : [];
      if (btns.length >= 2) return { prev: btns[0], next: btns[btns.length - 1], label: label };
      n = n.parentElement;
    }
    return null;
  }

  function tap(el) {
    if (!el) return;
    try {
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      });
    } catch (e) {}
  }

  function reveal(node) {
    var tree = DST.model.buildTree(state.nodes);
    var sibs = (node.parentId && tree.byId[node.parentId] ? tree.byId[node.parentId].children : tree.roots)
      .filter(function (c) { return c.role === node.role; })
      .sort(function (a, b) { return (a.versionIndex || 0) - (b.versionIndex || 0); });
    if (sibs.length < 2) { drawer.setStatus('这一处只有 1 个版本，不用切。'); return; }
    var guard = 0;
    drawer.setStatus('正在点 DeepSeek 自己的版本切换按钮…');

    (function step() {
      var cur = null;
      for (var i = 0; i < sibs.length; i++) { if (findDomFor(sibs[i])) { cur = sibs[i]; break; } }
      if (!cur) { drawer.setStatus('页面上找不到这组任何一版，无法切换（这一处的气泡可能被 DeepSeek 卸载了）。'); return; }
      if (cur.id === node.id) { locate(node); drawer.setStatus('已切到第 ' + (node.versionIndex + 1) + ' 版。'); return; }
      if (guard++ > sibs.length * 2 + 2) { drawer.setStatus('切了 ' + guard + ' 次仍没到第 ' + (node.versionIndex + 1) + ' 版：DeepSeek 的版本按钮大概不在我猜的位置。'); return; }
      var anchor = findDomFor(cur);
      var pager = findPager(anchor);
      if (!pager) { drawer.setStatus('找不到版本切换按钮（形如 ‹ 2/3 ›），这一组只能在数据里看。'); return; }
      var targetIsNext = (node.versionIndex || 0) > (cur.versionIndex || 0);
      tap(targetIsNext ? pager.next : pager.prev);
      setTimeout(step, 420);
    })();
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
    var pager = null;
    try {
      var all = document.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        var t = (all[j].textContent || '').trim();
        if (all[j].children.length === 0 && /^\d+\s*\/\s*\d+$/.test(t)) { pager = { text: t, parentClass: String(all[j].parentElement && all[j].parentElement.className || '') }; break; }
      }
    } catch (e) {}
    return {
      bubbles: bubbles.length,
      roles: roles,
      bodyChars: norm(document.body.innerText).length,
      classes: top.reduce(function (a, k) { a[k] = marks[k]; return a; }, {}),
      pagerSample: pager
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
  try {
    chrome.storage.local.get(['dst:prefs:open', 'dst:prefs:width'], function (r) {
      if (r) {
        if (r['dst:prefs:width']) drawer.host.style.width = r['dst:prefs:width'] + 'px';
        if (r['dst:prefs:open'] === false) drawer.setOpen(false);
      }
    });
  } catch (e) {}

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
