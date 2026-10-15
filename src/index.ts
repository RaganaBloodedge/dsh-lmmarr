// dsh-lmmarr —— DeepSeek Harness 插件入口。
//
// 一句话定位：**让「我在做什么、做到哪、和什么有关」零成本常驻的长期记忆**。
//
// 分层职责：
//   src/memory/    记忆内核（图谱 + 存储），零依赖、可离线单测
//   src/service.ts Cordis 服务：把记忆能力 provide 出去，工具只是它的一层视图
//   src/guidance.ts 记忆协议：告诉模型「什么时候该用、什么时候绝不该用」
//   src/project.ts  热记忆投影：把索引逐字放进稳定前缀，不需要每轮重新问
//   本文件          只做「按 dsh 插件规范挂载」这一件事
//
// 本地开发：  dsh web --patch ./cordis.yml
// 发布：      package.json 声明 dsh.bundle，构建产物在 lib/
//
// 两条硬规矩（违反了不报错，只是行为诡异）：
//   1. 只用具名导出，绝不 export default —— 默认导出会让加载器丢掉 inject 等元数据；
//   2. 模块顶层不留副作用，一切在 apply 内完成（插件会被反复挂载/卸载）。

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { join } from 'node:path';
import { MemoryStore } from './memory/store.ts';
import { NodeFs } from './memory/nodefs.ts';
import type { EdgeKind } from './memory/graph.ts';
import { createMemoryService, type LmmarrMemoryService, type MemorySnapshot } from './service.ts';
import { INDEX_ORDER, INDEX_SECTION, projectIndex } from './project.ts';
import { PROTOCOL_ORDER, PROTOCOL_SECTION, renderProtocol } from './guidance.ts';

export const name = 'dsh-lmmarr';

/**
 * 依赖的服务槽。
 * 只声明 tools：它没有就什么都干不了。
 * systemPrompt 是**可选**增强 —— 走 ctx.inject(['systemPrompt'], …) 而不是写进
 * 这里，否则在没有提示服务的 profile（如某些 headless）里整个插件都不会激活。
 * 这个取舍是从 dsh-mnemon 学来的。
 */
export const inject = ['tools'];

/** 提供给其它插件的服务名；用 ctx.get('lmmarrMemory') 取用 */
export const provide = ['lmmarrMemory'];

// 服务契约随包导出，扩展方无需依赖内部路径
export type { LmmarrMemoryService, MemorySnapshot } from './service.ts';

export interface Config {
  /** 记忆目录，默认 <cwd>/.dsh-memory */
  dir?: string;
  /** lmmarr_context 的默认邻域深度，默认 1 */
  depth?: number;
  /** 只读档：写工具一律拒绝执行（默认 false） */
  writeEnabled?: boolean;
  /** 是否注入记忆协议（默认 true） */
  guidance?: boolean;
  /** 是否把记忆索引投影进上下文（默认 true） */
  hotMemory?: boolean;
  /** 热记忆投影的字符预算（默认 2000） */
  maxProjectionCharacters?: number;
  /** 单个任务正文的软上限，超出只提示不自动改写（默认 16000） */
  bodySoftLimit?: number;
  /** 工具执行超时（毫秒，默认 10000） */
  timeoutMs?: number;
}

const STATUSES = 'todo | doing | blocked | done';
const KINDS = 'child | depends | relates';

// ---- 回执 schema 片段 ----
// dsh 只支持 JSON Schema 的一个子集，且**每个 object 都必须显式声明
// additionalProperties**（漏了会让 defineTool 抛错、插件静默不激活）。
// 固化成片段，避免四处手写走样。

const TASK_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    progress: { type: 'number' },
    summary: { type: 'string' },
    updatedAt: { type: 'number' },
    // tags 是 TaskNode 的真实字段，回执里必然带着它 —— 漏声明会让运行时
    // 以 additionalProperties:false 拒绝整个回执。这个字段是 L3（真实模型调用）
    // 抓出来的：写盘成功、回执报错，是最坏的一种失配。声明必须覆盖真实返回值。
    tags: { type: 'array', items: { type: 'string' } },
  },
} as const;

const EDGE_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string' },
    kind: { type: 'string' },
    to: { type: 'string' },
  },
} as const;

