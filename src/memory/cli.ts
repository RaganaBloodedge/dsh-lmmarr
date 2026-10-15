// 记忆库维护 CLI —— lmmarr-memory skill 的执行层（本仓库内部工具，不属于 dsh 插件本身）。
//
//   node cli.js index   <记忆目录>                        重建 MEMORY.md 索引
//   node cli.js check   <记忆目录>                        校验一致性（有问题时退出码 1）
//   node cli.js show    <记忆目录> [任务ID]                打印索引；给 id 时附带该任务正文
//   node cli.js context <记忆目录> <任务ID> [深度]         只打印该任务邻域内的记忆
//   node cli.js upsert  <记忆目录> <任务ID> [选项]         新建/更新任务文件，省略的字段保留原值
//   node cli.js link    <记忆目录> <from> <kind> <to>      建关系（kind: child | depends | relates）
//   node cli.js forget  <记忆目录> <任务ID>                删除任务文件（唯一的破坏性命令）
//
// 本文件是唯一真相源；skill 目录里的 scripts/ 由 `npm run sync:skill` 编译而来。

import { MemoryStore, isTaskId } from './store.ts';
import { NodeFs } from './nodefs.ts';
import type { EdgeKind, TaskNode, TaskStatus } from './graph.ts';

const EDGE_KINDS: readonly string[] = ['child', 'depends', 'relates'];
const STATUSES: readonly string[] = ['todo', 'doing', 'blocked', 'done'];

const USAGE = `lmmarr memory CLI

  index   <dir>                          重建 MEMORY.md 索引
  check   <dir>                          校验一致性（有问题时退出码 1）
  show    <dir> [taskId]                 打印索引；给 taskId 时附带该任务正文
  context <dir> <taskId> [depth=1]       只打印该任务及其邻域内的记忆
  upsert  <dir> <taskId> [options]       新建/更新任务文件（省略的字段保留原值）
  link    <dir> <from> <kind> <to>       建关系 child | depends | relates
  forget  <dir> <taskId>                 删除任务文件（唯一的破坏性命令）

upsert options:
  --title <s>        标题
  --status <s>       todo | doing | blocked | done
  --progress <p>     0..1 或 0..100，也接受 "40%"
  --summary <s>      一句话状态（会进索引表）
  --tags <a,b>       标签，逗号分隔
  --body-file <path> 正文从这里读（正文较长时用这个，避免 shell 转义）`;

const [cmd, dir, ...rest] = process.argv.slice(2);

if (!cmd || !dir) {
  console.error(USAGE);
  process.exit(2);
}

const store = new MemoryStore({ dir, fs: new NodeFs() });

