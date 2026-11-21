// 一份「长得像 DeepSeek 网页接口」的假返回，用来离线验证归一化 / 建树 / 渲染。
// 结构对应真实痛点：一条提问被重新生成 3 次、一次提问被编辑成 2 版。
var FIXTURE_HISTORY = {
  code: 0,
  msg: 'success',
  data: {
    chat_id: 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff',
    total: 12,
    messages: [
      {
        unique_id: 'u1', parent_message_id: null, role: 'user',
        content: '帮我写一个 Go 的 goroutine 池，要求能限流。',
        create_time: 1730000000, is_not_last_displayed: false,
        model: 'deepseek_chat', role_content_index: 0
      },
      {
        unique_id: 'a1v1', parent_message_id: 'u1', role: 'assistant',
        content: { text: '可以用 channel 做信号量：sem := make(chan struct{}, N)。每次提交前 sem <- struct{}{}，worker 结束时 <-sem。', reasoning_content: '' },
        create_time: 1730000060, is_not_last_displayed: true
      },
      {
        unique_id: 'a1v2', parent_message_id: 'u1', role: 'assistant',
        content: { text: '直接上 errgroup.SetLimit(N) 最省事，不用自己写 worker。', reasoning_content: '' },
        create_time: 1730000120, is_not_last_displayed: true
      },
      {
        unique_id: 'a1v3', parent_message_id: 'u1', role: 'assistant',
        content: { text: '完整实现：Worker struct 持有 jobs/errs channel，NewPool(size) 起 size 个 goroutine，Submit(fn) 带背压，Wait() 收口错误。下面给出可直接跑的代码。', reasoning_content: '' },
        create_time: 1730000180, is_not_last_displayed: false
      },
      {
        unique_id: 'u2a', parent_message_id: 'a1v3', role: 'user',
        content: '那要是任务会 panic 呢？',
        create_time: 1730000240, is_not_last_displayed: true
      },
      {
        unique_id: 'a2a', parent_message_id: 'u2a', role: 'assistant',
        content: { text: '在 worker 循环里 defer recover() 就行。' },
        create_time: 1730000300, is_not_last_displayed: true
      },
      {
        unique_id: 'u2b', parent_message_id: 'a1v3', role: 'user',
        content: '那要是任务会 panic，而且我还想拿到每个任务的结果呢？',
        create_time: 1730000360, is_not_last_displayed: false
      },
      {
        unique_id: 'a2b', parent_message_id: 'u2b', role: 'assistant',
        content: [
          { type: 'text', text: '把 Submit 改成泛型 Submit[T any](fn func() (T, error)) 并返回 <-chan Result[T]；worker 内部 runSafe 包一层 defer recover，panic 转成 error 一起回传。' }
        ],
        create_time: 1730000420, is_not_last_displayed: false
      },
      {
        unique_id: 'u3', parent_message_id: 'a2b', role: 'user',
        content: '给这段代码补上单元测试。',
        create_time: 1730000480, is_not_last_displayed: false
      },
      {
        unique_id: 'a3v1', parent_message_id: 'u3', role: 'assistant',
        content: { text: '用 httptest 起一个假服务，然后断言并发数峰值不超过 N。' },
        create_time: 1730000540, is_not_last_displayed: true
      },
      {
        unique_id: 'a3v2', parent_message_id: 'u3', role: 'assistant',
        content: { text: '三个用例：TestPoolLimitsConcurrency（用 atomic 统计峰值）、TestPanicBecomesError、TestResultOrder。配合 -race 跑。' },
        create_time: 1730000600, is_not_last_displayed: false
      },
      {
        unique_id: 'orphan1', parent_message_id: 'deleted0000', role: 'assistant',
        content: { text: '（这条的父轮次被删掉了，应该单独成组而不是丢掉）' },
        create_time: 1730000660, is_not_last_displayed: true
      }
    ]
  }
};

