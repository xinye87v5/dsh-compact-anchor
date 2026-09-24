/**
 * dsh-compact-anchor —— **结构性保留「回合」**：在压缩输出之后追加一节由代码生成的 Turn Index。
 *
 * ## 为什么（依据是实测，不是推理）
 *
 * | 实测 | 数字 | 本插件怎么修 |
 * |---|---|---|
 * | 靠**提示词**要求模型逐条引用用户原话 | 最低一次覆盖 **61.1%** | 改成**代码保证**（同类工具的做法也是由代码而非提示词保留用户消息） |
 * | **"用户在回应什么"完全丢失** | "所指有痕"在 12 组对照条件下**几乎恒为 0** | 每条用户发言附一个**机械抽取的所指锚** |
 *
 * ## 注入点（这个约束是读 DSH 源码得到的，不能想当然）
 *
 * `llm.stream` 返回 `AsyncIterable<StreamChunk>`；引擎侧是
 * `for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)`。
 * `BlockAssembler` 的契约逐字写着：
 * *"deltas arriving for an index already closed by `block-end` are **ignored**"*
 *
 * ⇒ 附录**必须**在文本块的 `block-end` **之前**发，且**同时改写 `block-end.block.text`**
 * （闭合块可能直接取 `block` 而不是累积 delta，两条路都要覆盖）：
 *
 * ```
 * 见到文本块的 block-end:
 *   1) { type:'text-delta', index, text: 附录 }
 *   2) { ...原chunk, block: { ...原block, text: 原block.text + 附录 } }
 * delta-only（没有 block-end）：在 finish 之前补发一次 text-delta
 * ```
 *
 * ## 安全约束（都是踩过的坑）
 *
 * 1. **`apply()` 绝不抛** —— 插件 apply 抛错会让**整个 dsh 启动失败**。
 * 2. **不留静默 catch** —— 任何异常都落 attest。
 * 3. **只在 `purpose === 'compaction'` 时生效**，其余调用原样透传。
 * 4. 附录**不参与**模型输出，因此**不影响**引擎的"撞顶拒收"判断（那看的是模型 finish kind）。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  IMPROVED_COMPACTION_INSTRUCTION,
  ORIGINAL_INSTRUCTION_MARKER,
  IMPROVED_INSTRUCTION_MARKER,
} from './instruction.mjs'
import { buildFootprint } from './footprint.mjs'

export const name = 'dsh-compact-anchor'
export const inject = ['llm']

const HEADING = '## Turn Index (harness-generated, verbatim user turns)'
const DEFAULT_BUDGET = 12000
const ANCHOR_CMD_CHARS = 60
const ANCHOR_TEXT_CHARS = 300
// 单条正文放不进预算时的显式标记 —— 宁可写明已截断，也不静默切尾
const TRUNC_MARK = '…（本条过长，已截断）'

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
}

/** 一条消息是不是"用户的真实发言"（排除压缩指令、旧 checkpoint 等 plugin 来源）。 */
function isRealUser(m) {
  if (m?.role !== 'user') return false
  const src = m?.source
  if (src && src.kind && src.kind !== 'user') return false
  const t = textOf(m.content)
  if (t.trim().length === 0) return false
  // 双保险：压缩指令自身不能算"用户发言"。生产里它带 source.kind='plugin'，
  // 但纯函数**不应该依赖调用方的构造方式**（实测：只靠 source 时这条用例是红的）。
  if (t.includes(ORIGINAL_INSTRUCTION_MARKER) || t.includes(IMPROVED_INSTRUCTION_MARKER)) return false
  return true
}

/**
 * 一条 assistant 消息的"所指锚"：工具调用（名字 + 主参数）+ 文本输出。
 * **全是机械抽取**，不做任何语义判断。
 */
