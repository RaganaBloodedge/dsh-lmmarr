// 记忆服务（Cordis service）—— 本次迭代从 dsh-mnemon 学到的第二条。
//
// dsh-mnemon 的架构骨架是「Host 提供 mnemonMemory 服务，source / strategy /
// provider 作为子插件 inject 它并注册扩展」。我们不需要那么多层，但骨架值得留：
// 把记忆能力 provide 成一个服务，四个工具只是它的一层视图。
//
// 好处是具体的，不是架构审美：
//   · 工具不再各自拼装「读图 → 采集问题 → 重写索引」这条链，
//     收敛到 service.refresh() 一处 —— 顺序错了（先写后查）这类 bug 只可能犯一次；
//   · 别人（另一个插件、测试、CLI）可以不经过模型直接拿记忆，不需要重复实现；
//   · 卸载语义干净：服务与 ctx 同生命周期，由 Cordis 负责。

import { MemoryStore } from './memory/store.ts';
import type { TaskDoc } from './memory/store.ts';
import { TaskGraph } from './memory/graph.ts';
import type { TaskEdge, TaskNode } from './memory/graph.ts';

/** 一次读一致的记忆快照。四个工具的回执都由它派生，形状因此天然一致。 */
export interface MemorySnapshot {
  dir: string;
  indexPath: string;
  tasks: TaskNode[];
  edges: TaskEdge[];
  /**
   * **本次调用结束时**仍然存在的问题 —— 也就是调用方真的需要处理的东西。
   * 正常情况下是空数组。
   */
  problems: string[];
  /**
   * 进来时存在、被这一次调用修好的问题（目前只有重写索引会自愈的悬空边）。
   *
   * 为什么单列而不是并进 problems：这里是"已解决"，problems 是"待处理"。
   * 混在一起会让模型在刚删掉一个任务、同一次调用已把索引收敛干净之后，
   * 看到"边指向缺失的任务文件"而去"修"一个并不存在的问题。
   * 这个语义是被测试逼出来的：最初实现把两者混在一起，测 lmmarr_forget 时红灯。
   */
  repaired: string[];
}

export interface LmmarrMemoryService {
  /** 记忆目录 */
  readonly dir: string;
  /** memory_context 的默认邻域深度 */
  readonly depth: number;
  /** 只读档下为 false —— 写工具会拒绝执行并说明原因，而不是静默无效 */
  readonly writeEnabled: boolean;
  /** 底层存储：给需要直接读写记忆的扩展方（测试 / CLI / 未来的 source 层） */
  readonly store: MemoryStore;

  indexPath(): string;
  /** 从磁盘现读现建的任务图谱（每次调用都是新对象，不共享可变状态） */
  graph(): TaskGraph;
  /** 只读该任务 + depth 跳邻域内的记忆文件 */
  context(taskId: string, depth?: number): TaskDoc[];
  /** 只采集快照，不落盘 */
  snapshot(): MemorySnapshot;
  /**
   * 采集问题 → 重写索引 → 再采集一次 → 返回快照。
   *
   * 必须采集两次：重写索引会把悬空边自愈掉，所以
   *   · 第一次采集到的 = 进来时就存在的问题（其中被自愈的进 repaired）
   *   · 第二次采集到的 = 离开时仍存在的问题（进 problems，这才是待办）
   * 这个顺序是上一轮契约测试刨出来的真实缺陷，收敛到这里之后只可能犯一次。
   */
  refresh(): MemorySnapshot;
}

export function createMemoryService(opts: {
  store: MemoryStore;
  depth: number;
  writeEnabled: boolean;
}): LmmarrMemoryService {
  const { store, depth, writeEnabled } = opts;

  const build = (problems: string[], repaired: string[]): MemorySnapshot => {
    const graph = store.loadGraph();
    return {
      dir: store.dir,
      indexPath: store.indexPath(),
      tasks: graph.listTasks(),
      edges: graph.listEdges(),
      problems,
      repaired,
    };
  };

  return {
    dir: store.dir,
    depth,
    writeEnabled,
    store,
    indexPath: () => store.indexPath(),
    graph: () => store.loadGraph(),
    context: (taskId, hops) => store.loadContext(taskId, hops ?? depth),
    snapshot: () => build(store.check(), []),
    refresh: () => {
      const found = store.check();
      const graph = store.loadGraph();
      store.saveIndex(graph);
      const remaining = store.check();
      const repaired = found.filter((p) => !remaining.includes(p));
      return build(remaining, repaired);
    },
  };
}
