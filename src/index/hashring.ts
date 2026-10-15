// 一致性哈希环 —— 检索层"O(1) 分块"的基础
// FNV-1a 32 位字符串哈希 + 虚拟节点打散；定位为二分查找（工程上按 O(1) 对待）。
// 增删存储节点只重映射 ~1/N 的键。

/** FNV-1a 32 位哈希，返回无符号整数 */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface RingEntry {
  hash: number;
  node: string;
}

export class HashRing {
  private ring: RingEntry[] = [];
  private sorted = true;
  private vnodes: number;

  constructor(vnodes = 128) {
    if (vnodes < 1) throw new Error('vnodes must be >= 1');
    this.vnodes = vnodes;
  }

  /** 加入一个存储节点（铺设 vnodes 个虚拟节点打散负载） */
  addNode(node: string): void {
    for (let i = 0; i < this.vnodes; i++) {
      this.ring.push({ hash: fnv1a(`${node}#vnode${i}`), node });
    }
    this.sorted = false;
  }

  removeNode(node: string): void {
    this.ring = this.ring.filter((e) => e.node !== node);
  }

  nodes(): string[] {
    return [...new Set(this.ring.map((e) => e.node))];
  }

  /** key → 节点。环为空时返回 undefined */
  get(key: string): string | undefined {
    if (this.ring.length === 0) return undefined;
    if (!this.sorted) {
      this.ring.sort((a, b) => a.hash - b.hash);
      this.sorted = true;
    }
    const h = fnv1a(key);
    // 二分查找第一个 hash >= h 的虚拟节点（环形回绕到头部）
    let lo = 0;
    let hi = this.ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    return this.ring[lo % this.ring.length].node;
  }
}
