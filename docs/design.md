# dsh-kv-memory 设计文档

## 用分层 KV 存储实现 Agent 的"准永恒记忆"

> 版本：v0.1（2026-10-14）｜目标平台：DeepSeek Harness（CLI: `dsh`，Cordis 插件架构）
> 关联代码：`../src/`（核心逻辑零依赖，`node --test tests/` 可直接运行）

---

## 0. TL;DR —— 先给结论

原始设想（**哈希 O(1) 分块 + 任务归纳表 + KV 直存直取，800MB 记住 2 亿 token**）大方向是对的：**用存储空间换记忆容量**这个交易在 NVMe 时代完全成立。但有三处硬伤必须先修正，否则做不出来：

| # | 原始设想 | 判断 | 修正 |
|---|---------|------|------|
| 1 | 按任务哈希找到存储空间，**直接调用里面的 KV 值** | ❌ 不成立。KV cache 不是"内容的函数"，是 **(内容, 位置, 模型)** 的函数。RoPE 把位置烧进了 K 向量，把 A 任务的 KV 原样拼到 B 对话前，模型看到的是"位置错乱的历史" | 三条路选一条：**A 稳定前缀 + 引擎原生前缀缓存**（零损失，首选）；**B 重新预填充召回段**（保质量，花一次 prefill）；**C 位置重映射直接挂载**（研究级，需对拍实验） |
| 2 | 2 亿 token ≈ 800MB | ❌ 差约 **4 个数量级**。逐字 KV 即使用 2-bit 量化也要 **~1.4TB** 量级；800MB 对应的是"每 1000 token 一个 4KiB int8 潜向量"（1000:1 压缩），那是 ICAE 式研究路线，有质量损失 | 分层量化：近期 int8、中期 int4、远期 int2/潜向量。**"牺牲存储"的思路成立，但别指望 MB 级**，按 TB 级设计 |
| 3 | 任务归纳表判断属于哪个向量，哈希表 O(1) 找到对应空间 | ⚠️ 半成立。O(1) 定位没问题，但**单点直查误判即漏召**；且"同一任务、不同对话"的 KV 内容并不相同 | 改成 **多路召回**（top-k 桶 + 文本通道兜底）+ **三段打分**（recency/importance/relevance）+ 容量预算裁剪 |

修正后的架构一句话：

> **检索层**（任务归纳表 + 一致性哈希环 + 三段打分，管"想得起"）× **存储层**（L0 内存 / L1 NVMe / L2 压缩归档 + KV 分级量化，管"记得下"）× **注入层**（稳定前缀 / 文本注入 / 实验性位置重映射，管"用得上"）。

一个更诚实的"永恒记忆"定义：**写侧无限**（落盘便宜），**读侧选择性**（注意力预算有限，召回必须打分裁剪），**漏召有兜底**（文本级 RAG 通道补刀）。

---

## 1. 原始方案复盘：哪些能留，哪些要改

```
原始设想                              保留?   说明
─────────────────────────────────────────────────────────────────────────
分级存储                             ✅      L0/L1/L2 三级是存储层的骨架，保留
哈希 O(1) 分块                       ✅      一致性哈希环，保留（见 §5.1）
每个哈希空间存一个向量               ✅      升级为"任务簇质心 + 段清单"（见 §5.2）
任务归纳表：判断当前对话属于哪个向量  ⚠️      保留思想，改为多路 top-k + 兜底（见 §5.2）
KV 值存进对应空间，下次直接调用        ❌      位置依赖问题，改为三条注入路线（见 §4）
2 亿 token ≈ 800MB                   ❌      量级差 4 个数量级，重算（见 §3）
"永远记住事情"                       ⚠️      写侧无限 + 读侧选择性 + 遗忘曲线（见 §5.4）
```

---

## 2. 硬问题一：KV cache 的位置依赖性（为什么不能"直取"）

### 2.1 机理

Transformer 的 attention score 是 $s_{ij} = q_i^\top R(i-j)\, k_j$：

