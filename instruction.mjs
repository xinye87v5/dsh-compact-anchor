/**
 * 指令侧 —— **取消"由模型逐条引用"的要求**，改由 harness 在输出后追加 Turn Index。
 *
 * ## 依据（实测）
 *
 * 把"逐条引用用户原话"写成对模型的硬要求时，实测下限只有 **61.1%**
 * （口径：一次长篇会话的留出窗口）—— 因为**提示词请求 ≠ 结构保证**。
 * 同类工具都是**用代码**保留用户消息，而不是靠模型自觉。
 *
 * 所以这份指令只做一件事：把枚举用户回合的活儿**从模型手里拿走**，
 * 让模型的预算回到"技术状态与决策"上；逐字与"所指"由 `index.mjs` 机械保证。
 *
 * 长度 **4422 字符**（DSH 官方压缩指令 1802 字符，2.45×；实测值，`String.length`）。
 */
export const IMPROVED_COMPACTION_INSTRUCTION = [
  "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
  "",
  "Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section — never drop a section.",
  "",
  "## Primary Request and Intent",
  "- A BRIEF chronological list of the user's turns in this span, oldest first: one short line each, intent and decision only. The exhaustive verbatim copy is appended by the harness — do NOT duplicate it, and do NOT expand this section.",
  "- The harness appends a machine-generated \"Turn Index\" section AFTER your output, which reproduces every substantive user turn VERBATIM with a short note of what it was responding to. Do NOT spend your budget re-listing all user turns one by one: cover their intent and the decisions taken, and leave the exhaustive verbatim enumeration to that appended index.",
  "- Still copy any user wording that carries a constraint, a correction, or a decision — the index guarantees presence, not emphasis.",
  "",
  "The list above is the priority, but the checkpoint must not lose the technical record either. While the same budget lasts, these are REQUIRED — you have room up to the ceiling stated below:",
  "- Files and Code: every file path that mattered, and the line numbers actually cited (write them as L123, exactly as they appeared). A path or line range that was used to make a decision belongs here even if it was mentioned only once.",
  "- Every clock time, date, and DURATION that was stated or computed (e.g. \"20分钟\", \"4:10\", \"12月20日\"), exactly as written — durations especially: they are derived values and cannot be recovered.",
  "- Superseded Rulings and Forbidden Zones: every ruling that was reversed (old → new) and everything forbidden, ONE BULLET EACH. These are regression guards: if they are lost the next model silently reinstates a corrected mistake.",
  "",
  "## Key Technical Concepts",
  "- [technologies, frameworks, patterns, and conventions in play]",
  "",
  "## Files and Code",
  "- [exact path: why it matters, key changes or snippets]",
  "",
  "## Errors and Fixes",
  "- [error: how it was resolved, plus any related user feedback]",
  "",
  "## Pending Jobs",
  "- [explicitly requested work not yet completed]",
  "",
  "## Current Work",
  "- [precisely what was in progress at this checkpoint]",
  "",
  "## Next Step",
  "- [the single next action, directly in line with the most recent request, or \"(none)\"]",
  "",
  "## Critical Context",
  "- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
  "",
  "Rules:",
  "- Write concise prose in the conversation's own language; quote user text verbatim in its original language and never translate quotations, proper nouns, or technical terms.",
  "- Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
  "- Copy the user's own words VERBATIM for every requirement, constraint, preference, correction, and decision, including the reason they gave; a paraphrased constraint is a DIFFERENT constraint.",
  "- Cover the WHOLE span, from the first message to the last: every user turn must be accounted for. Later turns must never crowd out earlier ones — a checkpoint that covers only the recent part has FAILED.",
  "- Be dense, not long: the Turn Index appended by the harness already carries the verbatim user turns, so spend your budget on decisions, constraints, state and anchors rather than on restating them. Never pad to fill space.",
  "- Do not pad: the harness guarantees the user turns are present, so a SHORTER checkpoint that covers decisions, constraints and state beats a longer one that repeats them.",
  "- Only when space genuinely runs short, cut operational detail (paths, commands, transient values, code) — never a user turn, a quotation, or an exact number.",
  "- Keep every date, clock time, duration, and numeric anchor exactly as written, and say when a value that can go stale was measured.",
  "- Do NOT mention this summarization request or that the context was compacted.",
  "- Output only the checkpoint text: do not call any tool or take any other action.",
  "- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.",
].join('\n')

export const ORIGINAL_INSTRUCTION_MARKER = 'You are now acting as a compaction engine for this AI coding assistant.'
export const IMPROVED_INSTRUCTION_MARKER = 'The harness appends a machine-generated'