const PROBLEMS = { type: 'array', items: { type: 'string' } } as const;
/** 本次调用顺手修好的问题（目前只有重写索引会自愈的悬空边） */
const REPAIRED = PROBLEMS;

function renderSnapshot(v: MemorySnapshot, headline: string): string {
  const lines = [headline, `memory dir: ${v.dir}`, `index: ${v.indexPath}`, ''];
  if (v.tasks.length === 0) {
    lines.push('tasks: (none yet)');
  } else {
    lines.push(`tasks (${v.tasks.length}):`);
    for (const t of v.tasks) {
      lines.push(`  - ${t.id} [${t.status} ${Math.round(t.progress * 100)}%] ${t.summary || t.title}`);
    }
  }
  if (v.edges.length > 0) {
    lines.push('', `relations (${v.edges.length}):`);
    for (const e of v.edges) lines.push(`  - ${e.from} -${e.kind}-> ${e.to}`);
  }
  // 待处理的问题在前，"已顺手修好"的在后 —— 两者的动作完全不同
  if (v.problems.length > 0) {
    lines.push('', `problems (${v.problems.length}):`, ...v.problems.map((p) => `  - ${p}`));
  }
  if (v.repaired.length > 0) {
    lines.push('', `repaired by this call (${v.repaired.length}):`, ...v.repaired.map((p) => `  - ${p}`));
  }
  return lines.join('\n');
}

/** systemPrompt 服务的最小接口面 —— 只写我们用到的部分，避免硬依赖它的包 */
interface SystemPromptLike {
  section(value: { name: string; order: number; text: string | (() => string) }): unknown;
}

