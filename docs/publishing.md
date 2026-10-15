# 发布到 dsh，让别人用 `dsh plugin add dsh-lmmarr` 装上

本文记录**我们实际验证过**的发布链路，以及每一步踩到的坑。参考对象是 `dsh-mnemon` 的发布形态
（npm 包名 = dsh 安装名；`dsh.bundle.patch` 指向随包发布的挂载层）。

## 0. 一句话原理

`dsh plugin --profile <name> add <pkg>` 本质是往那个 profile 里 `pnpm add <pkg>`，
然后把包名登记进 profile 的 `dsh.profile.bundles`。dsh 启动时逐个读这些包的
`package.json` → 取 `dsh.bundle.patch` 指向的 YAML → 作为一层 patch 叠进配置树。

所以「让人能用 `dsh plugin add X` 装上」= **把包发到 npm，且它带一个合法的 `dsh.bundle.patch`**。

## 1. 包名：安装名就是包名

```
dsh plugin --profile web add dsh-lmmarr     # 这里的字符串 = npm 包名
```

**硬约束：npm 新包名不允许大写。** 原始诉求的 `dsh-lmmArr` 无法发布：

```
$ node -e "console.log(require('validate-npm-package-name')('dsh-lmmArr'))"
{ validForNewPackages: false, warnings: ['name can no longer contain capital letters'], … }
```

（本机 `npm pack` 能过、`npm publish --dry-run` 也不拦，所以这个错误只有真发布那一刻才暴露。）
最终采用 **`dsh-lmmarr`**；品牌显示名仍可写 lmmArr。

这道检查已固化成脚本，`npm run verify:name`，并挂在 `prepublishOnly` 上。

## 2. `package.json` 的必备字段

```json
{
  "name": "dsh-lmmarr",
  "type": "module",
  "main": "./lib/index.js",            // 必须是构建产物，不能指向 src/*.ts
  "types": "./lib/index.d.ts",
  "exports": {                          // 子路径要给 types + default 两个条件
    ".":         { "types": "./lib/index.d.ts",   "default": "./lib/index.js" },
    "./contracts": { "types": "./lib/service.d.ts", "default": "./lib/service.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md", "LICENSE"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },   // ← 关键字段
  "publishConfig": { "access": "public", "tag": "latest" },
  "engines": { "node": ">=22.6" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.4", "@deepseek-ai/dsh-tools": "0.2.0-rc.2" }
}
```

三个要点：

- **`files` 必须显式包含 `cordis.patch.yml`**。漏了它，包能装上但 dsh 找不到挂载层 —— 静默不生效。
- **peer 版本要钉到与目标 dsh 内嵌版本一致**。写 `"*"` 会装到 registry 上 `latest` tag 指错的旧版
  （本项目实测踩过：`*` 装到 `0.0.1-rc.1`，而本机 dsh 内嵌的是 `0.2.0-rc.2`）。
  查法：`node -e "console.log(require('<dsh>/node_modules/@deepseek-ai/dsh-tools/package.json').version)"`
- **`main` 指向 `lib/`**：`src/` 里的 `.ts` 不能直接发给别人。

## 3. `cordis.patch.yml` 的形状

```yaml
- insert:                 # 顶层必须是序列！写成裸 `insert:` 映射会被静默忽略
    - id: lmmarr          # 配置 id，与代码里无关，但必须稳定
      name: dsh-lmmarr    # 这里写**包名**，不能写路径（路径只在本机成立）
      config:
        writeEnabled: true
        hotMemory: true
        depth: 1
```

本地开发用的 `cordis.yml` 是同一形状，只是 `name` 指向源码的 `./src/index.ts`（免构建直接挂）。
路径按**本文件所在目录**解析，所以可以随仓库移动，不需要在任何机器上改成绝对路径。

## 4. 构建

```bash
npm run build     # tsc -p tsconfig.build.json && node scripts/fix-declaration-imports.mjs
```

- `tsconfig.build.json` 用 `rewriteRelativeImportExtensions: true`，
  把源码里的 `./x.ts` 在**产物 JS** 里改写成 `./x.js`（源码保持可直接被 Node 运行，便于零构建测试）。
- 该选项**不改写声明文件**，所以 `lib/**/*.d.ts` 里仍留着 `./x.ts`。
  这在 nodenext 下仍能解析（已用干净消费者工程验证），但不规范、会被 publint / attw 挑出来。
  `scripts/fix-declaration-imports.mjs` 做这最后一道归一化（dsh-mnemon 的构建里也有同类后处理脚本）。
- `prepack` 挂了 `build`，所以 `npm pack` / `npm publish` 一定带产物。

