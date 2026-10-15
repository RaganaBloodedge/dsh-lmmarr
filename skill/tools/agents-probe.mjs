#!/usr/bin/env node
// agents-probe —— 探测当前 Agent 框架是否支持子代理（subagent）。
//
// 用途：skill 的「能力门」。有子代理 → 把探索委派出去（隔离，只回结论）；
//       没有子代理 → 退化为「自压缩」纪律（只留结果与关键节点）。
//
// 零依赖，只用 node:fs / node:os / node:path。
// 输出遵循执行器协议：OK / KEY / MODE（成功恒为退出码 0；--require 时不可用则退出码 3）。
//
// 用法：
//   node agents-probe.mjs            # 文本
//   node agents-probe.mjs --json     # JSON，供程序消费
//   node agents-probe.mjs --require  # 无子代理时退出码 3，供 shell 分支
//   LMMARR_SUBAGENTS=yes|no          # 环境变量强制覆盖（测试用）

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = new Set(process.argv.slice(2));
const asJson = argv.has('--json');
const requireAvailable = argv.has('--require');
const HOME = homedir();

const result = {
  subagents: false,
  harness: 'generic',
  builtin: [],
  custom: [],
  evidence: '',
  mode: 'self-compress',
};

function dirExists(p) {
  try {
    return existsSync(p) && readdirSync(p) !== null;
  } catch {
    return false;
  }
}

function listDir(dir, keep) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(keep)
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// 在插件缓存里找 `.codebuddy-plugin/plugin.json`，收集 manifest 的 agents 字段。
// 深度限制在 4 层，避免在巨大的缓存目录里深挖。
function scanPluginAgents(root, depth = 4) {
  const found = [];
  if (!dirExists(root) || depth <= 0) return found;
  for (const name of listDir(root, (d) => d.isDirectory())) {
    const dir = join(root, name);
    const manifest = join(dir, '.codebuddy-plugin', 'plugin.json');
    if (existsSync(manifest)) {
      try {
        const json = JSON.parse(readFileSync(manifest, 'utf8'));
        if (Array.isArray(json.agents)) {
          for (const a of json.agents) found.push(String(a).split(/[\\/]/).pop().replace(/\.md$/, ''));
        }
      } catch {
        /* 坏 manifest 忽略，不影响整体判定 */
      }
      continue;
    }
    found.push(...scanPluginAgents(dir, depth - 1));
  }
  return found;
}

function uniqueSorted(arr) {
  return [...new Set(arr)].sort();
}

// ---- 探测顺序：环境变量覆盖 → WorkBuddy → Claude Code → 泛型 ----

const override = String(process.env.LMMARR_SUBAGENTS ?? '').toLowerCase();
const wbDir = join(HOME, '.workbuddy');
const ccDir = existsSync(join(process.cwd(), '.claude'))
  ? join(process.cwd(), '.claude')
  : existsSync(join(HOME, '.claude'))
    ? join(HOME, '.claude')
    : null;

if (override === 'yes' || override === 'no') {
  result.subagents = override === 'yes';
  result.harness = 'override';
  result.evidence = `env LMMARR_SUBAGENTS=${override}`;
  if (result.subagents) result.builtin = ['(assumed by override)'];
} else if (dirExists(wbDir)) {
  result.subagents = true;
  result.harness = 'workbuddy';
  result.builtin = ['Explore', 'Plan', 'general-purpose'];
  result.custom = uniqueSorted(scanPluginAgents(join(wbDir, 'plugins', 'cache')));
  result.evidence = '~/.workbuddy present (内置 Explore/Plan/general-purpose 恒可用)';
} else if (ccDir) {
  result.subagents = true;
  result.harness = 'claude-code';
  result.builtin = ['general-purpose', 'Explore', 'Plan'];
  result.custom = uniqueSorted(
    listDir(join(ccDir, 'agents'), (d) => d.isFile() && d.name.endsWith('.md')).map((n) => n.replace(/\.md$/, '')),
  );
  result.evidence = `${ccDir} present (内置子代理恒可用)`;
} else {
  result.harness = 'generic';
  result.evidence = '未发现子代理标记（WorkBuddy / Claude Code 均不存在）';
}

result.mode = result.subagents ? 'delegate' : 'self-compress';

// ---- 输出 ----

if (asJson) {
  process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + '\n');
} else {
  const lines = [`OK    agents=${result.subagents ? 'yes' : 'no'}`, `KEY   harness=${result.harness}`];
  if (result.builtin.length) lines.push(`KEY   builtin=${result.builtin.join(',')}`);
  if (result.custom.length) lines.push(`KEY   custom=${result.custom.join(',')}`);
  lines.push(`KEY   evidence=${result.evidence}`);
  lines.push(`MODE  ${result.mode}`);
  process.stdout.write(lines.join('\n') + '\n');
}

if (requireAvailable && !result.subagents) process.exit(3);
process.exit(0);