export function apply(ctx: Context, config: Config = {}): void {
  const dir = config.dir ?? join(process.cwd(), '.dsh-memory');
  const depth = config.depth ?? 1;
  const writeEnabled = config.writeEnabled ?? true;
  const guidanceEnabled = config.guidance ?? true;
  const hotMemoryEnabled = config.hotMemory ?? true;
  const maxProjectionCharacters = config.maxProjectionCharacters ?? 2000;
  const timeoutMs = config.timeoutMs ?? 10_000;

  const store = new MemoryStore({
    dir,
    fs: new NodeFs(),
    bodySoftLimit: config.bodySoftLimit ?? 16_000,
  });
  const memory = createMemoryService({ store, depth, writeEnabled });
  ctx.provide('lmmarrMemory', memory);

  const requireWrite = (tool: string): void => {
    if (!writeEnabled) {
      throw new Error(
        `${tool} is unavailable: this profile runs dsh-lmmarr read-only (writeEnabled: false)`,
      );
    }
  };

  // ---- 引导层：把纪律写进系统提示 ----
  // 这是本次迭代最重要的一块。工具的 description 只说"能做什么"，
  // "什么时候用、什么时候绝不该写"必须常驻，模型才会真的遵守。
  ctx.inject(['systemPrompt'], (scoped: Context) => {
    const prompt = ((scoped as unknown as { systemPrompt?: SystemPromptLike }).systemPrompt ??
      (scoped as unknown as { get?: (n: string) => unknown }).get?.('systemPrompt')) as
      | SystemPromptLike
      | undefined;
    if (prompt === undefined || typeof prompt.section !== 'function') return;

    if (guidanceEnabled) {
      prompt.section({
        name: PROTOCOL_SECTION,
        order: PROTOCOL_ORDER,
        text: () => renderProtocol({ writeEnabled }),
      });
    }
    if (hotMemoryEnabled) {
      // 投影每轮重新求值，但内容**确定性**（按 id 排序、不含时间戳）：
      // 记忆没变时逐字相同，稳定前缀成立，前缀缓存命中。
      prompt.section({
        name: INDEX_SECTION,
        order: INDEX_ORDER,
        text: () => projectIndex(memory.graph(), { dir, maxCharacters: maxProjectionCharacters }),
      });
    }
  });

  // ---- 工具面 ----
  // ctx.tools.register 返回卸载函数，插件卸载时由 Cordis 自动调用。

  ctx.tools.register(
    defineTool({
      name: 'lmmarr_index',
      description:
        'Read the complete memory index: every tracked task with status and progress, the task relationship graph, and any consistency problems. The same index is already projected into your context each turn, so call this only when you need the full table (the projection is bounded), after an external edit, or to report problems. Edge kinds: child = this task was decomposed into that one, depends = prerequisite, relates = weak link.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dir: { type: 'string' },
            indexPath: { type: 'string' },
            tasks: { type: 'array', items: TASK_ITEM },
            edges: { type: 'array', items: EDGE_ITEM },
            problems: PROBLEMS,
            repaired: REPAIRED,
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: renderSnapshot(value as MemorySnapshot, 'memory index refreshed') }];
        },
      },
      presentCall: () => ({ card: 'generic', title: 'Read memory index', kind: 'read' }),
      timeoutMs,
      async execute() {
        return memory.refresh();
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'lmmarr_context',
      description:
        'Load one task\'s memory plus its direct neighbourhood, and nothing else. This is the intended way to read memory: unrelated task files are never loaded, so the working context stays focused. Read it when the work depends on an earlier decision, or when the user refers to something that is not visible in this conversation. Get the task id from the index.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task id, as listed by the index' },
        depth: {
          type: 'integer',
          description: 'Neighbourhood hops; default 1 = the task itself plus its direct relations',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string' },
            depth: { type: 'number' },
            loaded: { type: 'array', items: { type: 'string' } },
            docs: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  status: { type: 'string' },
                  progress: { type: 'number' },
                  summary: { type: 'string' },
                  body: { type: 'string' },
                },
              },
            },
          },
        },
        render(_args, value) {
          const v = value as {
            loaded: string[];
            docs: Array<{ id: string; status: string; progress: number; summary: string; body: string }>;
          };
          const parts = [`loaded ${v.docs.length} task memory file(s): ${v.loaded.join(', ') || '(none)'}`, ''];
          for (const d of v.docs) {
            parts.push(`===== ${d.id} [${d.status} ${Math.round(d.progress * 100)}%] ${d.summary} =====`);
            parts.push(d.body.trim());
            parts.push('');
          }
          return [{ type: 'text', text: parts.join('\n') }];
        },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Recall task memory',
        kind: 'read',
        rawInput: (args as { taskId?: string }).taskId,
      }),
      timeoutMs,
      async execute(args) {
        const taskId = String(args.taskId);
        const hops = typeof args.depth === 'number' ? args.depth : depth;
        const docs = memory.context(taskId, hops);
        return {
          taskId,
          depth: hops,
          loaded: docs.map((d) => d.node.id),
          docs: docs.map((d) => ({
            id: d.node.id,
            title: d.node.title,
            status: d.node.status,
            progress: d.node.progress,
            summary: d.node.summary,
            body: d.body,
          })),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'lmmarr_upsert',
      description:
        'Create or update one task memory file (MEMORY_<id>.md) and refresh the index. Use a stable kebab-case id, one topic per id; reusing an id updates that task and preserves every field you omit. Call it when a milestone lands, a decision is made, or the user corrects you. Record decisions, constraints and reusable lessons — not transient progress chatter, not secrets, and not what the code already says. Never write back what a read returned.',
      parameters: {
        id: { type: 'string', required: true, description: 'Stable task id (kebab-case), e.g. lmmarr-hot-memory' },
        title: { type: 'string', description: 'Human readable task title' },
        status: { type: 'string', description: `One of: ${STATUSES}` },
        progress: { type: 'number', description: 'Progress in 0..1' },
        summary: { type: 'string', description: 'One-line state, shown in the index and in the hot projection' },
        tags: { type: 'array', description: 'String tags' },
        body: { type: 'string', description: 'Markdown body of the task memory file' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            path: { type: 'string' },
            created: { type: 'boolean' },
            dir: { type: 'string' },
            indexPath: { type: 'string' },
            tasks: { type: 'array', items: TASK_ITEM },
            edges: { type: 'array', items: EDGE_ITEM },
            problems: PROBLEMS,
            repaired: REPAIRED,
          },
        },
        render(_args, value) {
          const v = value as MemorySnapshot & { id: string; path: string; created: boolean };
          return [
            {
              type: 'text',
              text: renderSnapshot(v, `${v.created ? 'created' : 'updated'} ${v.id} -> ${v.path}`),
            },
          ];
        },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Record task memory',
        kind: 'edit',
        rawInput: (args as { id?: string }).id,
      }),
      timeoutMs,
      async execute(args) {
        requireWrite('lmmarr_upsert');
        const id = String(args.id);
        const existing = store.loadTask(id);
        const tags = Array.isArray(args.tags) ? args.tags.map((t: unknown) => String(t)) : undefined;

        store.saveTask({
          node: {
            id,
            title: typeof args.title === 'string' ? args.title : (existing?.node.title ?? id),
            status: typeof args.status === 'string' ? (args.status as never) : (existing?.node.status ?? 'doing'),
            progress: typeof args.progress === 'number' ? args.progress : (existing?.node.progress ?? 0),
            summary: typeof args.summary === 'string' ? args.summary : (existing?.node.summary ?? ''),
            updatedAt: Date.now(),
            tags: tags ?? existing?.node.tags ?? [],
          },
          body: typeof args.body === 'string' ? args.body : (existing?.body ?? ''),
        });

        return { id, path: store.taskPath(id), created: existing === undefined, ...memory.refresh() };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'lmmarr_link',
      description:
        'Declare a relationship between two existing tasks and refresh the index. Both task ids must already exist (use lmmarr_upsert first). Edge kinds: child = the source was decomposed into the target, depends = the target is a prerequisite, relates = weak link. child and depends must stay acyclic: a link that would create a cycle is rejected and nothing changes.',
      parameters: {
        from: { type: 'string', required: true, description: 'Source task id' },
        to: { type: 'string', required: true, description: 'Target task id' },
        kind: { type: 'string', required: true, description: `Edge kind, one of: ${KINDS}` },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            error: { type: 'string' },
            dir: { type: 'string' },
            indexPath: { type: 'string' },
            tasks: { type: 'array', items: TASK_ITEM },
            edges: { type: 'array', items: EDGE_ITEM },
            problems: PROBLEMS,
            repaired: REPAIRED,
          },
        },
        render(_args, value) {
          const v = value as MemorySnapshot & { ok: boolean; error: string };
          if (!v.ok) return [{ type: 'text', text: `link rejected: ${v.error}\n(nothing was changed)` }];
          return [{ type: 'text', text: renderSnapshot(v, 'linked') }];
        },
      },
      presentCall: () => ({ card: 'generic', title: 'Link task memory', kind: 'edit' }),
      timeoutMs,
      async execute(args) {
        requireWrite('lmmarr_link');
        // 图先建、边先试；建边失败就不落盘 —— 索引保持原样
        const graph = store.loadGraph();
        const error = graph.tryLink(String(args.from), String(args.to), String(args.kind) as EdgeKind);
        if (error !== undefined) {
          return { ok: false, error, ...memory.snapshot() };
        }
        store.saveIndex(graph);
        return { ok: true, error: '', ...memory.refresh() };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'lmmarr_forget',
      description:
        'Delete one task memory file and every relation that mentions it, then refresh the index. This is destructive and irreversible. Use it only when the user explicitly asks, or when an entry is provably wrong — never as part of tidying up.',
      parameters: {
        id: { type: 'string', required: true, description: 'Task id to delete' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            existed: { type: 'boolean' },
            droppedEdges: { type: 'array', items: EDGE_ITEM },
            dir: { type: 'string' },
            indexPath: { type: 'string' },
            tasks: { type: 'array', items: TASK_ITEM },
            edges: { type: 'array', items: EDGE_ITEM },
            problems: PROBLEMS,
            repaired: REPAIRED,
          },
        },
        render(_args, value) {
          const v = value as MemorySnapshot & { id: string; existed: boolean; droppedEdges: Array<{ from: string; kind: string; to: string }> };
          const headline = v.existed
            ? `forgot ${v.id} (dropped ${v.droppedEdges.length} relation(s))`
            : `no such task: ${v.id} (nothing to forget)`;
          return [{ type: 'text', text: renderSnapshot(v, headline) }];
        },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Forget task memory',
        kind: 'delete',
        rawInput: (args as { id?: string }).id,
      }),
      timeoutMs,
      async execute(args) {
        requireWrite('lmmarr_forget');
        const id = String(args.id);
        const { existed, droppedEdges } = store.forgetTask(id);
        return { id, existed, droppedEdges, ...memory.refresh() };
      },
    }),
  );
}