function anchorOf(m) {
  if (!m) return ''
  const parts = []
  const blocks = Array.isArray(m.content) ? m.content : []
  for (const b of blocks) {
    if (b?.type === 'tool-call' || b?.type === 'tool_call') {
      const name = b.name ?? b.toolName ?? 'tool'
      let arg = ''
      const a = b.arguments ?? b.args ?? b.input
      if (typeof a === 'string') arg = a
      else if (a && typeof a === 'object') {
        arg = String(a.path ?? a.file_path ?? a.command ?? a.pattern ?? a.query ?? JSON.stringify(a))
      }
      parts.push(`${name} ${String(arg).replace(/\s+/g, ' ').slice(0, ANCHOR_CMD_CHARS)}`.trim())
    }
  }
  // ⚠️ 取**结尾**而不是开头：用户回应的是对方最后给出的结论/做法。
  // 实测：取"第一句"时，预先声明的"所指有痕"指标（比对上一条 assistant 末 2,000 字符）读到 0% ——
  // 因为开头那句与用户真正回应的那段几乎不重叠。判据不动，改实现。
  const text = textOf(m.content).replace(/\s+/g, ' ').trim()
  if (text) parts.push(text.slice(-ANCHOR_TEXT_CHARS))
  return parts.join('；')
}

/**
 * 纯函数：从"正在被压缩的面"构造 Turn Index 附录。
 *
 * @returns {{ text: string, turns: number, omitted: number, chars: number }}
 */
export function buildTurnIndex(messages, budget = DEFAULT_BUDGET) {
  const entries = []
  for (let i = 0; i < messages.length; i++) {
    if (!isRealUser(messages[i])) continue
    // 往前找最近的 assistant 回合作为"上文"
    let prev = null
    for (let k = i - 1; k >= 0; k--) {
      if (messages[k]?.role === 'assistant') { prev = messages[k]; break }
    }
    const text = textOf(messages[i].content).replace(/\s+/g, ' ').trim()
    // 锚**只给短/回指式发言**：长发言自带上下文，短发言（"同意"/"可以"）单看没有信息。
    // 这不是为了迁就指标 —— 指标把 DEP 定在 ≤12 字符，而这里放宽到 ≤20，
    // 即"凡是可能不自足的都带锚"，比指标的口径更宽。
    entries.push({ text, anchor: text.length <= 20 ? anchorOf(prev) : '' })
  }
  if (entries.length === 0) return { text: '', turns: 0, omitted: 0, chars: 0 }

  // ── 分配：**用户正文永远全在**，剩余预算按「新 → 旧」给短发言配锚 ──
  // 早先版本是 400→150→0 一步到位地整体降级，实测把锚全砍光了（预算被 88 行正文吃掉）；
  // 现在改成贪心逐条分配，新近的短发言优先拿到锚。
  const omittedLine = (om) => `- … 另有 ${om} 个更早的用户回合因预算被省略（见会话日志）\n`
  const lineOf = (e, idx, withAnchor) => {
    const head = `- [t${idx}] 用户："${e.text}"`
    return withAnchor && e.anchor ? `${head}\n       ← 上文：${e.anchor.slice(-ANCHOR_TEXT_CHARS)}` : head
  }
  const size = (arr, om) =>
    HEADING.length + 1 + arr.reduce((n, s2) => n + s2.length + 1, 0) + (om > 0 ? omittedLine(om).length : 0)

  // 先只放正文，量出剩余
  const plain = entries.map((e, i) => lineOf(e, i + 1, false))
  let budgetLeft = budget - size(plain, 0)
  const wantAnchor = new Array(entries.length).fill(false)
  for (let i = entries.length - 1; i >= 0; i--) {           // 新 → 旧
    if (!entries[i].anchor) continue
    const cost = lineOf(entries[i], i + 1, true).length - plain[i].length
    if (cost <= budgetLeft) { wantAnchor[i] = true; budgetLeft -= cost }
  }
  let lines = entries.map((e, i) => lineOf(e, i + 1, wantAnchor[i]))
  // 仍超预算（正文本身太大）才省略最旧的回合，且省略可见
  let omitted = 0
  let kept = lines
  while (kept.length > 1 && size(kept, omitted + 1) > budget) {
    kept = kept.slice(1)
    omitted++
  }
    // ── 收尾：省略提示与最新回合一粒都不能被切掉 ──────────────────────────
    // 旧实现在这里无条件 `text.slice(0, budget)`，切的是**尾部** —— 而尾部正是省略提示
    // 与最新回合所在。实测 budget=40 会退化成「一个被切断的标题、零个回合」，且 `chars`
    // 比预算还大 1（多出收尾的换行）。触发条件不止极小预算：**只要最新一条用户发言
    // 本身长于预算**（一次长日志/报告粘贴），循环就停在 `kept.length === 1` 且仍超预算。
    // 新规则：① 任何情况下 chars ≤ budget ② 省略提示永不丢 ③ 单条放不下就**显式截断
    // 并标注** ④ 连最低限度都放不下就**不注入** —— 一个自称 Turn Index 却没有任何回合的
    // 残片，比不注入更糟（占预算、且让人以为保留生效了）。
    const notice = omitted > 0 ? omittedLine(omitted) : ''
    const fixed = HEADING.length + 1 + notice.length
    if (budget < fixed + TRUNC_MARK.length + 1) {
      return { text: '', turns: entries.length, omitted: entries.length, chars: 0 }
    }
    let body = kept.join('\n')
    if (fixed + body.length + 1 > budget) {
      const room = Math.max(0, budget - fixed - TRUNC_MARK.length - 1)
      body = body.slice(0, room) + TRUNC_MARK
    }
    const text = HEADING + '\n' + body + '\n' + notice
    return { text, turns: entries.length, omitted, chars: text.length }
}

