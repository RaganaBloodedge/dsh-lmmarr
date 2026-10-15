// @deepseek-ai/* 的最小测试替身 —— 只在测试里通过 module.registerHooks 注入。
//
// 为什么需要它：src/index.ts 只依赖两个 dsh 包，而脱离 harness 仓库时这两个包不存在，
// 于是「插件能不能加载、工具能不能注册、execute 跑不跑得通」这件事就无法验证。
// 用替身把 dsh 的契约「形状」钉下来，插件级测试就能在任意机器上离线运行。
//
// ===== 边界（必须清楚，否则会把绿灯当保证）=====
//   ✅ 能证明：具名导出齐全、apply 会注册工具、execute 真能读写磁盘、
//             多次挂载之间互不污染、卸载能注销
//   ❌ 不能证明：官方运行时接受这些定义、官方 defineTool 的额外校验、
//             框架层的参数校验 / 权限 / 超时 / 取消
//   后一组只能靠真实 dsh 挂载（见 docs/design.md 的验证清单 / L2 层）来证明。
//
// 这里的校验规则对齐 src/dsh-shim.d.ts（我读 dsh 文档后写下的契约），
// 而不是官方源码；所以宁可稍严，不要过松 —— 过松的替身会放过真问题。

export interface ContentBlock {
  type: string;
  text?: string;
}

export interface ParamSpec {
  type: string;
  required?: boolean;
  description?: string;
  items?: ParamSpec;
}

/** 与 shim 里的 ToolRunContext 同构；execute 的第二参数 */
export interface ToolRunContext {
  signal: AbortSignal;
  agent: { id: string; ctx: unknown };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, ParamSpec>;
  output: {
    schema: Record<string, unknown>;
    render: (args: any, value: any) => ContentBlock[];
    presentationMeta?: (args: any, value: any) => unknown;
  };
  timeoutMs?: number;
  /** 纯函数，只依赖 args —— UI 用它渲染"进行中的调用" */
  presentCall?: (args: any) => unknown;
  execute: (args: any, exec: ToolRunContext) => unknown | Promise<unknown>;
}

// ---- schema 子集校验 ----
//
// 复刻真实 dsh-tools 的规则（见 dsh-tools/lib/index.js 的 runSchemaCompiler）：
//   · 支持的 keyword 只有 type / oneOf / properties / required / additionalProperties /
//     items / enum / const 外加注解类
//   · **每个 object 必须显式声明 additionalProperties: true|false**
//     —— 这条最容易漏，而且是真实启动（L2）才抓到的，凭直觉写 schema 必踩
// 这里只回放已确证的规则，不猜测；宁可漏报也不误报（保守的替身好过假红灯）。

const ALLOWED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
]);
const ANNOTATION_KEYWORDS = new Set(['title', 'description', 'examples', 'default', 'deprecated', '$comment']);

export function assertJsonSchemaSubset(node: unknown, path: string): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError(`${path} must be a schema object`);
  }
  const n = node as Record<string, unknown>;

  for (const key of Object.keys(n)) {
    if (!ALLOWED_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      throw new TypeError(`${path}.${key} is not a supported keyword`);
    }
  }
  if (n.type === 'object' && typeof n.additionalProperties !== 'boolean') {
    throw new TypeError(`${path}.additionalProperties must be explicitly true or false`);
  }
  if (n.additionalProperties !== undefined && n.type !== 'object') {
    throw new TypeError(`${path}.additionalProperties is only allowed on type: "object"`);
  }
  if (n.properties !== undefined) {
    if (n.type !== 'object') throw new TypeError(`${path}.properties is only allowed on type: "object"`);
    for (const [k, v] of Object.entries(n.properties as Record<string, unknown>)) {
      assertJsonSchemaSubset(v, `${path}.properties.${k}`);
    }
  }
  if (n.items !== undefined) {
    if (n.type !== 'array') throw new TypeError(`${path}.items is only allowed on type: "array"`);
    assertJsonSchemaSubset(n.items, `${path}.items`);
  }
}

