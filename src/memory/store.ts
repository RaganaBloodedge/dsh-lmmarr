// 记忆存储 —— 把「索引 MEMORY.md + 每任务 MEMORY_<id>.md」这层磁盘布局管起来。
//
// 分层：
//   YYYY-MM-DD.md      原始日志（append-only，只写不改）
//   MEMORY_<任务ID>.md  单个任务的当前状态与沉淀（可重写）
//   MEMORY.md          只放索引：任务表 + 关系图谱 + 机器可读边块
//
// 关键纪律：做某任务时只读该任务 + 其邻域内的文件（loadContext），其余不读。
//
// 核心逻辑不依赖 node:fs —— 通过 FsPort 注入，便于单测。

import { TaskGraph } from './graph.ts';
import type { EdgeKind, TaskEdge, TaskNode, TaskStatus } from './graph.ts';

/** 文件系统端口：核心逻辑只认这四个方法 */
export interface FsPort {
  read(path: string): string | undefined;
  write(path: string, content: string): void;
  list(dir: string): string[];
  remove(path: string): void;
}

export interface MemoryStoreOptions {
  /** 记忆目录 */
  dir: string;
  fs: FsPort;
  /** 索引文件名，默认 MEMORY.md */
  indexFile?: string;
  /** 任务文件名前缀，默认 MEMORY_ */
  taskPrefix?: string;
  /**
   * 单个任务正文的软上限（字符数）。超了不报错、不自动改写 ——
   * 只在 check() 里提示「该任务该拆了」，由模型或人决定怎么拆。
   * 记忆的容量治理是纪律问题，不是能靠静默搬运解决的技术问题。
   */
  bodySoftLimit?: number;
  clock?: () => number;
}

export interface TaskDoc {
  node: TaskNode;
  body: string;
}

const EDGE_KINDS: readonly EdgeKind[] = ['child', 'depends', 'relates'];
const STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'blocked', 'done'];

/** 任务 id 白名单：字母数字开头，只含 [A-Za-z0-9._-]，且不得出现 `..`。
 *  taskPath 是唯一的路径拼装点，越界必须在那一处挡住 ——
 *  否则 id 里带 `../`（模型被注入诱导、或人手误传）就能读写记忆目录之外的文件。 */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isTaskId(id: string): boolean {
  return TASK_ID_RE.test(id) && !id.includes('..');
}

export function assertTaskId(id: string): string {
  if (!isTaskId(id)) {
    throw new Error(
      `invalid task id: ${JSON.stringify(id)} —— 只允许字母数字开头、由 [A-Za-z0-9._-] 组成，且不得包含 ".."`,
    );
  }
  return id;
}

export class MemoryStore {
  readonly dir: string;
  private fs: FsPort;
  private indexFile: string;
  private taskPrefix: string;
  private bodySoftLimit: number;
  private clock: () => number;

  constructor(opts: MemoryStoreOptions) {
    this.dir = opts.dir.replace(/\/+$/, '');
    this.fs = opts.fs;
    this.indexFile = opts.indexFile ?? 'MEMORY.md';
    this.taskPrefix = opts.taskPrefix ?? 'MEMORY_';
    this.bodySoftLimit = opts.bodySoftLimit ?? 16_000;
    this.clock = opts.clock ?? (() => Date.now());
  }

  indexPath(): string {
    return `${this.dir}/${this.indexFile}`;
  }

  taskPath(id: string): string {
    assertTaskId(id);
    return `${this.dir}/${this.taskPrefix}${id}.md`;
  }

  /** 目录里所有 MEMORY_<id>.md（不含索引本身、不含日期日志）。
   *  id 不合法的文件名会被忽略 —— 免得一个手工建的怪名字让整条记忆链炸掉；
   *  它们由 check() 报出来，不会静默消失。 */
  listTaskIds(): string[] {
    const out: string[] = [];
    for (const name of this.fs.list(this.dir)) {
      if (!name.startsWith(this.taskPrefix) || !name.endsWith('.md')) continue;
      const id = name.slice(this.taskPrefix.length, -3);
      if (!isTaskId(id)) continue;
      out.push(id);
    }
    return out.sort();
  }