/** 纯函数：改写压缩指令（把逐条枚举用户回合的活儿从模型手里拿走，交给 harness）。 */
/**
 * 改写压缩指令，并**顺带**把 Turn Index 算好返回。
 *
 * ⚠️ `budget` 必须从调用方传进来（2026-09-23 修）：此前本函数内部写死
 * `buildTurnIndex(messages)`，于是 `config.budget` **完全失效** —— 不论配多少都用
 * `DEFAULT_BUDGET`。生产之所以没暴露，只因为 patch 里写的恰好等于默认值。
 * 存证还把"配置值"与"默认值算出的 chars"并排打印，看着像生效了。
 * @param options - `{ purpose, messages }`
 * @param budget - Turn Index 的字符预算
 */
export function rewriteInstruction(options, budget = DEFAULT_BUDGET) {
  if (options?.purpose !== 'compaction') return null   // 自我防护：不靠调用方先判断用途
  const messages = options?.messages
  if (!Array.isArray(messages) || messages.length === 0) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    const t = textOf(m.content)
    if (t.includes(ORIGINAL_INSTRUCTION_MARKER)) {
      const next = messages.slice()
      next[i] = {
        ...m,
        content: Array.isArray(m.content)
          ? m.content.map((b) => (b?.type === 'text' ? { ...b, text: IMPROVED_COMPACTION_INSTRUCTION } : b))
          : [{ type: 'text', text: IMPROVED_COMPACTION_INSTRUCTION }],
      }
      return { messages: next, index: i, turns: buildTurnIndex(messages, budget) }
    }
  }
  return null
}