- **RoPE** 把绝对/相对位置 $i-j$ 以旋转角的形式烧进了 $k_j$。段在序列中的位置一变，同一个 $k_j$ 的含义就变了；
- **causal mask** 决定了段内每个 token 只能看到自己之前的 token——段边界变化时，"之前"的集合也变；
- 因此 **KV cache 是三元组 (token 序列, 位置区间, 模型权重) 的函数**。同一次对话里逐字相同的前缀可以复用；换了任务、换了位置，原样挂载就是给模型看一份"地址错乱的历史"。

### 2.2 工业界与学术界已有的答案

| 工作 | 做法 | 对本插件的意义 |
|------|------|---------------|
| vLLM Automatic Prefix Caching | 精确 token 前缀匹配，命中即复用 KV | Route A 的引擎侧机制，零质量损失 |
| SGLang RadixAttention | 基数树管理前缀缓存，跨请求共享 | 同上；树形结构比扁平哈希更适合多变体前缀 |
| RAGCache (2024) | 把检索文档的 KV 按 token 前缀树缓存，RAG 请求间共享 | **和本插件最像的 prior art**：证明"文档级 KV 复用"可行，但前提是前缀逐字一致 |
| Mooncake (Moonshot, 2024) | KVCache 为中心的分离式架构，GPU→CPU→SSD 分层 + prefix-aware 存储 | 存储层 L0/L1/L2 设计与淘汰策略的直接参照 |
| CacheGen / CacheBlend / Prompt Cache | KV 量化流式传输、同前缀不同后缀的 serving 优化 | 说明"跨请求 KV 搬运"工程上可行，但都要求前缀一致 |
| KIVI / SnapKV / PyramidKV / H2O | KV 量化与稀疏淘汰 | 存储层量化档位（int8/int4/int2）的依据 |
| ICAE / AutoCompressor | 用软向量（潜空间记忆 token）压缩长上下文 | Route C 的唯一路径，需训练/校准，有质量损失 |
| MemGPT / Letta | 操作系统式虚拟内存分页 + 遗忘曲线 | 检索层淘汰策略与"主存/外存"思想来源 |
| Generative Agents (2023) | 记忆流打分 = α·recency + β·importance + γ·relevance | §5.3 三段打分的原型 |

**结论**：KV 可以存、可以搬，但"取出来直接用"只有三条路（§4）。社区已有的 `dsh-infinite-context` 插件走的是纯文本摘要金字塔，恰恰绕开了 KV；本插件的差异化就在于**把 KV 级逐字记忆做进存储层，同时用前缀工程把引擎原生缓存利用到极致**。

---

## 3. 硬问题二：存储量级重算（800MB 差在哪）

### 3.1 公式

$$\text{bytes/token} = 2 \times L \times H_{kv} \times d_{head} \times B$$

（2 = K 和 V 两份；$B$ = 每元素字节数，bf16=2，int8=1，int4=0.5，int2=0.25）

### 3.2 量级表（2 亿 token）

| 模型（参考配置） | bf16 | int8 | int4 | int2 |
|---|---|---|---|---|
| R1-Distill-Qwen-7B（L=28, H_kv=4, d=128，56 KiB/token） | 11.5 TB | 5.7 TB | 2.9 TB | **1.4 TB** |
| DeepSeek-V2-Lite（MLA，latent 512+64，≈30 KiB/token） | 6.2 TB | 3.1 TB | 1.6 TB | **0.78 TB** |
| Qwen2.5-1.5B（L=28, H_kv=2, d=128，28 KiB/token） | 5.7 TB | 2.9 TB | 1.4 TB | **0.7 TB** |

（数值为量级估算，以 `src/store/kvcodec.ts` 的公式为准，可用 `estimateStoreBytes()` 复算）

### 3.3 那 800MB 对应什么？

800MB ÷ 2 亿 token = **4 字节/token**。相对 bf16 KV（56 KiB/token）是 **~14000:1** 的压缩率。唯一路径是潜空间记忆向量：

| 方案 | 每个向量覆盖 token 数 | 向量维度×精度 | 2 亿 token 占用 |
|---|---|---|---|
| ICAE 式潜向量 | 1000 | 4096 × int8（4 KiB） | **≈ 800 MB** ✅ 命中你的估算 |
| 同上，减半覆盖 | 500 | 4096 × int8 | ≈ 1.6 GB |
| 同上，加倍覆盖 | 2000 | 4096 × int8 | ≈ 400 MB |

