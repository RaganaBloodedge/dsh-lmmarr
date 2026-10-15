// 插件契约测试 —— 证明「它作为一个 dsh 插件成不成立」。
//
// 与 tests/memory.test.ts 的分工（两层不同的验证，缺一不可）：
//   memory.test.ts  证明记忆算法对不对  —— 直接 new MemoryStore，纯逻辑
//   plugin.test.ts  证明插件挂得上跑得通 —— 加载 src/index.ts，走 apply + execute
//
// 关键手法：用 module.registerHooks 在加载插件之前，把 @deepseek-ai/* 重定向到
// 本地替身（tests/dsh-stubs.ts）。这样不需要安装 dsh，也不需要改源码结构。
// 注意顺序 —— ESM 的静态 import 会被提升到模块体之前解析，
// 所以对插件的导入必须是动态 import()，否则 hooks 还没生效就已经解析完了。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FakeCtx, assertJsonSchemaSubset, assertValueMatchesSchema } from './dsh-stubs.ts';
import type { ToolRunContext } from './dsh-stubs.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools' || specifier === '@deepseek-ai/cordis') {
      // 优先用真实包（装了 peerDependencies 就有）——真实 defineTool 才是真契约，
      // 刚才的 additionalProperties 就是它抓到的；没装时才退回本地替身，保证离线可跑。
      try {
        return nextResolve(specifier, context);
      } catch {
        return { url: new URL('./dsh-stubs.ts', import.meta.url).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const PLUGIN = new URL('../src/index.ts', import.meta.url).href;

/** bust=true 时给 URL 加查询串，强制 ESM 重新求值（用来观察模块首次求值的副作用） */
let bustSeq = 0;
async function loadPlugin(bust = false): Promise<any> {
  return import(bust ? `${PLUGIN}?bust=${++bustSeq}` : PLUGIN);
}

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `kvmem-${tag}-`));
}

function execCtx(ctx: FakeCtx): ToolRunContext {
  return { signal: new AbortController().signal, agent: { id: 'test-agent', ctx } };
}

/** 每个工具「最小合法回执」的形状，用来单独测 render 而不必先造数据 */
const EMPTY_OUTPUT: Record<string, unknown> = {
  lmmarr_index: { dir: '/mem', indexPath: '/mem/MEMORY.md', tasks: [], edges: [], problems: [], repaired: [] },
  lmmarr_context: { taskId: 'x', depth: 1, loaded: [], docs: [] },
  lmmarr_upsert: { id: 'x', path: '/mem/MEMORY_x.md', created: false, dir: '/mem', indexPath: '/mem/MEMORY.md', tasks: [], edges: [], problems: [], repaired: [] },
  lmmarr_link: { ok: true, error: '', dir: '/mem', indexPath: '/mem/MEMORY.md', tasks: [], edges: [], problems: [], repaired: [] },
  lmmarr_forget: { id: 'x', existed: true, droppedEdges: [], dir: '/mem', indexPath: '/mem/MEMORY.md', tasks: [], edges: [], problems: [], repaired: [] },
};

/** 按名字调用一个已注册的工具，模拟框架的派发 */
async function call(ctx: FakeCtx, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const tool = ctx.registered.find((t) => t.name === name);
  if (tool === undefined) {
    throw new Error(`未注册的工具: ${name}（已注册: ${ctx.registered.map((t) => t.name).join(', ')}）`);
  }
  return await tool.execute(args, execCtx(ctx));
}

// ==================== 1. 导出形状 ====================

test('plugin: 导出形状符合 dsh 规范（具名导出 + inject + provide）', async () => {
  const mod = await loadPlugin();

  assert.equal(mod.name, 'dsh-lmmarr', 'name 必须与 package.json 的包名一致');
  assert.equal(typeof mod.apply, 'function', 'apply 是唯一的挂载入口');
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组');
  assert.ok(mod.inject.includes('tools'), 'inject 必须声明 tools —— 否则 apply 时 ctx.tools 还没就绪');
  assert.ok(
    !mod.inject.includes('systemPrompt'),
    'systemPrompt 不得写进 inject：某些 headless profile 没有它，写进去会让整个插件不激活',
  );
  assert.deepEqual(mod.provide, ['lmmarrMemory'], '服务名要与 ctx.provide 调用一致');

  // dsh 硬规矩：export default 会让加载器丢掉 inject 等元数据，且不报错
  assert.ok(!Object.prototype.hasOwnProperty.call(mod, 'default'), '不得存在 default 导出');
});

