// 任务归纳表：文本 → 任务桶（多路 top-k，话题漂移自动建新桶）
// 设计动机：单点直查"最像的一个桶"误判即漏召，因此对外暴露 top-k 候选；
// 桶的质心用滑动平均维护（存未归一化和，质心 = normalize(sum)）。
import { cosine } from './embedder.ts';
import type { Embedder } from './embedder.ts';

export interface Bucket {
  id: string;
  sum: Float32Array; // 质心的未归一化和
  count: number;
  createdAt: number;
}

export interface InductionCandidate {
  bucketId: string;
  score: number;
}

export interface InductionResult {
  /** 最相似桶（低于阈值时为新建桶） */
  bucketId: string;
  score: number;
  /** top-k 多路候选（按分数降序） */
  candidates: InductionCandidate[];
  /** 本次是否因话题漂移新建了桶 */
  created: boolean;
}

export interface InductionOptions {
  /** 最高相似度低于此分数视为新话题，新建桶 */
  newBucketThreshold?: number;
  /** 多路召回的桶数量 */
  topK?: number;
  /** 测试可注入的时钟 */
  clock?: () => number;
}

export class TaskInductionTable {
  private buckets = new Map<string, Bucket>();
  private seq = 0;
  private embedder: Embedder;
  private newBucketThreshold: number;
  private topK: number;
  private clock: () => number;

  constructor(embedder: Embedder, opts: InductionOptions = {}) {
    this.embedder = embedder;
    this.newBucketThreshold = opts.newBucketThreshold ?? 0.35;
    this.topK = opts.topK ?? 3;
    this.clock = opts.clock ?? (() => Date.now());
  }

  get size(): number {
    return this.buckets.size;
  }

  listBuckets(): Array<{ id: string; count: number }> {
    return [...this.buckets.values()].map((b) => ({ id: b.id, count: b.count }));
  }

  /** 桶质心（L2 归一化） */
  centroid(bucketId: string): Float32Array | undefined {
    const b = this.buckets.get(bucketId);
    if (!b) return undefined;
    const c = new Float32Array(b.sum.length);
    let s = 0;
    for (let i = 0; i < c.length; i++) s += b.sum[i] * b.sum[i];
    const n = Math.sqrt(s) || 1;
    for (let i = 0; i < c.length; i++) c[i] = b.sum[i] / n;
    return c;
  }

  /**
   * 归纳当前文本：
   * 1. 与所有桶质心算余弦相似度，取 top-k；
   * 2. 最高分低于阈值 → 新建任务桶（话题漂移）；
   * 3. 否则把文本并入最相似桶（滑动平均更新质心）。
   */
  induce(text: string): InductionResult {
    const v = this.embedder.embed(text);
    const scored: InductionCandidate[] = [];
    for (const b of this.buckets.values()) {
      scored.push({ bucketId: b.id, score: cosine(v, this.centroid(b.id)!) });
    }
    scored.sort((a, b) => b.score - a.score);
    const topK = scored.slice(0, this.topK);
    const best = topK[0];

    if (!best || best.score < this.newBucketThreshold) {
      this.seq += 1;
      const id = `task-${this.seq.toString(36)}`;
      const sum = new Float32Array(v.length);
      sum.set(v);
      this.buckets.set(id, { id, sum, count: 1, createdAt: this.clock() });
      return { bucketId: id, score: 1, candidates: [{ bucketId: id, score: 1 }], created: true };
    }

    // 滑动平均：sum += v, count += 1（质心 = normalize(sum)）
    const b = this.buckets.get(best.bucketId)!;
    for (let i = 0; i < b.sum.length; i++) b.sum[i] += v[i];
    b.count += 1;
    return { bucketId: best.bucketId, score: best.score, candidates: topK, created: false };
  }
}