**判断**：你的 800MB 数字隐含假设了"每 1000 token 压成一个 4KiB 向量"——这正是 ICAE/AutoCompressor 式压缩，属于**路线 C（研究级，有质量损失，需对拍实验，opt-in）**。逐字 KV 路线按 **TB 级**设计——好消息是 4TB NVMe 现在几百块钱，"牺牲存储"的交易依然划算。

> 设计决策：**存储预算按 int2 全量 ~1TB 规划，默认混合策略（近 int8 / 远 int2），潜向量作为远期归档的可选层。**

---

## 4. 注入层：三条路线（工程风险递增）

### Route A —— 稳定前缀 + 引擎原生前缀缓存【首选，零质量损失】

**核心洞察：插件根本不用自己碰 KV。**

vLLM（Automatic Prefix Caching）、SGLang（RadixAttention）、TensorRT-LLM 等引擎已经内置了 token 级前缀缓存。插件要做的只有一件事：**让 prompt 的前缀稳定，并且让召回的记忆落在前缀里**。

```
┌───────────────────────── 稳定前缀（可被引擎缓存）─────────────────────────┐
│ system prompt（不变） → 记忆段（按 taskId/segId 字典序稳定排列）            │
└──────────────────────────────────────────────────────────────────────────┘
┌────── 可变尾部（每轮不同）──────┐
│ 当前对话消息                      │
└─────────────────────────────────┘
```

- 记忆段的**选择**按打分（相关才注入），**排序**按稳定 ID（不按分数——分数漂移会改前缀哈希，缓存全失效）；
- 追加新记忆只改变选择集合，不改动既有前缀块的相对顺序 → 前缀缓存尽可能命中；
- dsh 支持的推理后端（vLLM / SGLang / TensorRT-LLM / llama.cpp）天然适配；调 DeepSeek API 时此路线自动退化为纯文本注入（依然有效，只是省的是 token 而非 prefill 算力）。

工程细节见 `src/recall/prefix.ts` + `tests/prefix.test.ts`（追加不变性有测试保证）。

### Route B —— 插件管理的 KV 分段存取【主体，中等风险】

插件把会话切成段，每段存 `(tokens, KV, 摘要向量, 元数据)`：

- **写入**：轮次结束 → 切段 → KV 经引擎导出接口落 L1（NVMe）；
- **召回**：命中段若与当前前缀**逐字连续**（如同一会话恢复），直接挂载；否则 **re-prefill**：把召回段的 token 原文拼到 prompt 前部，让引擎重算 KV（一次 prefill，质量无损），算过的 KV 再由引擎缓存住，下次免费；
- **后台预热**：`memory_search` 工具被调用或归纳表预测到下个话题时，提前 re-prefill，把成本藏进空闲期。

前提：推理引擎开放 KV 导出/导入（vLLM 的 KV transfer connector、Mooncake Store 等）。调 API 的模型走不了这条路——所以 **tokens 原文必须永远存着**，它是任何路线的重建源。

### Route C —— 位置重映射 / 潜空间记忆向量【研究级，opt-in】

- **C1 位置重映射**：把旧段 KV 按新位置区间重新旋转 RoPE 后挂载。数学上近似，实际有损，需要系统对拍（同 prompt 下"原样 prefill vs 重映射挂载"的输出相似度、下游任务分）。实现见 `src/recall/remap.ts`（预留接口 + 实验开关，默认关闭）；
- **C2 潜空间记忆向量**：ICAE 式，把长段压成少量软向量当"记忆 token"拼接。唯一能达到 800MB/2 亿 token 量级的路线，但需要训练/校准 encoder，质量掉多少必须实测。**默认关闭，作为远期归档层。**

**三线关系：A 是地基（现在就做），B 是主体（引擎 API 就绪后做），C 是远景（发实验）。**

---

## 5. 检索层：把"任务归纳表"升级成可靠索引

### 5.1 一致性哈希环（O(1) 分块）

- `HashRing`：FNV-1a + 虚拟节点（默认 128/节点），key → 节点 O(log n) 二分定位（工程上按 O(1) 对待）；
- 增删存储节点只重映射 ~1/N 的键（测试保证：`tests/hashring.test.ts`）；
- 作用：把段 ID 映射到存储分片，支撑 L1/L2 的水平扩展。

