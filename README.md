# dsh-lmmarr

DeepSeek Harness 的长期记忆插件。**lmmArr** = *long-memory, as a task graph*。

一句话定位：让「我在做什么、做到哪、和什么有关」**零成本常驻**，并且**按任务只读那一块记忆**。

## 它解决什么

上下文压缩会丢细节，RAG 只能"再找回来"，而每开一个新会话，模型都得重新被告知你是谁、在做什么。
本插件的做法不是压缩，而是**换一种组织方式**：

| 层 | 文件 | 谁在维护 | 成本 |
|---|---|---|---|
| 原始 | `YYYY-MM-DD.md` | 人手工写，append-only | 零（不进上下文） |
| 任务 | `MEMORY_<任务ID>.md` | 模型按需读写 | 只在召回该任务时进上下文 |
| 索引 | `MEMORY.md` | 工具自动重写 | **常驻**（投影进系统提示，确定性、有预算） |

关键在最后一行：索引被**逐字**放进了稳定前缀，所以它是"免费"的 —— 引擎的前缀缓存第一次算完就留住了。
索引里**不含时间戳**，同一份记忆投影出的文本逐字相同；这是缓能否命中的充要条件，也是本仓 `docs/design.md` 里那条论证的落地。

## 安装

从源码直接挂载（免构建，当前可用）：

```bash
dsh web --patch ./cordis.yml
```

从 npm 安装（包尚未发布，发布后可用）：

```bash
dsh plugin --profile web add dsh-lmmarr
```

自检（改配置后务必看一眼，dsh 对配置错误是**静默忽略**而不是报错）：

```bash
dsh --profile web --dump-config | grep -A8 "id: lmmarr"
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `dir` | `<cwd>/.dsh-memory` | 记忆目录 |
| `depth` | `1` | `lmmarr_context` 的默认邻域跳数 |
| `writeEnabled` | `true` | 设 `false` 整插件只读；写工具会**明确拒绝并说明原因**，而不是静默无效 |
| `guidance` | `true` | 是否注入记忆协议到系统提示 |
| `hotMemory` | `true` | 是否把索引投影进上下文 |
| `maxProjectionCharacters` | `2000` | 投影的字符预算；超出先丢关系、再裁任务，且**显式说明截断** |
| `bodySoftLimit` | `16000` | 单个任务正文的软上限；超出只在索引里提示「该拆了」，不自动改写 |
| `timeoutMs` | `10000` | 工具执行超时 |

## 工具

| 工具 | 作用 |
|---|---|
| `lmmarr_index` | 读完整索引（任务表 + 关系图 + 一致性问题）。索引已在上下文里，**只在需要全表或要报告问题时调用** |
| `lmmarr_context` | 读一个任务 + 其直接邻域，**其余文件一个不碰**。这是读记忆的正道 |
| `lmmarr_upsert` | 建/改一个任务记忆文件。同 id 复用即更新，**未传的字段一律保留** |
| `lmmarr_link` | 声明 `child`（拆解）/ `depends`（前置）/ `relates`（弱关联）；`child`/`depends` 必须无环，成环的边会被拒绝且**什么都不改** |
| `lmmarr_forget` | 删一个任务文件并带走它的关系。破坏性操作，只在用户明确要求或条目确实错了时用 |

## 架构

```
src/
  index.ts       插件入口：只做「按 dsh 规范挂载」这一件事
  guidance.ts    记忆协议 → systemPrompt.section（告诉模型何时该用、何时绝不该写）
  project.ts     热记忆投影 → systemPrompt.section（确定性、有预算、无时间戳）
  service.ts     Cordis 服务 lmmarrMemory（工具只是它的一层视图）
  memory/        记忆内核：graph（图谱）/ store（存储）/ nodefs / cli
  index/         未接入的检索路线探索（embedding / 一致性哈希 / 任务归纳），论证见 docs/design.md
```

三条设计约束，都写进了测试：

1. **内核对外零依赖**。`graph.ts` / `store.ts` 只认一个 `FsPort` 接口，所以能完全离线单测。
2. **写路径唯一**。「采集问题 → 重写索引 → 返回快照」收敛在 `service.refresh()` 一处。顺序不可换：重写索引会把悬空边自愈掉，先写再查就永远报不出问题。
3. **引导与工具分离**。工具的 `description` 只说"能做什么"；"什么时候用、什么时候绝不该写回"必须常驻系统提示，模型才会形成纪律。

## 开发

```bash
npm run verify      # 类型检查 + 全部测试 + 构建
npm test            # 只跑测试（node --test，无需构建）
npm run build       # tsc → lib/
npm pack            # prepack 会自动构建；产物只含 lib/ + cordis.patch.yml + 文档
npm run verify:name # 发布前包名闸门
npm run verify:mount # 挂载探针：真实 boot 一次，确认 5 个工具与两段引导真进了模型可见面（不花模型调用）
```

发布流程与坑清单见仓库内的 `docs/publishing.md`（维护者文档，不随 npm 包发布）。

## 同一套记忆，装成 Agent skill

`skill/` 是同一份记忆内核的 skill 形态（`SKILL.md` + `references/` + 零依赖脚本），供按 skill 机制加载的宿主使用。它与 dsh 插件**同源**——都编译自 `src/memory/`，不会分裂成两份实现：

```bash
npm run sync:skill   # src/memory → skill/scripts，并安装到 ~/.workbuddy/skills/lmmarr-memory
```

`skill/tools/agents-probe.mjs` 是一个零依赖的**能力门**：探测当前框架有没有子代理，输出 `MODE delegate|self-compress`，给「探索性工作该委派出去、还是只留结论」这条纪律分叉用。

## 与 dsh-mnemon 的关系

本插件的架构骨架（引导层、视图/注意力分离、服务化、打包与发布形态）参考了 [`dsh-mnemon`](https://github.com/omdsh-dev/dsh-mnemon)。
刻意的取舍：

**借鉴**：系统提示里常驻的记忆协议；把能力 `provide` 成服务、工具只做视图；`params` 走 JSON Schema 子集（每个 `object` 必须显式 `additionalProperties`）；发布形态（`lib/` 构建产物 + `dsh.bundle.patch` + `exports`/`files` 白名单）。

**不跟**：多 provider 后端（9 个外部记忆服务）、React 客户端 UI、Git 同步与 GitHub 登录、子代理协调器、`view_route`/`view_action` 的双层间接寻址。这些在 mnemon 的规模下是必要的，在我们这里主要变成维护面。

## License

MIT
