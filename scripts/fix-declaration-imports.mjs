// 构建后处理：把 lib/**/*.d.ts 里的 `./x.ts` 归一成 `./x.js`。
//
// 为什么需要：tsconfig.build.json 开了 rewriteRelativeImportExtensions，
// 它会把**产物 JS** 里的 `./x.ts` 重写成 `./x.js`（已核对 lib/index.js），
// 但**声明文件里保留原样**（已核对 lib/index.d.ts）。
//
// 保留 `.ts` 在 nodenext 下其实仍能解析到 `x.d.ts`（已用一个干净消费者工程验证过），
// 所以这不是一个"跑不起来"的缺陷。但它是不规范的发布物：publint / attw 这类
// 严格工具会挑出来，别的打包器也未必买账。
// 归一成 `.js` 是声明文件里的惯用写法，两种解析路径都成立，没有坏处。
//
// dsh-mnemon 的构建同样带一个后处理脚本（scripts/link-bundle-declarations.mjs），
// 属于同类做法：构建产物在发布前的最后一道形状修正。

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LIB = new URL('../lib/', import.meta.url);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// 只改相对说明符：`from './x.ts'` / `from "../x.ts"`，不碰裸包名
const RELATIVE_TS = /(from\s+|import\s*\(\s*)(['"])(\.[^'"]*?)\.ts\2/g;

let changed = 0;
let files = 0;
for (const file of walk(LIB.pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(RELATIVE_TS, '$1$2$3.js$2');
  files++;
  if (after !== before) {
    writeFileSync(file, after, 'utf8');
    changed++;
  }
}

console.log(`declaration imports normalized: ${changed}/${files} file(s) rewritten`);
