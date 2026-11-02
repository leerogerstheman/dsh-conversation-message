/**
 * 离线冒烟测试：不连 Host，只验证纯逻辑与一条完整投递链路。
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import {
  TAG,
  TOOL_LIST,
  TOOL_SEND,
  apply,
  buildInboundText,
  claimSend,
  collectPeers,
  formatPeerList,
  isPeerDelivery,
  readConfig,
  resolvePeer,
  titleFor,
} from '../index.js'

/** 活着的对话（ctx.sessions.list()）：一个在跑、一个空闲、一个子代理、一个空白。 */
const PANEL = [
  { id: 'session-web', header: { cwd: 'C:\\work\\web' } },
  { id: 'session-paper', header: { cwd: 'C:\\work\\paper' } },
  { id: 'session-self', header: { cwd: 'C:\\work\\self' } },
  { id: 'session-child', header: { cwd: 'C:\\work\\self', parentSession: 'session-self', origin: 'subagent' } },
  { id: 'session-blank', header: { cwd: 'C:\\work\\blank' } },
]

const AGENTS = new Map([
  ['session-web', { id: 'session-web', status: 'running' }],
  ['session-paper', { id: 'session-paper', status: 'idle' }],
  ['session-self', { id: 'session-self', status: 'running' }],
  ['session-blank', { id: 'session-blank', status: 'idle' }],
])

const TITLES = new Map([
  ['session-web', '前端重构'],
  ['session-paper', '论文实验'],
  ['session-self', '本对话'],
])

/** 冷会话（sessionController.list() 才有）。 */
const COLD = [
  {
    sessionId: 'session-cold',
    running: false,
    agentAvailable: false,
    blank: false,
    cwd: 'D:\\work\\cold',
    updatedAt: 5,
    projections: { values: { title: '旧实验' } },
  },
]

/** 最小 Host 假件：只提供被测代码真正用到的那几个面。 */
function fakeHost(config = {}, options = {}) {
  const listeners = new Map()
  const registered = []
  const delivered = []
  const prompts = []
  const byId = new Map(PANEL.map((session) => [session.id, session]))
  const targets = new Map()
  for (const [id, record] of AGENTS) {
    targets.set(id, {
      ...record,
      followup(message) {
        delivered.push({ target: id, message })
      },
    })
  }
  const agent = targets.get('session-self')
  if (options.cold !== false) {
    // 冷会话在 resolveAgent 时按需恢复
    targets.set('session-cold', {
      id: 'session-cold',
      status: 'idle',
      followup(message) {
        delivered.push({ target: 'session-cold', message })
      },
    })
  }
  const controller = {
    async list() {
      return { items: options.cold === false ? [] : COLD }
    },
    async resolveAgent(sessionId) {
      if (options.resolveError !== undefined) {
        return { error: { code: options.resolveError, message: options.resolveError } }
      }
      const target = targets.get(sessionId)
      return target === undefined
        ? { error: { code: 'session/not-found', message: `session "${sessionId}" not found` } }
        : { agent: target }
    },
    async prompt(request) {
      prompts.push(request)
      return { accepted: true }
    },
  }
  if (options.legacyPromptOnly === true) delete controller.resolveAgent
  const selfScope = {
    get: (key) => (key === 'systemPrompt' ? { section: () => () => {} } : undefined),
    inject(_deps, callback) {
      callback({ tools: { register: (definition) => (registered.push(definition), () => {}) } })
      return () => {}
    },
    effect(fn) {
      fn()
      return () => {}
    },
  }
  const hostAgent = { ...agent, session: { header: { cwd: 'C:\\work\\self' } }, ctx: selfScope }
  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    get: (key) => {
      if (key === 'agents') return { roots: () => [hostAgent], get: (id) => targets.get(id) }
      if (key === 'sessions') return { list: () => PANEL, get: (id) => byId.get(id) }
      if (key === 'sessionTitle') return { get: (session) => (TITLES.has(session?.id) ? { title: TITLES.get(session.id) } : undefined) }
      if (key === 'sessionController') return controller
      return undefined
    },
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {}
    },
    effect(fn) {
      fn()
      return () => {}
    },
  }
  apply(ctx, config)
  const tools = Object.fromEntries(registered.map((tool) => [tool.name, tool]))
  const fire = (name, payload) => {
    for (const fn of listeners.get(name) ?? []) fn(payload)
  }
  return { agent: hostAgent, ctx, delivered, prompts, registered, tools, fire, controller }
}

const exec = (host) => ({ agent: host.agent, signal: new AbortController().signal, callId: 'call-1' })