/**
 * 挂载插件。
 *
 * ⚠️ **`apply()` 绝不抛**：DSH 在启动时调用各插件的 `apply()`，任何逃逸的异常
 * 都会让**整个 dsh 启动失败**（不只是本插件失效）。所以这里从探测服务、替换
 * `llm.stream`、到注册清理，每一步都包在 try 里，失败只落 attest。
 *
 * @param {{ get: (name: string, strict?: boolean) => unknown, effect?: (fn: () => void) => void }} ctx
 * @param {{ enabled?: boolean, budget?: number, attestTo?: string, footprint?: { enabled?: boolean, budget?: number } }} [config]
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return
  const budget = Number(config?.budget ?? DEFAULT_BUDGET)
  /**
   * 工具足迹附录。**默认关闭**：它改变 checkpoint 的内容面，
   * 属于"改动生产行为"的一类，应当由使用者显式开启：`footprint: { enabled: true }`。
   */
  const fpEnabled = config?.footprint?.enabled === true
  const fpBudget = Number(config?.footprint?.budget ?? 4000)
  const attestTo = typeof config?.attestTo === 'string' && config.attestTo.length > 0
    ? config.attestTo
    : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'reports', 'dsh-compact-anchor.jsonl')
  const attest = (record) => {
    try {
      mkdirSync(dirname(attestTo), { recursive: true })
      appendFileSync(attestTo, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...record }) + '\n', 'utf8')
    } catch { /* 存证失败不影响压缩 */ }
  }

  /**
   * ⚠️ 挂载必须可重试。实测：**headless** 会话里，本插件在 apply 时探到
   * `llm.stream 不可用` —— headless 启动时 llm 尚未装配完。
   * 第一版一次性探测后**直接放弃**（`not-mounted` 就再也不试），于是那些会话里插件**静默不生效**。
   * 这是异步装配服务的通用缺陷：**服务是异步装载的，取值不能只试一次**。
   */
  const tryMount = () => {
  let llm = null
  try {
    llm = ctx.get('llm', false) ?? null
  } catch (e) {
    attest({ kind: 'not-mounted', reason: `探测 llm 抛错: ${e?.message ?? e}` })
    return false
  }
  if (!llm || typeof llm.stream !== 'function') {
    return false
  }
  if (llm.__compactAnchorPatched === true) return true

  const originalStream = llm.stream
  const stats = { seen: 0, injected: 0, passthrough: 0, errors: 0 }
  // 诊断（2026-09-23，docs/53 §八）：压缩调用究竟以什么 purpose 进来。
  // 若它不以 'compaction' 进来，下面的改写逻辑根本不会被执行 —— 而那种情况此前
  // 是完全不可见的（没有注入记录 ≠ 没发生压缩）。每个新 purpose 只落一条，噪声有界。
  const purposesSeen = new Set()

  const patched = function stream(options, ...rest) {
    try {
      const purpose = options?.purpose
      if (!purposesSeen.has(purpose)) {
        purposesSeen.add(purpose)
        attest({ kind: 'stream-purpose-seen', purpose: purpose ?? null,
          messageCount: Array.isArray(options?.messages) ? options.messages.length : null })
      }
      if (options?.purpose !== 'compaction') return originalStream.call(this, options, ...rest)
      stats.seen++
      const r = rewriteInstruction(options, budget)
      if (!r) {
        stats.passthrough++
        const msgs = Array.isArray(options?.messages) ? options.messages : null
        const tail = msgs ? msgs.slice(-3) : []
        attest({ kind: 'turn-index-miss',
          why: msgs === null ? 'messages-not-array' : 'no-original-marker',
          messageCount: msgs ? msgs.length : null,
          tailRoles: tail.map((m) => m?.role ?? null),
          lastUserHead: (() => {
            for (let k = (msgs?.length ?? 0) - 1; k >= 0; k--) {
              if (msgs[k]?.role === 'user') return textOf(msgs[k].content).slice(0, 120)
            }
            return null
          })() })
        return originalStream.call(this, options, ...rest)
      }
      const fp = fpEnabled ? buildFootprint(r.messages, fpBudget) : { text: '', files: 0, commands: 0, omitted: 0, chars: 0 }
      const appendix = [r.turns.text, fp.text].filter(Boolean).join('\n\n')
      if (!appendix) {
        stats.passthrough++
        // 诊断（2026-09-23，docs/53 §八）：改写成功但附录为空 —— 最可能是
        // `buildTurnIndex` 在这段压缩输入里**一个真用户回合都没找到**（索引为空）。
        // 这条路径此前完全静默：既没有 injected 也没有 miss，看起来像"插件没生效"。
        attest({ kind: 'turn-index-empty', rewrote: r !== null, instructionIndex: r?.index ?? null,
          turns: r?.turns?.turns ?? null, chars: r?.turns?.chars ?? null, budget })
        return originalStream.call(this, options, ...rest)
      }

      const nextOptions = { ...options, messages: r.messages }
      const inner = originalStream.call(this, nextOptions, ...rest)
      if (!inner || typeof inner[Symbol.asyncIterator] !== 'function') {
        stats.errors++
        attest({ kind: 'turn-index-error', reason: 'stream 不是 async iterable' })
        return inner
      }

      stats.injected++
      attest({
        kind: 'turn-index-injected',
        messageCount: r.messages.length,
        instructionIndex: r.index,
        turns: r.turns.turns,
        omitted: r.turns.omitted,
        chars: r.turns.chars,
        budget,
        nth: stats.injected,
        footprintOn: fpEnabled,
        footprintChars: fp.chars,
        footprintFiles: fp.files,
        footprintCommands: fp.commands,
        footprintOmitted: fp.omitted,
      })

      // ── 输出流包装：把附录插在文本块的 block-end 之前，并改写 block-end.block.text ──
      async function* wrapped() {
        let emitted = false
        let lastTextIndex = null
        let sawBlockEnd = false
        const emit = (index) => ({ type: 'text-delta', index: index ?? 0, text: '\n\n' + appendix })

        try {
          for await (const chunk of inner) {
            if (!emitted) {
              if (chunk?.type === 'text-delta') { lastTextIndex = chunk.index; yield chunk; continue }
              if (chunk?.type === 'block-end' && chunk.block?.type === 'text') {
                sawBlockEnd = true
                yield emit(chunk.index)                                     // 1) delta 先发
                yield { ...chunk, block: { ...chunk.block, text: (chunk.block.text ?? '') + '\n\n' + appendix } } // 2) 再改写 block
                emitted = true
                continue
              }
              if (chunk?.type === 'finish') {                               // delta-only：收尾前补发
                yield emit(lastTextIndex)
                emitted = true
                yield chunk
                continue
              }
            }
            yield chunk
          }
          if (!emitted) {
            stats.errors++
            attest({ kind: 'turn-index-error', reason: '流结束但未找到注入点', sawBlockEnd, lastTextIndex })
          }
        } catch (e) {
          stats.errors++
          attest({ kind: 'turn-index-error', reason: `流中异常: ${e?.message ?? e}`, emitted })
          throw e
        }
      }
      return wrapped()
    } catch (e) {
      stats.errors++
      attest({ kind: 'turn-index-error', reason: `patch 抛错: ${e?.stack ?? e}` })
      return originalStream.call(this, options, ...rest)   // 绝不因为本插件而让压缩失败
    }
  }

  try {
    llm.stream = patched
  } catch (e) {
    attest({ kind: 'not-mounted', reason: `无法替换 llm.stream: ${e?.message ?? e}` })
    return false
  }
  try {
    ctx.effect?.(() => { try { if (llm.stream === patched) llm.stream = originalStream } catch { /* 还原失败无所谓 */ } })
  } catch (e) {
    // ⚠️ apply() 绝不抛：注册清理失败也必须吞下并留痕（插件 apply 抛错会让整个 dsh 启动失败）
    attest({ kind: 'effect-register-failed', reason: `${e?.message ?? e}` })
  }
  try { llm.__compactAnchorPatched = true } catch { /* 打标失败不影响功能 */ }
  // 存证里带上配置状态：上线后要能**用证据**确认足迹是否启用，
  // 而不是靠"文件里写了"这种身份比较。
  attest({
    kind: 'mounted',
    plugin: name,            // 让存证自述身份：改名后可用证据确认，不靠比对文件
    improvedChars: IMPROVED_COMPACTION_INSTRUCTION.length,
    marker: IMPROVED_INSTRUCTION_MARKER,
    footprintOn: fpEnabled,
    footprintBudget: fpBudget,
  })
  return true
  }

  // ── 挂载驱动：先试一次，失败则每 250ms 重试，最多 60 次（15s）──
  if (!tryMount()) {
    attest({ kind: 'mount-deferred', reason: 'llm.stream 尚不可用，转入重试' })
    let tries = 0
    const timer = setInterval(() => {
      tries++
      if (tryMount()) {
        clearInterval(timer)
        attest({ kind: 'mounted-late', tries })
      } else if (tries >= 60) {
        clearInterval(timer)
        attest({ kind: 'not-mounted', reason: `重试 ${tries} 次后仍不可用` })
      }
    }, 250)
    try { timer.unref?.() } catch { /* 无所谓 */ }
  }
}

export default { name, inject, apply }
