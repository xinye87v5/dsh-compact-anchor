#!/usr/bin/env node
/**
 * `index.mjs` 的离线断言。
 *
 * ## 为什么先做这一层
 *
 * 注入点是**流式**的，而且 DSH 的 `BlockAssembler` 契约里有一条陷阱：
 * *"deltas arriving for an index already closed by `block-end` are ignored"*。
 * 所以必须先在**构造出来的 chunk 序列**上证明：
 *   ① 附录出现在文本块 `block-end` **之前**；
 *   ② `block-end.block.text` **也被改写**（闭合块可能只认 block，不认 delta）；
 *   ③ delta-only（没有 block-end）时在 `finish` 之前补发；
 *   ④ 非压缩调用**原样透传**；
 *   ⑤ `apply()` 在取不到 llm 时**不抛**（否则整个 dsh 起不来）。
 *
 * 断言必须**能变红**才算数（已逐条做过变异验证）：
 *   · 把注入点从"block-end **之前**"改成"之后"        ⇒ 4b、4c 变红
 *   · 只去掉 `block-end.block.text` 的改写             ⇒ 4c 变红
 *   · 让 `anchorOf()` 返回空串                         ⇒ 1d、1e 变红
 *   · 去掉"省略可见"那一行                             ⇒ 2b 变红
 *   · 让 `rewriteInstruction()` 不再判断 purpose        ⇒ 3f 变红
 *   · 不再按 `source.kind` 排除 plugin 来源            ⇒ 1a、1f 变红
 *
 * 用法: node --test test/plugin.test.mjs
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTurnIndex, rewriteInstruction, apply } from '../index.mjs'

const U = (text, source) => ({ role: 'user', content: [{ type: 'text', text }], ...(source ? { source } : {}) })
const A = (content) => ({ role: 'assistant', content })
const AText = (text) => A([{ type: 'text', text }])
const ATool = (name, args, text = '') =>
  A([...(text ? [{ type: 'text', text }] : []), { type: 'tool-call', name, arguments: args }])

/** 夹具一律用中立路径：没有任何作者机器上的真实目录。 */
const FIXTURE_FILE = '/srv/app/src/index.mjs'
const FIXTURE_USER_LONG = '帮我看看这个仓库的结构，重点是 src 目录'

const OFFICIAL = 'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.\n\n## Primary Request and Intent\n- [x]'

/** 每个用例一个独立的存证目录，避免污染 $HOME 也不互相干扰。 */
const TMPDIRS = []
// 每个用例都会建一个独立的存证目录，因此需要在进程退出时统一回收 ——
// 否则临时目录会随运行次数不断累积。注册式写法在断言中途失败时同样生效；
// 回收失败只影响该目录自身，不改变测试结果。
process.on('exit', () => {
  for (const d of TMPDIRS) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 已被其他路径回收 */ }
  }
})
const tmpAttest = () => {
  const d = mkdtempSync(join(tmpdir(), 'compact-anchor-'))
  TMPDIRS.push(d)
  return join(d, 'attest.jsonl')
}

function baseMessages() {
  return [
    AText('我先看一下项目结构。'),
    U(FIXTURE_USER_LONG),
    ATool('read_file', { path: FIXTURE_FILE }, '文件很大，主要是入口逻辑。'),
    U('同意'),
    ATool('bash', { command: 'zstd -dc session.jsonl.zstd | grep compaction' }, '找到 2 次压缩事务。'),
    U('好的'),
    AText('已经把两次压缩的时间线整理出来了。'),
    U('就按这个来'),
    // 旧 checkpoint：plugin 来源，必须排除
    U('This is an automatically generated checkpoint…', { kind: 'plugin', plugin: 'compact' }),
    U(OFFICIAL),
  ]
}

// ── 1. buildTurnIndex：逐字 + 所指锚 + 排除规则 ──────────────────────────────

