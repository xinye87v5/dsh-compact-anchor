/**
 * 工具足迹附录：把"**动过哪些文件、跑过哪些命令**"用**代码**写进 checkpoint。
 *
 * ## 为什么需要它（实测）
 *
 * 实测：checkpoint 对工具结果**整体是半盲的** ——
 * 即使摘要模型看得到那些工具结果，**路径类锚点只有 34% 存活、bash 锚点只有 3.1%**；
 * 而被裁掉的那批（摘要模型根本没看见）是 0%。⇒ 信息损失发生在**摘要这一步**，
 * 不在裁剪那一步。所以调"裁剪 vs 摘要"的比例是白费力气，该做的是把这件事
 * **从提示词里搬出来交给代码** —— 与 Turn Index 对用户发言做的事完全同构
 * （Turn Index 把"逐字保留用户发言"从模型自觉变成 harness 保证）。
 *
 * ## 判据（**先写死**）
 *
 * | 项 | 规格 |
 * |---|---|
 * | **唯一来源** | 被压缩面里的 `assistant` 消息的 `tool-call` 块（**不解析工具结果** —— 那正是要丢的东西） |
 * | **文件类** | `read`/`edit`/`write`/`read_image` 的 `file_path`；`grep`/`glob` 的 `path` |
 * | **命令类** | `bash` 的 `command` 的**第一个 token**（后面的参数不进附录：太长且多为一次性） |
 * | **网络类** | `web_fetch` 的 `url`（去掉 scheme 与 query） |
 * | **垃圾过滤** | 复用早前抽取器的教训：相对路径**必须**末段带已知扩展名；段不得为纯数字；段必须是标识符样式 |
 * | **合并** | 同一路径/命令合并计数（`edit×2, read×1`） |
 * | **排序** | 触碰次数降序，次数相同按**最后一次出现**的新旧 |
 * | **预算** | 默认 **4,000 字符**（远小于 Turn Index 的 12,000 —— 路径本身短）；超预算时**可见省略** |
 * | **不变量** | 空输入 ⇒ 空文本（**绝不注入空壳标题**） |
 */

const KNOWN_EXT = new Set([
  'mjs', 'cjs', 'js', 'ts', 'tsx', 'jsx', 'json', 'jsonl', 'md', 'txt', 'py', 'rs', 'go',
  'java', 'c', 'h', 'cpp', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
  'lock', 'zstd', 'gz', 'csv', 'tsv', 'html', 'htm', 'css', 'scss', 'xml', 'sql', 'zip',
  'tar', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'pdf', 'log', 'env', 'patch', 'diff', 'bak',
  // 首轮测试暴露的缺口：`.markdown` 曾不在表里 ⇒ 整批文件被当成"非路径"丢弃
  'markdown', 'rst', 'adoc', 'tex', 'ipynb', 'parquet', 'sqlite', 'db', 'proto', 'gradle',
])

const HEADING = '## Tool Footprint (harness-generated, files & commands touched)'
// 同一规则见 index.mjs：单条放不下时显式标注，而不是静默切尾
const TRUNC_MARK = '…（本项过长，已截断）'

const FILE_TOOLS = new Set(['read', 'edit', 'write', 'read_image', 'notebook_edit', 'multi_edit'])
const SEARCH_TOOLS = new Set(['grep', 'glob'])
const URL_TOOLS = new Set(['web_fetch'])

/** 段与扩展名闸门 —— 与早前的实体抽取器同源。 */
export function looksLikePath(p) {
  if (typeof p !== 'string' || p.length < 3) return false
  const segs = p.split('/').filter(Boolean)
  if (segs.length < 1) return false
  if (!segs.every((s) => s.length >= 1 && /^[\w.@+-]+$/.test(s))) return false
  // `68.61/223` 这类评分列表。⚠️ 这一条是**冗余的纵深防御**：`KNOWN_EXT` 里全是字母扩展名，
  // 而"所有段都是纯数字"意味着末段无点号（`dot <= 0` 先拒）或点是小数点（扩展名是数字，白名单先拒），
  // 所以它永远不会是唯一防线（穷举 1,044 组全数字段候选，0 命中）。保留不动，但**不要**写一条
  // "删掉这行就会变红"的断言来证明它 —— 那断言是假的。
  if (segs.every((s) => /^\d+(\.\d+)?$/.test(s))) return false
  const last = segs[segs.length - 1]
  const dot = last.lastIndexOf('.')
  if (dot <= 0) return false
  return KNOWN_EXT.has(last.slice(dot + 1).toLowerCase())
}

