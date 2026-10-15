// 把 lmmarr 记忆能力同步成一个 WorkBuddy skill。
//
//   src/memory/*.ts  --tsc-->  skill/scripts/*.js  --copy-->  <skill 目录>/scripts/*.js
//   skill/SKILL.md   -------------------------------------->  <skill 目录>/SKILL.md
//   skill/references/ ------------------------------------->  <skill 目录>/references/
//
// 为什么要编译而不是让 skill 直接引用本仓库：skill 必须自包含。
// 靠某个固定绝对路径活着，换个项目或换台机器立刻失效。
//
// 用法：node scripts/sync-skill.mjs [目标目录]
// 默认目标：~/.workbuddy/skills/lmmarr-memory

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'skill');
const OUT = join(SRC, 'scripts'); // tsc 的项目内输出目录
const TOOLS = join(SRC, 'tools'); // 手写的零依赖工具（不经 tsc）
const SKILL_NAME = 'lmmarr-memory';
const DEST = resolve(process.argv[2] ?? join(homedir(), '.workbuddy', 'skills', SKILL_NAME));

const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  console.error(`找不到 TypeScript：${tsc}\n先跑 npm install。`);
  process.exit(1);
}

// 1) 编译 src/memory -> skill/scripts（纯 JS，零运行时依赖）
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
execFileSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.skill.json')], { stdio: 'inherit' });

const built = readdirSync(OUT).filter((f) => f.endsWith('.js')).sort();
if (!built.includes('cli.js')) {
  console.error('编译产物里没有 cli.js —— 同步中止');
  process.exit(1);
}

// 2) 组装目标 skill 目录
mkdirSync(DEST, { recursive: true });
rmSync(join(DEST, 'scripts'), { recursive: true, force: true });
rmSync(join(DEST, 'references'), { recursive: true, force: true });
rmSync(join(DEST, 'tools'), { recursive: true, force: true });
cpSync(OUT, join(DEST, 'scripts'), { recursive: true });
cpSync(join(SRC, 'references'), join(DEST, 'references'), { recursive: true });
cpSync(join(SRC, 'SKILL.md'), join(DEST, 'SKILL.md'));
if (existsSync(TOOLS)) cpSync(TOOLS, join(DEST, 'tools'), { recursive: true });

// 3) 冒烟：坏掉的 skill 比没有更糟，所以产物必须真能跑起来。
//    不带参数时 cli.js 打印用法并以退出码 2 结束 —— 那正是预期行为。
const cli = join(DEST, 'scripts', 'cli.js');
try {
  execFileSync(process.execPath, [cli], { stdio: 'pipe' });
  console.error('冒烟失败：cli.js 无参数运行竟然成功退出（预期应为退出码 2）');
  process.exit(1);
} catch (err) {
  if (err.status !== 2) {
    console.error(`冒烟失败：cli.js 退出码 ${err.status}，预期 2`);
    console.error(String(err.stderr ?? err.message).trim());
    process.exit(1);
  }
}

// 4) 工具冒烟：agents-probe 必须真能判定（覆盖为 yes 时输出 MODE delegate）。
const probe = join(DEST, 'tools', 'agents-probe.mjs');
let probeNote = '（无 tools/，跳过）';
if (existsSync(probe)) {
  const out = execFileSync(process.execPath, [probe], {
    encoding: 'utf8',
    env: { ...process.env, LMMARR_SUBAGENTS: 'yes' },
  });
  if (!/^MODE\s+delegate$/m.test(out)) {
    console.error('工具冒烟失败：agents-probe 覆盖为 yes 时未输出 MODE delegate');
    process.exit(1);
  }
  probeNote = 'agents-probe 可判定（yes -> MODE delegate）';
}

console.log(`\n同步完成：${DEST}`);
console.log(`  SKILL.md       ${statSync(join(DEST, 'SKILL.md')).size} bytes`);
console.log(`  scripts/       ${built.join(', ')}`);
console.log(`  references/    ${readdirSync(join(DEST, 'references')).join(', ')}`);
if (existsSync(join(DEST, 'tools'))) {
  console.log(`  tools/         ${readdirSync(join(DEST, 'tools')).join(', ')}`);
}
console.log('  smoke          cli.js 可执行（无参数 -> 用法 + 退出码 2）');
console.log(`  smoke          ${probeNote}`);
