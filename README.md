# dsh-compact-anchor

> **Stop *asking* the model to preserve the user's words — guarantee it in code.**
> 不再"请求"模型保留用户原话，改由**代码**保证。

DSH（DeepSeek Harness）插件。在上下文压缩的接缝上，harness 会把两份**代码生成**的附录
追加进 checkpoint：

- **Turn Index** —— 每个用户回合**逐字**在场，短发言另附**所指锚**（它当时在回应什么）
- **Tool Footprint**（可选）—— 这段里**真动过**哪些文件与命令

**实测效果**（作者自测，非第三方基准；条件与样本量见"实测效果"一节）

| 指标 | 不开 | 开 |
|---|---|---|
| 「所指有痕」：短发言指向的东西还找得到吗 | **≈ 0%** | **78–100%** |
| 用户原话逐字覆盖（严格档下限） | 61.1% | **100.0%** |
| 路径类锚点存活 | 34% | 由 footprint 补齐 |

```bash
dsh plugin --profile web add dsh-compact-anchor
```

纯 ESM · 零运行时依赖 · 无构建步骤 · 不改上游 · **`apply()` 内部绝不抛错**（DSH 契约：抛错会让整个 dsh 起不来）

---

## 它修的是什么

上下文压缩（compaction）的接缝上有两处信息损失，都是**提示词管不住**的：

| 症状 | 实测 | 本插件的修法 |
|---|---|---|
| 用户原话被改写、被合并、被漏掉 | 只在提示词里要求"逐条引用用户原话"时，覆盖率下限 **61.1%** | 指令**不再要求**模型枚举用户回合（那件事交给代码），附录由 harness 逐字追加 |
| **"用户在回应什么"完全丢失** | "所指有痕"在 12 组对照条件下**几乎恒为 0** | 每条短发言附一个**机械抽取的所指锚**（上一条 assistant 的工具调用 + 文本结尾） |
| （可选）文件路径与命令消失 | **路径类锚点存活 34%、bash 锚点存活 3.1%** | `footprint.enabled` 打开后，用代码把"动过什么"写进 checkpoint |

关键点在于**谁负责**：提示词请求 ≠ 结构保证。把枚举用户回合的活儿从模型手里拿走之后，模型的预算回到"技术状态与决策"上，而逐字与所指由代码保证。

## 怎么装

前提：DSH 已安装，profile 已存在（没有会自动初始化），`pnpm` 在 PATH 上。

```bash
# ① 从 npm（推荐；发布后可用）
dsh plugin --profile web add dsh-compact-anchor

# ② 从本仓库的本地路径（monorepo 里的子目录用这条）
dsh plugin --profile web add /path/to/dsh-plugins/仓库根

# ③ 从 tarball（打一个包再装，适合不走 registry 的场合）
cd 仓库根 && npm pack
dsh plugin --profile web add ./dsh-compact-anchor-0.1.0.tgz
```

装完**重启 dsh** 生效。`dsh plugin add` 会把包装进 profile 目录，并把 `dsh-compact-anchor` 追加进该 profile 的 `dsh.profile.bundles` —— 这一步之所以会发生，是因为本包在 `package.json` 里声明了：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

**这个字段是"能否被 `dsh plugin add` 装上"的判据**，缺了它包只会作为普通依赖装进去，**永远不会成为 profile 的一层**（DSH 与插件市场都会明确警告这一点，见下文「关于 `dsh.bundle`」）。

本包**没有 `prepare` 脚本、没有构建步骤**，所以不需要 pnpm 的 `allowBuilds` 授权。

### 手工安装（不走 `dsh plugin`）

编辑 `$DSH_HOME/profiles/<name>/package.json`，把两件事都做上：

```json
{
  "dependencies": { "dsh-compact-anchor": "^0.1.0" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-compact-anchor"] } }
}
```

然后在 profile 目录里 `pnpm install`。**只加 dependencies 不加 bundles 是没用的**（缺的就是那一层）。

### 卸载

```bash
dsh plugin --profile web remove dsh-compact-anchor
```

## 配置

全部可选。默认值如下：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 则完全不挂载（连 `llm.stream` 都不碰） |
| `budget` | `12000` | Turn Index 的字符预算；超预算时**可见省略**最旧的回合 |
| `footprint.enabled` | `false` | 是否追加「工具足迹」一节（**默认关闭**，见「已知边界」） |
| `footprint.budget` | `4000` | 工具足迹的字符预算；超预算时可见省略并报数 |
| `attestTo` | `$DSH_HOME/reports/turn-index.jsonl`<br>（无 `DSH_HOME` 时 `~/.dsh/reports/turn-index.jsonl`） | 存证文件路径 |