// ---------------------------------------------------------------- 纯函数
assert.equal(readConfig({}).inbound, 'accept')
assert.equal(readConfig({ inbound: ' REFUSE ' }).inbound, 'refuse')
assert.equal(readConfig({ inbound: 'hold' }).inbound, 'accept', '未知策略退回 accept，不静默拒绝一切')
assert.equal(readConfig({ maxSendsPerTarget: 0 }).maxSendsPerTarget, 1)
assert.equal(readConfig({ maxSendsPerTarget: 99 }).maxSendsPerTarget, 50)
assert.equal(readConfig({ enabled: { get: () => false } }).enabled, false, 'volatile 引用要能解包')

const peers = [
  { id: 'session-web', title: '前端重构', cwd: 'C:\\work\\web', running: true, live: true },
  { id: 'session-paper', title: '论文实验', cwd: 'C:\\work\\paper', running: false, live: true },
]
assert.equal(resolvePeer(peers, 'session-paper').id, 'session-paper')
assert.equal(resolvePeer(peers, '前端').id, 'session-web')
assert.equal(resolvePeer(peers, '论文实验').id, 'session-paper')
assert.throws(() => resolvePeer(peers, '不存在'), /没有找到对话/)
assert.throws(() => resolvePeer(peers, ''), /要发给哪个对话/)
assert.throws(() => resolvePeer([{ id: 'a', title: '实验' }, { id: 'b', title: '实验' }], '实验'), /同时匹配多个对话/)

const inbound = buildInboundText({
  senderTitle: '前端重构',
  senderId: 'session-web',
  body: '跑一下集成测试，把失败用例贴回来。',
  expectReply: true,
  now: Date.UTC(2026, 10, 1, 11, 40),
})
assert.ok(inbound.startsWith(`${TAG} 来自对话「前端重构」（session-web）`), inbound)
assert.match(inbound, /发送时间：/)
assert.match(inbound, /跑一下集成测试/)
assert.match(inbound, /to="session-web"/, '期待回复时要附回信地址')
assert.doesNotMatch(buildInboundText({ senderTitle: 'x', senderId: 'y', body: 'z' }), /要回复就调用/)

assert.equal(isPeerDelivery({ content: [{ type: 'text', text: `${TAG} 来自对话` }] }), true)
assert.equal(isPeerDelivery({ content: [{ type: 'text', text: '普通用户消息' }] }), false)
assert.equal(isPeerDelivery({ content: [] }), false)

const listText = formatPeerList(
  [
    { id: 'session-web', title: '前端重构', cwd: 'C:\\work\\web', running: true, live: true },
    { id: 'session-cold', title: 'cold', cwd: 'D:\\work\\cold', running: false, live: false },
  ],
  { self: { id: 'session-self', title: '本对话' }, allowWakeCold: false },
)
assert.match(listText, /1\. 前端重构 — session-web · 运行中/)
assert.match(listText, /未打开（不可发送）/)
assert.match(listText, /你所在的对话：「本对话」（session-self）/)

const state = { counters: new Map() }
assert.deepEqual(claimSend(state, 'a', 'b', 2), { used: 0, next: 1 })
assert.throws(() => claimSend({ counters: new Map([['a', new Map([['b', 2]])]]) }, 'a', 'b', 2), /达到上限/)

{
  const host = fakeHost()
  assert.equal(titleFor(host.ctx, { sessionId: 'session-web' }), '前端重构')
  assert.equal(titleFor(host.ctx, { sessionId: 'session-blank', cwd: 'C:\\work\\blank' }), 'blank')
  const live = await collectPeers(host.ctx, 'session-self')
  assert.deepEqual(live.map((peer) => peer.id).sort(), ['session-blank', 'session-paper', 'session-web'])
  const warm = await collectPeers(host.ctx, 'session-self', undefined, { includeCold: true })
  assert.ok(warm.some((peer) => peer.id === 'session-cold'), '允许唤醒时才列出冷会话')
}

