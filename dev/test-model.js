// 离线断言：喂假接口返回，检查归一化、建树、版本编号、当前路径、布局坐标。
// 运行：node dev/test-model.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

global.window = global;
const root = path.join(__dirname, '..');
['src/model.js', 'src/layout.js', 'dev/fixture.js'].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
});

var DST = window.__DST__;
var fails = 0;
function check(name, got, want) {
  var ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '\n      got: ' + JSON.stringify(got) + '\n     want: ' + JSON.stringify(want)));
}

var ing = DST.model.ingest(JSON.stringify(FIXTURE_HISTORY));
check('DeepSeek 形状返回 → 认出 12 条', ing.nodes.length, 12);
check('解析无错误', ing.error, null);
check('chatId 拿到', ing.chatId, 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff');

var byId = {};
ing.nodes.forEach(function (n) { byId[n.id] = n; });
check('content 是对象时取到 text', byId.a1v2.text.indexOf('errgroup.SetLimit') > -1, true);
check('content 是数组时取到 text', byId.a2b.text.indexOf('runSafe') > -1, true);
check('隐藏标记：a1v1=true', byId.a1v1.hidden, true);
check('隐藏标记：a1v3=false', byId.a1v3.hidden, false);
check('秒转毫秒', byId.u1.ts, 1730000000000);
check('父节点：a1v2 → u1', byId.a1v2.parentId, 'u1');
check('根节点无父', byId.u1.parentId, '');

var tree = DST.model.buildTree(ing.nodes);
check('总节点数', tree.stats.total, 12);
check('分叉处数量（u1 / a1v3 / u3）', tree.stats.branchPoints, 3);
check('被标记旧版数量', tree.stats.hiddenCount, 6);
check('两个根（正常根 + 断链虚拟根）', tree.roots.length, 2);
check('断链虚拟根有子', tree.roots.filter(function (r) { return r.virtual; })[0].children.length, 1);
check('a1v3 有 3 个版本', [byId.a1v1, byId.a1v2, byId.a1v3].map(function (n) { return n.versionCount; }), [3, 3, 3]);
check('a1v1/v2/v3 序号 0/1/2', [byId.a1v1, byId.a1v2, byId.a1v3].map(function (n) { return n.versionIndex; }), [0, 1, 2]);
check('被编辑的提问 u2a/u2b 互为 2 版', [byId.u2a.versionCount, byId.u2b.versionCount], [2, 2]);

var onPath = tree.ordered.filter(function (n) { return n.onActivePath && !n.virtual; }).map(function (n) { return n.id; });
check('当前显示路径', onPath, ['u1', 'a1v3', 'u2b', 'a2b', 'u3', 'a3v2']);
check('隐藏版本不在路径上', byId.a1v1.onActivePath, false);

var laid = DST.layout(tree.roots, function () { return true; });
check('布局节点数 = 树节点数', laid.nodes.length, tree.ordered.length);
check('布局宽度为正', laid.width > 300, true);
check('布局高度为正', laid.height > 300, true);
check('没有 NaN 坐标', laid.nodes.some(function (n) { return !isFinite(n.x) || !isFinite(n.y); }), false);
check('同一层节点不横向重叠', (function () {
  var rows = {};
  laid.nodes.forEach(function (n) { (rows[n.y] = rows[n.y] || []).push(n); });
  return Object.keys(rows).every(function (y) {
    var r = rows[y].slice().sort(function (a, b) { return a.x - b.x; });
    return r.every(function (n, i) { return i === 0 || n.x - DST.SIZE.NODE_W / 2 >= r[i - 1].x + DST.SIZE.NODE_W / 2 - 0.01; });
  });
})(), true);
check('父子层间距正确', laid.nodes.every(function (n) { return n.y === 16 + n.depth * (DST.SIZE.NODE_H + 40); }), true);

var alt = DST.model.ingest(JSON.stringify(FIXTURE_ALT));
check('改字段名的返回也能认出 2 条', alt.nodes.length, 2);
var altTree = DST.model.buildTree(alt.nodes);
check('改字段名后父子关系正确', altTree.stats.total, 2);
check('改字段名后只有一根', altTree.roots.length, 1);

check('垃圾输入不抛错', (function () {
  try {
    DST.model.ingest('<html>not json</html>');
    DST.model.ingest('null');
    DST.model.ingest(JSON.stringify({ data: { list: [{ id: 1, role: 'x' }] } }));
    DST.model.buildTree([]);
    DST.layout([], null);
    return true;
  } catch (e) { return String(e); }
})(), true);

// 线上实测到的两种真实形态：全量历史 vs 命中客户端缓存的几百字节桩
check('缓存桩里没有消息时不硬凑节点', DST.model.ingest(JSON.stringify({ code: 0, data: { chat_session_id: 'x', cache_hit: true, has_more: false, messages: [] } })).nodes.length, 0);
var shapeStub = DST.model.shape(JSON.stringify({ code: 0, data: { chat_session_id: 'x', cache_hit: true, messages: [] } }));
check('骨架第一行报出顶层键', shapeStub[0], '$: obj{code,data}');
check('骨架能标出空数组', shapeStub.some(function (l) { return /messages: arr\(0\)/.test(l); }), true);
var shapeFull = DST.model.shape(JSON.stringify(FIXTURE_HISTORY));
check('骨架里消息数组带条数', shapeFull.some(function (l) { return /messages\[\]: obj\{/.test(l); }), true);
check('骨架不含任何聊天原文', shapeFull.some(function (l) { return /重新生成|你好|帮我/.test(l); }), false);
check('骨架里字符串只报长度', shapeFull.some(function (l) { return /: str\(\d+\)$/.test(l); }), true);

// ---- 第二轮线上诊断实测到的信封：data.biz_data.chat_messages + 数字 id ----
var biz = DST.model.ingest(JSON.stringify(FIXTURE_BIZ));
check('biz_data 信封认出 7 条（数字 id 不再是障碍）', biz.nodes.length, 7);
check('biz_data 信封没有解析错误', biz.error, null);
check('chatId 取自 data.biz_data.chat_session.id', biz.chatId, 'cb4b7e18-498c-4ed7-9c29-2cc735da0705');
var bById = {};
biz.nodes.forEach(function (n) { bById[n.id] = n; });
check('数字 id 归一化成字符串', bById['201'].id, '201');
check('数字父 id 归一化成字符串', bById['201'].parentId, '101');
check('message_type 当角色用', bById['201'].role, 'assistant');
check('content 字符串直接取', bById['101'].text.indexOf('帮我看看') > -1, true);
check('content 对象取 text', bById['202'].text.indexOf('goroutine 泄漏') > -1, true);
check('is_not_last_displayed → 隐藏', [bById['201'].hidden, bById['202'].hidden], [true, false]);
var bizTree = DST.model.buildTree(biz.nodes);
check('biz 树只有一个根', bizTree.roots.length, 1);
check('biz 树分叉处 = 2（101 出 2 版、102 出 3 版）', bizTree.stats.branchPoints, 2);
check('biz 树旧版数 = 3', bizTree.stats.hiddenCount, 3);
check('102 那一组有 3 个版本', [bById['203'].versionCount, bById['204'].versionCount, bById['205'].versionCount], [3, 3, 3]);
check('biz 当前路径走隐藏标记', bizTree.ordered.filter(function (n) { return n.onActivePath && !n.virtual; }).map(function (n) { return n.id; }), ['101', '202', '102', '205']);

var bizShape = DST.model.shape(JSON.stringify(FIXTURE_BIZ));
check('骨架报出 biz_data.chat_messages 条数', bizShape.some(function (l) { return /data\.biz_data\.chat_messages: arr\(7\)/.test(l); }), true);
check('骨架不含聊天原文', bizShape.some(function (l) { return /帮我看看|goroutine 泄漏|超时/.test(l); }), false);

var bizCand = DST.model.candidates(JSON.stringify(FIXTURE_BIZ));
var msgCand = bizCand.filter(function (c) { return /chat_messages$/.test(c.path); })[0];
check('候选清单里能找到消息数组', !!msgCand, true);
check('候选清单给出条数', msgCand && msgCand.count, 7);
check('候选清单给出真实键名', msgCand && ['id', 'parent_message_id', 'message_type', 'content', 'created_at'].every(function (k) { return k in msgCand.keys; }), true);
check('候选清单标明 id 是数字', msgCand && msgCand.keys.id, 'number');
check('候选清单不含任何聊天原文', JSON.stringify(bizCand).indexOf('帮我看看') === -1, true);

// ---- 流式返回：之前当成 JSON 解析才有那 5 条 Unexpected token 'e' ----
check('整包 SSE 直接 JSON.parse 确实会失败（这就是旧报错的来源）', !!DST.model.ingest(FIXTURE_SSE).error, true);
var chunks = DST.model.ssePayloads(FIXTURE_SSE);
check('按 data: 行拆出 3 段', chunks.length, 3);
var sseIn = DST.model.ingest(JSON.stringify(chunks));
check('流式里认出刚生成的那一版', sseIn.nodes.length, 1);
check('流式那版的 id/父/角色都对', [sseIn.nodes[0].id, sseIn.nodes[0].parentId, sseIn.nodes[0].role], ['1008', '1006', 'assistant']);
check('流式那版的正文也从 fragments 取到', sseIn.nodes[0].text, '流式里刚诞生的那一版。');
check('流式增量包（只有 delta）不会被硬当成消息', sseIn.nodes.some(function (n) { return n.id === 'undefined'; }), false);
check('ssePayloads 对非流式文本不抛错', DST.model.ssePayloads('{"a":1}').length, 0);
check('ssePayloads 跳过 [DONE]', DST.model.ssePayloads('data: [DONE]\n\ndata: {"id":9,"role":"user","content":"x"}').length, 1);

// ---- 会话归属：只有真拿到 chatId 才不会把两条对话并成一棵树 ----
check('老形状 chatId 仍能取到', DST.model.findChatId(FIXTURE_HISTORY), 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff');
check('缓存桩里没有 chatId 也不抛错', DST.model.findChatId({ code: 0, data: { messages: [] } }), null);

// ---- 第三轮线上诊断：真字段名 message_id / parent_id / fragments[].content / current_message_id ----
var live = DST.model.ingest(JSON.stringify(FIXTURE_LIVE));
check('线上真结构认出 7 条', live.nodes.length, 7);
check('线上真结构没有解析错误', live.error, null);
check('线上 chatId 取自 chat_session.id', live.chatId, '5635bcd5-51b6-4c7d-8082-8d6d71cb8efc');
check('线上当前版本指针取自 current_message_id', live.currentMessageId, '1007');
var lById = {};
live.nodes.forEach(function (n) { lById[n.id] = n; });
check('字段提示报出真实键名', [live.nodes[0].fieldHints.id, lById['1004'].fieldHints.parent], ['message_id', 'parent_id']);
check('正文从 fragments 里取到', lById['1001'].text, '甲');
check('回答正文也取到', lById['1005'].text, '回答乙第二版');
check('思考链归 reasoning、不混进正文', [lById['1002'].text, lById['1002'].reasoning], ['回答甲一', '先想想甲是什么意思']);
check('检索/引用块不算正文', lById['1007'].text, '回答丙一');
check('没有一条是空文本', live.nodes.filter(function (n) { return !n.text; }).length, 0);
check('inserted_at 认作时间', lById['1001'].ts, 1730000001000);
check('父指针正确（1004/1005 同父 1003）', [lById['1004'].parentId, lById['1005'].parentId], ['1003', '1003']);
check('编辑出来的两个提问都是根', [lById['1001'].parentId, lById['1003'].parentId], ['', '']);
check('current_message_id 反推出旧版：1001/1002/1004 是旧版',
  [lById['1001'].hidden, lById['1002'].hidden, lById['1004'].hidden], [true, true, true]);
check('当前路径上的都不是旧版',
  [lById['1003'].hidden, lById['1005'].hidden, lById['1006'].hidden, lById['1007'].hidden], [false, false, false, false]);
var liveTree = DST.model.buildTree(live.nodes);
check('线上形状：两个根（编辑出的两版提问各自成根）', liveTree.roots.length, 2);
check('线上形状：1 处分叉（1003 出 2 版回答）', liveTree.stats.branchPoints, 1);
check('线上形状：3 条旧版', liveTree.stats.hiddenCount, 3);
check('线上当前路径', liveTree.ordered.filter(function (n) { return n.onActivePath && !n.virtual; }).map(function (n) { return n.id; }),
  ['1003', '1005', '1006', '1007']);
check('版本序号按时间排（1004 是第 1 版、1005 是第 2 版）',
  [lById['1004'].versionIndex, lById['1005'].versionIndex, lById['1004'].versionCount], [0, 1, 2]);

// 当前版本指针不在返回里时，不能瞎标旧版
var noCur = JSON.parse(JSON.stringify(FIXTURE_LIVE));
noCur.data.biz_data.chat_session.current_message_id = 9999;
check('当前指针指向返回里没有的消息 → 不硬标旧版',
  DST.model.ingest(JSON.stringify(noCur)).nodes.filter(function (n) { return n.hidden === true; }).length, 0);
// 显式的旧版标记优先于反推
var withFlag = JSON.parse(JSON.stringify(FIXTURE_LIVE));
withFlag.data.biz_data.chat_messages[3].is_not_last_displayed = false;
check('接口自己带了隐藏标记就不覆盖',
  DST.model.ingest(JSON.stringify(withFlag)).nodes.filter(function (n) { return n.id === '1004'; })[0].hidden, false);
check('后到的返回能纠正旧的隐藏标记', DST.model.merge(
  [{ id: '1', parentId: '', role: 'user', text: 'a', reasoning: '', ts: 1, hidden: true, source: 'api' }],
  [{ id: '1', parentId: '', role: 'user', text: 'a', reasoning: '', ts: 1, hidden: false, source: 'api' }]
)[0].hidden, false);

var liveShape = DST.model.shape(JSON.stringify(FIXTURE_LIVE));
check('骨架能看到 fragments 这一层', liveShape.some(function (l) { return /chat_messages\[\]\.fragments: arr\(\d\)/.test(l); }), true);
check('骨架不含聊天原文', liveShape.some(function (l) { return /回答乙|先想想|检索到/.test(l); }), false);
var liveCand = DST.model.candidates(JSON.stringify(FIXTURE_LIVE));
var liveMsgCand = liveCand.filter(function (c) { return /chat_messages$/.test(c.path); })[0];
check('候选清单给出线上真实键名', liveMsgCand && ['message_id', 'parent_id', 'role', 'fragments', 'inserted_at'].every(function (k) { return k in liveMsgCand.keys; }), true);
var fragCand = liveCand.filter(function (c) { return /fragments$/.test(c.path); })[0];
check('候选清单也给出 fragments 的键名', fragCand && ['type', 'content'].every(function (k) { return k in fragCand.keys; }), true);

// ---- 第四轮线上诊断：客户端配置返回被当成消息，树里长出"不属于当前对话的分支" ----
var junk = DST.model.ingest(JSON.stringify(FIXTURE_SETTINGS));
check('settings 配置返回一个节点都不许产生', junk.nodes.length, 0);
check('配置里的提示词模板不算消息', DST.model.looksLikeMessage({ id: 1, type: 'REQUEST', content: '模板文字' }), false);
check('父指针键存在即算消息（根消息的值是 null）',
  DST.model.looksLikeMessage({ message_id: 5, parent_id: null, role: 'user', fragments: [] }), true);
check('没有父指针但角色是已知取值 → 仍算消息（流式增量常见）',
  DST.model.looksLikeMessage({ message_id: 6, role: 'assistant', fragments: [] }), true);
check('配置项的 id 不会撞进真消息里', (function () {
  var merged = DST.model.merge(live.nodes, junk.nodes);
  return [merged.length, merged.filter(function (n) { return n.id === '1001'; })[0].text];
})(), [7, '甲']);
check('脏节点（角色 unknown、无父）过不了 isChatNode',
  DST.model.isChatNode({ id: '1', parentId: '', role: 'unknown', source: 'api' }), false);
check('真根消息（角色 user、无父）过得了 isChatNode',
  DST.model.isChatNode({ id: '1001', parentId: '', role: 'user', source: 'api' }), true);
check('页面抓取来的节点（角色可能猜错）不误删',
  DST.model.isChatNode({ id: 'dom:x', parentId: '', role: 'unknown', source: 'dom' }), true);

// 当前指针移动后要能整体重算，而不是只补 null
var moved = JSON.parse(JSON.stringify(live.nodes));
DST.model.markActiveChain(moved, '1007');
check('指针在 1007 时：1003 这条分支是当前路径', moved.filter(function (n) { return n.id === '1003'; })[0].hidden, false);
DST.model.markActiveChain(moved, '1002');
check('指针移到 1002 后：1003 那支整体改判为旧版', moved.filter(function (n) { return n.id === '1003'; })[0].hidden, true);
check('指针移动后 1001/1002 回到当前路径',
  moved.filter(function (n) { return n.id === '1001' || n.id === '1002'; }).map(function (n) { return n.hidden; }), [false, false]);
check('接口自带的标记不被反推改写', (function () {
  var withFlag2 = JSON.parse(JSON.stringify(live.nodes));
  withFlag2.forEach(function (n) { if (n.id === '1003') { n.hidden = false; n.hiddenSrc = 'flag'; } });
  DST.model.markActiveChain(withFlag2, '1002');
  return withFlag2.filter(function (n) { return n.id === '1003'; })[0].hidden;
})(), false);

// 刚流式生成的那一版：指针还没跟上，不能判成旧版
var withSse = DST.model.merge(JSON.parse(JSON.stringify(live.nodes)), sseIn.nodes);
DST.model.markActiveChain(withSse, '1007');
var fresh = withSse.filter(function (n) { return n.id === '1008'; })[0];
check('比当前指针还新的那版不标旧版（hidden 留 null）', fresh.hidden, null);
check('比当前指针还新的那版仍算节点', !!fresh, true);

console.log(fails ? '\n' + fails + ' 项失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