test('1a. 只统计真实用户发言（排除 plugin 来源与压缩指令）', () => {
  const r = buildTurnIndex(baseMessages())
  assert.equal(r.turns, 4, `期望 4，得到 ${r.turns}`)
})

test('1b. 用户发言逐字在场', () => {
  const r = buildTurnIndex(baseMessages())
  assert.ok(r.text.includes(FIXTURE_USER_LONG))
})

test('1c. 短发言/回指式发言也逐字在场', () => {
  const r = buildTurnIndex(baseMessages())
  assert.ok(r.text.includes('同意'))
  assert.ok(r.text.includes('好的'))
  assert.ok(r.text.includes('就按这个来'))
})

test('1d. 短发言带工具锚（read_file + 路径）', () => {
  const r = buildTurnIndex(baseMessages())
  assert.ok(r.text.includes('read_file'))
  assert.ok(r.text.includes(FIXTURE_FILE))
})

test('1e. 短发言带 bash 工具锚（命令）', () => {
  const r = buildTurnIndex(baseMessages())
  assert.ok(r.text.includes('zstd -dc session.jsonl.zstd | grep compaction'))
})

test('1f. 旧 checkpoint（plugin 来源）被排除', () => {
  const r = buildTurnIndex(baseMessages())
  assert.ok(!r.text.includes('automatically generated checkpoint'))
})

test('1g. 压缩指令本身被排除', () => {
  const r = buildTurnIndex(baseMessages())
  assert.ok(!r.text.includes('acting as a compaction engine'))
})

test('1h. 附录以固定标题开头', () => {
  const r = buildTurnIndex(baseMessages())
  assert.ok(r.text.startsWith('## Turn Index'))
})

// ── 2. 预算：超限保留最近的，且省略可见 ──────────────────────────────────────

test('2a. 附录不超预算', () => {
  const many = []
  for (let i = 0; i < 60; i++) {
    many.push(U(`这是第 ${i} 条用户发言，内容也有一定长度用来把预算撑满。`))
    many.push(AText(`第 ${i} 轮的回答内容。`))
  }
  many.push(U(OFFICIAL))
  const r = buildTurnIndex(many, 2000)
  assert.ok(r.chars <= 2000, `${r.chars} ≤ 2000`)
})

test('2b. 触发省略并计数 + 省略是可见的一行', () => {
  const many = []
  for (let i = 0; i < 60; i++) {
    many.push(U(`这是第 ${i} 条用户发言，内容也有一定长度用来把预算撑满。`))
    many.push(AText(`第 ${i} 轮的回答内容。`))
  }
  many.push(U(OFFICIAL))
  const r = buildTurnIndex(many, 2000)
  assert.ok(r.omitted > 0, `omitted=${r.omitted}`)
  assert.match(r.text, /另有 \d+ 个更早的用户回合因预算被省略/)
})

