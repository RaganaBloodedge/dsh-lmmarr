// 发布前的包名闸门。
//
// 为什么需要它：`dsh-lmmArr` 这种带大写的名字在本机 `npm pack` 能过，
// 但 registry 会拒绝作为**新包**发布（"name can no longer contain capital letters"）。
// 等到 `npm publish` 那一刻才失败就太晚了 —— 而且这个插件的安装名**就是**包名，
// 名字一改，用户的安装命令、cordis.patch.yml、文档全都要跟着改。
//
// 所以把它前置成一条可跑的检查：npm run verify:name

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const validate = require('validate-npm-package-name');

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const result = validate(pkg.name);

const problems = [...(result.errors ?? []), ...(result.warnings ?? [])];
const ok = result.validForNewPackages;

if (ok) {
  console.log(`package name ok: ${pkg.name}`);
  process.exit(0);
}

console.error(`package name cannot be published as a new package: ${pkg.name}`);
for (const p of problems) console.error(`  - ${p}`);
console.error('\nnpm 规则：新包名只能是小写字母、数字、"." 、"_" 、"-"（且不能以 . 或 _ 开头）。');
process.exit(1);
