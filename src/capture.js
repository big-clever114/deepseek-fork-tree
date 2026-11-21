(function () {
  'use strict';
  if (window.__DST_INSTALLED__) return;
  window.__DST_INSTALLED__ = true;

  var CHANNEL = '__dst_capture__';
  var MAX_BYTES = 4 * 1024 * 1024;
  var stats = { hits: 0, last: [], installedAt: Date.now() };
  window.__DST_STATS__ = stats;

  function isApiUrl(raw) {
    try {
      var u = new URL(raw, location.href);
      return /deepseek\.com$/.test(u.hostname.replace(/:[0-9]+$/, '')) && u.pathname.indexOf('/api/') !== -1;
    } catch (e) {
      return false;
    }
  }

  var JWT = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/;

  function token() {
    try {
      var direct = localStorage.getItem('default_user_access_token');
      if (direct && JWT.test(direct.trim())) return direct.trim();
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        var v = localStorage.getItem(k);
        if (!v || v.length > 40000) continue;
        if (JWT.test(v.trim())) return v.trim();
        // 有的站点把整块状态塞成一个 JSON 字符串，往里再找一层
        if (v.charAt(0) === '{') {
          var hit = searchJwt(JSON.parse(v), 0);
          if (hit) return hit;
        }
      }
    } catch (e) {}
    return null;
  }

  function searchJwt(o, depth) {
    if (!o || typeof o !== 'object' || depth > 3) return null;
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      var v = o[k];
      if (typeof v === 'string' && JWT.test(v.trim())) return v.trim();
      if (v && typeof v === 'object') { var nested = searchJwt(v, depth + 1); if (nested) return nested; }
    }
    return null;
  }

  function storageKeys() {
    var out = [];
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k) out.push(k); } } catch (e) {}
    return out.slice(0, 80);
  }

  // 页面自己发的请求头里的鉴权信息：只留在注入层内存，绝不进诊断、绝不落盘
  var lastHeaders = {};
  var lastHistoryUrl = '';

  function headerPairs(h) {
    var out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== 'undefined' && h instanceof Headers) { h.forEach(function (v, k) { out[k] = v; }); return out; }
      if (Array.isArray(h)) { for (var i = 0; i < h.length; i++) { var p = h[i]; if (p && p.length === 2) out[String(p[0])] = String(p[1]); } return out; }
      if (typeof h === 'object') { for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) out[String(k)] = String(h[k]); }
    } catch (e) {}
    return out;
  }

  function namesOf(h) {
    var o = {};
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) o[k] = String(h[k]).length;
    return o;
  }

  function noteReq(rawUrl, method, headers) {
    try {
      var u = new URL(rawUrl, location.href);
      if (!isApiUrl(u.href)) return;
      for (var k in headers) {
        if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
        if (/^(authorization|x-csrf-token|x-xsrf-token)$/i.test(k)) lastHeaders[k] = headers[k];
      }
      if (String(method).toUpperCase() === 'GET' && /history|messages|thread/i.test(u.pathname)) lastHistoryUrl = u.href;
    } catch (e) {}
  }

  function post(rec) {
    try { window.postMessage({ __dst: 1, channel: CHANNEL, rec: rec }, '*'); } catch (e) {}
  }

  // 在页面自己的上下文里重发一次它用过的历史请求：去掉缓存参数，要全量版本
  function doRefetch(chatId) {
    var target = lastHistoryUrl;
    if (!target && chatId) target = '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(String(chatId));
    var u;
    try { u = new URL(target, location.href); } catch (e) { return post({ kind: 'refetch-fail', reason: 'bad-url: ' + target }); }
    if (!isApiUrl(u.href)) return post({ kind: 'refetch-fail', reason: 'not-api: ' + u.href });
    u.searchParams.delete('cache_version');
    u.searchParams.delete('cache_reset_at');
    u.searchParams.set('show_all', 'true');
    // 页面切了会话但不再发历史请求（走它自己的缓存）时，记录下来的 URL 会是上一条对话的 —— 必须换成当前会话
    if (chatId) {
      u.searchParams.forEach(function (val, key) {
        if (/^(?:chat_session_id|chat_id|session_id|cid)$/i.test(key) && val !== String(chatId)) u.searchParams.set(key, String(chatId));
      });
    }
    var headers = {};
    for (var k in lastHeaders) headers[k] = lastHeaders[k];
    var hasAuth = Object.keys(headers).some(function (h) { return /^authorization$/i.test(h); });
    if (!hasAuth) {
      var t = token();
      if (t) headers.Authorization = 'Bearer ' + t;
    }
    try {
      origFetch.call(window, u.href, { method: 'GET', headers: headers, credentials: 'include' })
        .then(function (r) {
          return r.text().then(function (text) {
            emit({ kind: 'refetch', url: r.url || u.href, method: 'GET', reqBody: null, status: r.status, ct: 'application/json', body: String(text || '').slice(0, MAX_BYTES), sentHeaders: namesOf(headers) });
          });
        })
        .catch(function (e) { post({ kind: 'refetch-fail', reason: String((e && e.message) || e) }); });
    } catch (e) {
      post({ kind: 'refetch-fail', reason: String((e && e.message) || e) });
    }
  }

  function emit(rec) {
    try {
      rec.at = Date.now();
      stats.hits++;
      rec.hits = stats.hits;
      stats.last.unshift({ url: rec.url, method: rec.method, status: rec.status, kind: rec.kind, len: rec.body ? rec.body.length : 0, at: rec.at });
      stats.last = stats.last.slice(0, 20);
      window.postMessage({ __dst: 1, channel: CHANNEL, rec: rec }, '*');
    } catch (e) {}
  }

  var origFetch = window.fetch;
  window.fetch = function () {
    var input = arguments[0];
    var init = arguments[1] || {};
    var url = typeof input === 'string' ? input : (input && input.url) || String(location.href);
    var method = (init.method || (input && input.method) || 'GET').toUpperCase();
    var reqBody = typeof init.body === 'string' ? init.body.slice(0, 20000) : null;

    if (!isApiUrl(url)) return origFetch.apply(this, arguments);
    noteReq(url, method, headerPairs(init.headers || (input && input.headers)));

    var p = origFetch.apply(this, arguments);
    p.then(function (res) {
      try {
        var ct = (res.headers && res.headers.get('content-type')) || '';
        if (ct.indexOf('event-stream') !== -1) {
          // 流式补全：不缓冲正文，只记下「又生成了一版、挂在哪个父节点下」
          emit({ kind: 'stream', url: url, method: method, reqBody: reqBody, status: res.status, ct: ct, body: '' });
          return;
        }
        if (ct.indexOf('json') === -1 && ct.indexOf('text') === -1) return;
        res.clone().text().then(function (text) {
          emit({ kind: 'fetch', url: url, method: method, reqBody: reqBody, status: res.status, ct: ct, body: text.slice(0, MAX_BYTES) });
        }).catch(function () {});
      } catch (e) {}
    }).catch(function () {});
    return p;
  };
  window.fetch.__dstHooked = true;

  var OrigXHR = window.XMLHttpRequest;
  function XHRHook() {
    var x = new OrigXHR();
    var meta = { headers: {} };
    var open = x.open;
    x.open = function (m, u) {
      meta.method = String(m).toUpperCase();
      meta.url = u;
      meta.capturable = isApiUrl(u);
      return open.apply(x, arguments);
    };
    var setH = x.setRequestHeader;
    x.setRequestHeader = function (name, value) {
      try { meta.headers[String(name)] = String(value); } catch (e) {}
      return setH.apply(x, arguments);
    };
    var send = x.send;
    x.send = function (body) {
      meta.reqBody = typeof body === 'string' ? body.slice(0, 20000) : null;
      if (meta.capturable) {
        noteReq(x.responseURL || meta.url, meta.method, meta.headers);
        x.addEventListener('readystatechange', function () {
          if (x.readyState !== 4) return;
          try {
            var ct = x.getResponseHeader('content-type') || '';
            var text = String(x.responseText || '');
            if (ct.indexOf('event-stream') !== -1) {
              // 重新生成 / 编辑重发都是这种流式返回：整包在结束时才齐，里面就带着新那一版的消息对象
              emit({ kind: 'sse', url: x.responseURL || meta.url, method: meta.method, reqBody: meta.reqBody, status: x.status, ct: ct, body: text.slice(0, MAX_BYTES) });
              return;
            }
            if (ct.indexOf('json') === -1 && ct.indexOf('text') === -1) return;
            emit({ kind: 'xhr', url: x.responseURL || meta.url, method: meta.method, reqBody: meta.reqBody, status: x.status, ct: ct, body: text.slice(0, MAX_BYTES) });
          } catch (e) {}
        });
      }
      return send.apply(x, arguments);
    };
    return x;
  }
  XHRHook.prototype = OrigXHR.prototype;
  XHRHook.__dstHooked = true;
  window.XMLHttpRequest = XHRHook;

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || !d.__dstCmd) return;
    if (d.__dstCmd === 'refetch') { doRefetch(d.chatId); return; }
    var isDiag = d.__dstCmd === 'diag';
    var hookFetch = isDiag ? (window.fetch !== origFetch && window.fetch.__dstHooked === true) : undefined;
    var hookXHR = isDiag ? (window.XMLHttpRequest !== OrigXHR && window.XMLHttpRequest.__dstHooked === true) : undefined;
    if (d.__dstCmd === 'token' || isDiag) {
      var rec = isDiag
        ? {
            kind: 'diag',
            stats: { hits: stats.hits, last: stats.last, installedAt: stats.installedAt, hookFetch: hookFetch, hookXHR: hookXHR },
            storageKeys: storageKeys(),
            authHeaderNames: namesOf(lastHeaders),
            hasToken: !!token(),
            lastHistoryUrl: lastHistoryUrl
          }
        : { kind: 'token', token: token() };
      post(rec);
    }
  }, false);

  window.__DST_STATS__.pageLanguage = document.documentElement.lang || navigator.language;
})();
