(function (global) {
  'use strict';
  var DST = global.__DST__ = global.__DST__ || {};

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function create(handlers) {
    handlers = handlers || {};
    var host = el('div', 'dst-host');
    host.id = 'dst-host';

    var tab = el('button', 'dst-tab', '分叉树');
    tab.title = '显示分叉树';

    var panel = el('aside', 'dst-panel');

    var counts = el('div', 'dst-counts', '还没抓到数据');
    var header = el('header', 'dst-head');
    var headTxt = el('div', 'dst-headtxt');
    headTxt.appendChild(el('div', 'dst-title', '分叉树'));
    headTxt.appendChild(counts);
    header.appendChild(headTxt);

    var btns = el('div', 'dst-btns');
    function headBtn(act, label, title) {
      var b = el('button', 'dst-btn', label);
      b.dataset.act = act;
      b.title = title || '';
      btns.appendChild(b);
      b.addEventListener('click', function () {
        if (act === 'close') setOpen(false);
        else if (act === 'fit') fit();
        else if (act === 'refetch' && handlers.onRefetch) handlers.onRefetch();
        else if (act === 'sync' && handlers.onSync) handlers.onSync();
        else if (act === 'diag' && handlers.onDiag) handlers.onDiag();
      });
      return b;
    }
    headBtn('refetch', '重新抓取', '向 DeepSeek 重新要一次完整历史（含被隐藏的旧版本）');
    headBtn('sync', '同步本页', '把当前页面上显示的消息并入树');
    headBtn('fit', '适配', '缩放至整棵树可见');
    headBtn('diag', '诊断', '复制一份诊断信息，方便反馈问题');
    var closeBtn = headBtn('close', '✕', '收起');
    closeBtn.classList.add('is-close');
    header.appendChild(btns);

    var tools = el('div', 'dst-tools');
    var search = el('input', 'dst-search');
    search.type = 'search';
    search.placeholder = '在所有版本里搜索文字…';
    tools.appendChild(search);
    var chips = el('div', 'dst-chips');
    var FILTERS = [
      ['branchesOnly', '只看分叉处'],
      ['hiddenOnly', '只看旧版本'],
      ['activeOnly', '只看当前路径'],
      ['usersOnly', '只看我的提问']
    ];
    var filterState = {};
    FILTERS.forEach(function (f) {
      var lab = el('label', 'dst-chip');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      lab.appendChild(cb);
      lab.appendChild(el('span', null, f[1]));
      chips.appendChild(lab);
      cb.addEventListener('change', function () {
        filterState[f[0]] = cb.checked;
        renderNow();
      });
    });
    tools.appendChild(chips);

    var searchTimer = null;
    search.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderNow, 180);
    });

    var zoomBar = el('div', 'dst-zoom');
    var zOut = el('button', 'dst-btn', '−');
    var zLabel = el('span', 'dst-zlabel', '100%');
    var zIn = el('button', 'dst-btn', '＋');
    zoomBar.appendChild(zOut);
    zoomBar.appendChild(zLabel);
    zoomBar.appendChild(zIn);
    tools.appendChild(zoomBar);

    var canvas = el('div', 'dst-canvas');
    var inner = el('div', 'dst-inner');
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'dst-svg');
    var cards = el('div', 'dst-cards');
    inner.appendChild(svg);
    inner.appendChild(cards);
    canvas.appendChild(inner);

    var status = el('footer', 'dst-status', '');
    panel.appendChild(header);
    panel.appendChild(tools);
    panel.appendChild(canvas);
    panel.appendChild(status);

    var grip = el('div', 'dst-grip');
    grip.title = '拖动改变宽度';

    var detail = el('div', 'dst-detail');
    detail.style.display = 'none';

    host.appendChild(grip);
    host.appendChild(panel);
    host.appendChild(tab);
    host.appendChild(detail);

    var open = true;
    var zoom = 1;
    var data = { roots: [], nodes: [], byId: {}, stats: {}, chatId: null, layout: null };
    var selectedId = null;
    var fittedOnce = false;

    function setOpen(v) {
      open = v;
      panel.classList.toggle('is-open', v);
      grip.classList.toggle('is-open', v);
      tab.classList.toggle('is-hidden', v);
      if (v) renderNow();
      try { chrome.storage.local.set({ 'dst:prefs:open': v }); } catch (e) {}
    }
    tab.addEventListener('click', function () { setOpen(true); });

    zIn.addEventListener('click', function () { setZoom(zoom * 1.2); });
    zOut.addEventListener('click', function () { setZoom(zoom / 1.2); });
    function setZoom(z) {
      zoom = Math.min(2, Math.max(0.25, z));
      inner.style.transform = 'scale(' + zoom + ')';
      inner.style.transformOrigin = 'top left';
      zLabel.textContent = Math.round(zoom * 100) + '%';
    }

    function fit() {
      if (!data.layout) return;
      var w = canvas.clientWidth - 24;
      setZoom(Math.min(1, Math.max(0.55, w / data.layout.width)));
      var leaf = null;
      data.layout.nodes.forEach(function (n) {
        if (n.onActivePath && !n.virtual && (!leaf || n.y > leaf.y)) leaf = n;
      });
      if (leaf) {
        canvas.scrollTop = Math.max(0, (leaf.y + DST.SIZE.NODE_H) * zoom - canvas.clientHeight + 140);
        canvas.scrollLeft = Math.max(0, leaf.x * zoom - canvas.clientWidth / 2);
      }
    }

    // ---- 拖宽 ----
    (function () {
      var dragging = false, startX = 0, startW = 0;
      grip.addEventListener('mousedown', function (ev) {
        dragging = true;
        startX = ev.clientX;
        startW = host.getBoundingClientRect().width;
        ev.preventDefault();
      });
      window.addEventListener('mousemove', function (ev) {
        if (!dragging) return;
        var w = Math.min(window.innerWidth * 0.85, Math.max(320, startW - (ev.clientX - startX)));
        host.style.width = w + 'px';
      });
      window.addEventListener('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        try { chrome.storage.local.set({ 'dst:prefs:width': Math.round(host.getBoundingClientRect().width) }); } catch (e) {}
        renderNow();
      });
    })();

    function keepSet() {
      var q = (search.value || '').trim().toLowerCase();
      var anyFilter = q || filterState.branchesOnly || filterState.hiddenOnly || filterState.activeOnly || filterState.usersOnly;
      if (!anyFilter) return null;
      var keep = {};
      var matched = 0;
      function chainToRoot(n) {
        var seen = {};
        var cur = n;
        while (cur && !seen[cur.id]) {
          seen[cur.id] = 1;
          keep[cur.id] = 1;
          cur = cur.parentId && data.byId[cur.parentId];
        }
      }
      data.nodes.forEach(function (n) {
        var ok = true;
        if (q && String(n.text || '').toLowerCase().indexOf(q) === -1 && String(n.previewText || '').toLowerCase().indexOf(q) === -1) ok = false;
        if (filterState.hiddenOnly && !(n.hidden === true)) ok = false;
        if (filterState.branchesOnly && !(n.children && n.children.length > 1)) ok = false;
        if (filterState.activeOnly && !n.onActivePath) ok = false;
        if (filterState.usersOnly && n.role !== 'user') ok = false;
        if (ok) { matched++; chainToRoot(n); }
      });
      return { keep: keep, matched: matched };
    }

    function renderNow() {
      var tree = data.tree;
      cards.textContent = '';
      svg.textContent = '';
      if (!tree || !tree.roots.length) {
        setStatus('没有节点');
        return;
      }
      var ks = keepSet();
      var visible = function (n) { return !ks || ks.keep[n.id]; };

      var laid = DST.layout(tree.roots.filter(visible), visible);
      data.layout = laid;

      svg.setAttribute('width', laid.width);
      svg.setAttribute('height', laid.height);
      svg.style.width = laid.width + 'px';
      svg.style.height = laid.height + 'px';
      inner.style.width = laid.width + 'px';
      inner.style.height = laid.height + 'px';

      laid.edges.forEach(function (e) {
        var dy = (e.y2 - e.y1) / 2;
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M' + e.x1 + ',' + e.y1 + ' C' + e.x1 + ',' + (e.y1 + dy) + ' ' + e.x2 + ',' + (e.y2 - dy) + ' ' + e.x2 + ',' + e.y2);
        path.setAttribute('class', 'dst-edge' + (e.to.hidden === true ? ' is-hidden-branch' : '') + (e.to.onActivePath ? ' is-active' : ''));
        svg.appendChild(path);
      });

      var W = DST.SIZE.NODE_W, H = DST.SIZE.NODE_H;
      laid.nodes.forEach(function (n) {
        if (!visible(n)) return;
        var c = el('div', 'dst-card');
        c.dataset.id = n.id;
        c.style.left = (n.x - W / 2) + 'px';
        c.style.top = n.y + 'px';
        c.style.width = W + 'px';
        c.style.height = H + 'px';
        if (n.role === 'user') c.classList.add('is-user');
        else if (n.role === 'assistant') c.classList.add('is-bot');
        if (n.hidden === true) c.classList.add('is-hiddenver');
        if (n.hidden === null) c.classList.add('is-unknownflag');
        if (n.source === 'dom') c.classList.add('is-domonly');
        if (n.onActivePath) c.classList.add('is-onpath');
        if (n.id === selectedId) c.classList.add('is-selected');
        if (n.children && n.children.length > 1) {
          c.classList.add('is-fork');
          c.dataset.forkcount = String(n.children.length);
        }
        c.title = (n.versionCount > 1 ? '这是同一处第 ' + (n.versionIndex + 1) + ' 版，共 ' + n.versionCount + ' 版\n' : '') + String(n.text || '').slice(0, 900);

        var line1 = el('div', 'dst-card-top');
        var role = n.virtual ? '断链' : (n.role === 'user' ? '你' : n.role === 'assistant' ? 'DeepSeek' : n.role);
        line1.appendChild(el('span', 'dst-role', role));
        if (n.versionCount > 1) line1.appendChild(el('span', 'dst-ver', '版本 ' + (n.versionIndex + 1) + '/' + n.versionCount));
        if (n.hidden === true) line1.appendChild(el('span', 'dst-flag', '旧版'));
        if (n.source === 'dom') line1.appendChild(el('span', 'dst-flag', '仅页面'));
        var t = fmtTime(n.ts);
        if (t) line1.appendChild(el('span', 'dst-time', t));
        c.appendChild(line1);
        c.appendChild(el('div', 'dst-card-prev', n.previewText || DST.model.preview(n.text)));

        c.addEventListener('click', function () { openDetail(n); });
        cards.appendChild(c);
      });

      var s = tree.stats;
      counts.textContent = s.total + ' 条消息 · ' + s.branchPoints + ' 处分叉 · ' + s.hiddenCount + ' 条被标记为旧版';
      if (ks && !ks.matched) setStatus('筛选后没有节点，取消勾或清空搜索');
      else if (ks) setStatus('命中 ' + ks.matched + ' 条，其余节点暂时隐藏（父链仍保留）');
      else setStatus(data.statusBase || '共 ' + laid.nodes.length + ' 个节点');
    }

    function setStatus(text) { status.textContent = text; }

    function openDetail(n) {
      selectedId = n.id;
      detail.textContent = '';
      detail.style.display = 'block';
      detail.classList.toggle('is-user', n.role === 'user');

      var head = el('div', 'dst-detail-head');
      var role = n.virtual ? '断链节点' : (n.role === 'user' ? '我的提问' : n.role === 'assistant' ? 'DeepSeek 回答' : n.role);
      head.appendChild(el('div', 'dst-detail-title', role));
      var sub = [];
      if (n.versionCount > 1) sub.push('第 ' + (n.versionIndex + 1) + ' 版 / 共 ' + n.versionCount + ' 版');
      if (n.hidden === true) sub.push('当前页面不显示这一版');
      if (n.hidden === false) sub.push('当前页面显示这一版');
      if (n.source === 'dom') sub.push('只从页面抓到，挂在对话末尾，父节点位置可能不准');
      if (n.ts) sub.push(fmtTime(n.ts));
      head.appendChild(el('div', 'dst-detail-sub', sub.join(' · ')));
      var x = el('button', 'dst-btn', '✕');
      x.addEventListener('click', function () { detail.style.display = 'none'; selectedId = null; renderNow(); });
      head.appendChild(x);
      detail.appendChild(head);

      if (n.reasoning) {
        var rz = el('div', 'dst-reason', '（这一版包含思考过程，正文在下方）');
        detail.appendChild(rz);
      }

      var body = el('pre', 'dst-detail-body');
      body.textContent = (n.text || '（这一版没有正文，可能接口没返回内容）');
      detail.appendChild(body);

      var foot = el('div', 'dst-detail-foot');
      function dbtn(label, fn, title) {
        var b = el('button', 'dst-btn', label);
        if (title) b.title = title;
        b.addEventListener('click', fn);
        foot.appendChild(b);
        return b;
      }
      dbtn('复制全文', function () {
        copyText(n.text || '').then(function (ok) { setStatus(ok ? '已复制到剪贴板' : '复制失败：浏览器没允许，可手动选中'); });
      });
      dbtn('在网页中定位', function () { handlers.onLocate && handlers.onLocate(n); }, '滚动到页面上对应的气泡并高亮');
      if (n.hidden === true || n.versionCount > 1) {
        dbtn('切到这一版', function () { handlers.onReveal && handlers.onReveal(n); }, '点 DeepSeek 自己的版本切换按钮，把这一版显示出来');
      }
      detail.appendChild(foot);
      renderNow();
    }

    function copyText(t) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).then(function () { return true; }, fallback);
      } catch (e) {}
      return Promise.resolve().then(function () { return fallback(); });
      function fallback() {
        var ta = el('textarea', 'dst-tmp');
        ta.value = t;
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) {}
        ta.remove();
        return ok;
      }
    }

    function load(payload) {
      // payload: {nodes, chatId, statusBase}
      if (payload.chatId && payload.chatId !== data.chatId) fittedOnce = false;
      var tree = DST.model.buildTree(payload.nodes || []);
      data.tree = tree;
      data.byId = tree.byId;
      data.nodes = tree.ordered;
      data.chatId = payload.chatId || data.chatId;
      data.statusBase = payload.statusBase;
      tree.ordered.forEach(function (n) { n.previewText = DST.model.preview(n.text); });
      renderNow();
      if (payload.width) host.style.width = payload.width + 'px';
      if (!fittedOnce) { fittedOnce = true; fit(); }
    }

    var api = {
      host: host,
      load: load,
      setStatus: setStatus,
      setOpen: setOpen,
      isOpen: function () { return open; },
      toggle: function () { setOpen(!open); },
      fit: fit,
      render: renderNow
    };
    setOpen(true);
    return api;
  }

  DST.drawer = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
