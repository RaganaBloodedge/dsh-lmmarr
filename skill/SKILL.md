---
name: lmmarr-memory
description: 跨会话的长期任务记忆编排，把记忆拆成「索引 + 每任务一文件 + 关系图谱」三层，做某个任务时只加载它及其邻域。当用户要求记住跨会话的进度、决策或约束，当任务已被拆解成多个子任务，当需要梳理任务之间的依赖/拆解/关联关系，或当单个 MEMORY.md 已经过长而需要拆分归档时使用。
agent_created: true
---

# lmmarr 任务记忆

## 它解决什么问题

把长期记忆全写进一个 `MEMORY.md`，会在两件事上失效：文件本身会超限，且**每个任务都要把别人的记忆一起读进来**——上下文被无关内容占满，而真正相关的细节反而被挤掉。

lmmarr 的解法是**分层 + 按需加载**：一份索引负责"有哪些任务、彼此什么关系"，每个任务一份文件负责"这个任务到底怎么样了"。做任务时只加载该任务及其邻域，其余一个字都不读。

## 三层结构

| 层 | 文件 | 性质 | 谁写 |
|---|---|---|---|
| 原始 | `YYYY-MM-DD.md` | append-only 流水，**只加不改** | 人或 agent，按天追加 |
| 任务 | `MEMORY_<task-id>.md` | 单任务状态与沉淀，**可重写** | 用下面的命令维护 |
| 索引 | `MEMORY.md` | **只放**任务表 + 关系图谱 + 机器可读边块 | 由 `index` 命令生成，勿手改 |

默认记忆目录是当前工作区的 `.workbuddy/memory/`。若用户另有指定，以用户说的为准。

## 何时使用

- 用户要求"记住这件事"，而它需要跨会话存活；
- 一个请求天然拆成多个子任务，各自有独立进度；
- 需要表达任务之间的**拆解**、**依赖**或**关联**；
- 已有的 `MEMORY.md` 太长，需要拆分归档；
- 开工前需要回想"这个任务之前的决策是什么"。

若只是当前对话内的一次性问答，不要动记忆。

## 工作流

### 读：只加载相关的那部分

```bash
node <skill-dir>/scripts/cli.js show    .workbuddy/memory            # 先看索引：有哪些任务
node <skill-dir>/scripts/cli.js context .workbuddy/memory <task-id> 1  # 只读该任务 + 1 跳邻域
```

**不要**把所有 `MEMORY_*.md` 一次性读进来。那正是这套分层要避免的事。先看索引定位 id，再按邻域取内容。

### 写：一个话题一个任务

```bash
node <skill-dir>/scripts/cli.js upsert .workbuddy/memory api-retry \
  --title "支付接口重试策略" --status doing --progress 40% \
  --summary "已定指数退避，待补熔断" --tags backend,reliability
```

省略的字段**保留原值**，所以更新一条不会清空其余。正文较长时，先用写入工具把正文写成文件，再 `--body-file <path>` 传进来（避免 shell 转义）。

新信息进来时优先**更新已有任务**，而不是新建一个概念重复的文件。只有在话题确实不同时才开新 id。

### 关联：三种边

```bash
node <skill-dir>/scripts/cli.js link .workbuddy/memory parent child child-a
node <skill-dir>/scripts/cli.js link .workbuddy/memory child-a depends api-key
node <skill-dir>/scripts/cli.js link .workbuddy/memory a relates b
```

- `child` —— 父任务拆解出的子任务
- `depends` —— 前置依赖（`to` 先完成，`from` 才能动）
- `relates` —— 弱关联，只影响邻域召回，不参与拓扑

`child` 和 `depends` 必须是 DAG：成环的边会被拒绝，且**什么都不改**。

### 收尾：校验一致性

```bash
node <skill-dir>/scripts/cli.js check .workbuddy/memory   # ok，或者列出问题
node <skill-dir>/scripts/cli.js index .workbuddy/memory   # 重建索引（手改过任务文件后跑一次）
```

## 纪律

这几条是硬约束，不是风格建议——它们各自对应一类真实故障：

1. **只读邻域。** 做任务 A 时不要读任务 B 的文件。分层一旦破了，就退化成"一个巨大的 MEMORY.md"。
2. **日期日志只追加。** `YYYY-MM-DD.md` 是流水账，改写它会丢失"当时是怎么想的"这一信息。
3. **读回来的东西不要写回记忆。** 回答一个查询是只读操作。把刚检索到的内容当成"新知识"再存一遍，是记忆库自我膨胀的主要来源。
4. **删除必须有明确意图。** `forget` 是唯一破坏性命令，只在用户明确要求、或条目被证明是错的时使用；不要拿它"整理"。
5. **写完要有回执。** 没有命令返回成功、没有文件真的落盘，就不能声称"已经记住了"。
6. **容量靠拆分，不靠搬运。** `check` 提示某任务正文超限时，正确动作是拆成子任务并用 `child` 关联，而不是把内容挪到别处。

## 探索性工作：先探测有没有子代理

探索会产生大量繁重上下文，而轨迹**从不"宣布结束"**，于是被反复复用。处理它先分叉：

```bash
node <skill-dir>/tools/agents-probe.mjs    # 第一行 OK agents=yes|no，最后一行 MODE
```

- `MODE delegate`（有子代理）→ 把探索**委派**出去，只让**结论**回主流程；brief 必须自包含，禁止回贴原文。
- `MODE self-compress`（没有）→ 探索**完成时只留结果与关键节点**，不留过程（执行的代码、长串输出）；先 grep 定位再带 limit 读，结论写进记忆后不再引用原文。

细节见 `references/capability-gate.md`。

## 命令速查

| 命令 | 作用 |
|---|---|
| `index <dir>` | 重建 `MEMORY.md` |
| `check <dir>` | 校验索引与任务文件是否一致（有问题退出码 1） |
| `show <dir> [taskId]` | 打印索引；给 id 时附带该任务正文 |
| `context <dir> <taskId> [depth]` | 只打印该任务及其邻域 |
| `upsert <dir> <taskId> [选项]` | 新建/更新任务文件 |
| `link <dir> <from> <kind> <to>` | 建关系 |
| `forget <dir> <taskId>` | 删除任务文件（破坏性） |

完整参数、输出示例与故障处理见 `references/cli.md`；文件格式细节见 `references/memory-format.md`。

## 资源

- `references/memory-format.md` —— 任务文件与索引的精确格式（字段、模板、id 规则）
- `references/cli.md` —— 全部命令的参数、输出与排错
- `references/capability-gate.md` —— 能力门：探测有没有子代理，以及两条探索路线的纪律
- `scripts/cli.js` —— 执行层。零运行时依赖，需要 Node 22+；由 LongMemoryPlugin 仓库编译同步而来，**不要直接改这个产物**
- `tools/agents-probe.mjs` —— 零依赖探测脚本，判定当前框架有无子代理（`--json` / `--require`）
