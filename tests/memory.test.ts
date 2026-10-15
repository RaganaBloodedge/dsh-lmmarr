// 记忆图谱与存储的核心逻辑测试（零依赖，直接 node --test 跑）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskGraph } from '../src/memory/graph.ts';
import { MemoryStore } from '../src/memory/store.ts';
import type { EdgeKind, TaskNode } from '../src/memory/graph.ts';
import type { FsPort, TaskDoc } from '../src/memory/store.ts';

class MemFs implements FsPort {
  files = new Map<string, string>();
  reads: string[] = [];

  read(path: string): string | undefined {
    this.reads.push(path);
    return this.files.get(path);
  }

  write(path: string, content: string): void {
    this.files.set(path, content);
  }

  list(dir: string): string[] {
    const out: string[] = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(dir + '/')) continue;
      const rest = key.slice(dir.length + 1);
      if (!rest.includes('/')) out.push(rest);
    }
    return out.sort();
  }

  remove(path: string): void {
    this.files.delete(path);
  }
}

const DIR = '/mem';

function node(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: id,
    status: 'todo',
    progress: 0,
    summary: '',
    updatedAt: 1_700_000_000_000,
    tags: [],
    ...over,
  };
}

function doc(id: string, over: Partial<TaskNode> = {}, body = '正文\n'): TaskDoc {
  return { node: node(id, over), body };
}

function graphOf(ids: string[], edges: Array<[string, string, EdgeKind]>): TaskGraph {
  const g = new TaskGraph();
  for (const id of ids) g.addTask(node(id));
  for (const [from, to, kind] of edges) g.link(from, to, kind);
  return g;
}

// ---------- 图谱 ----------

test('graph: 拆解与依赖关系可查', () => {
  const g = new TaskGraph();
  for (const id of ['root', 'a', 'b']) g.addTask(node(id));
  g.link('root', 'a', 'child');
  g.link('root', 'b', 'child');
  g.link('b', 'a', 'depends');

  assert.deepEqual(g.children('root'), ['a', 'b']);
  assert.deepEqual(g.parents('a'), ['root']);
  assert.deepEqual(g.dependsOn('b'), ['a']);
  assert.deepEqual(g.dependents('a'), ['b']);
});

test('graph: 拒绝成环（child / depends 必须是 DAG）', () => {
  const g = new TaskGraph();
  for (const id of ['a', 'b', 'c']) g.addTask(node(id));
  g.link('a', 'b', 'depends'); // a 依赖 b → 执行序 b 先于 a
  g.link('b', 'c', 'depends'); // b 依赖 c → 执行序 c 先于 b

  assert.throws(() => g.link('c', 'a', 'depends'), /cycle/); // c 又依赖 a → 闭环
  assert.throws(() => g.link('a', 'c', 'child'), /cycle/); // a 拆出 c → 与依赖方向矛盾

  // 被拒绝的边不应留在图里
  assert.equal(g.listEdges().length, 2);
  assert.deepEqual(g.dependsOn('a'), ['b']);
  assert.deepEqual(g.dependsOn('c'), []);
});

test('graph: 邻域决定"要读哪些文件"', () => {
  const g = new TaskGraph();
  for (const id of ['a', 'b', 'c', 'd']) g.addTask(node(id));
  g.link('a', 'b', 'child');
  g.link('b', 'c', 'depends');
  g.link('c', 'd', 'relates');

  assert.deepEqual(g.neighborhood('a', 1), ['a', 'b']);
  assert.deepEqual(g.neighborhood('a', 2), ['a', 'b', 'c']);
  assert.deepEqual(g.neighborhood('a', 3), ['a', 'b', 'c', 'd']);
});

test('graph: 拓扑序满足前置关系', () => {
  const g = new TaskGraph();
  for (const id of ['root', 'a', 'b']) g.addTask(node(id));
  g.link('root', 'a', 'child');
  g.link('root', 'b', 'child');
  g.link('b', 'a', 'depends');

  const order = g.topoOrder();
  assert.equal(order.length, 3);
  assert.ok(order.indexOf('root') < order.indexOf('a'), '父任务应先于子任务');
  assert.ok(order.indexOf('a') < order.indexOf('b'), '被依赖者应先于依赖者');
});

test('graph: 重复建边幂等', () => {
  const g = new TaskGraph();
  for (const id of ['a', 'b']) g.addTask(node(id));
  g.link('a', 'b', 'child');
  g.link('a', 'b', 'child');
  assert.equal(g.listEdges().length, 1);
});

// ---------- 存储 ----------