function parseArgs(a) {
  if (a && typeof a === 'object') return a
  if (typeof a !== 'string') return {}
  try {
    const v = JSON.parse(a)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/**
 * 取"有信息量"的命令 token。
 *
 * ⚠️ 首轮真实数据暴露：真实会话里绝大多数命令写成 `cd /x && 真命令`，
 * 直接取首 token 得到的是 **`cd×503`** —— 命令行几乎零信息。
 * 所以先把命令按 `&& || ; |` 切段，**丢弃 `cd` 段**，再取第一个不在噪声表里的 token。
 * 噪声表只收"不表达意图"的导航/无副作用命令，且**先声明后使用**。
 */
const CMD_NOISE = new Set([
  // 导航/无副作用
  'cd', 'echo', 'sleep', 'true', 'false', ':', 'export', 'source', 'set', 'printf', 'wait',
  // **永不作为命令出现的关键字** —— heredoc 体（`python3 - <<PY\nimport …`）被按行切开后，
  // 这些词会冒出来当"命令"（实测 `import×94`、`from×4`）。它们在任何 shell/Python 里
  // 都不可能是一条命令的开头，剔除无风险。
  'import', 'from', 'do', 'done', 'then', 'fi', 'else', 'elif', 'esac', 'def', 'class',
  'return', 'print', 'EOF', 'PY', 'END',
])

/** 顶层分隔符切分：**引号/反引号内部不切**。 */
function splitTopLevel(cmd) {
  const out = []
  let buf = ''
  let q = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (q) {
      buf += ch
      if (ch === q && cmd[i - 1] !== '\\') q = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; buf += ch; continue }
    if (ch === '&' && cmd[i + 1] === '&') { out.push(buf); buf = ''; i++; continue }
    if (ch === '|' && cmd[i + 1] === '|') { out.push(buf); buf = ''; i++; continue }
    if (ch === ';' || ch === '|' || ch === '\n') { out.push(buf); buf = ''; continue }
    buf += ch
  }
  out.push(buf)
  return out
}

/** token 形状闸门：命令名只可能是这些字符。挡掉引号/花括号/中文等"代码碎片"。 */
const TOKEN_SHAPE = /^[A-Za-z0-9_./$@+-]+$/

/**
 * 取"有信息量"的命令 token。
 *
 * ⚠️ 两轮真实数据各暴露一个缺陷，都是"先检查输出"才发现的：
 * ① 首轮：真实命令多写成 `cd /x && 真命令`，直接取首 token 得到 **`cd×503`**；
 * ② 次轮：把 `;` `|` 一律当分隔符，会在**引号内部**切开 —— 于是 `echo "data:image/png;base64,…"`
 *    被切成 `echo "data:image/png` 与 `base64,…`，跳过噪声后返回的是**代码碎片**
 *    （实测混进 `base64,{b64(f)}"}})` 等 40 余条垃圾命令）。
 * ⇒ 现在：**引号感知切分** + **token 形状闸门** + 噪声表。
 */
function firstToken(cmd) {
  if (typeof cmd !== 'string') return null
  // ⚠️ **只切第一行**：多行命令的后续行是 heredoc 体（数据），不是命令。
  // 第三轮真实数据抓到的：`cd X && /很长/venv/bin/python - <<'PY'` 里 venv 路径超过长度闸门被丢，
  // 循环于是走进函数体，把 `ed = json.load(...)`、`key = env.get(...)` 当成了命令（实测 20+ 条垃圾）。
  const firstLine = cmd.split('\n')[0]
  for (const seg of splitTopLevel(firstLine)) {
    const m = seg.trim().match(/^[^\s]+/)
    if (!m) continue
    let t = m[0].replace(/^["']|["']$/g, '')
    if (t.includes('/')) t = t.slice(t.lastIndexOf('/') + 1)   // 长路径取 basename（/usr/bin/python3 → python3）
    if (!t || t.length < 2 || t.length > 40) continue
    if (!TOKEN_SHAPE.test(t)) continue
    if (CMD_NOISE.has(t)) continue
    return t
  }
  return null
}

function stripUrl(u) {
  if (typeof u !== 'string') return null
  const m = u.match(/^https?:\/\/([^\s/?#]+)(\/[^\s?#]*)?/)
  if (!m) return null
  return (m[1] + (m[2] ?? '')).replace(/\/$/, '')
}

/**
 * 纯函数：扫描被压缩面，收集"动过什么"。
 * @returns {{files: Map, commands: Map, urls: Map, other: Map, lastSeen: Map}}
 */
export function collectTouched(messages) {
  const files = new Map()      // path -> Map(op -> count)
  const commands = new Map()   // token -> count
  const urls = new Map()
  const other = new Map()      // toolName -> count
  const lastSeen = new Map()   // key -> 序号（越大越新）
  let order = 0
  const bump = (map, key) => { map.set(key, (map.get(key) ?? 0) + 1); lastSeen.set(key, order++) }
  const bumpOp = (path, op) => {
    if (!files.has(path)) files.set(path, new Map())
    const m = files.get(path)
    m.set(op, (m.get(op) ?? 0) + 1)
    lastSeen.set(path, order++)
  }

  for (const msg of messages ?? []) {
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const b of msg.content) {
      if (b?.type !== 'tool-call') continue
      const name = String(b.name ?? '')
      const a = parseArgs(b.arguments)
      if (FILE_TOOLS.has(name)) {
        const p = a.file_path ?? a.path ?? a.notebook_path
        if (looksLikePath(p)) bumpOp(p, name)
        else if (p) bump(other, `${name}(非路径参数)`)
        continue
      }
      if (SEARCH_TOOLS.has(name)) {
        const p = a.path
        if (looksLikePath(p)) bumpOp(p, name)
        else if (typeof a.pattern === 'string' && a.pattern.trim()) bump(other, `${name}:${a.pattern.trim().slice(0, 40)}`)
        continue
      }
      if (name === 'bash') {
        const t = firstToken(a.command)
        if (t && t.length >= 2 && t.length <= 40) bump(commands, t)
        continue
      }
      if (URL_TOOLS.has(name)) {
        const u = stripUrl(a.url)
        if (u) bump(urls, u)
        continue
      }
      if (name) bump(other, name)
    }
  }
  return { files, commands, urls, other, lastSeen }
}

/**
 * 纯函数：构造附录文本。
 * @returns {{text:string, files:number, commands:number, omitted:number, chars:number}}
 */
export function buildFootprint(messages, budget = 4000) {
  const { files, commands, urls, other, lastSeen } = collectTouched(messages)
  const empty = { text: '', files: 0, commands: 0, omitted: 0, chars: 0 }
  if (files.size === 0 && commands.size === 0 && urls.size === 0) return empty

  const byCountThenNew = (a, b) => (b[1] - a[1]) || ((lastSeen.get(b[2]) ?? 0) - (lastSeen.get(a[2]) ?? 0))

  const fileItems = [...files.entries()]
    .map(([p, ops]) => [p, [...ops.values()].reduce((x, y) => x + y, 0)])
    .sort(byCountThenNew)
    .map(([p, n]) => {
      const ops = [...files.get(p).entries()].sort((a, b) => b[1] - a[1]).map(([o, c]) => (c > 1 ? `${o}×${c}` : o))
      return `\`${p}\` (${ops.join(', ')})`
    })
  const cmdItems = [...commands.entries()].sort(byCountThenNew).map(([c, n]) => (n > 1 ? `\`${c}\`×${n}` : `\`${c}\``))
  const urlItems = [...urls.entries()].sort(byCountThenNew).map(([u]) => `\`${u}\``)
  const otherItems = [...other.entries()].sort(byCountThenNew).slice(0, 12).map(([o, n]) => (n > 1 ? `${o}×${n}` : o))

  // 分配：文件优先（实测：路径类锚点最有价值），其次命令，再次网络/其它
  const lines = []
  let omitted = 0
  const used = () => HEADING.length + 1 + lines.reduce((n, l) => n + l.length + 1, 0)
  const pushAll = (label, items, cap) => {
    if (!items.length) return
    const head = `- ${label}：`
    const keep = []
    // ⚠️ 必须用**本地累计长度**：早先版本在这里调 used()，而 used() 只看已 push 进 lines 的行，
    // 于是本轮待加入的条目一条都没被判定超预算 —— 200 条全进、省略计数恒为 0，
    // 最后被硬截断**静默**丢数据（自检第 5 条抓到的）。
    let run = used()
    for (const it of items) {
      const add = (keep.length === 0 ? head.length : 1) + it.length
      if (run + add + 1 > cap) { omitted += items.length - keep.length; break }
      keep.push(it)
      run += add
    }
    if (keep.length) lines.push(`${head}${keep.join('；')}`)
  }
  pushAll('文件（按触碰次数）', fileItems, budget)
  pushAll('命令', cmdItems, budget)
  pushAll('网络', urlItems, budget)
  if (otherItems.length) pushAll('其它工具', otherItems, budget)

  if (lines.length === 0) return empty
  // 收尾：与 buildTurnIndex 同一规则（见该处注释）——省略提示永不丢、显式截断、
  // 放不下就不注入，任何情况下 chars ≤ budget。旧实现在这里同样是无条件切尾。
  const notice = omitted > 0 ? `- … 另有 ${omitted} 项因预算省略'\n'` : ''
  const fixed = HEADING.length + 1 + notice.length
  if (budget < fixed + TRUNC_MARK.length + 1) {
    return { text: '', files: files.size, commands: commands.size, omitted: omitted + lines.length, chars: 0 }
  }
  let body = lines.join('\n')
  if (fixed + body.length + 1 > budget) {
    const room = Math.max(0, budget - fixed - TRUNC_MARK.length - 1)
    body = body.slice(0, room) + TRUNC_MARK
  }
  const text = HEADING + '\n' + body + '\n' + notice
  return { text, files: files.size, commands: commands.size, omitted, chars: text.length }
}