改配置的标准位置是 profile 自己的 `cordis.patch.yml`（`$DSH_HOME/profiles/<name>/cordis.patch.yml`），按**行 id** 命中，最后一次写入生效：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: compact-anchor
  config:
    budget: 12000
    footprint:
      enabled: true      # 打开工具足迹附录
      budget: 4000
```

也可以直接改本包 `cordis.patch.yml` 里那行 `config:`（注释里写了默认值），但那会在下次升级包时被覆盖 —— 优先用 profile 的 patch。

## 它做什么（机制）

只在 `purpose === 'compaction'` 的 `llm.stream` 调用上生效，其余调用**原样透传**（连 `options` 对象都不换）。两个附录都是**纯函数**生成的文本：

1. **Turn Index** —— `buildTurnIndex(messages, budget)`。逐字收录每个"真实用户发言"（排除 `source.kind !== 'user'` 的 plugin 消息、以及压缩指令自身），给**短发言（≤20 字符）**配一条所指锚。锚是机械抽取的：上一条 assistant 消息里的工具调用（名字 + 主参数）与文本**结尾**（取结尾不取开头 —— 用户回应的是对方最后给出的结论）。
2. **Tool Footprint**（可选）—— `buildFootprint(messages, budget)`。只扫 `assistant` 消息的 `tool-call` 块（**刻意不解析工具结果**，那正是要丢的东西）：文件路径、`bash` 命令的第一个有信息量的 token（穿透 `cd X && …`）、`web_fetch` 的 URL。带垃圾过滤与形状闸门。

**注入点**（读 DSH 源码得到的硬约束，不能想当然）：`BlockAssembler` 的契约写着 *"deltas arriving for an index already closed by `block-end` are ignored"*，所以附录必须在文本块的 `block-end` **之前**发出，并且**同时改写 `block-end.block.text`**（闭合块可能只认 `block`、不认累积的 delta）。两条路都覆盖；若 provider 只发 delta（没有 `block-end`），则在 `finish` 之前补发一次。附录不参与模型输出，因此**不影响**引擎"撞顶拒收"的判断。

### 导出的契约

```js
export const name = 'dsh-compact-anchor'   // 插件名
export const inject = ['llm']              // 依赖的服务
export function apply(ctx, config)         // 挂载
export default { name, inject, apply }
```

> ⚠️ **`apply()` 绝不抛，这是硬要求。** DSH 启动时会调用每个插件的 `apply()`，任何逃逸的异常都会让**整个 dsh 启动失败** —— 不只是本插件失效，是连 shell 都起不来。所以这里从探测服务、替换 `llm.stream`、到注册清理，每一步都在 try 里，失败只落存证。

### 挂载是可重试的

headless 启动时 `llm` 可能还没装配完，`apply()` 的那一刻探不到 `llm.stream`。第一版一次性探测后直接放弃，结果是**那些会话里插件静默不生效**。现在：先试一次，失败则每 250ms 重试，最多 60 次（约 15 秒）。服务是异步装载的，取值不能只试一次。

## 怎么验

### 单元测试（离线，不需要装 DSH）

```bash
cd 仓库根
node --test test/*.test.mjs
```

覆盖：Turn Index 的逐字/锚/排除规则/预算分层降级、指令改写（含"非压缩用途不改写"与"不改就地修改原消息"）、**流注入的两种协议**（`block-end` 与 delta-only，含"附录在 `block-end` 之前"和"`block-end.block.text` 也被改写"）、非压缩调用透传、`apply()` 在取不到 llm 时不抛、以及**惰性/重试挂载**。工具足迹一侧另有一组反证用例（把抽取关掉，正向断言必须变红）。

这些断言都做过**变异验证**（改坏实现 ⇒ 对应用例必须变红），结果记在两个测试文件的头部注释里。唯一的例外是 `looksLikePath()` 里的"数字段闸门"：它**不可达** —— 扩展名白名单已经先拒掉了所有纯数字段列表，所以它只是纵深防御，测试里按契约断言处理，不假装能证明那一行。

### 在生产里确认它真的生效

```bash
# 挂载成功（含配置状态）
grep '"kind":"mounted"' "$DSH_HOME/reports/turn-index.jsonl" | tail -1

# 每次真实注入：回合数、字符数、是否带工具足迹
grep '"kind":"turn-index-injected"' "$DSH_HOME/reports/turn-index.jsonl" | tail -3
```

判据是**证据**，不是"文件里写了"。只有 `mounted` 而没有 `turn-index-injected`，说明这个会话里没发生过压缩；一条都没有，说明没挂上（`not-mounted` / `mount-deferred` 会写明原因）。

## 实测效果

以下数字来自作者自己的测量（同一条会话、同一套判据的前后对比），**不是**独立第三方基准：

| 指标 | 改前 | 改后 |
|---|---|---|
| 逐字保留用户发言（仅提示词要求） | 下限 61.1% | 由代码保证在场（12,000 字符预算，超出可见省略） |
| "所指有痕"（用户发言能对回它回应的那段） | 0% | **78–100%** |
| 路径类锚点存活 / bash 锚点存活（工具足迹未开） | 34% / 3.1% | 打开 `footprint.enabled` 后由代码写入 |

"所指有痕"指的是：一条**短发言**（"同意"、"就按这个来"）在压缩后仍能读出它在回应什么。这正是不加锚时唯一恒为 0 的那一项，也是本插件存在的理由。

## 已知边界

- **只在压缩时生效**：`purpose !== 'compaction'` 一律透传，其他任何 LLM 调用零影响。
- **靠标记识别官方压缩指令**：指令改写只有在最后一条 user 消息里出现官方压缩指令的固定开头时才发生（`ORIGINAL_INSTRUCTION_MARKER`）。**DSH 若改了这段措辞，本插件会静默变成透传** —— 表现为存证里不再出现新的 `turn-index-injected`。这是能接受的失效方式（压缩照常工作，只是少了附录），但升级 DSH 后值得照「怎么验」看一眼。
- **锚只给短发言**：长度 ≤20 字符的用户发言才配锚（长发言自带上下文）。阈值写死在代码里，暂不对外暴露。
- **锚取自上一条 assistant 消息**：如果它没有工具调用、文本也空，锚就是空的。
- **预算是硬的**：预算不够时**先牺牲锚、再省略最旧的回合**，用户正文永远优先。省略一定会写成一行可见的说明，不静默丢弃。
- **Turn Index 只覆盖当前这次被压缩的面**：更早的、已经压过的回合不在 `messages` 里，也就不会出现在这次附录中。
- **工具足迹默认关闭**：它会改变 checkpoint 的内容面（多出一节），属于"改动生产行为"的一类，请显式打开。
- **本插件不改模型的输出**：附录是 harness 追加的。压缩模型写什么还是什么 —— 所以它治的是"用户发言与所指"，不是"摘要质量"。
- **存证文件只含元数据**：`turn-index.jsonl` 里是时间、pid、插件名、回合数、字符数、配置状态与错误原因，**不含任何用户发言或工具参数内容**。若把 `attestTo` 指到共享目录，请照此评估。

## 关于 `dsh.bundle`

`dsh.bundle` 的确切格式（依据：DSH 自身源码 + 6 个官方 bundle 包 + 3 个在装的社区插件）：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

- **`dsh.bundle.patch` 是一个字符串路径**（相对包根），指向一个 **cordis patch YAML**；它**不是**布尔值，也没有 `entry`/`main` 之类的字段名。
- DSH 源码里的判据：`plugins/...` 的 `exportsPatch()` 直接读 `readProfileManifest(...).dsh?.bundle?.patch !== void 0` —— 即"声明了这个字段，才算一个 profile bundle 层"。
- 缺了它，`dsh plugin add` 仍会装进 profile 目录，但**不会进 `dsh.profile.bundles`**；DSH 会打印警告：*"declares no dsh.bundle — installed as a plain dependency, not a profile layer"*，插件市场同样会把它标成普通依赖。
- patch YAML 的形状是 `insert:` 一行 `{ id, name }`，`name` 是模块说明符（本包直接写自己的包名）。

## 开发

```bash
cd 仓库根
npm test          # = node --test test/*.test.mjs
```

纯 ESM（`.mjs`），Node ≥ 20，无依赖、无构建。改完直接用 `dsh plugin --profile <name> add <本地路径>` 装进一个隔离 profile 验，别先动你在用的那个。

## License

MIT —— 见 [LICENSE](./LICENSE)。