### 5.2 任务归纳表（向量 → 桶）

```
当前对话文本 ──embed──▶ 查询向量 q
                          │
              余弦相似度  ▼
            ┌─── 任务桶 A (质心 c_A)  score 0.71 ──▶ 段清单 [seg1, seg5, seg9]
   top-k ──▶├─── 任务桶 B (质心 c_B)  score 0.58 ──▶ 段清单 [seg3]
            └─── 任务桶 C (质心 c_C)  score 0.12 ──▶ (低于阈值，丢弃)
                          │
              所有桶最高分 < 阈值？ ──▶ 新建任务桶（话题漂移）
```

- 桶 = 任务簇，质心 = 该类文本 embedding 的滑动平均；
- **多路召回**：取 top-k 桶（默认 k=3）而不是"最像的一个"——单点直查误判即漏召；
- **兜底通道**：若 top-1 分数低于阈值，回退到全量文本扫描（低频操作，防"新话题冷启动漏召"）；
- **归纳 ≠ KV 有效**：归纳只决定"去哪些桶里找段"，段能不能用由 §5.3 的打分和 Route A/B/C 的规则决定。

### 5.3 三段打分（Generative Agents 公式的工程化）

$$\text{score}(seg) = w_r \cdot 2^{-(t-t_{last})/T_{1/2}} \;+\; w_i \cdot \text{importance} \;+\; w_q \cdot \cos(emb_{seg}, q)$$

- **recency**：半衰期衰减（默认 24h）；
- **importance**：写入时由 LLM 判分（0~1，用户显式要求记住 = 1.0）；
- **relevance**：段摘要向量与查询向量的余弦相似度；
- 低于分数阈值或超出 token 预算的段丢弃，丢弃原因记录进 plan（可观测）。

### 5.4 遗忘曲线（"永远记住"的边界）

- 容量压力时的淘汰序：`score 低者先淘汰`，淘汰不是删除而是**降级**（L0→L1→L2→潜向量归档）；
- importance ≥ 0.9 的段（用户显式标记）永不淘汰出 L1；
- 与 MemGPT 的分页思想一致：外存无限，主存（注意力预算）有限。

---

## 6. 数据模型

```ts
Segment {                    // 一个记忆段 = 一段连续对话的完整存档
  id, sessionId, taskId,     // 归属
  tokenRange: [start, end],  // 在会话中的 token 区间（重建用）
  tokenCount,
  text,                      // 原文（所有路线的重建源，永远保存）
  summaryEmb,                // 摘要 embedding（检索用）
  kv?: KvRef,                // KV 引用（可选，取决于路线与引擎支持）
  createdAt, lastAccess, hitCount, importance,
  tier: 0 | 1 | 2            // 所在存储层
}

KvRef {
  engine, model,             // KV 与模型强绑定！换模型即失效，必须记录
  shape: { layers, kvHeads, headDim },
  dtype: 'bf16' | 'int8' | 'int4' | 'int2',
  bytes, path, tokenRange
}
```

**关键不变量**：`text` 永远存在；`kv` 是缓存，失效（换模型/换引擎）时从 `text` 重建。

---

## 7. 与 DeepSeek Harness 的集成点

基于 dsh 插件规范（TypeScript 模块 + `apply(ctx)` 挂载）：

| dsh 能力 | 用法 |
|---|---|
| `inject = ['tools', 'llm', 'sessions']` | 声明依赖的服务槽 |
| `ctx.llm` | 包装 LLM 调用：请求前召回注入（`onBeforeLlm`），请求后切段落库（`onAfterLlm`） |
| `ctx.tools.register(defineTool(...))` | 注册 `memory_search` / `memory_status` / `memory_forget` / `memory_consolidate` 四个工具 |
| `ctx.sessions` | 会话恢复时按 `sessionId` 拉取段清单，触发 Route B 的连续挂载 |
| 引擎配置 | 本地部署（vLLM/SGLang）时开启 Route A/B；DeepSeek API 时自动退化为文本注入 |
| PTC 模式 | dsh 的 Programmatic Tool Calling 省 token，与记忆注入正交，注入点在 LLM 调用层，天然兼容 |