switch (cmd) {
  case 'index': {
    // 顺序不可换：saveIndex 会把悬空边自愈掉，若先写再查就永远报不出问题。
    const problems = store.check();
    const graph = store.loadGraph();
    store.saveIndex(graph);
    console.log(
      `index written: ${store.indexPath()} (${graph.size} tasks, ${graph.listEdges().length} edges)`,
    );
    if (problems.length > 0) console.log('problems:\n  ' + problems.join('\n  '));
    break;
  }

  case 'check': {
    const problems = store.check();
    console.log(problems.length > 0 ? problems.join('\n') : 'ok');
    process.exit(problems.length > 0 ? 1 : 0);
  }

  case 'show': {
    const [maybeId] = rest;
    const graph = store.loadGraph();
    process.stdout.write(store.renderIndex(graph));
    if (maybeId !== undefined) {
      const doc = store.loadTask(safeId(maybeId));
      if (doc === undefined) {
        console.error(`\n(no such task: ${maybeId})`);
        process.exit(1);
      }
      console.log(`\n===== ${doc.node.id} [${doc.node.status}] ${pct(doc.node.progress)} =====`);
      console.log(doc.body.trim());
    }
    break;
  }

  case 'context': {
    const [taskId, depthArg] = rest;
    if (!taskId) fail('context needs a task id');
    const depth = depthArg ? Number(depthArg) : 1;
    if (!Number.isInteger(depth) || depth < 0) fail(`invalid depth: ${depthArg}`);
    const docs = store.loadContext(safeId(taskId), depth);
    if (docs.length === 0) {
      console.error(`(no such task: ${taskId})`);
      process.exit(1);
    }
    for (const doc of docs) {
      console.log(`===== ${doc.node.id} [${doc.node.status}] ${pct(doc.node.progress)} =====`);
      console.log(doc.body.trim());
      console.log('');
    }
    break;
  }

  case 'upsert': {
    const [taskId, ...flagArgs] = rest;
    if (!taskId) fail('upsert needs a task id');
    const id = safeId(taskId);
    const flags = parseFlags(flagArgs);
    const existing = store.loadTask(id);

    const node: TaskNode = existing?.node ?? {
      id,
      title: id,
      status: 'todo',
      progress: 0,
      summary: '',
      updatedAt: Date.now(),
      tags: [],
    };

    // 只覆盖显式传入的字段 —— 省略即保留，避免"更新一条"变成"清空其余"
    if (flags.title !== undefined) node.title = flags.title;
    if (flags.summary !== undefined) node.summary = flags.summary;
    if (flags.tags !== undefined) node.tags = splitList(flags.tags);
    if (flags.status !== undefined) {
      if (!STATUSES.includes(flags.status)) fail(`invalid status: ${flags.status} (${STATUSES.join(' | ')})`);
      node.status = flags.status as TaskStatus;
    }
    if (flags.progress !== undefined) node.progress = parseProgress(flags.progress);
    node.updatedAt = Date.now();

    const body = flags['body-file'] !== undefined ? readFileArg(flags['body-file']) : (existing?.body ?? '');

    store.saveTask({ node, body });
    const problems = store.check();
    store.saveIndex(store.loadGraph());

    console.log(`upsert: ${store.taskPath(id)} (${existing ? 'updated' : 'new'})`);
    if (problems.length > 0) console.log('problems:\n  ' + problems.join('\n  '));
    break;
  }

  case 'link': {
    const [from, kind, to] = rest;
    if (!from || !kind || !to) fail('link needs <from> <kind> <to>');
    if (!EDGE_KINDS.includes(kind)) fail(`invalid kind: ${kind} (${EDGE_KINDS.join(' | ')})`);

    const problems = store.check();
    const graph = store.loadGraph();
    try {
      graph.link(safeId(from), safeId(to), kind as EdgeKind);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    store.saveIndex(graph);
    console.log(`link: ${from} -${kind}-> ${to}  (${graph.size} tasks, ${graph.listEdges().length} edges)`);
    if (problems.length > 0) console.log('problems:\n  ' + problems.join('\n  '));
    break;
  }

  case 'forget': {
    const [taskId] = rest;
    if (!taskId) fail('forget needs a task id');
    const id = safeId(taskId);

    const before = store.check();
    const { existed, droppedEdges } = store.forgetTask(id);
    store.saveIndex(store.loadGraph());
    const after = store.check();
    // 删任务一定会先制造出"悬空边"，再由重建索引修好。
    // 分开报：problems = 仍需处理，repaired = 本次调用顺手修掉的。
    const repaired = before.filter((p) => !after.includes(p));

    console.log(`forget: ${id} (${existed ? 'removed' : 'no such file'})`);
    for (const e of droppedEdges) console.log(`  dropped edge: ${e.from} -${e.kind}-> ${e.to}`);
    if (repaired.length > 0) console.log('repaired by this call:\n  ' + repaired.join('\n  '));
    if (after.length > 0) console.log('problems:\n  ' + after.join('\n  '));
    break;
  }

  default:
    fail(`unknown command: ${cmd}`);
}

// ---------- 工具函数 ----------

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

/** 非法 id 是用法错误，不该以未捕获异常（堆栈 + 退出码 1）的形式冒出去 */
function safeId(raw: string): string {
  if (!isTaskId(raw)) {
    fail(
      `invalid task id: ${JSON.stringify(raw)} —— 只允许字母数字开头、由 [A-Za-z0-9._-] 组成，且不得包含 ".."`,
    );
  }
  return raw;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** `0.4` / `40` / `40%` 都接受；>1 视为百分数 */
function parseProgress(raw: string): number {
  const t = raw.trim();
  const n = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
  if (!Number.isFinite(n)) fail(`invalid progress: ${raw}`);
  const v = n > 1 ? n / 100 : n;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = '';
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function readFileArg(path: string): string {
  const text = new NodeFs().read(path);
  if (text === undefined) fail(`cannot read body file: ${path}`);
  return text;
}
