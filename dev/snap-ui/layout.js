(function (global) {
  'use strict';
  var DST = global.__DST__ = global.__DST__ || {};

  var NODE_W = 208;
  var NODE_H = 56;
  var GAP_X = 24;
  var GAP_Y = 40;

  function layout(roots, visibleFilter) {
    var cursor = 0;
    var maxY = 0;
    var placed = [];
    var edges = [];

    function place(n, depth) {
      n.depth = depth;
      n.y = 16 + depth * (NODE_H + GAP_Y);
      var kids = (n.children || []).filter(function (c) { return !visibleFilter || visibleFilter(c); });
      if (!kids.length) {
        n.x = cursor + NODE_W / 2;
        cursor += NODE_W + GAP_X;
      } else {
        kids.forEach(function (c) { place(c, depth + 1); });
        n.x = (kids[0].x + kids[kids.length - 1].x) / 2;
      }
      if (n.y > maxY) maxY = n.y;
      placed.push(n);
    }

    roots.forEach(function (r, i) {
      if (i) cursor += GAP_X * 2;
      place(r, 0);
    });

    placed.forEach(function (n) {
      (n.children || []).forEach(function (c) {
        if (c.depth === undefined || c.depth !== n.depth + 1) return;
        edges.push({ from: n, to: c, x1: n.x, y1: n.y + NODE_H, x2: c.x, y2: c.y });
      });
    });

    return { nodes: placed, edges: edges, width: Math.max(cursor + NODE_W, 320), height: maxY + NODE_H + 40, NODE_W: NODE_W, NODE_H: NODE_H };
  }

  DST.layout = layout;
  DST.SIZE = { NODE_W: NODE_W, NODE_H: NODE_H };
})(typeof window !== 'undefined' ? window : globalThis);