test('plugin: 模块求值不产生磁盘写入（顶层零副作用）', async () => {
  const dir = tempDir('nosfx');
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    // 强制重新求值：真实场景里插件会被反复挂载/卸载，顶层必须干净
    await loadPlugin(true);
    assert.deepEqual(readdirSync(dir), [], 'import 不应在工作目录产生任何文件或目录');
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ==================== 2. 工具注册与声明自洽 ====================

test('plugin: apply 注册五个工具，且每个声明自洽', async () => {
  const dir = tempDir('reg');
  const mod = await loadPlugin();
  const ctx = new FakeCtx();
  mod.apply(ctx, { dir });

  assert.deepEqual(
    ctx.registered.map((t) => t.name).sort(),
    ['lmmarr_context', 'lmmarr_forget', 'lmmarr_index', 'lmmarr_link', 'lmmarr_upsert'],
  );

  for (const tool of ctx.registered) {
    // description 是模型选工具的唯一依据，空描述等于工具不存在
    assert.ok(tool.description.trim().length > 20, `${tool.name} 的 description 太短`);
    assert.ok(tool.name.startsWith('lmmarr_'), `${tool.name} 缺少 lmmarr_ 前缀 —— 工具名冲突是静默故障`);
    assert.equal(typeof tool.timeoutMs, 'number', `${tool.name} 应声明超时，否则一次卡住会拖住整个 turn`);
    assert.equal(typeof tool.presentCall, 'function', `${tool.name} 应声明 presentCall，UI 才有卡片可渲染`);

    // 真实 defineTool 会把 parameters 的 spec 编译成 JSON Schema：
    //   { type:'object', properties:{...}, required:[...] }
    // 所以这里检查的是「编译产物」而不是原始 spec。
    const params = tool.parameters as unknown as {
      type?: string;
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    assert.equal(params.type, 'object', `${tool.name}.parameters 编译后应为 object`);
    for (const [key, spec] of Object.entries(params.properties ?? {})) {
      assert.equal(typeof spec.type, 'string', `${tool.name}.parameters.${key} 缺少 type`);
    }
    for (const key of params.required ?? []) {
      assert.ok(params.properties?.[key] !== undefined, `${tool.name}: required 点名了未声明的字段 ${key}`);
    }

    // output.schema 必须落在 dsh 支持的 JSON Schema 子集里。
    // 这条规则是真实启动（L2）抓出来的：每个 object 都要显式 additionalProperties。
    // 凭直觉写 schema 必踩，所以把它固化进 L1，不必再靠启动才发现。
    assertJsonSchemaSubset(tool.output.schema, `${tool.name}.output.schema`);

    // render 必须真的产出 text block，否则模型拿到的是空回执
    const sample = EMPTY_OUTPUT[tool.name];
    assert.ok(sample !== undefined, `测试缺少 ${tool.name} 的最小回执样本`);
    const rendered = tool.output.render({}, sample);
    assert.ok(Array.isArray(rendered) && rendered.length > 0, `${tool.name}.render 应返回非空 block 数组`);
    assert.equal(rendered[0].type, 'text', `${tool.name}.render 首个 block 应为 text`);
    assert.ok((rendered[0].text ?? '').length > 0, `${tool.name}.render 不应产出空文本`);
  }

  rmSync(dir, { recursive: true, force: true });
});

// ==================== 3. 端到端工具链 ====================

test('plugin: 端到端 —— upsert → link → index → context 全链路', async () => {
  const dir = tempDir('e2e');
  const mod = await loadPlugin();
  const ctx = new FakeCtx();
  mod.apply(ctx, { dir, depth: 1 });

  // ① 空目录：应能安全返回，不炸
  const empty = await call(ctx, 'lmmarr_index');
  assert.deepEqual(empty.tasks, []);
  assert.deepEqual(empty.edges, []);
  assert.deepEqual(empty.problems, []);

  // ② 写两个任务
  const created = await call(ctx, 'lmmarr_upsert', {
    id: 'kvmem-store',
    title: '存储底座',
    status: 'doing',
    progress: 0.5,
    summary: 'Segment 模型 + L0/L1/L2',
    tags: ['layer:store'],
    body: '## 进展\n- [x] FsPort\n- [ ] kvcodec\n',
  });
  assert.equal(created.created, true, '首次写入应标记为 created');

  await call(ctx, 'lmmarr_upsert', { id: 'kvmem-recall', title: '召回层', status: 'todo' });

  // ③ 建关系
  const linked = await call(ctx, 'lmmarr_link', { from: 'kvmem-store', to: 'kvmem-recall', kind: 'depends' });
  assert.equal(linked.ok, true, `建边应成功: ${linked.error}`);

  // ④ 磁盘上真的落了文件（这是"记忆能持久"的最小证据）
  const taskFile = join(dir, 'MEMORY_kvmem-store.md');
  assert.ok(existsSync(taskFile), `任务文件应存在: ${taskFile}`);
  const taskText = readFileSync(taskFile, 'utf8');
  assert.match(taskText, /^---\nid: kvmem-store\n/, 'frontmatter 应可被解析回来');
  assert.match(taskText, /status: doing/);
  assert.match(taskText, /progress: 0\.5/);
  assert.match(taskText, /- \[x\] FsPort/, '正文应原样保存');

  // ⑤ 索引可读回，且结构完整
  const indexed = await call(ctx, 'lmmarr_index');
  assert.deepEqual(indexed.tasks.map((t: { id: string }) => t.id), ['kvmem-recall', 'kvmem-store'], '任务按 id 字典序');
  assert.deepEqual(indexed.edges, [{ from: 'kvmem-store', kind: 'depends', to: 'kvmem-recall' }]);
  assert.deepEqual(indexed.problems, []);

  const indexText = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  assert.match(indexText, /```mermaid/, '索引应含关系图谱');
  assert.match(indexText, /```edges/, '索引应含机器可读边块');
  assert.match(indexText, /kvmem-store depends kvmem-recall/, '边块应能被解析回来');

  // render 决定模型实际读到什么 —— 用真实回执验证一次
  // （render 优先展示 summary，没有 summary 才退回 title）
  const rendered = ctx.registered.find((t) => t.name === 'lmmarr_index')!.output.render({}, indexed);
  assert.match(rendered[0].text ?? '', /kvmem-store \[doing 50%\] Segment 模型 \+ L0\/L1\/L2/);

  // ⑥ 按任务只加载邻域
  const loaded = await call(ctx, 'lmmarr_context', { taskId: 'kvmem-store' });
  assert.deepEqual(loaded.loaded, ['kvmem-recall', 'kvmem-store'], 'depth=1 应带上直接关联的任务');
  const self = loaded.docs.find((d: { id: string }) => d.id === 'kvmem-store');
  assert.match(self.body, /FsPort/, '正文应完整返回给模型');
  assert.equal(self.progress, 0.5);

  // ⑦ 幂等：只改 status，其余字段不得被清空
  await call(ctx, 'lmmarr_upsert', { id: 'kvmem-store', status: 'done' });
  const patched = await call(ctx, 'lmmarr_index');
  const node = patched.tasks.find((t: { id: string }) => t.id === 'kvmem-store');
  assert.equal(node.status, 'done');
  assert.equal(node.title, '存储底座', '未传入的字段应保留');
  assert.equal(node.progress, 0.5, '未传入的字段应保留');

  rmSync(dir, { recursive: true, force: true });
});

// ==================== 4. 跨会话持久 与 实例隔离 ====================

test('plugin: 新实例（模拟新会话）能从磁盘读回全部记忆', async () => {
  const dir = tempDir('persist');
  const mod = await loadPlugin();

  // 会话 A：把记忆写进磁盘
  const ctxA = new FakeCtx();
  mod.apply(ctxA, { dir });
  await call(ctxA, 'lmmarr_upsert', { id: 'task-a', title: '任务 A', status: 'doing', progress: 0.3 });
  await call(ctxA, 'lmmarr_upsert', { id: 'task-b', title: '任务 B', status: 'todo' });
  await call(ctxA, 'lmmarr_link', { from: 'task-a', to: 'task-b', kind: 'child' });
  const before = await call(ctxA, 'lmmarr_index');

  // 会话 B：全新 ctx、全新 store（apply 内新建），只有目录相同
  const ctxB = new FakeCtx();
  mod.apply(ctxB, { dir });
  const after = await call(ctxB, 'lmmarr_index');

  assert.deepEqual(after.tasks, before.tasks, '新会话应看到同样的任务状态');
  assert.deepEqual(after.edges, before.edges, '新会话应看到同样的关系');
  assert.deepEqual(after.problems, []);

  const ctxC = new FakeCtx();
  mod.apply(ctxC, { dir });
  const recalled = await call(ctxC, 'lmmarr_context', { taskId: 'task-b', depth: 1 });
  assert.deepEqual(recalled.loaded, ['task-a', 'task-b'], '新会话应能按关系召回邻域');

  rmSync(dir, { recursive: true, force: true });
});

test('plugin: 两个实例互不干扰（无全局可变状态）', async () => {
  const dirA = tempDir('iso-a');
  const dirB = tempDir('iso-b');
  const mod = await loadPlugin();
  const ctxA = new FakeCtx();
  const ctxB = new FakeCtx();
  mod.apply(ctxA, { dir: dirA });
  mod.apply(ctxB, { dir: dirB });

  await call(ctxA, 'lmmarr_upsert', { id: 'only-in-a', title: '只属于 A' });

  const seenByB = await call(ctxB, 'lmmarr_index');
  assert.deepEqual(seenByB.tasks, [], 'B 实例不应看到 A 的记忆');
  assert.equal(existsSync(join(dirB, 'MEMORY_only-in-a.md')), false, '不应写进 B 的目录');

  // 同一实例重复 apply（重新挂载）也不应破坏已有注册
  assert.equal(ctxA.registered.length, 5);

  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

test('plugin: 卸载后工具全部注销', async () => {
  const dir = tempDir('dispose');
  const mod = await loadPlugin();
  const ctx = new FakeCtx();
  mod.apply(ctx, { dir });
  assert.equal(ctx.registered.length, 5);

  ctx.dispose(); // 模拟 Cordis 卸载插件
  assert.equal(ctx.registered.length, 0, '卸载后不应残留任何工具');

  rmSync(dir, { recursive: true, force: true });
});

// ==================== 5. 失败路径 ====================

test('plugin: 成环的 lmmarr_link 返回 ok:false 且不污染索引', async () => {
  const dir = tempDir('cycle');
  const mod = await loadPlugin();
  const ctx = new FakeCtx();
  mod.apply(ctx, { dir });

  for (const id of ['a', 'b', 'c']) await call(ctx, 'lmmarr_upsert', { id, title: id });
  await call(ctx, 'lmmarr_link', { from: 'a', to: 'b', kind: 'depends' });
  await call(ctx, 'lmmarr_link', { from: 'b', to: 'c', kind: 'depends' });

  const bad = await call(ctx, 'lmmarr_link', { from: 'c', to: 'a', kind: 'depends' });
  assert.equal(bad.ok, false, '成环必须被拒绝');
  assert.match(bad.error, /cycle/);

  const after = await call(ctx, 'lmmarr_index');
  assert.equal(after.edges.length, 2, '被拒绝的边不得写进索引');
  assert.deepEqual(after.problems, []);

  rmSync(dir, { recursive: true, force: true });
});

// ==================== 6. 契约测试刨出来的两个洞 ====================

test('plugin: 任务 id 不得逃出记忆目录（路径穿越）', async () => {
  const dir = tempDir('escape');
  const mod = await loadPlugin();
  const ctx = new FakeCtx();
  mod.apply(ctx, { dir });

  // id 会被拼成 <dir>/MEMORY_<id>.md —— 若 id 里带 ../，就能写到目录外
  await assert.rejects(
    () => call(ctx, 'lmmarr_upsert', { id: '../../pwned', title: 'x' }),
    /invalid task id/,
    '含路径分隔符的 id 必须被拒绝',
  );
  await assert.rejects(
    () => call(ctx, 'lmmarr_context', { taskId: '../etc/passwd' }),
    /invalid task id/,
    '读路径同样要挡',
  );
  assert.equal(existsSync(join(dirname(dir), 'pwned.md')), false);

  rmSync(dir, { recursive: true, force: true });
});

test('plugin: 索引被外部改坏时，lmmarr_index 应报出并自愈', async () => {
  const dir = tempDir('dangling');
  const mod = await loadPlugin();
  const ctx = new FakeCtx();
  mod.apply(ctx, { dir });
  await call(ctx, 'lmmarr_upsert', { id: 'a', title: 'A' });

  // 手工往索引里塞一条指向不存在任务的边（模拟被外部工具/人手改坏）
  writeFileSync(join(dir, 'MEMORY.md'), '```edges\na child ghost\n```\n', 'utf8');
  const r = await call(ctx, 'lmmarr_index');
  assert.ok(
    (r.repaired as string[]).some((p) => p.includes('ghost')),
    `应在 repaired 里报告悬空边，实际 repaired=${JSON.stringify(r.repaired)}`,
  );
  assert.deepEqual(r.problems, [], '自愈掉的问题不该留在 problems 里 —— 那会让模型去修一个已经不存在的问题');

  // 自愈是真的落了盘：再读一次不该再有问题
  const again = await call(ctx, 'lmmarr_index');
  assert.deepEqual(again.repaired, []);
  assert.deepEqual(again.problems, []);

  rmSync(dir, { recursive: true, force: true });
});

// ==================== 7. 引导层与服务层（本次迭代新增） ====================

test('plugin: 注入记忆协议与热记忆投影两个系统提示段落', async () => {
  const dir = tempDir('guide');
  const mod = await loadPlugin();
  const ctx = new FakeCtx();
  mod.apply(ctx, { dir });

  const names = ctx.sections.map((s) => s.name).sort();
  assert.deepEqual(names, ['lmmarr:index', 'lmmarr:protocol'], '两段都要注册：纪律 + 现状');

  // 顺序：先读纪律，再读现状
  const protocol = ctx.sections.find((s) => s.name === 'lmmarr:protocol')!;
  const index = ctx.sections.find((s) => s.name === 'lmmarr:index')!;
  assert.ok(protocol.order < index.order, '协议应排在投影之前');

  // text 必须是 provider（每轮求值），不能是常量字符串
  assert.equal(typeof protocol.text, 'function', '协议必须每轮求值，才能跟随 writeEnabled');
  assert.equal(typeof index.text, 'function', '投影必须每轮求值');

  rmSync(dir, { recursive: true, force: true });
});

test('plugin: 热记忆投影随记忆变化，且不含时间戳', async () => {
  const dir = tempDir('hot');
  const mod = await loadPlugin();
  const ctx = new FakeCtx();
  mod.apply(ctx, { dir });
  const index = ctx.sections.find((s) => s.name === 'lmmarr:index')!;
  const text = () => (typeof index.text === 'function' ? index.text() : index.text);

  assert.match(text(), /empty/, '空记忆时投影应明说 empty');

  await call(ctx, 'lmmarr_upsert', { id: 'hot-a', title: '热记忆', status: 'doing', progress: 0.5, summary: '常驻投影' });
  const after = text();
  assert.match(after, /hot-a \[doing 50%\] 常驻投影/, '写入后投影应立刻反映新状态');
  assert.doesNotMatch(after, /\d{4}-\d{2}-\d{2}T/, '投影里不得出现 ISO 时间戳 —— 否则前缀每轮都变');

  rmSync(dir, { recursive: true, force: true });
});

test('plugin: 提示服务缺失时插件照常激活（不写进 inject 的理由）', async () => {
  const dir = tempDir('noprompt');
  const mod = await loadPlugin();
  const ctx = new FakeCtx();
  ctx.hasSystemPrompt = false; // 模拟某些 headless profile

  assert.doesNotThrow(() => mod.apply(ctx, { dir }), '没有 systemPrompt 时 apply 不得抛错');
  assert.equal(ctx.registered.length, 5, '工具仍应全部注册 —— 引导是增强，不是前提');
  assert.deepEqual(ctx.sections, [], '没有提示服务时不应有段落');

  rmSync(dir, { recursive: true, force: true });
});

test('plugin: 记忆能力作为服务 provide，且不经过模型也能用', async () => {
  const dir = tempDir('svc');
  const mod = await loadPlugin();
  const ctx = new FakeCtx();
  mod.apply(ctx, { dir });

  const svc = ctx.provided.get('lmmarrMemory') as {
    dir: string;
    writeEnabled: boolean;
    graph: () => { size: number };
    context: (id: string, depth?: number) => Array<{ node: { id: string } }>;
    refresh: () => { tasks: unknown[]; problems: string[] };
  };
  assert.ok(svc !== undefined, '未 provide lmmarrMemory');
  assert.equal(svc.dir, dir);
  assert.equal(svc.writeEnabled, true);

  await call(ctx, 'lmmarr_upsert', { id: 'svc-a', title: '服务', status: 'doing' });
  assert.equal(svc.graph().size, 1, '扩展方应能直接拿到图谱，不必自己实现');
  assert.deepEqual(svc.context('svc-a').map((d) => d.node.id), ['svc-a']);
  assert.deepEqual(svc.refresh().problems, []);

  rmSync(dir, { recursive: true, force: true });
});

test('plugin: 两个实例的 provide 互不覆盖（服务是实例级的）', async () => {
  const dirA = tempDir('svc-a');
  const dirB = tempDir('svc-b');
  const mod = await loadPlugin();
  const ctxA = new FakeCtx();
  const ctxB = new FakeCtx();

  mod.apply(ctxA, { dir: dirA });
  assert.throws(() => mod.apply(ctxA, { dir: dirA }), /重复 provide|already/, '同一 ctx 重复 provide 应报错，而不是静默覆盖');
  mod.apply(ctxB, { dir: dirB });

  assert.equal((ctxA.provided.get('lmmarrMemory') as { dir: string }).dir, dirA);
  assert.equal((ctxB.provided.get('lmmarrMemory') as { dir: string }).dir, dirB);

  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

// ==================== 8. 只读档 ====================

test('plugin: writeEnabled=false 时写工具明确拒绝，读工具照常', async () => {
  const dir = tempDir('ro');
  const mod = await loadPlugin();
  const ctx = new FakeCtx();
  mod.apply(ctx, { dir, writeEnabled: false });

  // 先用手写文件造出一份记忆（只读档下当然不能靠工具写）
  writeFileSync(join(dir, 'MEMORY_seed.md'), '---\nid: seed\ntitle: 种子\nstatus: doing\n---\n\n内容\n', 'utf8');

  const read = await call(ctx, 'lmmarr_index');
  assert.deepEqual(read.tasks.map((t: { id: string }) => t.id), ['seed'], '读工具必须照常可用');

  for (const [name, args] of [
    ['lmmarr_upsert', { id: 'x' }],
    ['lmmarr_link', { from: 'seed', to: 'seed', kind: 'relates' }],
    ['lmmarr_forget', { id: 'seed' }],
  ] as const) {
    await assert.rejects(() => call(ctx, name, args as Record<string, unknown>), /read-only/, `${name} 应拒绝执行`);
  }
  assert.ok(existsSync(join(dir, 'MEMORY_seed.md')), '被拒绝的写入不得留下副作用');

  // 只读档下协议也必须改口径
  const protocol = ctx.sections.find((s) => s.name === 'lmmarr:protocol')!;
  const text = typeof protocol.text === 'function' ? protocol.text() : protocol.text;
  assert.doesNotMatch(text, /lmmarr_upsert/, '只读档不得在协议里教模型调写工具');

  rmSync(dir, { recursive: true, force: true });
});

// ==================== 9. 遗忘 ====================

test('plugin: lmmarr_forget 删任务并带走它的关系', async () => {
  const dir = tempDir('forget');
  const mod = await loadPlugin();
  const ctx = new FakeCtx();
  mod.apply(ctx, { dir });

  for (const id of ['a', 'b', 'c']) await call(ctx, 'lmmarr_upsert', { id, title: id });
  await call(ctx, 'lmmarr_link', { from: 'a', to: 'b', kind: 'child' });
  await call(ctx, 'lmmarr_link', { from: 'c', to: 'b', kind: 'relates' });

  const r = await call(ctx, 'lmmarr_forget', { id: 'b' });
  assert.equal(r.existed, true);
  assert.equal(r.droppedEdges.length, 2, '应报出被带走的两条关系');
  assert.equal(existsSync(join(dir, 'MEMORY_b.md')), false, '任务文件应被真删');
  assert.deepEqual(r.tasks.map((t: { id: string }) => t.id), ['a', 'c']);
  assert.deepEqual(r.edges, [], '指向被删任务的关系不得留在索引里');
  assert.deepEqual(r.problems, [], '删除后不应留下任何待处理问题');
  assert.equal(r.repaired.length, 2, '删除造成的悬空边应由本次调用自愈，并记在 repaired 里 —— 而不是当成待办丢给模型');

  // 再删一次：幂等，不抛错
  const again = await call(ctx, 'lmmarr_forget', { id: 'b' });
  assert.equal(again.existed, false);

  rmSync(dir, { recursive: true, force: true });
});

// ==================== 10. 打包与挂载配置 ====================
//
// 配置写错时 dsh 的行为是「静默不加载」而不是报错 —— 最容易白忙半天。
// 把形状钉成测试，改坏时至少本地先炸。

test('plugin: cordis 配置形状正确（顶层必须是序列）', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

  // 本地开发 overlay：name 用**相对路径**，按本文件所在目录解析，可随仓库移动。
  // 写成绝对路径会把作者机器的目录带进公开仓库，别人 clone 后必炸。
  // （曾误以为相对路径会被静默解析失败，实测 --dump-config 从两个不同 cwd 均正确解析。）
  const local = read('../cordis.yml');
  assert.match(local, /^- insert:/m, 'cordis.yml 顶层必须是序列（裸 mapping: 会被静默忽略）');
  assert.match(local, /id: lmmarr/);
  assert.match(local, /name:\s+\.\/src\/index\.ts$/m, 'overlay 的 name 必须是相对路径 ./src/index.ts');
  assert.doesNotMatch(
    local,
    /name:\s+(?:\/|[A-Za-z]:[\\/])/,
    'overlay 不得写成绝对路径 —— 那会把作者机器的目录带进公开仓库',
  );

  // 发布用的 bundle 层：引用包名（不是路径），且 patch 路径与 package.json 声明一致
  const bundle = read('../cordis.patch.yml');
  assert.match(bundle, /^- insert:/m, 'cordis.patch.yml 顶层必须是序列');
  assert.match(bundle, /name: dsh-lmmarr$/m, 'bundle 层必须按包名引用，路径形式装到别人机器上必炸');

  const pkg = JSON.parse(read('../package.json')) as {
    name: string;
    type: string;
    main: string;
    exports: Record<string, { types?: string; default?: string } | string>;
    files: string[];
    dsh: { bundle: { patch: string } };
    scripts: Record<string, string>;
  };
  assert.equal(pkg.name, 'dsh-lmmarr', '包名必须与 cordis 里的 name 一致 —— 安装名就是包名');
  assert.equal(pkg.type, 'module', '必须是 ESM');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch 必须指向实际文件');
  assert.ok(existsSync(new URL(`../${pkg.dsh.bundle.patch}`, import.meta.url)), 'patch 文件必须存在，否则安装后挂载不到');

  // 发布物必须是构建产物：main 指向 lib/，且 lib/ 必须真的被 files 收进去
  assert.match(pkg.main, /^\.?\/?lib\//, 'main 必须指向构建产物（src/ 里的 .ts 不能直接当入口发给别人）');
  const root = pkg.exports['.'];
  assert.ok(typeof root === 'object' && root.default !== undefined, 'exports["."] 必须声明 default 入口');
  assert.ok(typeof root === 'object' && root.types !== undefined, 'exports["."] 必须声明 types，否则消费者没有类型');
  assert.ok(pkg.files.includes('lib'), 'files 必须包含 lib，否则构建产物不会被打进包');
  assert.ok(pkg.files.includes('cordis.patch.yml'), 'files 必须包含 cordis.patch.yml，否则 dsh 找不到挂载层');
});

// ==================== 11. 回执必须满足自己声明的 schema ====================
//
// 这一条是 L3（真实模型调用）抓出来的，前两层都看不见：
//   lmmarr_upsert 的 tasks[] 里带着 TaskNode 的 tags，而返回 schema 没声明它 ——
//   运行时以 additionalProperties:false 拒绝整个回执，工具报错。
//   **可是写盘已经生效了**：模型以为失败，磁盘上却已经改了。
//   这种「报错但已生效」是最坏的失配，会让模型重试、误判、甚至回滚错东西。
//
// 根因不是某个字段写漏，而是**缺少一条测试**：原来只断言 schema 自身合法
// （assertJsonSchemaSubset），没有任何东西检查「真实回执是否符合自己声明的 schema」。
// 断言必须落在真实返回值上，因为只有执行过才知道回执里到底有什么字段。

test('plugin: 每个工具的真实回执都满足自己声明的 output.schema', async () => {
  const dir = tempDir('receipt');
  const mod = await loadPlugin();
  const ctx = new FakeCtx();
  mod.apply(ctx, { dir, depth: 1 });

  let checked = 0;
  const check = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const tool = ctx.registered.find((t) => t.name === name);
    assert.ok(tool !== undefined, `未注册: ${name}`);
    const value = await call(ctx, name, args);
    assertValueMatchesSchema(tool.output.schema, value, `${name} 的回执`);
    checked++;
    return value;
  };

  // 覆盖每个工具的所有分支 —— 分支的返回形状不同，只测成功路径会漏掉一半
  const empty = await check('lmmarr_index');                                  // 空库
  assert.deepEqual(empty.tasks, []);

  const created = await check('lmmarr_upsert', {
    id: 'receipt-a',
    title: 'A',
    status: 'doing',
    progress: 0.25,
    summary: 's',
    tags: ['layer:x', 'layer:y'],                                             // ← tags 就是踩坑点
    body: 'body',
  });
  assert.equal(created.created, true, '首次写入应标记为 created');

  const updated = await check('lmmarr_upsert', { id: 'receipt-a', progress: 0.5 });
  assert.equal(updated.created, false, '重复写入应是更新语义');
  assert.deepEqual(
    updated.tasks.find((t: { id: string }) => t.id === 'receipt-a').tags,
    ['layer:x', 'layer:y'],
    '省略的字段必须保留 —— 回执里也要带上，否则模型会以为标签丢了',
  );

  await check('lmmarr_upsert', { id: 'receipt-b', title: 'B' });
  await check('lmmarr_link', { from: 'receipt-a', to: 'receipt-b', kind: 'depends' });
  await check('lmmarr_context', { taskId: 'receipt-a', depth: 1 });
  await check('lmmarr_context', { taskId: 'receipt-missing', depth: 1 });      // 不存在的 id
  await check('lmmarr_link', { from: 'receipt-b', to: 'receipt-a', kind: 'depends' }); // 成环被拒
  await check('lmmarr_forget', { id: 'receipt-b' });
  await check('lmmarr_forget', { id: 'receipt-b' });                           // 删不存在的

  assert.ok(checked >= 10, `应覆盖到每个分支，实际只有 ${checked} 次`);

  rmSync(dir, { recursive: true, force: true });
});