test('store: 任务文件 round-trip（含冒号标题、标签、进度）', () => {
  const fs = new MemFs();
  const store = new MemoryStore({ dir: DIR, fs });
  const original = doc(
    't1',
    { title: '标题: 带冒号', status: 'doing', progress: 0.35, summary: '一句话摘要', tags: ['x', 'y'] },
    '## 进度\n- [x] 完成设计\n',
  );

  store.saveTask(original);
  const back = store.loadTask('t1');
  assert.ok(back);
  assert.deepEqual(back.node, original.node);
  assert.equal(back.body.trim(), original.body.trim());
});

test('store: 索引渲染是确定性的，且边可被解析回来', () => {
  const fs = new MemFs();
  const store = new MemoryStore({ dir: DIR, fs });
  store.saveTask(doc('root'));
  store.saveTask(doc('a'));

  const graph = graphOf(['root', 'a'], [['root', 'a', 'child']]);
  const first = store.renderIndex(graph);
  const second = store.renderIndex(graph);
  assert.equal(first, second, '两次渲染必须逐字节相同');
  assert.match(first, /```mermaid/);
  assert.match(first, /```edges/);

  fs.write(store.indexPath(), first);
  assert.deepEqual(store.readEdges(), [{ from: 'root', to: 'a', kind: 'child' }]);
});

test('store: loadContext 只读邻域内的文件', () => {
  const fs = new MemFs();
  const store = new MemoryStore({ dir: DIR, fs });
  for (const id of ['a', 'b', 'z']) store.saveTask(doc(id));
  fs.write(store.indexPath(), store.renderIndex(graphOf(['a', 'b', 'z'], [['a', 'b', 'child']])));

  fs.reads.length = 0;
  const docs = store.loadContext('a', 1);

  assert.deepEqual(
    docs.map((d) => d.node.id),
    ['a', 'b'],
  );
  assert.ok(!fs.reads.includes(store.taskPath('z')), '无关任务文件不应被读取');
});

test('store: check 报告悬空边，健康目录返回空', () => {
  const fs = new MemFs();
  const store = new MemoryStore({ dir: DIR, fs });
  store.saveTask(doc('a'));

  fs.write(store.indexPath(), '```edges\na child ghost\n```\n');
  const problems = store.check();
  assert.ok(
    problems.some((p) => p.includes('ghost')),
    `应报告悬空边，实际: ${JSON.stringify(problems)}`,
  );

  fs.write(store.indexPath(), '```edges\n```\n');
  assert.deepEqual(store.check(), []);
});

test('store: 目录里只认 MEMORY_*.md，忽略索引与日期日志', () => {
  const fs = new MemFs();
  const store = new MemoryStore({ dir: DIR, fs });
  store.saveTask(doc('kvmem-a'));
  fs.write(store.indexPath(), '');
  fs.write(`${DIR}/2026-10-14.md`, '# 日志\n');

  assert.deepEqual(store.listTaskIds(), ['kvmem-a']);
});

// ---- 迭代新增：删除 与 容量 ----

test('store: forgetTask 删文件并报出它参与过的关系', () => {
  const fs = new MemFs();
  const store = new MemoryStore({ dir: DIR, fs });
  for (const id of ['a', 'b', 'c']) store.saveTask(doc(id));
  fs.write(
    store.indexPath(),
    store.renderIndex(graphOf(['a', 'b', 'c'], [['a', 'b', 'child'], ['c', 'b', 'relates']])),
  );

  const r = store.forgetTask('b');
  assert.equal(r.existed, true);
  assert.deepEqual(
    r.droppedEdges.map((e) => `${e.from} ${e.kind} ${e.to}`).sort(),
    ['a child b', 'c relates b'],
    '删除前应先报出会被带走的关系，让调用方知情',
  );
  assert.equal(fs.read(store.taskPath('b')), undefined, '任务文件应被真删');

  // 索引里那条边还在，但 loadGraph 会跳过端点缺失的边 —— 索引自然收敛
  assert.deepEqual(store.loadGraph().listEdges(), []);
});

test('store: forgetTask 对不存在的任务幂等（不抛错）', () => {
  const fs = new MemFs();
  const store = new MemoryStore({ dir: DIR, fs });
  const r = store.forgetTask('ghost');
  assert.equal(r.existed, false);
  assert.deepEqual(r.droppedEdges, []);
});

test('store: check 只在正文超过软上限时提示拆任务', () => {
  const fs = new MemFs();
  const store = new MemoryStore({ dir: DIR, fs, bodySoftLimit: 100 });
  store.saveTask({ node: node('small'), body: 'x'.repeat(50) });
  assert.deepEqual(store.check(), [], '未超限不应报任何问题');

  store.saveTask({ node: node('big'), body: 'x'.repeat(101) });
  const problems = store.check();
  assert.equal(problems.length, 1);
  assert.match(problems[0], /big: 正文 101 字符/);
  assert.match(problems[0], /child/, '提示应给出具体做法');
});
