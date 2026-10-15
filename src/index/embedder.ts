// 零依赖的 hashed n-gram embedding。
// 目的：让核心逻辑在没有外部模型/网络的环境里可运行、可测试。
// 生产环境请实现同一接口替换为 bge-m3 / OpenAI / 本地 encoder 等语义 embedding。
import { fnv1a } from './hashring.ts';

export interface Embedder {
  embed(text: string): Float32Array;
  readonly dim: number;
}

export class HashedNgramEmbedder implements Embedder {
  readonly dim: number;

  constructor(dim = 384) {
    if (dim < 8) throw new Error('dim too small');
    this.dim = dim;
  }

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!norm) return v;
    const words = norm.split(' ').filter(Boolean);
    const feats: string[] = [];
    // 词级 unigram + bigram（捕捉词序）
    for (const w of words) feats.push(`w:${w}`);
    for (let i = 0; i + 1 < words.length; i++) feats.push(`b:${words[i]}_${words[i + 1]}`);
    // 字符级 3-gram（对中文/拼写变体鲁棒）
    for (let i = 0; i + 3 <= norm.length; i++) feats.push(`c:${norm.slice(i, i + 3)}`);
    for (const f of feats) v[fnv1a(f) % this.dim] += 1;
    // L2 归一化，使余弦相似度 = 点积
    let s = 0;
    for (let i = 0; i < this.dim; i++) s += v[i] * v[i];
    const n = Math.sqrt(s) || 1;
    for (let i = 0; i < this.dim; i++) v[i] /= n;
    return v;
  }
}

/** 余弦相似度（输入已 L2 归一化时退化为点积；此处仍做完整点积以兼容未归一化向量） */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
}