// 2026-10-31 第三、四轮线上诊断拿到的**真**字段名，逐条照抄结构：
//   消息对象 = {message_id:number, parent_id:number|null, role:'user'|'assistant', status, inserted_at, fragments:[{id,type,content}]}
//   正文不在消息对象上，在 fragments 里；fragment 的 type 实测就是 REQUEST（提问）/ THINK（思考）/ RESPONSE（回答正文）
//   —— 依据：用户那次诊断 fragTypes {REQUEST:8, THINK:14, RESPONSE:14} 正好等于 2 次重抓 × (4 条提问 / 7 条回答的思考与正文)。
//   没有 is_not_last_displayed，当前版本靠 chat_session.current_message_id 反推。
// 拓扑照用户口述的那条真实对话搭（提问 2 版 × 回答、其中一版又重新生成 2 次、第二条提问挂在最终版下），
// 文字是另写的占位内容，不是用户的聊天原文。
function frag(id, type, content, extra) {
  var f = { id: id, type: type, content: content };
  if (extra) for (var k in extra) f[k] = extra[k];
  return f;
}
function liveMsg(id, parent, role, inserted, body, extra) {
  var m = {
    message_id: id, parent_id: parent, model: role === 'user' ? '' : 'deepseek-chat', role: role,
    thinking_enabled: false, ban_edit: false, ban_regenerate: false, status: 'finished',
    incomplete_message: null, accumulated_token_usage: 0, feedback: null, inserted_at: inserted,
    search_enabled: false, fragments: [frag(id * 10, role === 'user' ? 'REQUEST' : 'RESPONSE', body)],
    has_pending_fragment: false,
    auto_continue: false, search_triggered: false, extra_search_providers: []
  };
  if (extra) for (var k in extra) m[k] = extra[k];
  return m;
}
var FIXTURE_LIVE = {
  code: 0,
  msg: '',
  data: {
    biz_code: 0,
    biz_msg: '',
    biz_data: {
      chat_session: {
        id: '5635bcd5-51b6-4c7d-8082-8d6d71cb8efc', title: '占位标题', title_type: 'auto', model_type: 'deepseek',
        pinned: false, updated_at: 1730000600, seq_id: 7, agent: 'chat', version: 1, is_empty: false,
        current_message_id: 1007, inserted_at: 1729999000
      },
      chat_messages: [
        liveMsg(1001, null, 'user', 1730000001, '甲'),
        liveMsg(1002, 1001, 'assistant', 1730000002, '回答甲一', {
          thinking_enabled: true,
          fragments: [frag(10021, 'THINK', '先想想甲是什么意思', { elapsed_secs: 1.2, stage_id: 1 }), frag(10022, 'RESPONSE', '回答甲一')]
        }),
        liveMsg(1003, null, 'user', 1730000010, '乙'),
        liveMsg(1004, 1003, 'assistant', 1730000011, '回答乙第一版'),
        liveMsg(1005, 1003, 'assistant', 1730000012, '回答乙第二版'),
        liveMsg(1006, 1005, 'user', 1730000020, '丙'),
        liveMsg(1007, 1006, 'assistant', 1730000021, '回答丙一', {
          search_enabled: true, search_triggered: true,
          fragments: [
            frag(10071, 'search_result', '（检索到的网页正文，不该进节点）', { references: [], stage_id: 3, elapsed_secs: 1.2 }),
            frag(10072, 'RESPONSE', '回答丙一')
          ]
        })
      ],
      cache_control: '718',
      cache_reset_at: 1793437665
    }
  }
};

// 第四轮线上翻车现场：/api/v0/client/settings?scope=model（24258 字节）里的配置项
// 形如 {id:number, type:'REQUEST'|'THINK'|'RESPONSE', content:'提示词模板'}，
// 旧判据（有 id + 有文字就算消息）把它读成了 18 条消息；而且这些 id 是**和 message_id 同一套编号**的
// （线上诊断里消息 id 是 1..11、配置项 id 是 1..18），撞号之后连真消息的文本和当前路径都会被带歪。
// 这一份就是回归用例：必须一个节点都不许产生。
var FIXTURE_SETTINGS = {
  code: 0,
  msg: '',
  data: {
    biz_code: 0,
    biz_msg: '',
    biz_data: {
      version: 14,
      settings: {
        model: {
          id: 9,
          value: {
            prompts: [
              { id: 1001, type: 'REQUEST', content: '（配置里的提问模板，不是用户发的）' },
              { id: 1002, type: 'THINK', content: '（配置里的思考模板）' },
              { id: 1003, type: 'RESPONSE', content: '（配置里的回答模板）' },
              { id: 1005, type: 'REQUEST', content: '（另一条提问模板）' },
              { id: 1007, type: 'RESPONSE', content: '（另一条回答模板）' }
            ]
          }
        }
      }
    }
  }
};

