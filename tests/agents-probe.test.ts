// agents-probe 的契约测试：只锁定「判定结果 → MODE / 退出码」的映射，
// 不依赖宿主机到底装了什么（用 LMMARR_SUBAGENTS 覆盖）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = resolve(ROOT, 'skill/tools/agents-probe.mjs');

function run(env: Record<string, string>, args: string[] = []) {
  try {
    const out = execFileSync(process.execPath, [PROBE, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    return { out, code: 0 };
  } catch (err: any) {
    return { out: String(err.stdout ?? ''), code: err.status as number };
  }
}

test('覆盖为 yes：判定可用，MODE=delegate', () => {
  const { out, code } = run({ LMMARR_SUBAGENTS: 'yes' });
  assert.match(out, /^OK\s+agents=yes$/m);
  assert.match(out, /^MODE\s+delegate$/m);
  assert.equal(code, 0);
});

test('覆盖为 no：判定不可用，MODE=self-compress', () => {
  const { out, code } = run({ LMMARR_SUBAGENTS: 'no' });
  assert.match(out, /^OK\s+agents=no$/m);
  assert.match(out, /^MODE\s+self-compress$/m);
  assert.equal(code, 0);
});

test('--require 在不可用时退出码 3', () => {
  const { code } = run({ LMMARR_SUBAGENTS: 'no' }, ['--require']);
  assert.equal(code, 3);
});

test('--require 在可用时退出码 0', () => {
  const { code } = run({ LMMARR_SUBAGENTS: 'yes' }, ['--require']);
  assert.equal(code, 0);
});

test('--json 输出可被解析，字段与文本一致', () => {
  const { out } = run({ LMMARR_SUBAGENTS: 'yes' }, ['--json']);
  const json = JSON.parse(out);
  assert.equal(json.ok, true);
  assert.equal(json.subagents, true);
  assert.equal(json.mode, 'delegate');
});

test('输出第一行恒为 OK（执行器协议）', () => {
  const { out } = run({ LMMARR_SUBAGENTS: 'no' });
  assert.match(out.split('\n')[0], /^OK\s/);
});