## 5. 发布前验证（不花一次模型调用）

```bash
npm run verify          # typecheck + 全部测试 + build
npm run verify:name     # 包名闸门
npm run verify:mount    # 挂载探针：真实 boot，读 ctx.tools.schemas() 与 systemPrompt.assemble()
npm pack                # 得到 dsh-lmmarr-<ver>.tgz
```

`verify:mount` 用 `--patch` 临时叠一层（`scripts/mount-probe/`），**不写进任何 profile**。
探针插件在两处服务就绪后打印结果并 `process.exit`，抢在 headless runner 之前退出，
所以它验的是"工具与引导真的进了模型可见面"，却一次模型调用都不花。
注意 patch 里的相对路径是**相对于 patch 文件自身**解析的，不是 cwd。

然后把它装进一个**独立的 DSH_HOME**（不要动 `~/.dsh`）：

```bash
export DSH_HOME=/tmp/lmmarr-test/home
dsh lmmarrtest --from-default-profile web --dump-config   # 造一个一次性 profile
dsh plugin --profile lmmarrtest add ./dsh-lmmarr-0.2.0.tgz
dsh --profile lmmarrtest --dump-config | grep -A8 "id: lmmarr"   # 应出现 "# == dsh-lmmarr" 层
dsh --profile lmmarrtest --no-open --port 0                      # 真实启动：应零 warning
```

**本机没有 pnpm 时** `dsh plugin add` 会失败。可以手工模拟它的落地效果：

```
<profile>/node_modules/dsh-lmmarr/          ← 解包 tarball 到这里
<profile>/node_modules/@deepseek-ai/         ← 联结到 dsh 内嵌的那份（否则插件解析不到 peer）
<profile>/package.json  →  dsh.profile.bundles 里加上 "dsh-lmmarr"
```

### 想证明「工具与引导真的进了模型侧」，用探针插件

不需要花模型的额度：写一个只依赖 `ctx` 的探针插件，通过 `--patch` 挂上，
在 `ctx.tools.schemas()` 里读已注册工具、在 `ctx.systemPrompt.assemble()` 里读最终系统提示，
落盘即可。本项目实测输出：

```json
{
  "lmmarrTools": ["lmmarr_context","lmmarr_forget","lmmarr_index","lmmarr_link","lmmarr_upsert"],
  "sectionNames": ["harness:identity","deployment:persona-prefix","mcp-resource-servers",
                   "lmmarr:protocol","lmmarr:index","ui:deliverable-file-references", …],
  "protocolChars": 1488,
  "indexText": "LMMARR MEMORY — 3 task(s), 3 relation(s) …"
}
```

这同时证明了四件事：插件激活、五个工具注册成功（即所有 `output.schema` 都过了
dsh 的 JSON Schema 子集校验）、两段引导进入最终提示且落在预期位置、热记忆投影确实带着真实记忆内容。

## 6. 正式发布

```bash
npm login                      # 或 CI 里用 NPM_TOKEN
npm version patch|minor|major  # 语义化版本
npm publish                    # prepublishOnly 会自动跑 verify + verify:name
```

想发预发布版：`npm publish --tag next`（**不要**覆盖 `latest`，`latest` 是在 registry 上
按包名安装时被解析到的那个 tag）。

## 7. 用户侧

```bash
dsh plugin --profile web add dsh-lmmarr
dsh --profile web --dump-config | grep -A8 "id: lmmarr"   # 自检：配置错误 dsh 是静默忽略的
```

升级：`dsh plugin --profile web add dsh-lmmarr@latest`。

## 8. 坑清单（都是实测踩过的）

| 现象 | 原因 | 修法 |
|---|---|---|
| 包发不出去：`name can no longer contain capital letters` | 新包名不允许大写 | 用小写；`npm run verify:name` 前置拦截 |
| 装上了但完全没反应 | `files` 里漏了 `cordis.patch.yml` | 加进 `files` |
| `--dump-config` 里看不到自己的层 | `cordis.patch.yml` 顶层写成了裸 mapping | 顶层必须是**序列**（`- insert:`） |
| 启动打一行 `N entry did not activate` 就继续跑 | `output.schema` 里某个 `object` 没写 `additionalProperties` | 每个 object 都显式写上 |
| 运行时用的是错版本的 dsh-tools | `peerDependencies` 写了 `"*"`，装到 registry 的旧 latest | 钉到与目标 dsh 内嵌一致的版本 |
| 打包体积莫名很大 | `files` 没白名单，把 `src/`、测试、`node_modules` 都带上 | 用 `files` 白名单 + `npm pack` 核对清单 |
