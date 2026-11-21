(function (global) {
  'use strict';
  var DST = global.__DST__ = global.__DST__ || {};

  var ID_KEYS = ['unique_id', 'message_id', 'msg_id', 'uuid', 'id'];
  var PARENT_KEYS = ['parent_message_id', 'parent_id', 'parent_uuid', 'parentId', 'parentMsgId'];
  // 不收 'type'：线上实测它同时是 fragments 和客户端配置项的类型名，拿它当角色会把配置读成消息
  var ROLE_KEYS = ['role', 'message_type', 'sender'];
  var TEXT_KEYS = ['text', 'content', 'markdown', 'answer', 'message', 'role_content', 'value'];
  var REASON_KEYS = ['reasoning_content', 'thinking_content', 'reasoning'];
  var TIME_KEYS = ['create_time', 'created_at', 'createdAt', 'inserted_at', 'timestamp', 'time', 'mtime'];
  var HIDDEN_YES = ['is_not_last_displayed', 'is_hidden', 'hidden', 'is_expired'];
  var HIDDEN_NO = ['is_current', 'is_displayed', 'current', 'is_last_displayed'];
  var ROLE_VALUES = /^(user|assistant|human|ai|bot|reply|system|tool|function|member|prompt)$/;

  function isObj(v) { return v && typeof v === 'object'; }

  function hasKey(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (Object.prototype.hasOwnProperty.call(obj, keys[i])) return true;
    }
    return false;
  }

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var v = obj[k];
      if (v === null || v === undefined) continue;
      if (typeof v === 'string') { if (v.trim()) return { key: k, value: v }; continue; }
      if (typeof v === 'number' || typeof v === 'boolean') return { key: k, value: v };
    }
    return null;
  }

  function toPlainText(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (depth > 4) return '';
    if (Array.isArray(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i++) {
        var s = toPlainText(v[i], depth + 1);
        if (s) parts.push(s);
      }
      return parts.join('\n\n');
    }
    if (isObj(v)) {
      var prefer = ['text', 'content', 'markdown', 'value', 'answer'];
      for (var p = 0; p < prefer.length; p++) {
        if (v[prefer[p]] !== undefined) {
          var t = toPlainText(v[prefer[p]], depth + 1);
          if (t) return t;
        }
      }
      return '';
    }
    return '';
  }

  // 什么才算「对话里的一条消息」。2026-10-31 线上翻车教训：只按"有 id + 有文字"太宽，
  // /api/v0/client/settings?scope=model 里的 {id, type:'REQUEST', content:'提示词模板'}
  // 被当成 18 条消息并进了树（数字 id 还和真实 message_id 撞号，连当前路径都算错了）。
  // 消息的必备特征是「在树里」：要么带父指针键（根消息的值是 null 也算），要么角色是已知取值。
  function looksLikeMessage(o) {
    if (!isObj(o) || Array.isArray(o)) return false;
    var id = pick(o, ID_KEYS);
    // DeepSeek 线上的 id 是数字（seq_id 那一套），不能只认字符串
    if (!id || (typeof id.value !== 'string' && typeof id.value !== 'number')) return false;
    if (hasKey(o, PARENT_KEYS)) return true;
    var role = pick(o, ROLE_KEYS);
    return !!(role && ROLE_VALUES.test(String(role.value).toLowerCase()));
  }

  // 深度遍历任意形状的接口返回，收集所有「看起来像一条消息」的对象
  function collectMessages(node, out, depth) {
    depth = depth || 0;
    if (depth > 12 || out.length > 4000) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) collectMessages(node[i], out, depth + 1);
      return;
    }
    if (!isObj(node)) return;
    if (depth > 0 && looksLikeMessage(node)) { out.push(node); return; }
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      collectMessages(node[k], out, depth + 1);
    }
  }

  function flag(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v === true) return true;
      if (v === false) return false;
    }
    return null;
  }

  // 2026-10-31 线上实测：正文不在消息对象上，而在 fragments[]（{id,type,content}）里。
  // 检索/引用那类块不是回答正文，思考链单独归到 reasoning；没见过的 type 宁可当正文收，不能丢内容。
  var FRAG_REASON = /reason|think|chain_of|cot/;
  var FRAG_SKIP = /search|reference|quote|citation|knowledge|web_|source|stage|tool|image|file|attachment/;

  function bodyOf(raw) {
    var text = '', i;
    for (i = 0; i < TEXT_KEYS.length; i++) {
      text = toPlainText(raw[TEXT_KEYS[i]]);
      if (text) break;
    }
    var reasoning = toPlainText(raw[REASON_KEYS[0]] || raw[REASON_KEYS[1]] || raw[REASON_KEYS[2]] || '');
    var fr = raw.fragments;
    if (Array.isArray(fr)) {
      var parts = [], rs = [];
      for (i = 0; i < fr.length; i++) {
        var f = fr[i];
        if (!isObj(f) || Array.isArray(f)) continue;
        var type = String(f.type === undefined || f.type === null ? '' : f.type).toLowerCase();
        var c = toPlainText(f.content !== undefined ? f.content : f.text);
        if (!c) continue;
        if (FRAG_REASON.test(type)) rs.push(c);
        else if (FRAG_SKIP.test(type)) continue;
        else parts.push(c);
      }
      if (!text && parts.length) text = parts.join('\n\n');
      if (!reasoning && rs.length) reasoning = rs.join('\n\n');
    }
    return { text: text, reasoning: reasoning };
  }

  function normalize(raw) {
    var id = pick(raw, ID_KEYS).value;
    var parent = pick(raw, PARENT_KEYS);
    var role = pick(raw, ROLE_KEYS);
    var body = bodyOf(raw);
    var text = body.text;
    var time = pick(raw, TIME_KEYS);
    var hidden = flag(raw, HIDDEN_YES);
    if (hidden === null) {
      var shown = flag(raw, HIDDEN_NO);
      hidden = shown === null ? null : !shown;
    }
    var ts = time ? Number(time.value) || 0 : 0;
    if (ts && ts < 1e11) ts = Math.round(ts * 1000); // 秒 → 毫秒
    return {
      id: String(id),
      parentId: parent && parent.value ? String(parent.value) : '',
      role: role ? String(role.value).toLowerCase() : 'unknown',
      text: text,
      reasoning: body.reasoning,
      ts: ts,
      hidden: hidden,
      hiddenSrc: hidden === null ? '' : 'flag',
      source: 'api',
      fieldHints: { id: pick(raw, ID_KEYS).key, parent: parent ? parent.key : null }
    };
  }

  function ingest(text) {
    // 一条抓取记录 → 归一化节点数组。解析不了就返回空数组，绝不抛错。
    var payload;
    try { payload = JSON.parse(text); } catch (e) { return { nodes: [], error: String(e.message || e) }; }
    var found = [];
    collectMessages(payload, found, 0);
    var nodes = [];
    var seen = {};
    for (var i = 0; i < found.length; i++) {
      var n;
      try { n = normalize(found[i]); } catch (e) { continue; }
      if (!n.id || seen[n.id]) continue;
      seen[n.id] = 1;
      nodes.push(n);
    }
    var chatId = findChatId(payload);
    var curId = findCurrentMessageId(payload);
    if (curId) markActiveChain(nodes, curId);
    return { nodes: nodes, error: null, chatId: chatId, currentMessageId: curId, scanned: found.length, payload: payload };
  }

  // 线上消息对象里根本没有「是不是旧版」这种标记，但 chat_session.current_message_id 指向页面当前显示的那一版；
  // 沿 parent 往上走就是「当前路径」，路径之外的那些就是被重新生成/编辑顶掉旧版。
  // 只覆盖反推出来的标记，接口自己给了 hidden 的（hiddenSrc==='flag'）不覆盖。
  function findCurrentMessageId(payload) {
    if (!isObj(payload)) return null;
    var d = payload.data;
    var src = [
      d && isObj(d.biz_data) && isObj(d.biz_data.chat_session) && d.biz_data.chat_session.current_message_id,
      d && isObj(d.chat_session) && d.chat_session.current_message_id,
      d && d.current_message_id
    ];
    for (var i = 0; i < src.length; i++) {
      var v = src[i];
      if (typeof v === 'number' && v) return String(v);
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }

  function markActiveChain(nodes, currentId, force) {
    if (!currentId) return false;
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    var tip = byId[currentId];
    if (!tip) return false;   // 当前那一版不在这份数据里，宁可不下判断
    var onPath = {};
    var guard = 0;
    for (var n = tip; n && guard++ < nodes.length + 2; n = byId[n.parentId]) onPath[n.id] = true;
    if (!onPath[currentId]) return false;
    nodes.forEach(function (node) {
      // force：页面已经被确认切到这一版了，接口那批过期的 is_not_last_displayed 不再作数
      if (node.hiddenSrc === 'flag' && !force) return;
      // 比指针还新、而且就挂在指针那一轮上（同轮的另一个版本 / 指针之后的新一轮）——
      // 这是刚生成完、指针还没更新的那版，不能判成旧版；其余走不到的一律旧版。
      // force 时页面已被确认停在这一版，这条"指针可能还没更新"的启发式不再适用。
      var tooFresh = !force && tip.ts && node.ts > tip.ts &&
        (node.parentId === tip.parentId || node.parentId === tip.id);
      if (onPath[node.id]) { node.hidden = false; node.hiddenSrc = 'derived'; }
      else if (tooFresh) { node.hidden = null; node.hiddenSrc = ''; }
      else { node.hidden = true; node.hiddenSrc = 'derived'; }
    });
    return true;
  }

  // 落过盘的老数据可能带着修复前混进来的非消息节点，加载时用同一判据再筛一遍
  function isChatNode(n) {
    if (!n || n.virtual) return false;
    if (n.source === 'dom') return true;
    if (n.parentId) return true;
    return ROLE_VALUES.test(String(n.role || '').toLowerCase());
  }

  // 线上信封是 data.biz_data.chat_session.id，老形状是 data.chat_id，两边都认
  function findChatId(payload) {
    if (!isObj(payload)) return null;
    var d = payload.data;
    var candidates = [
      payload.chat_id, payload.chatId,
      d && (d.chat_id || d.chatId),
      d && isObj(d.biz_data) && isObj(d.biz_data.chat_session) && (d.biz_data.chat_session.id || d.biz_data.chat_session.chat_id),
      d && isObj(d.chat_session) && (d.chat_session.id || d.chat_session.chat_id)
    ];
    for (var i = 0; i < candidates.length; i++) {
      var v = candidates[i];
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number') return String(v);
    }
    return null;
  }

  function merge(existing, incoming) {
    var map = {};
    var out = [];
    function put(n) {
      var cur = map[n.id];
      if (!cur) { map[n.id] = n; out.push(n); return; }
      // 后到的数据只在「更完整」时覆盖
      if ((n.text || '').length > (cur.text || '').length) cur.text = n.text;
      if ((n.reasoning || '').length > (cur.reasoning || '').length) cur.reasoning = n.reasoning;
      if (!cur.parentId && n.parentId) cur.parentId = n.parentId;
      if ((cur.role === 'unknown' || !cur.role) && n.role) cur.role = n.role;
      // 隐藏标记：接口自带的永不被反推结果覆盖；两边都是反推时以"后到的那份返回"为准（整段重抓时当前路径会移动）
      if ((n.hidden !== null && n.hidden !== undefined) &&
        (n.hiddenSrc === 'flag' || cur.hiddenSrc !== 'flag')) {
        cur.hidden = n.hidden;
        cur.hiddenSrc = n.hiddenSrc || '';
      }
      if (!cur.ts && n.ts) cur.ts = n.ts;
      if (cur.source !== 'api' && n.source === 'api') cur.source = 'api';
    }
    existing.forEach(put);
    incoming.forEach(put);
    return out;
  }

  function buildTree(nodes) {
    var byId = {};
    nodes.forEach(function (n) {
      n.children = [];
      byId[n.id] = n;
    });
    var roots = [];
    var orphans = [];
    nodes.forEach(function (n) {
      var p = n.parentId && byId[n.parentId];
      if (p && p !== n) p.children.push(n);
      else if (!n.parentId) roots.push(n);
      else orphans.push(n);
    });
    // 断链（父节点缺失，常见于删了中间一轮）单独成组，不丢内容
    var groups = {};
    orphans.forEach(function (n) {
      var k = n.parentId || '~';
      if (!groups[k]) {
        groups[k] = [];
        var vr = { id: 'virtual:' + k, virtual: true, parentId: '', role: 'root', text: '（上一轮已被删除，或父节点不在本次返回里）', children: [], hidden: null, ts: 0 };
        vr.orphanKey = k;
        roots.push(vr);
      }
      groups[k].push(n);
    });
    roots.forEach(function (r) { if (r.virtual) r.children = groups[r.orphanKey]; });

    var ordered = [];
    (function walk(list) {
      list.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      list.forEach(function (n) { ordered.push(n); walk(n.children); });
    })(roots);

    // 版本序号：同父同角色的互为「重新生成 / 重新编辑」出来的几个版本
    var sibGroups = {};
    ordered.forEach(function (n) {
      if (n.virtual) return;
      var k = (n.parentId || '#') + '|' + n.role;
      (sibGroups[k] = sibGroups[k] || []).push(n);
    });
    Object.keys(sibGroups).forEach(function (k) {
      var g = sibGroups[k];
      g.forEach(function (n, i) { n.versionIndex = i; n.versionCount = g.length; });
    });

    // 当前显示路径：从每个根往下走，优先走未被标记隐藏的分支
    ordered.forEach(function (n) { n.onActivePath = false; });
    function markPath(n, guard) {
      if (guard > 500) return;
      n.onActivePath = true;
      var kids = n.children.filter(function (c) { return c.hidden !== true; });
      var next = kids.length ? kids[kids.length - 1] : null;
      if (next && !next.onActivePath) markPath(next, guard + 1);
    }
    // 整条被顶掉的旧分支（编辑出来的上一版提问及其回答）不该算进「当前路径」，否则这个筛选没意义
    var liveRoots = roots.filter(function (r) { return r.hidden !== true; });
    (liveRoots.length ? liveRoots : roots).forEach(function (r) { markPath(r, 0); });

    var branchPoints = 0, hiddenCount = 0, maxDepth = 0;
    ordered.forEach(function (n) {
      if (n.children.length > 1) branchPoints++;
      if (n.hidden === true) hiddenCount++;
      if (n.depthHint === undefined) n.depthHint = 0;
    });

    return {
      roots: roots,
      ordered: ordered,
      byId: byId,
      stats: { total: ordered.filter(function (n) { return !n.virtual; }).length, branchPoints: branchPoints, hiddenCount: hiddenCount }
    };
  }

  function preview(text) {
    var lines = String(text || '').split('\n');
    var line = '';
    for (var i = 0; i < lines.length && !line; i++) line = lines[i].replace(/^[#>*\-\s]+/, '').trim();
    line = line.replace(/[`*_]/g, '').replace(/\s+/g, ' ');
    return line.length > 74 ? line.slice(0, 74) + '…' : (line || '（空）');
  }

  // 只描述结构、不含任何聊天文字：接口返回长什么样 → 给诊断用
  var SHAPE_MAX_LINES = 110;
  function flattenShape(v, path, out, depth) {
    if (out.length >= SHAPE_MAX_LINES || depth > 6) return;
    var at = path || '$';
    if (v === null || v === undefined) { out.push(at + ': ' + (v === null ? 'null' : 'undefined')); return; }
    var t = typeof v;
    if (t === 'string') { out.push(at + ': str(' + v.length + ')'); return; }
    if (t === 'number' || t === 'boolean') { out.push(at + ': ' + t); return; }
    if (Array.isArray(v)) {
      out.push(at + ': arr(' + v.length + ')');
      for (var i = 0; i < Math.min(v.length, 2); i++) flattenShape(v[i], at + '[]', out, depth + 1);
      return;
    }
    var keys = [];
    for (var k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) keys.push(k); }
    keys = keys.slice(0, 40);
    out.push(at + ': obj{' + keys.join(',') + '}');
    for (var j = 0; j < keys.length; j++) flattenShape(v[keys[j]], (path ? path + '.' : '') + keys[j], out, depth + 1);
  }

  function asJson(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
  }

  function shape(text) {
    var v = asJson(text);
    if (v === null || v === undefined) return null;
    var out = [];
    flattenShape(v, '', out, 0);
    return out;
  }

  // 把返回里所有「对象数组」连它们的键名+值类型列出来。认不出字段时，这份清单就是答案本身。
  var CAND_MAX_LISTS = 8;
  var CAND_MAX_KEYS = 30;
  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'arr';
    return typeof v;
  }
  function candidates(text) {
    var root = asJson(text);
    if (root === null || root === undefined) return null;
    var out = [];
    (function walk(node, path, depth) {
      if (out.length >= CAND_MAX_LISTS || depth > 8) return;
      if (Array.isArray(node)) {
        var objs = [];
        for (var i = 0; i < node.length; i++) {
          if (node[i] && typeof node[i] === 'object' && !Array.isArray(node[i])) objs.push(node[i]);
          if (objs.length >= 3) break;
        }
        if (objs.length >= 2) {
          var keys = {};
          var n = 0;
          for (var s = 0; s < objs.length && n < CAND_MAX_KEYS; s++) {
            for (var k in objs[s]) {
              if (!Object.prototype.hasOwnProperty.call(objs[s], k)) continue;
              if (!(k in keys)) n++;
              keys[k] = typeOf(objs[s][k]);
            }
          }
          out.push({ path: path || '$', count: node.length, keys: keys });
        }
        for (var j = 0; j < Math.min(node.length, 2); j++) walk(node[j], (path || '$') + '[]', depth + 1);
        return;
      }
      if (!node || typeof node !== 'object') return;
      for (var k2 in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k2)) continue;
        walk(node[k2], (path ? path + '.' : '') + k2, depth + 1);
      }
    })(root, '', 0);
    return out;
  }

  // 流式返回（text/event-stream）里的一行行 data: JSON → 对象数组。
  // 线上 /chat/regenerate、/edit_message、/completion 就是这个形态，直接 JSON.parse 整包必报「Unexpected token e」。
  function ssePayloads(body) {
    var out = [];
    var lines = String(body || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].replace(/^\s+/, '');
      if (ln.indexOf('data:') !== 0) continue;
      var raw = ln.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try { out.push(JSON.parse(raw)); } catch (e) {}
    }
    return out;
  }

  DST.model = {
    ingest: ingest,
    merge: merge,
    buildTree: buildTree,
    preview: preview,
    toPlainText: toPlainText,
    collectMessages: collectMessages,
    shape: shape,
    candidates: candidates,
    ssePayloads: ssePayloads,
    findChatId: findChatId,
    findCurrentMessageId: findCurrentMessageId,
    markActiveChain: markActiveChain,
    isChatNode: isChatNode,
    looksLikeMessage: looksLikeMessage,
    bodyOf: bodyOf
  };
})(typeof window !== 'undefined' ? window : globalThis);