test('2c. 保留的是最近的回合', () => {
  const many = []
  for (let i = 0; i < 60; i++) {
    many.push(U(`这是第 ${i} 条用户发言，内容也有一定长度用来把预算撑满。`))
    many.push(AText(`第 ${i} 轮的回答内容。`))
  }
  many.push(U(OFFICIAL))
  const r = buildTurnIndex(many, 2000)
  assert.ok(r.text.includes('第 59 条用户发言'))
})

  // ── 2e–2g. 预算边界不变式 ────────────────────────────────────────────────
  // 旧实现在收尾处无条件 `text.slice(0, budget)`：切的是**尾部**，而尾部正是最新回合
  // 与省略提示所在 ⇒ budget=40 会吐出「一个被切断的标题、零个回合」，`chars` 还比预算大 1。
  // 触发条件不止极小预算：**最新一条用户发言本身长于预算**（一次长日志粘贴）同样走到那里。
  test('2e. 任何预算下 chars ≤ budget', () => {
    const many = []
    for (let i = 0; i < 20; i++) { many.push(U(`第 ${i} 条用户发言，写长一点。`)); many.push(AText(`回答 ${i}`)) }
    many.push(U('这是最新的一条用户发言'))
    for (const b of [5000, 2000, 400, 200, 120, 90, 80, 60, 40, 10]) {
      const r = buildTurnIndex(many, b)
      assert.ok(r.chars <= b, `budget=${b} 却 chars=${r.chars}`)
    }
  })

  test('2f. 放不下就不注入（残片比不注入更糟）', () => {
    const many = []
    for (let i = 0; i < 20; i++) { many.push(U(`第 ${i} 条用户发言，写长一点。`)); many.push(AText(`回答 ${i}`)) }
    const r = buildTurnIndex(many, 40)
    assert.equal(r.text, '', '极小预算应返回空串，而不是一个被切断的标题')
    assert.equal(r.chars, 0)
    assert.ok(r.omitted > 0, '应如实报告被省略的回合数')
  })

  test('2g. 单条长于预算时显式标注截断，而不是静默切尾', () => {
    const r = buildTurnIndex([U('Y'.repeat(20000))], 12000)
    assert.ok(r.chars <= 12000, `chars=${r.chars}`)
    assert.match(r.text, /本条过长，已截断/)
    assert.ok(r.text.startsWith('## Turn Index'), '标题必须完整')
  })

  // ── 3x. budget 必须真的接进索引 ──────────────────────────────────────────
  // 2026-09-23 修：`rewriteInstruction` 内部写死 `buildTurnIndex(messages)`，
  // 于是 `config.budget` **完全失效**，不论配多少都用默认值。生产没暴露只因
  // patch 里写的恰好等于默认值；存证还把配置值与默认值算出的 chars 并排打印。
  // 这条断言就是那次断路的回归守卫：**两种预算必须给出不同结果**。
  test('3x. budget 真的接进索引（曾因调用点丢参而完全失效）', () => {
    const many = []
    for (let i = 0; i < 60; i++) {
      many.push(U(`这是第 ${i} 条用户发言，内容也有一定长度用来把预算撑满。`))
      many.push(AText(`第 ${i} 轮的回答内容。`))
    }
    many.push(U(OFFICIAL))          // 压缩指令标记：rewriteInstruction 靠它定位
    const opts = { purpose: 'compaction', messages: many }
    const wide = rewriteInstruction(opts, 24000)
    const narrow = rewriteInstruction(opts, 400)
    assert.notEqual(wide.turns.chars, narrow.turns.chars,
      '两种预算给出相同结果 ⇒ budget 没接进 buildTurnIndex')
    assert.ok(narrow.turns.chars <= 400, `chars=${narrow.turns.chars}`)
    assert.ok(narrow.turns.omitted > 0, '窄预算必须触发省略')
  })

// ── 2d. 分层降级：预算紧张时**先牺牲锚，不牺牲用户正文** ─────────────────────

function bulkedMessages() {
  const msgs = []
  for (let i = 0; i < 40; i++) {
    msgs.push(U(`第${i}条用户发言正文`))
    msgs.push(AText(`第${i}轮回答的结尾结论，内容是给用户看的那个决定。`.repeat(20)))
  }
  msgs.push(U(OFFICIAL))
  return msgs
}

test('2d-i. 锚降级后仍不超预算', () => {
  const r = buildTurnIndex(bulkedMessages(), 3000)
  assert.ok(r.chars <= 3000, `${r.chars} ≤ 3000`)
})

test('2d-ii. 40 条用户正文全部在场（锚被牺牲而不是正文）', () => {
  const r = buildTurnIndex(bulkedMessages(), 3000)
  const allPresent = Array.from({ length: 40 }, (_, i) => r.text.includes(`第${i}条用户发言正文`)).every(Boolean)
  assert.ok(allPresent)
})

test('2d-iii. 没有省略任何回合', () => {
  const r = buildTurnIndex(bulkedMessages(), 3000)
  assert.equal(r.omitted, 0)
})

