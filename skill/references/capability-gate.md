# 能力门：先探测有没有子代理，再决定探索怎么做

`tools/agents-probe.mjs` 回答一个二选一：**当前 Agent 框架有没有子代理（subagent）？**
它是"探索性工作怎么办"这条纪律的入口——因为**两条路线的做法完全不同**。

## 为什么要探测

探索会产生大量繁重上下文，而它**从不"宣布结束"**，于是轨迹一直被复用。
处理它只有两条路线，取决于框架能力：

| 判定 | 路线 | 做法 |
|---|---|---|
| **有子代理** | `delegate` | 把探索**委派**给子代理：它在自己的上下文窗口里跑，**只有最终结论回主流程**，过程物理上进不来 |
| **没有子代理** | `self-compress` | 退化：探索**完成时只保留结果与关键节点**，过程信息（执行的代码、长串输出）不要留 |

## 用法

```bash
node <skill-dir>/tools/agents-probe.mjs            # 文本，第一行就是结论
node <skill-dir>/tools/agents-probe.mjs --json     # JSON，供程序消费
node <skill-dir>/tools/agents-probe.mjs --require  # 无子代理时退出码 3（供 shell 分支）
```

输出遵循执行器协议：

```
OK    agents=yes
KEY   harness=workbuddy
KEY   builtin=Explore,Plan,general-purpose
KEY   custom=doc-writer,doc-formatter
KEY   evidence=~/.workbuddy present ...
MODE  delegate
```

`MODE` 就是行动指令：`delegate` 或 `self-compress`。**退出码恒为 0**（探测成功≠有子代理）；要 shell 分支就加 `--require`。

## 判定顺序

1. `LMMARR_SUBAGENTS=yes|no` 环境变量强制覆盖（测试与强制用）；
2. `~/.workbuddy` 存在 → `yes`（内置 Explore / Plan / general-purpose **恒可用**）；
3. `.claude/` 或 `~/.claude/` 存在 → `yes`（Claude Code 同样自带子代理）；
4. 都不是 → `no`（保守：当作没有，走 self-compress）。

除内置子代理外，还会扫描已安装的**自定义**子代理（WorkBuddy 读插件 manifest 的 `agents` 字段；Claude Code 读 `.claude/agents/*.md`）。有自定义子代理时优先用它们——它们可以被钉死"只回结论"。

## 两条路线各自的纪律

### delegate（有子代理）

- **探索前先写下这次要回答的问题**（一句话）。问题答完 = 该委派结束的点。
- **brief 必须自包含**（子代理看不到主流程历史）：目标 / 已知关键事实 / 产出格式 / 禁区（不要回贴原文）。
- **返回契约**：只用结论 + 指针回主流程，**不要把原文和中间过程带回来**。默认子代理只回最终消息，但要在 prompt 里钉死。
- 注意成本：子代理**首请求不吃父级 cache**，且有固定开销。所以**单个子代理远比并发一群便宜**，别做 fan-out。

### self-compress（没有子代理）

**做不到**"让已经进窗口的旧观测消失"——模型不能改写自己的历史。
所以能做的只有两件半，全部落在**入口**与**退休标记**上：

1. **不让过程进来**：能把探索写成脚本的就写成脚本（命令一行、输出只留结论）；必须交互读的，先 grep 定位再带 limit 读。
2. **答完即登记**：探索的结论写进记忆（`did` / `pit` / `open` / `next`）+ 指针，**此后不再引用原文**。
3. （半件）**标记退休点**：明确写下"这个问题已经答完了"，避免继续在同一个探索上来回翻。

## 边界（必须说清）

- **在 WorkBuddy / Claude Code 里，这个探测几乎总是 `yes`** —— 内置子代理一直都在。`no` 分支是为**可移植性**准备的（裸 API 循环、极简 CLI）。
- 探测**只读**，不改任何配置；失败也不抛异常，最差返回 `no`（保守）。
- 它**不判断具体该委派哪部分探索** —— 那是模型的事。它只回答"允许不允许委派"这个前提。
