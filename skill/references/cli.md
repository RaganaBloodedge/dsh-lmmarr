# cli.js 命令手册

执行层是 `scripts/cli.js`（Node 22+，零运行时依赖）。下面用 `$C` 代指它的路径：

```bash
C=<skill-dir>/scripts/cli.js
```

所有命令的第一个参数都是**记忆目录**（默认 `.workbuddy/memory`）。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 校验发现问题（`check`）；或 `show`/`context` 找不到该任务 |
| 2 | 用法错误、参数非法、id 不合法、关系成环被拒 |

## `index <dir>`

重建 `MEMORY.md`：从任务文件收集节点，从旧索引的 `edges` 块继承关系，整体重写索引。

```bash
node $C index .workbuddy/memory
# index written: .workbuddy/memory/MEMORY.md (3 tasks, 3 edges)
```

**顺序是有讲究的**：先采集问题、再重写。反过来的话，重写会把悬空边顺手自愈掉，问题就永远报不出来。输出里若出现 `problems:` 段，那是重写**之前**就存在的问题。

## `check <dir>`

不改任何文件，只报告一致性问题并给出退出码。

```bash
node $C check .workbuddy/memory
# ok        <- 健康时只输出一行
```

会报出的问题类型：重复的边、边指向缺失的任务文件、`child`/`depends` 成环、`progress` 越界、非法文件名、正文超过软上限。

## `show <dir> [taskId]`

打印索引全文；给了 `taskId` 再附上该任务正文。

```bash
node $C show .workbuddy/memory
node $C show .workbuddy/memory api-retry
```

用作"先看有哪些任务、再决定读哪个"的第一步。

## `context <dir> <taskId> [depth=1]`

按关系邻域只打印相关任务，**其余文件完全不碰**。`depth` 是跳数。

```bash
node $C context .workbuddy/memory api-retry    # 自己 + 1 跳邻居
node $C context .workbuddy/memory api-retry 2  # 再往外一层
```

这是这套记忆的核心操作：带着上下文开工前，先用它把相关部分取回来。

## `upsert <dir> <taskId> [选项]`

新建或更新一个任务文件。**省略的字段保留原值**，不会清空。

| 选项 | 说明 |
|---|---|
| `--title <s>` | 标题 |
| `--status <s>` | `todo` / `doing` / `blocked` / `done` |
| `--progress <p>` | `0.4`、`40`、`40%` 都接受；`>1` 视为百分数 |
| `--summary <s>` | 一句话状态（进索引表） |
| `--tags <a,b>` | 逗号分隔，写成 `[a, b]` |
| `--body-file <path>` | 正文从这个文件读 |

```bash
node $C upsert .workbuddy/memory api-retry --status blocked --summary "等网关团队确认幂等键"
# upsert: .workbuddy/memory/MEMORY_api-retry.md (updated)
```

正文较长时先把正文写好再 `--body-file`，比在命令行里塞长文本可靠。也可以直接用文件写入工具编辑 `MEMORY_<id>.md`——前提是 frontmatter 格式对（见 `memory-format.md`），改完跑一次 `index`。

## `link <dir> <from> <kind> <to>`

建一条关系并重建索引。`kind` ∈ `child` / `depends` / `relates`。

```bash
node $C link .workbuddy/memory lmmarr child lmmarr-publish
# link: lmmarr -child-> lmmarr-publish  (4 tasks, 4 edges)
```

- 两端任务必须都已存在，否则报错且不落盘。
- 自环（`from === to`）被拒。
- `child` / `depends` 会被检查是否成环；成环则**回滚、什么都不改**。
- 重复的边是幂等的，不会报错也不会重复写。

## `forget <dir> <taskId>`

删除任务文件，并丢弃所有提到它的边（下一步重建索引时自然收敛）。

```bash
node $C forget .workbuddy/memory scratch-note
# forget: scratch-note (removed)
#   dropped edge: scratch-note relates api-retry
```

唯一的破坏性命令。`dropped edge` 列出随任务一起失效的关系——重建索引时会自然收敛，不需要手工清边。

若删除**之前**索引本身就带着问题（例如手工删过文件却没重建索引），会多打一段 `repaired by this call`：那是本次调用顺手修好的，不是待办。`problems` 段才是仍需处理的。

## 常见故障

**`invalid task id`** —— id 含非法字符或 `..`。id 只允许字母数字开头、`[A-Za-z0-9._-]`。

**`link would create a cycle`** —— `child`/`depends` 会形成环。检查方向：`child` 是"父 → 子"，`depends` 是"依赖者 → 被依赖者"。若两条边只是概念相关，改用 `relates`。

**`check` 报"边指向缺失的任务文件"** —— 任务文件被删了但索引还留着边。跑一次 `index` 即可（会自动跳过端点不存在的边）。

**`index` 输出的 `problems` 和 `check` 不一致** —— `index` 报的是重写**之前**的状态。想看待办就单独跑 `check`。

**任务文件不存在，但 `context` 有输出** —— `context` 会打印邻域内**所有**存在的任务，不只是你点名的那一个。这是预期行为。