test('2d-iv. 锚被裁剪（不是每条都带满 300 字符的锚）', () => {
  const r = buildTurnIndex(bulkedMessages(), 3000)
  assert.ok(!r.text.includes('← 上文：') || r.text.split('← 上文：').length - 1 < 40)
})

// ── 3. rewriteInstruction：只在压缩用途下改写 ────────────────────────────────

test('3a. 识别到官方指令并改写', () => {
  assert.notEqual(rewriteInstruction({ purpose: 'compaction', messages: baseMessages() }), null)
})

test('3b. 改写的是最后一条', () => {
  const msgs = baseMessages()
  const r = rewriteInstruction({ purpose: 'compaction', messages: msgs })
  assert.equal(r.index, msgs.length - 1)
})

test('3c. 换成了改进版指令文本', () => {
  const msgs = baseMessages()
  const r = rewriteInstruction({ purpose: 'compaction', messages: msgs })
  const t = r.messages[r.index].content[0].text
  assert.ok(t.includes('The harness appends a machine-generated'))
})

test('3d. 不再要求模型逐条编号（那件事交给 harness）', () => {
  const msgs = baseMessages()
  const r = rewriteInstruction({ purpose: 'compaction', messages: msgs })
  const t = r.messages[r.index].content[0].text
  assert.ok(!t.includes('NUMBERED 1, 2, 3'))
})

test('3e. 原消息未被就地修改（纯函数）', () => {
  const msgs = baseMessages()
  rewriteInstruction({ purpose: 'compaction', messages: msgs })
  assert.ok(msgs[msgs.length - 1].content[0].text.includes('acting as a compaction engine'))
})

test('3f. 非 compaction 用途不改写', () => {
  assert.equal(rewriteInstruction({ purpose: 'chat', messages: baseMessages() }), null)
})

// ── 4. 流注入：这是本文件的核心 ─────────────────────────────────────────────

async function streamTest(chunks, expectBlockEndRewrite) {
  const out = []
  const llm = {
    stream() {
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
  const fakeCtx = { get: (n) => (n === 'llm' ? llm : null), effect: undefined }
  apply(fakeCtx, { attestTo: tmpAttest() })
  const opts = { purpose: 'compaction', messages: baseMessages() }
  for await (const c of llm.stream(opts)) out.push(c)
  return out
}

const BLOCK_END_CHUNKS = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '## Primary Request and Intent\n- 用户在推进一项重构。' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '## Primary Request and Intent\n- 用户在推进一项重构。' } },
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const DELTA_ONLY_CHUNKS = [
  { type: 'text-delta', index: 0, text: '## Primary Request and Intent\n- delta-only 协议。' },
  { type: 'finish', reason: { kind: 'stop' } },
]

test('4a. 附录以 text-delta 发出（block-end 协议，真实 provider 走这条）', async () => {
  const out = await streamTest(BLOCK_END_CHUNKS, true)
  assert.ok(out.findIndex((c) => c.type === 'text-delta' && String(c.text).includes('## Turn Index')) >= 0)
})

test('4b. 附录在 block-end **之前**', async () => {
  const out = await streamTest(BLOCK_END_CHUNKS, true)
  const appIdx = out.findIndex((c) => c.type === 'text-delta' && String(c.text).includes('## Turn Index'))
  const beIdx = out.findIndex((c) => c.type === 'block-end')
  assert.ok(appIdx < beIdx, `${appIdx} < ${beIdx}`)
})

test('4c. block-end.block.text **也被改写**（闭合块只认 block 的情况）', async () => {
  const out = await streamTest(BLOCK_END_CHUNKS, true)
  const be = out.find((c) => c.type === 'block-end')
  assert.ok(String(be.block?.text ?? '').includes('## Turn Index'))
})

test('4d. 不产生重复的 block-end', async () => {
  const out = await streamTest(BLOCK_END_CHUNKS, true)
  assert.equal(out.filter((c) => c.type === 'block-end').length, 1)
})