// ---- 值 ↔ schema 一致性校验 ----
//
// assertJsonSchemaSubset 只证明「schema 本身合法」，**不证明工具真的按它返回**。
// 这两件事的差距是 L3（真实模型调用）暴露的：lmmarr_upsert 的 tasks[] 里带着
// TaskNode 的 tags，而 schema 没声明它 —— 运行时以 additionalProperties:false
// 拒绝整个回执，工具报错。**但写盘已经生效了**：模型看到失败、磁盘上却已经改了。
// 这是最坏的一种失配，所以必须有一条测试覆盖「真实回执」而不是「schema 自身」。
//
// 只实现 dsh 支持的那个子集：type / oneOf / properties / required /
// additionalProperties / items / enum / const。

export function assertValueMatchesSchema(schema: unknown, value: unknown, path: string): void {
  const s = schema as Record<string, unknown>;

  if (Array.isArray(s.oneOf)) {
    const failures: string[] = [];
    for (const branch of s.oneOf) {
      try {
        assertValueMatchesSchema(branch, value, path);
        return;
      } catch (e) {
        failures.push((e as Error).message);
      }
    }
    throw new TypeError(`${path}: 不满足 oneOf 的任何一支 —— ${failures.join(' | ')}`);
  }

  if (Array.isArray(s.enum) && !s.enum.includes(value as never)) {
    throw new TypeError(`${path}: ${JSON.stringify(value)} 不在 enum ${JSON.stringify(s.enum)} 内`);
  }
  if (s.const !== undefined && value !== s.const) {
    throw new TypeError(`${path}: 期望 const ${JSON.stringify(s.const)}，实际 ${JSON.stringify(value)}`);
  }

  switch (s.type) {
    case undefined:
      return;
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${path}: 期望 object，实际 ${Array.isArray(value) ? 'array' : typeof value}`);
      }
      const v = value as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const declared = new Set(Object.keys(props));
      if (s.additionalProperties === false) {
        for (const key of Object.keys(v)) {
          if (!declared.has(key)) {
            throw new TypeError(`${path}.${key} is not a declared property (additionalProperties: false)`);
          }
        }
      }
      for (const key of (s.required ?? []) as string[]) {
        if (!Object.prototype.hasOwnProperty.call(v, key)) {
          throw new TypeError(`${path}.${key} is required but missing`);
        }
      }
      for (const [key, sub] of Object.entries(props)) {
        if (Object.prototype.hasOwnProperty.call(v, key)) {
          assertValueMatchesSchema(sub, v[key], `${path}.${key}`);
        }
      }
      if (typeof s.additionalProperties === 'object') {
        for (const [key, val] of Object.entries(v)) {
          if (!declared.has(key)) assertValueMatchesSchema(s.additionalProperties, val, `${path}.${key}`);
        }
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) throw new TypeError(`${path}: 期望 array，实际 ${typeof value}`);
      if (s.items !== undefined) {
        value.forEach((item, i) => assertValueMatchesSchema(s.items, item, `${path}[${i}]`));
      }
      return;
    }
    case 'string':
      if (typeof value !== 'string') throw new TypeError(`${path}: 期望 string，实际 ${typeof value}`);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${path}: 期望有限 number，实际 ${JSON.stringify(value)}`);
      }
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new TypeError(`${path}: 期望 integer，实际 ${JSON.stringify(value)}`);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') throw new TypeError(`${path}: 期望 boolean，实际 ${typeof value}`);
      return;
    case 'null':
      if (value !== null) throw new TypeError(`${path}: 期望 null`);
      return;
    default:
      return;
  }
}