// ---------------------------------------------------------------- 工具
{
  const host = fakeHost()
  assert.equal(host.registered.length, 2)
  assert.ok(host.tools[TOOL_LIST], 'list_conversations 已注册')
  assert.ok(host.tools[TOOL_SEND], 'send_conversation_message 已注册')
  assert.equal(host.tools[TOOL_LIST].parameters.type, 'object')
  assert.match(host.tools[TOOL_SEND].output.render({}, 'x')[0].text, /x/)

  const text = await host.tools[TOOL_LIST].execute({}, exec(host))
  assert.match(text, /前端重构 — session-web · 运行中/)
  assert.match(text, /论文实验 — session-paper · 空闲/)
  assert.doesNotMatch(text, /本对话 — session-self/, '自己不在可发列表里')
  assert.doesNotMatch(text, /session-child/, '子代理不在列表里')
  assert.doesNotMatch(text, /session-cold/, '冷会话默认不列')

  const filtered = await host.tools[TOOL_LIST].execute({ query: '论文' }, exec(host))
  assert.match(filtered, /论文实验/)
  assert.doesNotMatch(filtered, /前端重构/)

  const receipt = await host.tools[TOOL_SEND].execute(
    { to: '前端', message: ' 跑一下集成测试 ', expect_reply: true },
    exec(host),
  )
  assert.match(receipt, /已送达对话「前端重构」（session-web）/)
  assert.match(receipt, /第 1\/3 条/)
  assert.equal(host.delivered.length, 1)
  const sent = host.delivered[0]
  assert.equal(sent.target, 'session-web')
  assert.equal(sent.message.role, 'user')
  assert.equal(sent.message.source.kind, 'agent-message', '用内置的转述来源，UI 才渲染成「来自会话」而不是用户发言')
  assert.equal(sent.message.source.form, 'relay')
  assert.equal(sent.message.source.senderSessionId, 'session-self')
  assert.ok(sent.message.id, '每条消息都有自己的 id')
  assert.ok(Object.isFrozen(sent.message), '消息要冻结后再交给 agent')
  assert.ok(Object.isFrozen(sent.message.content), '内容也要递归冻结')
  assert.equal(sent.message.content[0].type, 'text')
  assert.ok(sent.message.content[0].text.includes('跑一下集成测试'))
  assert.ok(sent.message.content[0].text.startsWith(TAG))

  await assert.rejects(
    host.tools[TOOL_SEND].execute({ to: '旧实验', message: 'hi' }, exec(host)),
    /没有找到对话|没有打开/,
    '默认既不列也不发给冷会话',
  )
  await assert.rejects(
    host.tools[TOOL_SEND].execute({ to: 'session-self', message: 'hi' }, exec(host)),
    /没有找到对话/,
    '自己不在目标列表里',
  )
  await assert.rejects(host.tools[TOOL_SEND].execute({ to: '前端' }, exec(host)), /缺少 message/)
  await assert.rejects(
    host.tools[TOOL_SEND].execute({ to: '前端', message: 'x'.repeat(20001) }, exec(host)),
    /消息太长/,
  )
}

// ---------------------------------------------------------------- 限流与重置
{
  const host = fakeHost({ maxSendsPerTarget: 2 })
  await host.tools[TOOL_SEND].execute({ to: 'session-web', message: '一' }, exec(host))
  await host.tools[TOOL_SEND].execute({ to: 'session-web', message: '二' }, exec(host))
  await assert.rejects(
    host.tools[TOOL_SEND].execute({ to: 'session-web', message: '三' }, exec(host)),
    /达到上限（2）/,
  )
  assert.equal(host.delivered.length, 2, '被限流的那条不能投递出去')

  // 同伴消息不算「用户开口」，不应重置配额
  host.fire('agent/inbox/inserted', {
    agent: host.agent,
    message: { content: [{ type: 'text', text: `${TAG} 来自对话「别的」` }], source: { kind: 'user' } },
  })
  await assert.rejects(
    host.tools[TOOL_SEND].execute({ to: 'session-web', message: '四' }, exec(host)),
    /达到上限/,
  )

  // 用户真的在对话里说话了 → 配额清零
  host.fire('agent/inbox/inserted', {
    agent: host.agent,
    message: { content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } },
  })
  const after = await host.tools[TOOL_SEND].execute({ to: 'session-web', message: '五' }, exec(host))
  assert.match(after, /第 1\/2 条/)
}

// ---------------------------------------------------------------- 策略与失败
{
  const refused = fakeHost({ inbound: 'refuse' })
  await assert.rejects(
    refused.tools[TOOL_SEND].execute({ to: '前端', message: 'hi' }, exec(refused)),
    /入站策略是 refuse/,
  )

  const busy = fakeHost({}, { resolveError: 'session/agent-busy' })
  await assert.rejects(
    busy.tools[TOOL_SEND].execute({ to: '前端', message: 'hi' }, exec(busy)),
    /无法接收消息/,
    '投递失败要翻译成人话',
  )

  const wake = fakeHost({ allowWakeCold: true })
  const receipt = await wake.tools[TOOL_SEND].execute({ to: '旧实验', message: 'hi' }, exec(wake))
  assert.match(receipt, /唤醒了它/)

  // 部署里没有 resolveAgent 时退回 prompt() 通道，功能不丢
  const legacy = fakeHost({}, { legacyPromptOnly: true })
  const legacyReceipt = await legacy.tools[TOOL_SEND].execute({ to: '前端', message: 'hi' }, exec(legacy))
  assert.match(legacyReceipt, /已送达/)
  assert.equal(legacy.prompts.length, 1)
  assert.equal(legacy.prompts[0].mode, 'queue')
  assert.equal(legacy.prompts[0].content[0].type, 'text')
}

console.log('smoke: 全部通过')
