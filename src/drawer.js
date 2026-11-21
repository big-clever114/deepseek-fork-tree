(function (global) {
  'use strict';
  var DST = global.__DST__ = global.__DST__ || {};
  var SVGNS = 'http://www.w3.org/2000/svg';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // Lucide 图形：24 视口、2px 圆头描边、currentColor 着色
  var ICONS = {
    fork: [['circle', { cx: 12, cy: 18, r: 3 }], ['circle', { cx: 6, cy: 6, r: 3 }], ['circle', { cx: 18, cy: 6, r: 3 }],
      ['path', { d: 'M18 9v2a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9' }], ['path', { d: 'M12 13v2' }]],
    refresh: [['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }],
      ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }], ['path', { d: 'M8 16H3v5' }]],
    scan: [['path', { d: 'M3 7V5a2 2 0 0 1 2-2h2' }], ['path', { d: 'M17 3h2a2 2 0 0 1 2 2v2' }],
      ['path', { d: 'M21 17v2a2 2 0 0 1-2 2h-2' }], ['path', { d: 'M7 21H5a2 2 0 0 1-2-2v-2' }], ['path', { d: 'M7 12h10' }]],
    fit: [['path', { d: 'M8 3H5a2 2 0 0 0-2 2v3' }], ['path', { d: 'M21 8V5a2 2 0 0 0-2-2h-3' }],
      ['path', { d: 'M3 16v3a2 2 0 0 0 2 2h3' }], ['path', { d: 'M16 21h3a2 2 0 0 0 2-2v-3' }]],
    diag: [['path', { d: 'M22 12h-4l-3 9L9 3l-3 9H2' }]],
    x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
    search: [['circle', { cx: 11, cy: 11, r: 8 }], ['path', { d: 'm21 21-4.3-4.3' }]],
    plus: [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
    minus: [['path', { d: 'M5 12h14' }]],
    copy: [['rect', { x: 8, y: 8, width: 14, height: 14, rx: 2, ry: 2 }],
      ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }]],
    locate: [['path', { d: 'M2 12h5' }], ['path', { d: 'M17 12h5' }], ['path', { d: 'M12 2v5' }], ['path', { d: 'M12 17v5' }],
      ['circle', { cx: 12, cy: 12, r: 7 }], ['circle', { cx: 12, cy: 12, r: 3 }]],
    swap: [['path', { d: 'm17 2 4 4-4 4' }], ['path', { d: 'M3 11v-1a4 4 0 0 1 4-4h14' }],
      ['path', { d: 'm7 22-4-4 4-4' }], ['path', { d: 'M21 13v1a4 4 0 0 1-4 4H3' }]],
    move: [['path', { d: 'm5 9-3 3 3 3' }], ['path', { d: 'm9 5 3-3 3 3' }], ['path', { d: 'm15 19-3 3-3-3' }],
      ['path', { d: 'm19 9 3 3-3 3' }], ['path', { d: 'M2 12h20' }], ['path', { d: 'M12 2v20' }]],
    split: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M15 4v16' }]]
  };

  function icon(name) {
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('class', 'dst-i');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach(function (sp) {
      var e = document.createElementNS(SVGNS, sp[0]);
      for (var k in sp[1]) e.setAttribute(k, String(sp[1][k]));
      s.appendChild(e);
    });
    return s;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var MIN_ZOOM = 0.02;   // 绝对保险：树很小也别无限缩
  var MAX_ZOOM = 20;

  function create(handlers) {
    handlers = handlers || {};
    var host = el('div', 'dst-host');
    host.id = 'dst-host';

    var tab = el('button', 'dst-tab');
    tab.appendChild(icon('fork'));
    tab.appendChild(el('span', null, '分叉树'));
    tab.title = '显示分叉树';

    var panel = el('aside', 'dst-panel');

    var header = el('header', 'dst-head');
    var brand = el('div', 'dst-brand');
    brand.appendChild(icon('fork'));
    brand.appendChild(el('span', 'dst-title', '分叉树'));
    header.appendChild(brand);
    header.appendChild(el('div', 'dst-spacer'));

    var counts = el('div', 'dst-stats', '还没抓到数据');

    var btns = el('div', 'dst-btns');
    function headBtn(act, label, iconName, extraCls, title) {
      var b = el('button', 'dst-btn' + (extraCls ? ' ' + extraCls : ''), label);
      b.dataset.act = act;
      if (title) b.title = title;
      if (iconName) b.insertBefore(icon(iconName), b.firstChild);
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
    headBtn('refetch', '重新抓取', 'refresh', 'is-primary', '向 DeepSeek 重新要一次完整历史（含被隐藏的旧版本）');

    // 铺开方式：挤开（把页面压到左边）/ 浮层（原来的盖住页面）
    var modeBtn = el('button', 'dst-btn is-quiet');
    modeBtn.dataset.act = 'mode';
    modeBtn.insertBefore(icon('split'), modeBtn.firstChild);
    var modeLabel = el('span', null, '挤开');
    modeBtn.appendChild(modeLabel);
    btns.appendChild(modeBtn);
    modeBtn.addEventListener('click', function () { setMode(mode === 'push' ? 'overlay' : 'push'); });

    headBtn('close', null, 'x', 'is-icon is-quiet', '收起');
    header.appendChild(btns);

    var tools = el('div', 'dst-tools');
    var inputWrap = el('div', 'dst-inputwrap');
    inputWrap.appendChild(icon('search'));
    var search = el('input', 'dst-search');
    search.type = 'search';
    search.placeholder = '在所有版本里搜索文字…';
    inputWrap.appendChild(search);
    tools.appendChild(inputWrap);

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
        // 筛选会换掉整批节点，视图得跟着重新收一次，不然留下的那几个可能在视野外
        fit();
      });
    });
    tools.appendChild(chips);

    var searchTimer = null;
    search.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { renderNow(); fit(); }, 180);
    });

    var bar = el('div', 'dst-bar');
    function headBtnIn(act, label, iconName, title) {
      var b = el('button', 'dst-btn is-quiet', label);
      b.dataset.act = act;
      b.title = title || '';
      b.insertBefore(icon(iconName), b.firstChild);
      b.addEventListener('click', function () {
        if (act === 'fit') fit();
        else if (act === 'sync' && handlers.onSync) handlers.onSync();
        else if (act === 'diag' && handlers.onDiag) handlers.onDiag();
      });
      return b;
    }
    bar.appendChild(headBtnIn('sync', '同步本页', 'scan', '把当前页面上显示的消息并入树'));
    bar.appendChild(headBtnIn('fit', '适配', 'fit', '回到 100% 并把当前这条线的最新一版放进视野；装不下的部分按住拖动'));
    bar.appendChild(headBtnIn('diag', '诊断', 'diag', '复制一份诊断信息，方便反馈问题'));
    var zoomBar = el('div', 'dst-zoom');
    var zOut = el('button', 'dst-btn', null);
    zOut.appendChild(icon('minus'));
    zOut.title = '缩小';
    var zLabel = el('span', 'dst-zlabel', '100%');
    var zIn = el('button', 'dst-btn', null);
    zIn.appendChild(icon('plus'));
    zIn.title = '放大';
    zoomBar.appendChild(zOut);
    zoomBar.appendChild(zLabel);
    zoomBar.appendChild(zIn);
    bar.appendChild(zoomBar);

    var canvas = el('div', 'dst-canvas');
    var inner = el('div', 'dst-inner');
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'dst-svg');
    var cards = el('div', 'dst-cards');
    inner.appendChild(svg);
    inner.appendChild(cards);
    canvas.appendChild(inner);
    var hint = el('div', 'dst-hint');
    hint.appendChild(icon('move'));
    hint.appendChild(el('span', null, '按住拖动平移 · 滚轮缩放'));
    canvas.appendChild(hint);

    var empty = el('div', 'dst-empty');
    var emptyBox = el('div', 'dst-box');
    emptyBox.appendChild(icon('fork'));
    empty.appendChild(emptyBox);
    empty.appendChild(el('div', 'dst-empty-t', '还没抓到这一条对话'));
    empty.appendChild(el('div', 'dst-empty-d', '在网页里点开一条对话，或点上面的「重新抓取」；抓到之后这里会摊开整棵分叉树。'));
    canvas.appendChild(empty);

    var status = el('footer', 'dst-status', '');
    panel.appendChild(header);
    panel.appendChild(counts);
    panel.appendChild(tools);
    panel.appendChild(bar);
    panel.appendChild(canvas);
    panel.appendChild(status);

    var grip = el('div', 'dst-grip');
    grip.title = '拖动改变宽度';

    var detail = el('div', 'dst-detail');
    detail.style.display = 'none';

    var ctxMenu = el('div', 'dst-menu');
    ctxMenu.setAttribute('role', 'menu');
    ctxMenu.style.display = 'none';

    host.appendChild(grip);
    host.appendChild(panel);
    host.appendChild(tab);
    host.appendChild(detail);
    host.appendChild(ctxMenu);

    var open = false;                      // 每次进页面都先折叠，只留右侧标签
    var mode = 'push';                     // 'push' 展开时把页面挤到左边；'overlay' 原来的浮层
    var zoom = 1;
    var panX = 0, panY = 0;
    var data = { roots: [], nodes: [], byId: {}, stats: {}, chatId: null, layout: null };
    var selectedId = null;
    var fittedOnce = false;

    function syncModeBtn() {
      var push = mode === 'push';
      modeLabel.textContent = push ? '挤开' : '浮层';
      var tip = push
        ? '当前：展开时把页面挤到左边；点一下改成「浮层」盖住页面'
        : '当前：浮层盖住页面（保持原来的样子）；点一下改成「挤开」';
      modeBtn.title = tip;
      modeBtn.setAttribute('aria-label', tip);
    }

    // 挤开模式：线上会话页的整屏层可能不在 body 直接子级 ——
    // #root 收窄了，里面的 position:fixed; inset:0 仍按视口算宽度，所以要对整棵页面一起收口
    var pushStyle = null;
    function applyPush() {
      if (!pushStyle) {
        pushStyle = document.createElement('style');
        pushStyle.id = 'dst-push-style';
        (document.head || document.documentElement).appendChild(pushStyle);
      }
      var w = (open && mode === 'push') ? Math.round(host.getBoundingClientRect().width) : 0;
      if (w > 0) {
        var cap = 'calc(100vw - ' + w + 'px)';
        pushStyle.textContent =
          'html{margin-right:' + w + 'px !important;transition:margin-right 200ms ease-out;}' +
          // 普通文档流：body 顶层容器收窄（border-box 让带内边距的根层外框也正好停住）
          'html body > *:not(#dst-host){max-width:' + cap + ' !important;box-sizing:border-box !important;' +
          'transition:max-width 200ms ease-out;}' +
          // 固定定位的整屏层：不管嵌多深，一律封顶到抽屉左边（我们自己的抽屉子树排除在外）
          'html body > *:not(#dst-host) *{max-width:' + cap + ' !important;}' +
          'html body > *:not(#dst-host) *:not(input):not(textarea){transition:max-width 200ms ease-out;}';
      } else {
        // 整条撤掉，别给页面留下我们自己写的 margin / max-width
        pushStyle.textContent = '';
      }
    }

    function setMode(m, quiet) {
      mode = m === 'overlay' ? 'overlay' : 'push';
      syncModeBtn();
      applyPush();
      if (!quiet) { try { chrome.storage.local.set({ 'dst:prefs:mode': mode }); } catch (e) {} }
    }

    function setOpen(v) {
      open = v;
      if (!v) closeCtxMenu();
      panel.classList.toggle('is-open', v);
      grip.classList.toggle('is-open', v);
      tab.classList.toggle('is-hidden', v);
      if (v) renderNow();
      applyPush();
    }

    // ---- 折叠标签：贴着屏幕右边缘上下拖动 ----
    var tabDrag = null, tabMoved = false;
    function tabTopLimit(t) {
      var h = tab.offsetHeight || 70;
      var max = (window.innerHeight || document.documentElement.clientHeight) - h - 8;
      return Math.max(8, Math.min(t, max));
    }
    tab.addEventListener('pointerdown', function (ev) {
      if (open || (ev.button !== undefined && ev.button !== 0)) return;
      tabDrag = { id: ev.pointerId, y: ev.clientY, top: tab.getBoundingClientRect().top };
      tabMoved = false;
      try { tab.setPointerCapture(ev.pointerId); } catch (e) {}
    });
    tab.addEventListener('pointermove', function (ev) {
      if (!tabDrag || ev.pointerId !== tabDrag.id) return;
      var dy = ev.clientY - tabDrag.y;
      if (!tabMoved && Math.abs(dy) < 4) return;
      tabMoved = true;
      tab.classList.add('is-moving');
      tab.style.top = tabTopLimit(tabDrag.top + dy) + 'px';
    });
    function endTabDrag(ev) {
      if (!tabDrag || (ev && ev.pointerId !== tabDrag.id)) return;
      tabDrag = null;
      tab.classList.remove('is-moving');
      if (tabMoved) {
        try { chrome.storage.local.set({ 'dst:prefs:tabY': Math.round(parseFloat(tab.style.top) || 0) }); } catch (e) {}
      }
    }
    tab.addEventListener('pointerup', endTabDrag);
    tab.addEventListener('pointercancel', endTabDrag);
    tab.addEventListener('click', function (ev) {
      // 拖完手指/鼠标抬起时浏览器还会补一次 click，别让它顺手把抽屉打开
      if (tabMoved) { tabMoved = false; ev.preventDefault(); ev.stopImmediatePropagation(); return; }
      setOpen(true);
    });

    zIn.addEventListener('click', function () { setZoom(zoom * 1.2); });
    zOut.addEventListener('click', function () { setZoom(zoom / 1.2); });

    function fmtZoomPct(z) {
      var p = z * 100;
      if (p >= 10) return String(Math.round(p));
      if (p >= 1) return p.toFixed(1);
      return p.toFixed(2);
    }

    function applyTransform() {
      inner.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
      // 缩到全景时：网点比节点还抢眼、文字糊成一片，两者都撤掉，画布读作"一张色块地图"
      var mini = zoom < 0.2;
      inner.classList.toggle('is-mini', mini);
      canvas.style.backgroundImage = mini ? 'none' : '';
      // 网点跟着缩放走：定死 22px 的话，5% 时一个网点比整张卡还大，画布看着就"崩"了
      var g = Math.min(48, Math.max(8, 22 * zoom));
      canvas.style.backgroundSize = g + 'px ' + g + 'px';
      canvas.style.backgroundPosition = panX + 'px ' + panY + 'px';
      zLabel.textContent = fmtZoomPct(zoom) + '%';
    }

    // 整棵树正好铺满画布所需的缩放
    function fitZoom() {
      var l = data.layout;
      var cw = canvas.clientWidth, ch = canvas.clientHeight;
      if (!l || !l.width || !l.height || !cw || !ch) return MIN_ZOOM;
      return Math.min((cw - 40) / l.width, (ch - 40) / l.height);
    }

    function zoomFloor() {
      return Math.max(0.001, Math.min(MIN_ZOOM, fitZoom() * 0.6));
    }

    function clampPan() {
      var l = data.layout;
      var cw = canvas.clientWidth, ch = canvas.clientHeight;
      var keep = 80;
      var w = l ? l.width * zoom : 0;
      var h = l ? l.height * zoom : 0;
      // 整个世界比画布还小时，别再用"至少留 80px"那套：那样全景会歪在一角，看着像坏了
      if (w <= cw) panX = (cw - w) / 2;
      else panX = Math.min(cw - keep, Math.max(keep - w, panX));
      if (h <= ch) panY = (ch - h) / 2;
      else panY = Math.min(ch - keep, Math.max(keep - h, panY));
    }

    // ax/ay：以画布内哪个像素为缩放锚点（不传就用视口中心）
    function setZoom(z, ax, ay) {
      var next = Math.min(MAX_ZOOM, Math.max(zoomFloor(), z));
      if (next === zoom) return;
      if (ax === undefined) { ax = canvas.clientWidth / 2; ay = canvas.clientHeight / 2; }
      panX = ax - (ax - panX) * (next / zoom);
      panY = ay - (ay - panY) * (next / zoom);
      zoom = next;
      clampPan();
      applyTransform();
    }

    function fit() {
      var l = data.layout;
      if (!l) return;
      var cw = canvas.clientWidth, ch = canvas.clientHeight;
      var padX = 28, padY = 28;
      // 不为了"塞进画面"而自动缩小：中文一缩就糊，装不下的部分靠拖；要看全局用滚轮自己缩
      zoom = 1;
      var leaf = null;
      l.nodes.forEach(function (n) {
        if (n.onActivePath && !n.virtual && (!leaf || n.y > leaf.y)) leaf = n;
      });
      var worldW = l.width * zoom, worldH = l.height * zoom;
      if (worldW <= cw - padX) panX = (cw - worldW) / 2;
      else panX = cw / 2 - (leaf ? leaf.x : l.width / 2) * zoom;
      if (worldH <= ch - padY) panY = (ch - worldH) / 2;
      else panY = ch - 150 - ((leaf ? leaf.y : 0) + DST.SIZE.NODE_H) * zoom;
      clampPan();
      applyTransform();
    }

    // ---- 画布拖拽平移（思维导图式）----
    // 这里不能用 setPointerCapture：捕获一开，浏览器就把这次手势随后的 click 改嫁到画布上，
    // 卡片自己的 click 监听永远收不到，表现就是"点任何节点都没反应"（0.1.7 及之前踩的坑）。
    // 改成挂在 window 上的常驻监听：光标拖出画布、拖出抽屉都还在继续平移。
    var drag = null, suppressClick = false;
    canvas.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      suppressClick = false;   // 上一回拖动若没等到 click，这里兜住，别把这一次真点击也吞了
      drag = { lx: ev.clientX, ly: ev.clientY, moved: false, id: ev.pointerId };
    });
    window.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var dx = ev.clientX - drag.lx, dy = ev.clientY - drag.ly;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        canvas.classList.add('is-panning');
      }
      panX += dx;
      panY += dy;
      drag.lx = ev.clientX;
      drag.ly = ev.clientY;
      clampPan();
      applyTransform();
    });
    function endDrag(ev) {
      if (!drag || (ev && ev.pointerId !== drag.id)) return;
      var moved = drag.moved;
      drag = null;
      canvas.classList.remove('is-panning');
      if (moved) suppressClick = true;   // 这一串事件是拖动，不算「点节点」
    }
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    // 真的拖动过就不算「点节点」：捕获阶段拦掉，事件不会传到卡片上
    canvas.addEventListener('click', function (ev) {
      if (!suppressClick) return;
      suppressClick = false;
      ev.stopPropagation();
      ev.preventDefault();
    }, true);

    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      closeCtxMenu();
      // 滚轮＝缩放（以光标为锚点）；平移交给按住拖动。deltaMode=1 时 deltaY 的单位是"行"
      var unit = ev.deltaMode === 1 ? 16 : (ev.deltaMode === 2 ? 100 : 1);
      setZoom(zoom * Math.exp(-ev.deltaY * unit * 0.0016), ev.clientX - canvas.getBoundingClientRect().left, ev.clientY - canvas.getBoundingClientRect().top);
    }, { passive: false });

    // 右键卡片 → 插件自己的快捷菜单；画布空白处仍交给浏览器
    canvas.addEventListener('contextmenu', function (ev) {
      var card = ev.target && ev.target.closest ? ev.target.closest('.dst-card') : null;
      if (!card || !cards.contains(card)) return;
      ev.preventDefault();
      var node = data.byId[card.dataset.id];
      if (node) openCtxMenu(node, card, ev.clientX, ev.clientY);
    });
    // 菜单外按下、Esc、滚轮都关掉菜单
    window.addEventListener('pointerdown', function (ev) {
      if (ctxMenu.style.display === 'none') return;
      if (ev.target && ev.target.closest && ev.target.closest('.dst-menu')) return;
      closeCtxMenu();
    }, true);
    window.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeCtxMenu();
    });
    ctxMenu.addEventListener('wheel', function () { closeCtxMenu(); }, { passive: true });

    // ---- 拖宽 ----
    (function () {
      var dragging = false, startX = 0, startW = 0;
      grip.addEventListener('mousedown', function (ev) {
        if (!open) return;                 // 折叠时不响应，避免在页面中间"抓空气"
        dragging = true;
        startX = ev.clientX;
        startW = host.getBoundingClientRect().width;
        ev.preventDefault();
      });
      window.addEventListener('mousemove', function (ev) {
        if (!dragging) return;
        var w = Math.min(window.innerWidth * 0.85, Math.max(320, startW - (ev.clientX - startX)));
        host.style.width = w + 'px';
        applyPush();                       // 挤开模式下页面跟着一起收窄
      });
      window.addEventListener('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        try { chrome.storage.local.set({ 'dst:prefs:width': Math.round(host.getBoundingClientRect().width) }); } catch (e) {}
        renderNow();
        // 抽屉变窄后只收口、不重新取景：用户手动拖到的位置不该被抹掉
        clampPan();
        applyTransform();
        applyPush();
      });
      window.addEventListener('resize', function () {
        if (tab.style.top) tab.style.top = tabTopLimit(parseFloat(tab.style.top) || 0) + 'px';
        applyPush();
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

    function setStats(s) {
      counts.textContent = '';
      if (!s.total) { counts.textContent = '还没抓到数据'; return; }
      counts.appendChild(stat('is-total', s.total, '条消息'));
      counts.appendChild(stat('is-fork', s.branchPoints, '处分叉'));
      counts.appendChild(stat('is-old', s.hiddenCount, '条旧版'));
    }
    function stat(cls, n, label) {
      var box = el('span', 'dst-stat ' + cls);
      box.appendChild(el('span', 'dot'));
      box.appendChild(el('b', null, String(n)));
      box.appendChild(el('span', null, label));
      return box;
    }

    function renderNow() {
      closeCtxMenu();
      var tree = data.tree;
      cards.textContent = '';
      svg.textContent = '';
      if (!tree || !tree.roots.length) {
        empty.style.display = 'flex';
        setStats({ total: 0, branchPoints: 0, hiddenCount: 0 });
        setStatus('没有节点');
        return;
      }
      empty.style.display = 'none';
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
        var path = document.createElementNS(SVGNS, 'path');
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

      setStats(tree.stats);
      if (ks && !ks.matched) setStatus('筛选后没有节点，取消勾或清空搜索');
      else if (ks) setStatus('命中 ' + ks.matched + ' 条，其余节点暂时隐藏（父链仍保留）');
      else setStatus(data.statusBase || '共 ' + laid.nodes.length + ' 个节点');
    }

    function setStatus(text) { status.textContent = text; }

    function openDetail(n) {
      selectedId = n.id;
      detail.textContent = '';
      detail.style.display = 'flex';
      detail.classList.toggle('is-user', n.role === 'user');

      var head = el('div', 'dst-detail-head');
      var headTxt = el('div');
      var role = n.virtual ? '断链节点' : (n.role === 'user' ? '我的提问' : n.role === 'assistant' ? 'DeepSeek 回答' : n.role);
      headTxt.appendChild(el('div', 'dst-detail-title', role));
      var sub = [];
      if (n.versionCount > 1) sub.push('第 ' + (n.versionIndex + 1) + ' 版 / 共 ' + n.versionCount + ' 版');
      if (n.hidden === true) sub.push('当前页面不显示这一版');
      if (n.hidden === false) sub.push('当前页面显示这一版');
      if (n.hidden === null) sub.push('不确定这一版是否还在页面上');
      if (n.source === 'dom') sub.push('只从页面抓到，挂在对话末尾，父节点位置可能不准');
      if (n.ts) sub.push(fmtTime(n.ts));
      headTxt.appendChild(el('div', 'dst-detail-sub', sub.join(' · ')));
      head.appendChild(headTxt);
      var x = el('button', 'dst-btn is-icon is-quiet');
      x.appendChild(icon('x'));
      x.title = '关闭';
      x.addEventListener('click', function () { detail.style.display = 'none'; selectedId = null; renderNow(); });
      head.appendChild(x);
      detail.appendChild(head);

      if (n.reasoning) {
        detail.appendChild(el('div', 'dst-reason', '（这一版包含思考过程，正文在下方）'));
      }

      var body = el('pre', 'dst-detail-body');
      body.textContent = (n.text || '（这一版没有正文，可能接口没返回内容）');
      detail.appendChild(body);

      var foot = el('div', 'dst-detail-foot');
      function dbtn(label, iconName, fn, title) {
        var b = el('button', 'dst-btn', label);
        if (iconName) b.insertBefore(icon(iconName), b.firstChild);
        if (title) b.title = title;
        b.addEventListener('click', fn);
        foot.appendChild(b);
        return b;
      }
      dbtn('复制全文', 'copy', function () {
        copyText(n.text || '').then(function (ok) { setStatus(ok ? '已复制到剪贴板' : '复制失败：浏览器没允许，可手动选中'); });
      });
      dbtn('在网页中定位', 'locate', function () { handlers.onLocate && handlers.onLocate(n); }, '滚动到页面上对应的气泡并高亮');
      if (n.hidden === true || n.versionCount > 1) {
        dbtn('切到这一版', 'swap', function () { handlers.onReveal && handlers.onReveal(n); }, '按轮次点 DeepSeek 自己的版本切换按钮，把页面上整条线换成这一版所在的那条分支');
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

    // ---- 右键快捷菜单 ----
    function roleLabel(n) {
      return n.virtual ? '断链' : (n.role === 'user' ? '你' : n.role === 'assistant' ? 'DeepSeek' : n.role);
    }

    function pathText(n) {
      var chain = [], cur = n, guard = 0;
      while (cur && guard++ < 1000) {
        var t = String(cur.text || '').replace(/\s+/g, ' ').trim();
        chain.push(roleLabel(cur) + '：' + (t ? t.slice(0, 20) : '（无正文）'));
        cur = cur.parentId ? data.byId[cur.parentId] : null;
      }
      return chain.reverse().join(' → ');
    }

    function closeCtxMenu() {
      if (ctxMenu.style.display === 'none') return;
      ctxMenu.style.display = 'none';
    }

    function openCtxMenu(n, card, x, y) {
      // 选中态直接改卡片 class：renderNow 会关菜单，不能在这里重渲染
      Array.prototype.forEach.call(cards.querySelectorAll('.dst-card.is-selected'), function (c) { c.classList.remove('is-selected'); });
      card.classList.add('is-selected');
      selectedId = n.id;

      ctxMenu.textContent = '';
      function item(label, iconName, fn, disabled) {
        var b = el('button', 'dst-menu-item');
        b.setAttribute('role', 'menuitem');
        b.appendChild(icon(iconName));
        b.appendChild(el('span', null, label));
        if (disabled) b.disabled = true;
        else b.addEventListener('click', function () { closeCtxMenu(); fn(); });
        ctxMenu.appendChild(b);
      }
      item('定位到这一版', 'locate', function () { handlers.onLocate && handlers.onLocate(n); });
      item('切到这一版', 'swap', function () { handlers.onReveal && handlers.onReveal(n); }, !(n.hidden === true && !n.virtual));
      ctxMenu.appendChild(el('div', 'dst-menu-sep'));
      item('复制消息内容', 'copy', function () {
        copyText(n.text || '').then(function (ok) { setStatus(ok ? '已复制这条消息' : '复制失败，请手动选中文本'); });
      }, !String(n.text || '').trim());
      item('复制分支路径', 'fork', function () {
        copyText(pathText(n)).then(function (ok) { setStatus(ok ? '已复制分支路径' : '复制失败，请手动选中文本'); });
      });

      ctxMenu.style.display = 'block';
      ctxMenu.style.left = '0px';
      ctxMenu.style.top = '0px';
      var mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
      var left = x, top = y;
      if (x + mw + 8 > window.innerWidth) left = x - mw;
      if (y + mh + 8 > window.innerHeight) top = y - mh;
      left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - mh - 8));
      ctxMenu.style.left = Math.round(left) + 'px';
      ctxMenu.style.top = Math.round(top) + 'px';
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
      applyTransform();
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
    syncModeBtn();
    try {
      chrome.storage.local.get(['dst:prefs:width', 'dst:prefs:tabY', 'dst:prefs:mode'], function (r) {
        if (!r) return;
        if (r['dst:prefs:width']) host.style.width = r['dst:prefs:width'] + 'px';
        if (typeof r['dst:prefs:tabY'] === 'number') tab.style.top = tabTopLimit(r['dst:prefs:tabY']) + 'px';
        if (r['dst:prefs:mode'] === 'overlay' || r['dst:prefs:mode'] === 'push') setMode(r['dst:prefs:mode'], true);
        applyPush();
      });
    } catch (e) {}
    setOpen(false);
    applyTransform();
    return api;
  }

  DST.drawer = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