/** defineTool 只负责构造并校验定义；注册始终走 ctx.tools.register() */
export function defineTool(definition: ToolDefinition): ToolDefinition {
  const named = definition as { name?: unknown };
  const at = `defineTool(${typeof named?.name === 'string' ? named.name : '?'})`;

  if (definition === null || typeof definition !== 'object') {
    throw new TypeError('defineTool: 定义必须是一个对象');
  }
  if (typeof definition.name !== 'string' || definition.name.trim() === '') {
    throw new TypeError('defineTool: name 必须是非空字符串');
  }
  if (typeof definition.description !== 'string' || definition.description.trim() === '') {
    throw new TypeError(`${at}: description 必填 —— 模型靠它决定要不要调用这个工具`);
  }
  if (typeof definition.execute !== 'function') {
    throw new TypeError(`${at}: execute 必填`);
  }
  if (definition.output === null || typeof definition.output !== 'object') {
    throw new TypeError(`${at}: output 必填`);
  }
  if (definition.output.schema === null || typeof definition.output.schema !== 'object') {
    throw new TypeError(`${at}: output.schema 必填`);
  }
  if (typeof definition.output.render !== 'function') {
    throw new TypeError(`${at}: output.render 必填 —— 否则模型只拿到结构化数据，看不到文本`);
  }
  assertJsonSchemaSubset(definition.output.schema, `${at}.output.schema`);
  for (const [key, spec] of Object.entries(definition.parameters ?? {})) {
    assertJsonSchemaSubset(spec as unknown, `${at}.parameters.${key}`);
  }
  if (definition.parameters !== undefined) {
    if (definition.parameters === null || typeof definition.parameters !== 'object' || Array.isArray(definition.parameters)) {
      throw new TypeError(`${at}: parameters 必须是对象`);
    }
  }
  return definition;
}

/** 一段注册进系统提示的文本（对应真实 dsh 的 PromptSection） */
export interface SectionSpec {
  name: string;
  order: number;
  text: string | (() => string);
}

/**
 * 假的 Cordis Context：实现插件真正用到的那几个面。
 * - tools.register 拒绝工具重名（与框架一致：重名会互相覆盖，是静默故障源）
 * - provide / inject 复刻 Cordis 的语义：inject 只在依赖就绪时跑回调
 * - systemPrompt.section 记录段落，并同样拒绝重名
 * - 所有注册都返回 disposer，dispose() 模拟插件卸载
 */
export class FakeCtx {
  readonly registered: ToolDefinition[] = [];
  /** provide 出去的服务 */
  readonly provided = new Map<string, unknown>();
  /** 已注册进系统提示的段落 */
  readonly sections: SectionSpec[] = [];
  /** 置 false 可模拟「没有提示服务的 profile」（如某些 headless） */
  hasSystemPrompt = true;

  private readonly disposers: Array<() => void> = [];

  get(name: string): unknown {
    if (name === 'systemPrompt') return this.hasSystemPrompt ? this.systemPrompt : undefined;
    if (name === 'tools') return this.tools;
    return this.provided.get(name);
  }

  provide(name: string, value: unknown): void {
    if (this.provided.has(name)) throw new Error(`服务重复 provide: ${name}`);
    this.provided.set(name, value);
  }

  readonly systemPrompt = {
    section: (spec: SectionSpec): (() => void) => {
      if (this.sections.some((s) => s.name === spec.name)) {
        throw new Error(`重复的 section 名: ${spec.name}`);
      }
      this.sections.push(spec);
      const disposer = () => {
        const i = this.sections.indexOf(spec);
        if (i >= 0) this.sections.splice(i, 1);
      };
      this.disposers.push(disposer);
      return disposer;
    },
  };

  /** 复刻 ctx.inject(deps, cb)：依赖缺失时**不跑**回调，也不报错 */
  inject(deps: string[], cb: (scoped: FakeCtx) => void): () => void {
    const missing = deps.filter((d) => this.get(d) === undefined);
    if (missing.length === 0) cb(this);
    return () => {};
  }

  readonly tools: { register: (tool: ToolDefinition) => () => void } = {
    register: (tool: ToolDefinition) => {
      if (this.registered.some((t) => t.name === tool.name)) {
        throw new Error(`重复注册的工具名: ${tool.name}`);
      }
      this.registered.push(tool);
      const disposer = () => {
        const i = this.registered.indexOf(tool);
        if (i >= 0) this.registered.splice(i, 1);
      };
      this.disposers.push(disposer);
      return disposer;
    },
  };

  /** 模拟 Cordis 卸载插件：撤销 apply 期间注册的一切 */
  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
  }
}