// 故意换了字段名，验证「接口改名也不会全盘失效」
var FIXTURE_ALT = {
  data: {
    chat_id: 'otherchat',
    msgs: [
      { id: 'x1', sender: 'user', text: '换字段名也能认出来吗', created_at: 1730001000 },
      { id: 'x2', parentId: 'x1', message_type: 'assistant', answer: '能', mtime: 1730001060 }
    ]
  }
};

// 2026-10-31 线上诊断实测到的真实信封：{code,msg,data:{biz_code,biz_msg,biz_data:{chat_session,chat_messages,cache_control}}}
// 且这个 API 的 id 是数字（chat_session.current_message_id: number）。
// 注意：biz_data.chat_messages 里每个消息对象的字段名线上还没拿到过（那正是诊断要问的问题），
// 这里按「数字 id + parent_message_id + message_type + content 对象」这一套最可能的写法造，用来证明解析层不再要求字符串 id。
var FIXTURE_BIZ = {
  code: 0,
  msg: '',
  data: {
    biz_code: 0,
    biz_msg: '',
    biz_data: {
      chat_session: {
        id: 'cb4b7e18-498c-4ed7-9c29-2cc735da0705', title: '测试会话', title_type: 'auto',
        model_type: 'deepseek', pinned: false, updated_at: 1730000900, seq_id: 42,
        agent: 'chat', version: 1, is_empty: false, current_message_id: 205, inserted_at: 1729999000
      },
      chat_messages: [
        { id: 101, chat_session_id: 'cb4b7e18-498c-4ed7-9c29-2cc735da0705', parent_message_id: null, message_type: 'user', content: '帮我看看这段 Go 代码有什么问题。', created_at: 1730000000, is_not_last_displayed: false },
        { id: 201, parent_message_id: 101, message_type: 'assistant', content: { text: '第一版回答：没有明显问题。' }, created_at: 1730000060, is_not_last_displayed: true },
        { id: 202, parent_message_id: 101, message_type: 'assistant', content: { text: '第二版回答：goroutine 泄漏，缺少 defer close。' }, created_at: 1730000070, is_not_last_displayed: false },
        { id: 102, parent_message_id: 202, message_type: 'user', content: '那超时呢？', created_at: 1730000100, is_not_last_displayed: false },
        { id: 203, parent_message_id: 102, message_type: 'assistant', content: { text: '超时没设 context。' }, created_at: 1730000160, is_not_last_displayed: true },
        { id: 204, parent_message_id: 102, message_type: 'assistant', content: { text: '用 WithTimeout 包一层。' }, created_at: 1730000170, is_not_last_displayed: true },
        { id: 205, parent_message_id: 102, message_type: 'assistant', content: { text: '两个都要：WithTimeout + 取消传播。' }, created_at: 1730000180, is_not_last_displayed: false }
      ],
      cache_control: '718'
    }
  }
};

// 线上 /api/v0/chat/regenerate、/edit_message、/completion 的返回是 text/event-stream，
// 之前被当成 JSON 解析，所以诊断里全是「Unexpected token e」。这一份按线上真字段名造。
var FIXTURE_SSE = [
  'event: message_created',
  'data: {"message_id":1008,"parent_id":1006,"role":"assistant","status":"finished","inserted_at":1730000030,"fragments":[{"id":10081,"type":"text","content":"流式里刚诞生的那一版。"}]}',
  '',
  'event: reasoning_content',
  'data: {"delta":"想一下"}',
  '',
  'event: done',
  'data: {"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":"ok"}}',
  ''
].join('\n');