本地开发用 `cordis.yml` overlay + `pnpm dsh web --patch ./cordis.yml`；发布按官方规范打包 npm 包、仓库打 `dsh-plugin` topic。

---

## 8. 与 dsh-infinite-context 的关系

社区插件 `dsh-infinite-context`（chocobo77，MIT）做的是：短/中/长三层**文本摘要金字塔** + SQLite + 语义检索去重。它是"归纳"路线（你提到的主流方案）。

**定位：互补，不替代。** 它管文本级压缩，本插件管 KV 级逐字记忆 + 前缀工程 + 分层存储。二者可并存：摘要管"快速回顾"，KV 段管"逐字精确召回"。若只选一个做 MVP，先把本插件的 Route A（前缀工程 + 任务索引 + 文本注入）做扎实——这部分不依赖引擎 KV 接口，全模型可用。

---

## 9. 实验计划与验收指标

| 实验 | 指标 | 通过标准 |
|---|---|---|
| E1 前缀命中率（Route A） | 引擎 prefix cache hit rate（同会话连续轮次） | > 80% |
| E2 注入稳定性 | 前缀哈希的追加不变性（`tests/prefix.test.ts`） | 100% |
| E3 召回精度 | top-5 召回段中"相关"的人工标注比例 | > 85% |
| E4 量化损失 | int8/int4/int2 KV 对拍输出的余弦相似度 | int8 > 0.99，int4 > 0.97，int2 > 0.93 |
| E5 位置重映射（C1） | 重映射挂载 vs 原样 prefill 的输出相似度 + 下游任务分 | 相似度 > 0.95 才默认开启 |
| E6 潜向量（C2） | 潜向量召回段 vs 原文段的 QA 对拍 | 掉分 < 5% 才作为归档层 |
| E7 端到端 | 长会话（>20 轮）任务连续性人工评分 | 不低于纯摘要方案 |

---

## 10. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| KV 与模型权重强绑定，换模型全失效 | 高 | `text` 永远存档；`KvRef` 记录 model/engine；失效自动重建 |
| KV dump 隐私（潜表示仍含逐字信息） | 高 | L2 静态加密；提供 redact 选项；本地存储不上云 |
| 召回 KV 仍消耗 attention 算力（O(n)） | 中 | 打分裁剪 + token 预算；后台预热摊薄 prefill |
| 归纳表误判导致漏召 | 中 | top-k 多路 + 文本兜底 + 漏召日志 |
| 陈旧记忆污染新任务 | 中 | importance 复核 + recency 衰减 + `memory_forget` 工具 |
| 引擎 KV 导出 API 不开放 | 中 | Route A/B 解耦；无 API 时自动降级为文本注入 |
| 潜向量路线质量不可控 | 高 | 默认关闭，E6 达标才启用 |

---

## 11. 代码地图（本仓库）

```
src/
  index.ts              插件入口（apply(ctx)，依赖 dsh 运行时）
  config.ts             配置解析与默认值（零依赖）
  index/
    hashring.ts         一致性哈希环（O(1) 定位）
    embedder.ts         hashed n-gram embedding（零依赖可测；生产可换 bge-m3/API）
    induction.ts        任务归纳表（向量→桶，top-k 多路，漂移建新桶）
  store/
    segment.ts          Segment / KvRef 数据模型
    kvcodec.ts          KV 量级公式 + int8 量化编解码（E4 的地基）
    tiers.ts            L0 内存 / L1 NVMe(JSONL) / L2 归档 + 淘汰降级
  recall/
    scorer.ts           三段打分（recency/importance/relevance）
    prefix.ts           稳定前缀布局（Route A，追加不变性）
    planner.ts          召回计划（多路召回+打分+预算裁剪，纯函数可测）
    remap.ts            C1 位置重映射（预留，默认关闭）
  bridge/llm.ts         ctx.llm 包装（召回注入 + 切段落库）
  tools/memory.ts       memory_* 工具注册
tests/                  六个测试文件，node --test 直接跑
```

**运行**：`node --test tests/*.test.ts`（Node ≥ 22.6，零依赖）。