  /** 看起来像任务文件、但 id 不合法（因而被忽略）的文件名 */
  private ignoredTaskFiles(): string[] {
    const out: string[] = [];
    for (const name of this.fs.list(this.dir)) {
      if (!name.startsWith(this.taskPrefix) || !name.endsWith('.md')) continue;
      const id = name.slice(this.taskPrefix.length, -3);
      if (!isTaskId(id)) out.push(name);
    }
    return out;
  }

  // ---------- 单任务文件 ----------

  parseDoc(id: string, text: string): TaskDoc {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    const fm = m ? m[1] : '';
    const body = m ? text.slice(m[0].length) : text;

    const kv = new Map<string, string>();
    for (const line of fm.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }

    const rawStatus = kv.get('status');
    const status: TaskStatus =
      rawStatus !== undefined && (STATUSES as readonly string[]).includes(rawStatus)
        ? (rawStatus as TaskStatus)
        : 'todo';
    const ts = Date.parse(kv.get('updated') ?? '');

    const node: TaskNode = {
      id: kv.get('id') ?? id,
      title: kv.get('title') ?? id,
      status,
      progress: clamp01(Number(kv.get('progress') ?? '0')),
      summary: kv.get('summary') ?? '',
      updatedAt: Number.isFinite(ts) ? ts : this.clock(),
      tags: parseInlineList(kv.get('tags') ?? ''),
    };
    return { node, body };
  }

  renderDoc(doc: TaskDoc): string {
    const n = doc.node;
    const head = [
      '---',
      `id: ${n.id}`,
      `title: ${n.title}`,
      `status: ${n.status}`,
      `progress: ${round2(n.progress)}`,
      `updated: ${new Date(n.updatedAt).toISOString()}`,
      `tags: [${n.tags.join(', ')}]`,
      `summary: ${n.summary}`,
      '---',
      '',
    ].join('\n');
    return head + doc.body.replace(/^\n+/, '');
  }

  loadTask(id: string): TaskDoc | undefined {
    const text = this.fs.read(this.taskPath(id));
    return text === undefined ? undefined : this.parseDoc(id, text);
  }

  saveTask(doc: TaskDoc): void {
    this.fs.write(this.taskPath(doc.node.id), this.renderDoc(doc));
  }

  /**
   * 删掉一个任务文件，返回它曾经参与的关系。
   *
   * 注意这是「真删」—— 记忆库要求永久，所以删除必须有明确意图
   * （用户要求，或条目被证明是错的），不能作为"整理"的副产品。
   * 关系不需要单独清理：边存在索引里，而 loadGraph / saveIndex 都会
   * 跳过端点已不存在的边，索引自然收敛。
   */
  forgetTask(id: string): { existed: boolean; droppedEdges: TaskEdge[] } {
    const path = this.taskPath(id);
    const existed = this.fs.read(path) !== undefined;
    const droppedEdges = this.readEdges().filter((e) => e.from === id || e.to === id);
    this.fs.remove(path);
    return { existed, droppedEdges };
  }

  // ---------- 索引 ----------

