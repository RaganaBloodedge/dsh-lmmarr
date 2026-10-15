// 热记忆投影 —— 让「有哪些任务、彼此什么关系、进行到哪」常驻，而不是每轮重新问一遍。
//
// 这就是你在对话里说的那件事的落地：不要让模型每次都要"重新记忆出我是谁、
// 我在做什么"。做法不是把记忆压成向量，而是把它的**索引**逐字放进稳定前缀。
//
// 两条纪律，缺一不可：
//
//   1. 确定性。按 id 排序、**绝不含时间戳**。同一份记忆投影出的文本逐字相同，
//      稳定前缀才成立，前缀缓存才命中。我们自己的 MEMORY.md 里是带 updated
//      日期的（人读有用），但投影给模型的这份不带 —— 一次无关紧要的时间戳
//      变化就会把整段前缀的缓存打掉，而那正是我们想省的钱。
//      验证在 tests/project.test.ts：只改 updatedAt 不得改变投影。
//
//   2. 有预算。超长时截断，并且**显式说明截断了**。静默截断比不截断更危险：
//      模型会把"没看到"当成"不存在"，然后凭空推断。
//
// 纯函数、不碰 fs —— store 负责读，这里只负责渲染，所以能离线单测。

import type { TaskGraph, TaskNode } from './memory/graph.ts';

export const INDEX_SECTION = 'lmmarr:index';

/**
 * 系统提示里热记忆投影的位置。
 * 取 4400 —— 紧跟在协议（4300）之后：先读纪律，再读现状。
 */
export const INDEX_ORDER = 4400;

export interface ProjectionOptions {
  /** 记忆目录，展示给模型以便它知道记忆在哪 */
  dir: string;
  /** 硬预算（字符）。超出按「先丢关系 → 再裁任务」的顺序收敛。 */
  maxCharacters: number;
}

function taskLine(t: TaskNode): string {
  const detail = (t.summary || t.title).replace(/\s+/g, ' ').trim();
  return `  - ${t.id} [${t.status} ${Math.round(t.progress * 100)}%] ${detail}`;
}

/**
 * 把任务图谱渲染成一段确定性的热记忆文本。
 *
 * 输出形状（固定顺序、固定措辞）：
 *   LMMARR MEMORY — 3 task(s), 2 relation(s) (dir: …)
 *   tasks:
 *     - a [doing 60%] …
 *   relations:
 *     a child b
 */
export function projectIndex(graph: TaskGraph, opts: ProjectionOptions): string {
  const max = Math.max(0, opts.maxCharacters);
  const tasks = graph.listTasks();
  const edges = graph.listEdges();

  if (tasks.length === 0) {
    return [
      `LMMARR MEMORY — empty (dir: ${opts.dir})`,
      'No tasks recorded yet. Use lmmarr_upsert when work starts, so the next session can pick it up.',
    ].join('\n');
  }

  const head = (bounded: boolean): string =>
    `LMMARR MEMORY — ${tasks.length} task(s), ${edges.length} relation(s) (dir: ${opts.dir})` +
    (bounded ? '\n(bounded projection: an omission here is not a deletion)' : '');

  const body = (taskCount: number, withEdges: boolean, bounded: boolean): string => {
    const lines = [head(bounded)];
    if (taskCount > 0) {
      lines.push('tasks:');
      for (let i = 0; i < taskCount; i++) lines.push(taskLine(tasks[i]));
    }
    const omitted = tasks.length - taskCount;
    if (omitted > 0) {
      lines.push(`  …${omitted} more task(s) omitted — call lmmarr_index for the full table`);
    }
    if (withEdges) {
      lines.push('relations:');
      for (const e of edges) lines.push(`  ${e.from} ${e.kind} ${e.to}`);
    }
    return lines.join('\n');
  };

  // ① 完整版放得下就原样返回 —— 绝大多数记忆库都走这条路径
  const full = body(tasks.length, edges.length > 0, false);
  if (full.length <= max) return full;

  // ② 先丢关系块：关系仍能从 lmmarr_index 读回来，而任务状态更常被直接问到
  const noEdges = body(tasks.length, false, true);
  if (noEdges.length <= max) return noEdges;

  // ③ 再从尾部裁任务，直到放得下（裁掉的数量会显式写在文本里）
  for (let n = tasks.length - 1; n >= 0; n--) {
    const candidate = body(n, false, true);
    if (candidate.length <= max) return candidate;
  }

  // ④ 连一条任务都放不下：只留头与解释（极端小预算下的诚实降级）
  return [
    head(true),
    `tasks: 0 of ${tasks.length} shown — budget ${max} characters is too small; call lmmarr_index`,
  ].join('\n');
}
