// 任务记忆图谱 —— 记忆的「索引层」。
// 只描述"有哪些任务、彼此是什么关系"，不存任何内容。
// 内容在 MEMORY_<id>.md；本模块负责拆解关系、依赖校验、邻域计算（决定要读哪些文件）。
// 零依赖、可单测；配合 tests/memory.test.ts。

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

// child  ：父任务拆解出的子任务
// depends：前置依赖（to 先完成，from 才能动）
// relates：弱关联，只用于邻域召回，不参与拓扑
export type EdgeKind = 'child' | 'depends' | 'relates';

export interface TaskNode {
  id: string;
  title: string;
  status: TaskStatus;
  /** 0..1 */
  progress: number;
  summary: string;
  updatedAt: number;
  tags: string[];
}

export interface TaskEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

/** 参与拓扑排序（要求无环）的边类型 */
const STRUCTURAL: readonly EdgeKind[] = ['child', 'depends'];

export class TaskGraph {
  private nodes = new Map<string, TaskNode>();
  private edges: TaskEdge[] = [];

  addTask(node: TaskNode): TaskNode {
    const copy: TaskNode = { ...node, tags: [...node.tags] };
    this.nodes.set(node.id, copy);
    return copy;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  get size(): number {
    return this.nodes.size;
  }

  getTask(id: string): TaskNode | undefined {
    return this.nodes.get(id);
  }

  /** 按 id 字典序，保证索引渲染稳定 */
  listTasks(): TaskNode[] {
    return [...this.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  updateTask(id: string, patch: Partial<Omit<TaskNode, 'id'>>): TaskNode {
    const cur = this.nodes.get(id);
    if (!cur) throw new Error(`unknown task: ${id}`);
    const next: TaskNode = { ...cur, ...patch, id };
    this.nodes.set(id, next);
    return next;
  }

  /** 建边。child/depends 会做存在性与无环校验；relates 不做。重复边幂等。 */
  link(from: string, to: string, kind: EdgeKind): void {
    if (!this.nodes.has(from)) throw new Error(`unknown task: ${from}`);
    if (!this.nodes.has(to)) throw new Error(`unknown task: ${to}`);
    if (from === to) throw new Error(`self link not allowed: ${from}`);
    if (this.edges.some((e) => e.from === from && e.to === to && e.kind === kind)) return;

    this.edges.push({ from, to, kind });
    if (STRUCTURAL.includes(kind) && this.hasCycle()) {
      this.edges.pop();
      throw new Error(`link would create a cycle: ${from} -${kind}-> ${to}`);
    }
  }

  /** 与 link 相同，但把错误当作返回值（批量建图时用） */
  tryLink(from: string, to: string, kind: EdgeKind): string | undefined {
    try {
      this.link(from, to, kind);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** 稳定排序：(from, kind, to) */
  listEdges(): TaskEdge[] {
    return [...this.edges].sort((a, b) => {
      if (a.from !== b.from) return a.from < b.from ? -1 : 1;
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
    });
  }

  children(id: string): string[] {
    return this.targets(id, 'child');
  }

  parents(id: string): string[] {
    return this.sources(id, 'child');
  }

  /** 该任务依赖谁（前置） */
  dependsOn(id: string): string[] {
    return this.targets(id, 'depends');
  }

  /** 谁依赖该任务 */
  dependents(id: string): string[] {
    return this.sources(id, 'depends');
  }

  private targets(id: string, kind: EdgeKind): string[] {
    return this.edges.filter((e) => e.from === id && e.kind === kind).map((e) => e.to).sort();
  }

  private sources(id: string, kind: EdgeKind): string[] {
    return this.edges.filter((e) => e.to === id && e.kind === kind).map((e) => e.from).sort();
  }

  /** 无向邻域：任务本身 + depth 跳内的所有亲戚（"只加载相关记忆"的取值域） */
  neighborhood(id: string, depth = 1): string[] {
    const seen = new Set<string>([id]);
    let frontier: string[] = [id];
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const e of this.edges) {
          if (e.from === f && !seen.has(e.to)) {
            seen.add(e.to);
            next.push(e.to);
          } else if (e.to === f && !seen.has(e.from)) {
            seen.add(e.from);
            next.push(e.from);
          }
        }
      }
      frontier = next;
    }
    return [...seen].sort();
  }

  /** 执行顺序：父任务先于拆解出的子任务，被依赖者先于依赖者 */
  topoOrder(): string[] {
    return kahn(this.nodes, this.precedenceEdges());
  }

  /** 把 child / depends 统一成"(先做的 → 后做的)" */
  private precedenceEdges(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const e of this.edges) {
      if (e.kind === 'child') out.push([e.from, e.to]);
      else if (e.kind === 'depends') out.push([e.to, e.from]);
    }
    return out;
  }

  hasCycle(): boolean {
    const structural = this.precedenceEdges();
    if (structural.length === 0) return false;
    const endpoints = new Map<string, TaskNode>();
    for (const [a, b] of structural) {
      const na = this.nodes.get(a);
      const nb = this.nodes.get(b);
      if (na) endpoints.set(a, na);
      if (nb) endpoints.set(b, nb);
    }
    return kahn(endpoints, structural).length < endpoints.size;
  }

  /** 一致性校验：进度越界、悬空边、环。空数组 = 健康 */
  validate(): string[] {
    const problems: string[] = [];
    for (const n of this.nodes.values()) {
      if (!Number.isFinite(n.progress) || n.progress < 0 || n.progress > 1) {
        problems.push(`${n.id}: progress 越界 (${n.progress})`);
      }
    }
    for (const e of this.edges) {
      if (!this.nodes.has(e.from) || !this.nodes.has(e.to)) {
        problems.push(`悬空边: ${e.from} -${e.kind}-> ${e.to}`);
      }
    }
    if (this.hasCycle()) problems.push('child/depends 关系里存在环，必须是 DAG');
    return problems;
  }
}

/** Kahn 拓扑排序；返回顺序长度小于节点数即说明有环 */
function kahn(nodes: Map<string, TaskNode>, edges: Array<[string, string]>): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of nodes.keys()) {
    indeg.set(id, 0);
    adj.set(id, []);
  }
  for (const [a, b] of edges) {
    if (!indeg.has(a) || !indeg.has(b)) continue;
    adj.get(a)!.push(b);
    indeg.set(b, (indeg.get(b) ?? 0) + 1);
  }

  const queue = [...nodes.keys()].filter((id) => (indeg.get(id) ?? 0) === 0).sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    const freed: string[] = [];
    for (const t of adj.get(id) ?? []) {
      const d = (indeg.get(t) ?? 0) - 1;
      indeg.set(t, d);
      if (d === 0) freed.push(t);
    }
    queue.push(...freed.sort());
  }
  return order;
}