  /** 从 MEMORY.md 的 ```edges 代码块读出关系（唯一的机器可读来源） */
  readEdges(): TaskEdge[] {
    const text = this.fs.read(this.indexPath());
    if (text === undefined) return [];
    const out: TaskEdge[] = [];
    let inBlock = false;
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!inBlock) {
        if (/^```+\s*edges\s*$/.test(t)) inBlock = true;
        continue;
      }
      if (/^```+$/.test(t)) break;
      if (t === '') continue;
      const parts = t.split(/\s+/);
      if (parts.length !== 3) continue;
      const kind = parts[1];
      if ((EDGE_KINDS as readonly string[]).includes(kind)) {
        out.push({ from: parts[0], to: parts[2], kind: kind as EdgeKind });
      }
    }
    return out;
  }

  /** 任务文件提供节点，索引提供边 */
  loadGraph(): TaskGraph {
    const g = new TaskGraph();
    for (const id of this.listTaskIds()) {
      const doc = this.loadTask(id);
      if (doc) g.addTask(doc.node);
    }
    for (const e of this.readEdges()) {
      if (!g.has(e.from) || !g.has(e.to)) continue;
      g.tryLink(e.from, e.to, e.kind);
    }
    return g;
  }

  renderIndex(graph: TaskGraph): string {
    const tasks = graph.listTasks();
    const edges = graph.listEdges();
    const alias = new Map<string, string>();
    tasks.forEach((t, i) => alias.set(t.id, `n${i}`));

    const rows = tasks.length
      ? tasks
          .map(
            (t) =>
              `| ${t.id} | ${t.title} | ${t.status} | ${Math.round(t.progress * 100)}% | ${day(t.updatedAt)} |`,
          )
          .join('\n')
      : '| _(空)_ | | | | |';

    const mermaidNodes = tasks
      .map((t) => `  ${alias.get(t.id)}["${t.id} · ${t.status} ${Math.round(t.progress * 100)}%"]`)
      .join('\n');
    const mermaidEdges = edges.map((e) => `  ${alias.get(e.from)} -->|${e.kind}| ${alias.get(e.to)}`).join('\n');

    const edgeBlock = edges.map((e) => `${e.from} ${e.kind} ${e.to}`).join('\n');

    return [
      '# 记忆索引',
      '',
      '> 本文件只做索引与关系图谱；任务内容在 `MEMORY_<任务ID>.md`，原始日志在 `YYYY-MM-DD.md`。',
      '> 做某个任务时只加载该任务及其邻域文件（`loadContext(id, depth)`），其余不读。',
      '',
      '## 任务',
      '',
      '| ID | 标题 | 状态 | 进度 | 更新 |',
      '|----|------|------|------|------|',
      rows,
      '',
      '## 关系图谱',
      '',
      '```mermaid',
      'graph LR',
      mermaidNodes,
      mermaidEdges,
      '```',
      '',
      '## 机器可读的关系块（由工具生成，勿手改）',
      '',
      '```edges',
      edgeBlock,
      '```',
      '',
    ].join('\n');
  }

  saveIndex(graph: TaskGraph): void {
    this.fs.write(this.indexPath(), this.renderIndex(graph));
  }

  // ---------- 按需加载 ----------

  /** 只读该任务 + depth 跳邻域内的任务文件，其余文件完全不碰 */
  loadContext(id: string, depth = 1): TaskDoc[] {
    const edges = this.readEdges();
    const seen = new Set<string>([id]);
    let frontier: string[] = [id];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const e of edges) {
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

    const out: TaskDoc[] = [];
    for (const tid of [...seen].sort()) {
      const doc = this.loadTask(tid);
      if (doc) out.push(doc);
    }
    return out;
  }

  /** 校验索引与任务文件是否一致：重复边、悬空边、环、进度越界、容量 */
  check(): string[] {
    const problems: string[] = [];
    const ids = this.listTaskIds();
    const idSet = new Set(ids);

    const g = new TaskGraph();
    for (const id of ids) {
      const doc = this.loadTask(id);
      if (doc) g.addTask(doc.node);
    }

    const seen = new Set<string>();
    for (const e of this.readEdges()) {
      const key = `${e.from} ${e.kind} ${e.to}`;
      if (seen.has(key)) {
        problems.push(`重复的边: ${key}`);
        continue;
      }
      seen.add(key);
      if (!idSet.has(e.from) || !idSet.has(e.to)) {
        problems.push(`边指向缺失的任务文件: ${key}`);
        continue;
      }
      const err = g.tryLink(e.from, e.to, e.kind);
      if (err) problems.push(err);
    }

    problems.push(...g.validate());

    for (const name of this.ignoredTaskFiles()) {
      problems.push(`文件名不是合法的任务 id，已忽略: ${name}`);
    }

    // 容量提示：不自动拆分，只把"该拆了"这件事说出来。
    // 记忆库的健康靠纪律，静默搬运只会让人不知道发生了什么。
    for (const id of ids) {
      const doc = this.loadTask(id);
      if (doc !== undefined && doc.body.length > this.bodySoftLimit) {
        problems.push(
          `${id}: 正文 ${doc.body.length} 字符，超过软上限 ${this.bodySoftLimit}；` +
            `建议拆成多个子任务并用 lmmarr_link 的 child 关联`,
        );
      }
    }

    return problems;
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function round2(x: number): number {
  return Math.round(clamp01(x) * 100) / 100;
}

/** 解析 `[a, b]` 形式的内联数组 */
function parseInlineList(raw: string): string[] {
  const m = /^\[(.*)\]$/.exec(raw.trim());
  const inner = m ? m[1] : raw;
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function day(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
