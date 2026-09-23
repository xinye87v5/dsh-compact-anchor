#!/usr/bin/env node
/**
 * `footprint.mjs` 的自检：工具足迹附录。
 *
 * 纪律：**反证必须能变红** —— 每个断言都要能指出"关掉哪一行会让它失败"。
 * 本文件已逐条做过变异验证（改坏实现 ⇒ 对应用例变红）；唯一例外是 `looksLikePath` 的
 * 数字段闸门，它**不可达**（见 `footprint.mjs` 里的说明），所以只作契约断言，不假装能证明那一行。
 *
 * 用法: node --test test/footprint.test.mjs
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildFootprint, collectTouched, looksLikePath } from '../footprint.mjs'

const call = (name, args) => ({ type: 'tool-call', id: 'x', name, arguments: JSON.stringify(args) })
const msg = (...blocks) => ({ role: 'assistant', content: blocks })

// ── 1. 文件：同类合并 + 计数 ────────────────────────────────────────────────

test('1a. 同一路径合并操作并计数（edit×2, read）', () => {
  const m = [msg(call('read', { file_path: '/tmp/a/one.md' }), call('edit', { file_path: '/tmp/a/one.md' }),
    call('edit', { file_path: '/tmp/a/one.md' }), call('read', { file_path: '/tmp/a/two.ts' }))]
  const { text } = buildFootprint(m)
  assert.match(text, /one\.md` \(edit×2, read\)/)
})

test('1b. 另一个路径单独成条', () => {
  const m = [msg(call('read', { file_path: '/tmp/a/one.md' }), call('edit', { file_path: '/tmp/a/one.md' }),
    call('edit', { file_path: '/tmp/a/one.md' }), call('read', { file_path: '/tmp/a/two.ts' }))]
  const { text } = buildFootprint(m)
  assert.match(text, /two\.ts` \(read\)/)
})

// ── 2. 命令：只取第一个 token 并去重 ────────────────────────────────────────

test('2. 命令取首 token，`npm` 计 2 次；`git` 也在场', () => {
  const m = [msg(call('bash', { command: 'npm test --silent' }), call('bash', { command: 'npm run build' }),
    call('bash', { command: 'git log --oneline -5' }))]
  const { text } = buildFootprint(m)
  assert.match(text, /命令：`npm`×2；`git`/)
})

// ── 2b. 命令：必须穿透 `cd X && …`（首轮隔离验证抓到的）────────────────────

test('2b-i. 穿透 cd/&& 取到真命令（python3×2）', () => {
  const m = [msg(call('bash', { command: 'cd /srv/repo && python3 -m pytest -q' }),
    call('bash', { command: 'cd /srv/repo && python3 -m pytest tests/' }),
    call('bash', { command: 'sleep 5; curl -s http://x' }))]
  const { text } = buildFootprint(m)
  assert.match(text, /`python3`×2/)
})

test('2b-ii. cd 是导航噪声，不得占据命令行', () => {
  const m = [msg(call('bash', { command: 'cd /srv/repo && python3 -m pytest -q' }),
    call('bash', { command: 'cd /srv/repo && python3 -m pytest tests/' }),
    call('bash', { command: 'sleep 5; curl -s http://x' }))]
  const { text } = buildFootprint(m)
  assert.doesNotMatch(text, /`cd`/)
})

test('2b-iii. 分隔符后的第二条命令也要取到（curl）', () => {
  const m = [msg(call('bash', { command: 'cd /srv/repo && python3 -m pytest -q' }),
    call('bash', { command: 'cd /srv/repo && python3 -m pytest tests/' }),
    call('bash', { command: 'sleep 5; curl -s http://x' }))]
  const { text } = buildFootprint(m)
  assert.match(text, /`curl`/)
})

// ── 2c. 引号内的 ; | 不得切开（第二轮真实数据抓到的）──────────────────────

test('2c-i. 引号内内容不得变成命令', () => {
  const m = [msg(call('bash', { command: 'echo "data:image/png;base64,{b64(f)}" > /tmp/x.html' }),
    call('bash', { command: 'python3 - <<PY\nprint(1); x|y\nPY' }))]
  const { text } = buildFootprint(m)
  assert.doesNotMatch(text, /base64/)
})

test('2c-ii. heredoc 体不被当成命令（取到 python3）', () => {
  const m = [msg(call('bash', { command: 'echo "data:image/png;base64,{b64(f)}" > /tmp/x.html' }),
    call('bash', { command: 'python3 - <<PY\nprint(1); x|y\nPY' }))]
  const { text } = buildFootprint(m)
  assert.match(text, /`python3`/)
})

test('2c-iii. 命令 token 必须过形状闸门（无代码碎片）', () => {
  const m = [msg(call('bash', { command: 'echo "data:image/png;base64,{b64(f)}" > /tmp/x.html' }),
    call('bash', { command: 'python3 - <<PY\nprint(1); x|y\nPY' }))]
  const { text } = buildFootprint(m)
  assert.ok(!/`[^`]*[{}(一-鿿]/.test(text), '命令 token 必须过形状闸门：' + text)
})

// ── 3. 垃圾过滤（早前抽取器的教训）────────────────────────────────────────

test('3a. 评分列表/斜杠列表被拒', () => {
  assert.equal(looksLikePath('68.61/223/11x'), false)
  assert.equal(looksLikePath('Completed/Active'), false)
  assert.equal(looksLikePath('Foo/Bar/Baz'), false)
})

test('3b. 真正的路径被接受（相对与绝对）', () => {
  assert.equal(looksLikePath('src/core/signals.mjs'), true)
  assert.equal(looksLikePath('/srv/data/a/b.jsonl'), true)
})

test('3c. 斜杠列表不得进入文件清单', () => {
  const m = [msg(call('read', { file_path: 'Foo/Bar/Baz' }), call('read', { file_path: 'a/b/c.ts' }))]
  const { files } = buildFootprint(m)
  assert.equal(files, 1)
})

test('3d. 被拒的参数也不得以原文出现在附录里', () => {
  const m = [msg(call('read', { file_path: 'Foo/Bar/Baz' }), call('read', { file_path: 'a/b/c.ts' }))]
  const { text } = buildFootprint(m)
  assert.doesNotMatch(text, /Foo\/Bar\/Baz/)
})

// ── 4. 排序：触碰次数降序 ───────────────────────────────────────────────────

test('4. 按触碰次数排序（高频道排在前面）', () => {
  const m = [msg(call('read', { file_path: '/a/rare.md' }), call('read', { file_path: '/a/hot.ts' }),
    call('edit', { file_path: '/a/hot.ts' }), call('edit', { file_path: '/a/hot.ts' }))]
  const { text } = buildFootprint(m)
  assert.ok(text.indexOf('hot.ts') < text.indexOf('rare.md'))
})

// ── 5. 预算：可见省略 ───────────────────────────────────────────────────────

function manyFiles() {
  const blocks = []
  for (let i = 0; i < 200; i++) blocks.push(call('read', { file_path: `/very/long/path/number/${i}/file_${i}.markdown` }))
  return [msg(...blocks)]
}

test('5a. 超预算时输出被裁到预算内', () => {
  const { text } = buildFootprint(manyFiles(), 600)
  assert.ok(text.length <= 600, `预算内（实际 ${text.length}）`)
})

test('5b. 超预算必须报告省略数量（不是静默硬截断）', () => {
  const { text, omitted } = buildFootprint(manyFiles(), 600)
  assert.ok(omitted > 0)
  assert.match(text, /另有 \d+ 项因预算省略/)
})

  // 预算边界不变式（与 buildTurnIndex 同一规则）：chars ≤ budget；放不下就不注入；
  // 单条过长则显式标注截断。旧实现在收尾处无条件切尾，会切掉尾部条目且 chars 超预算 1。
  test('budget 边界：chars ≤ budget、放不下不注入、过长显式截断', () => {
    for (const b of [4000, 600, 200, 120, 90, 60, 20]) {
      const r = buildFootprint(manyFiles(), b)
      assert.ok(r.chars <= b, `budget=${b} 却 chars=${r.chars}`)
    }
    const tiny = buildFootprint(manyFiles(), 20)
    assert.equal(tiny.text, '')
    assert.equal(tiny.chars, 0)
    const tight = buildFootprint(manyFiles(), 120)
    assert.ok(tight.chars <= 120)
    if (tight.text) assert.match(tight.text, /本项过长/)
  })

// ── 6. 空输入 ⇒ 空文本（**不注入空壳标题**）────────────────────────────────

test('6. 无工具调用时不产生任何文本', () => {
  assert.equal(buildFootprint([]).text, '')
  assert.equal(buildFootprint([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]).text, '')
  assert.equal(buildFootprint([msg({ type: 'text', text: 'no tools' })]).text, '')
})

// ── 7. 反证：把抽取关掉，第 1 条必须变红 ────────────────────────────────────

test('7. 反证成立：抽取失效 ⇒ 输出为空（第 1 条确实在测抽取）', () => {
  const m = [msg(call('read', { file_path: '/tmp/a/one.md' }))]
  assert.match(buildFootprint(m).text, /one\.md/)
  // 模拟"抽取没测到东西"：把块类型改掉，功能应当整体消失
  const broken = buildFootprint([{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }]).text
  assert.equal(broken, '')
})

// ── 8. 其它工具与网络不丢 ───────────────────────────────────────────────────

test('8a. URL 去掉 scheme 与 query', () => {
  const m = [msg(call('web_fetch', { url: 'https://example.com/docs/page.html?x=1' }), call('subagent', { prompt: 'x' }))]
  const { text } = buildFootprint(m)
  assert.match(text, /example\.com\/docs\/page\.html/)
})

test('8b. 未知工具仍记名', () => {
  const m = [msg(call('web_fetch', { url: 'https://example.com/docs/page.html?x=1' }), call('subagent', { prompt: 'x' }))]
  const { text } = buildFootprint(m)
  assert.match(text, /subagent/)
})

// ── 9. collectTouched 是纯函数 ──────────────────────────────────────────────

test('9. collectTouched 不修改输入消息', () => {
  const m = [msg(call('read', { file_path: '/tmp/a/one.md' }))]
  const snapshot = JSON.stringify(m)
  collectTouched(m)
  assert.equal(JSON.stringify(m), snapshot)
})
