// 热记忆投影 与 记忆协议 的测试。
//
// 这两层是本次迭代从 dsh-mnemon 学来的核心，也是最容易被写坏的地方：
//   · 投影一旦混进时间戳，"稳定前缀"这个前提就没了 —— 每次对话都在打掉自己的缓存；
//   · 协议一旦与 writeEnabled 脱节，模型会试图调用被禁用的工具。
// 两者都是纯函数，所以可以离线、逐条钉死。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskGraph } from '../src/memory/graph.ts';
import type { TaskNode } from '../src/memory/graph.ts';
import { projectIndex } from '../src/project.ts';
import { renderProtocol } from '../src/guidance.ts';

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

function graphOf(tasks: TaskNode[], edges: Array<[string, string, 'child' | 'depends' | 'relates']>): TaskGraph {
  const g = new TaskGraph();
  for (const t of tasks) g.addTask(t);
  for (const [from, to, kind] of edges) g.link(from, to, kind);
  return g;
}

const OPTS = { dir: '/mem', maxCharacters: 2000 };

// ==================== 1. 确定性：前缀稳定的前提 ====================

test('project: 同一份记忆投影两次逐字节相同', () => {
  const g = graphOf([node('a', { status: 'doing', progress: 0.5 }), node('b')], [['a', 'b', 'child']]);
  assert.equal(projectIndex(g, OPTS), projectIndex(g, OPTS));
});

test('project: 只有 updatedAt 变化时投影不变 —— 这是前缀缓存能命中的充要条件', () => {
  const before = graphOf(
    [node('a', { status: 'doing', progress: 0.5, updatedAt: 1_000 }), node('b', { updatedAt: 1_000 })],
    [['a', 'b', 'child']],
  );
  const after = graphOf(
    [node('a', { status: 'doing', progress: 0.5, updatedAt: 9_999_999 }), node('b', { updatedAt: 9_999_999 })],
    [['a', 'b', 'child']],
  );
  assert.equal(
    projectIndex(after, OPTS),
    projectIndex(before, OPTS),
    '时间戳不得进入投影 —— 否则每轮都在打掉自己的前缀缓存',
  );
});

test('project: 任务与关系都按 id / (from,kind,to) 排序，与插入顺序无关', () => {
  const one = graphOf([node('z'), node('a'), node('m')], [['z', 'a', 'relates'], ['a', 'm', 'child']]);
  const two = graphOf([node('a'), node('m'), node('z')], [['a', 'm', 'child'], ['z', 'a', 'relates']]);
  assert.equal(projectIndex(one, OPTS), projectIndex(two, OPTS));
});

// ==================== 2. 内容形状 ====================

test('project: 空记忆给出明确指引，而不是空白', () => {
  const text = projectIndex(new TaskGraph(), OPTS);
  assert.match(text, /empty/);
  assert.match(text, /lmmarr_upsert/, '空记忆应告诉模型下一步怎么开始，而不是留个空字符串');
});

test('project: 非空投影含状态、进度与摘要', () => {
  const g = graphOf([node('a', { title: '标题', summary: '一句话状态', status: 'blocked', progress: 0.25 })], []);
  const text = projectIndex(g, OPTS);
  assert.match(text, /- a \[blocked 25%\] 一句话状态/);
  assert.match(text, /1 task\(s\), 0 relation\(s\)/);
});

test('project: summary 缺失时退回 title，不留空位', () => {
  const text = projectIndex(graphOf([node('a', { title: '只有标题' })], []), OPTS);
  assert.match(text, /只有标题/);
});

// ==================== 3. 预算：截断必须显式 ====================

test('project: 超预算时先丢关系，再裁任务，且明说被裁了多少', () => {
  const tasks = Array.from({ length: 40 }, (_, i) => node(`task-${String(i).padStart(2, '0')}`, { summary: 'x'.repeat(30) }));
  const edges: Array<[string, string, 'child']> = [];
  for (let i = 1; i < 40; i++) edges.push([`task-${String(i - 1).padStart(2, '0')}`, `task-${String(i).padStart(2, '0')}`, 'child']);

  const text = projectIndex(graphOf(tasks, edges), { dir: '/mem', maxCharacters: 400 });
  assert.ok(text.length <= 400, `投影不得超过预算，实际 ${text.length}`);
  assert.match(text, /omitted/, '截断必须显式说明 —— 静默截断会让模型把"没看到"当成"不存在"');
  assert.match(text, /not a deletion/, '要让模型知道省略不等于删除');
  assert.doesNotMatch(text, /relations:/, '关系是最先被舍弃的，因为任务状态更常被问到');
});

test('project: 预算足够时不得出现任何截断痕迹', () => {
  const g = graphOf([node('a'), node('b')], [['a', 'b', 'child']]);
  const text = projectIndex(g, OPTS);
  assert.doesNotMatch(text, /omitted/);
  assert.doesNotMatch(text, /bounded/);
  assert.match(text, /relations:/);
});

// ==================== 4. 协议：与 writeEnabled 严格一致 ====================

test('protocol: 可写档描述写工具与写入纪律', () => {
  const text = renderProtocol({ writeEnabled: true });
  for (const tool of ['lmmarr_context', 'lmmarr_upsert', 'lmmarr_link', 'lmmarr_forget']) {
    assert.match(text, new RegExp(tool), `协议应提到 ${tool}`);
  }
  assert.match(text, /never write back what a read returned/i, '必须写明"读取回执不得写回"这条纪律');
  assert.match(text, /a write exists only after its receipt/i, '必须写明"回执才算写入成功"');
});

test('protocol: 只读档不得再教模型去写', () => {
  const text = renderProtocol({ writeEnabled: false });
  assert.match(text, /READ-ONLY|read-only/);
  assert.doesNotMatch(text, /lmmarr_upsert/, '只读档下不得把写工具写进协议');
  assert.doesNotMatch(text, /lmmarr_forget/);
});

test('protocol: 文本足够短 —— 它住在每一轮的上下文里', () => {
  const chars = renderProtocol({ writeEnabled: true }).length;
  assert.ok(chars < 1500, `协议正文 ${chars} 字符，超出预算；这段文本每轮都花 token`);
});
