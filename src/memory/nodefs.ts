// FsPort 的 node:fs 实现。
// 只有 CLI（src/memory/cli.ts）与 dsh 插件入口（src/index.ts）会用到它；
// 核心逻辑（graph.ts / store.ts）保持零依赖、可单测。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FsPort } from './store.ts';

export class NodeFs implements FsPort {
  read(path: string): string | undefined {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  }

  write(path: string, content: string): void {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, content, 'utf8');
  }

  list(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  }

  /** 删单个文件；文件本就不存在时静默返回（删除幂等，重试不会失败） */
  remove(path: string): void {
    rmSync(path, { force: true });
  }
}
