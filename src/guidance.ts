// 记忆协议 —— 本次迭代从 dsh-mnemon 学到的第一条、也是最重要的一条。
//
// 为什么单独一层：工具的 description 只回答「这个工具能做什么」，
// 不回答「什么时候该用、什么时候绝对不该用」。后者是纪律，必须作为
// 系统提示的一段常驻，模型才会真的遵守；否则记忆工具形同虚设 ——
// 模型要么整轮不碰，要么把检索回来的东西又写回记忆（污染源头）。
//
// 与设计文档的关系（顺带解释为什么它能零成本）：
//   这段文本每轮**逐字相同**（只在 writeEnabled 变化时变），
//   所以它落在稳定前缀里 —— 引擎的前缀缓存第一次算完就留住了，
//   之后每轮复用。这正是「人设/协议不需要向量，只需要稳定」那句话的落地。
//
// 文本刻意写紧：它住在每一轮的上下文里，长度直接换成 token 成本。
// dsh-mnemon 的协议正文接近 2000 字符，那是它的选择；我们的目标是
// 把同样的纪律压进一半长度里。

export const PROTOCOL_SECTION = 'lmmarr:protocol';

/**
 * 系统提示里这段协议的位置。
 * 取 4300：排在各工具用法说明（1000–3100）之后、TOOLS_SDK（5000）之前，
 * 属于「项目级纪律」该在的区段。
 */
export const PROTOCOL_ORDER = 4300;

export interface ProtocolFacts {
  /** 只读档：不描述写工具，并显式告诉模型不要尝试写 */
  writeEnabled: boolean;
}

const HEAD = `LMMARR MEMORY PROTOCOL
Memory is a directory of Markdown files in three layers:
  MEMORY.md             index only — task table, relationship graph, machine-readable edge block
  MEMORY_<task-id>.md   one file per task — status, progress and notes
  YYYY-MM-DD.md         append-only raw log, written by hand, not by these tools
The index is projected below; do not call lmmarr_index merely to see it again.`;

const READ_BLOCK = `READ
- lmmarr_context loads one task plus its direct neighbourhood, and nothing else.
  Keep one topic per task id so that stays true.
- Read when the work depends on an earlier decision, or when the user refers to something not visible here.
  Never invent a stored fact that no tool returned.`;

const WRITE_BLOCK = `WRITE
- lmmarr_upsert records a milestone, a decision, a constraint, or a user correction. Reuse a stable kebab-case id per topic; reusing it updates that task and preserves every field you omit.
- Put a one-line state in summary and the substance in body. Record decisions, constraints and reusable lessons — not progress chatter, not secrets, not what the code already says.
- lmmarr_link declares child (decomposed into), depends (prerequisite) or relates (weak). child and depends must stay acyclic.
- lmmarr_forget deletes one task file and its edges. Only on an explicit request, or when an entry is provably wrong.
- Answering a read question is read-only: never write back what a read returned.
- A write exists only after its receipt. Never claim memory was saved otherwise.`;

const WRITE_BLOCK_DISABLED = `WRITE — DISABLED
This profile runs lmmarr read-only. Read the memory below; do not attempt to change it, and tell the user when a change is needed.`;

export function renderProtocol(facts: ProtocolFacts): string {
  return [HEAD, '', READ_BLOCK, '', facts.writeEnabled ? WRITE_BLOCK : WRITE_BLOCK_DISABLED].join('\n');
}

/** 只读档下模型可见的工具名（写工具仍然注册，但由权限在调用时挡住并给出明确原因） */
export const WRITE_TOOLS = ['lmmarr_upsert', 'lmmarr_link', 'lmmarr_forget'] as const;