test('4e. 只注入一次', async () => {
  const out = await streamTest(BLOCK_END_CHUNKS, true)
  const n = out.filter((c) => c.type === 'text-delta' && String(c.text).includes('## Turn Index')).length
  assert.equal(n, 1)
})

test('4f. delta-only：附录在 finish 之前补发', async () => {
  const out = await streamTest(DELTA_ONLY_CHUNKS, false)
  const appIdx = out.findIndex((c) => c.type === 'text-delta' && String(c.text).includes('## Turn Index'))
  const finIdx = out.findIndex((c) => c.type === 'finish')
  assert.ok(appIdx >= 0 && appIdx < finIdx, `${appIdx} < ${finIdx}`)
})

test('4g. delta-only：也只注入一次', async () => {
  const out = await streamTest(DELTA_ONLY_CHUNKS, false)
  const n = out.filter((c) => c.type === 'text-delta' && String(c.text).includes('## Turn Index')).length
  assert.equal(n, 1)
})

// ── 5. 非压缩调用透传 + apply 不抛 ──────────────────────────────────────────

test('5a. 非压缩用途的 options 原样传给底层（未被改写）', async () => {
  const seen = []
  const llm = { stream(options) { seen.push(options); return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })() } }
  apply({ get: (n) => (n === 'llm' ? llm : null), effect: undefined }, { attestTo: tmpAttest() })
  const chat = { purpose: 'chat', messages: baseMessages() }
  for await (const _ of llm.stream(chat)) { /* drain */ }
  assert.equal(seen[0], chat)
})

test('5b. 取不到 llm 时 apply() 不抛（否则整个 dsh 启动失败）', () => {
  assert.doesNotThrow(() => {
    apply({ get: () => { throw new Error('service unavailable') }, effect: undefined }, { attestTo: tmpAttest() })
  })
})

test('5c. llm 为 null 时 apply() 不抛', () => {
  assert.doesNotThrow(() => {
    apply({ get: () => null, effect: undefined }, { attestTo: tmpAttest() })
  })
})

test('5d. config.enabled === false 时完全不挂载', () => {
  const llm = { stream: function () { throw new Error('不该被替换') } }
  const before = llm.stream
  apply({ get: () => llm, effect: undefined }, { enabled: false, attestTo: tmpAttest() })
  assert.equal(llm.stream, before)
})

// ── 6. 惰性/重试挂载（headless 场景：apply 时 llm 还没装好）────────────────

test('6a. apply 时 llm 未就绪 ⇒ 不挂载（且不抛）', () => {
  const llm = { stream: undefined }
  const ready = false   // 模拟 headless 启动：apply 的这一刻 llm 还没装配完
  assert.doesNotThrow(() => {
    apply({ get: (n) => (n === 'llm' ? (ready ? llm : null) : null), effect: undefined }, { attestTo: tmpAttest() })
  })
  assert.equal(llm.stream, undefined, 'llm 未就绪时插件不该往它上面装任何东西')
})

test('6b. 重试驱动生效：附录真的被注入（可观察行为，非恒真判据）', async () => {
  let ready = false
  const llm = { stream: undefined }
  const fakeCtx = { get: (n) => (n === 'llm' ? (ready ? llm : null) : null), effect: undefined }
  apply(fakeCtx, { attestTo: tmpAttest() })
  const calls = []
  llm.stream = function (options) { calls.push(options); return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })() }
  ready = true
  await new Promise((r) => setTimeout(r, 400))   // 重试间隔 250ms
  // ⚠️ 判据必须是**可观察行为**，不能是"llm.stream 是函数"—— 那是测试自己赋的值，恒真。
  const out = []
  for await (const c of llm.stream({ purpose: 'compaction', messages: baseMessages() })) out.push(c)
  assert.ok(out.some((c) => c.type === 'text-delta' && String(c.text).includes('## Turn Index')))
  assert.equal(calls.length, 1, '确实拦到了一次 compaction 调用')
})
