# multiclaw 项目约定

## 构建 / 校验
- 包管理:pnpm workspace(3 个包:core / cli / dashboard + examples/dev-team)。
- CI 顺序固定为 **install → lint → build → typecheck → test**。
  - 原因:cli、dashboard 的 typecheck 从 `packages/core/dist/*.d.ts` 解析跨包类型;clean checkout 下不先 build 会报 TS2307。不要调整这个顺序。
- 常用命令(根目录):
  - `pnpm verify` = lint + build + typecheck + test(本地提交前跑)
  - `pnpm lint` = `biome check .`;`pnpm lint:fix` = `biome check --write .`;`pnpm format` = `biome format --write .`
  - `pnpm typecheck` = `pnpm -r typecheck`
  - `pnpm test` = `pnpm -r test`(跑全部 3 个包)
  - `pnpm test:coverage` = `pnpm -r test:coverage`(跑测试并强制覆盖率门槛,CI 用这个)
- 发布:**手动触发**。changesets 驱动,但 `.github/workflows/release.yml` 只由 `workflow_dispatch` 触发——合并 PR 不会发布任何东西。维护者在 Actions 手动跑一次即完成 version → commit → publish → push tags。三包锁步(fixed 组)。
  - 文档:`RELEASING.md`(英)/ `RELEASING.zh-CN.md`(中)。改动发布流程时同步更新这两份。

## 工具链版本(互相约束,不能单独升)
- **Vite 8 + `@vitejs/plugin-react` 6 + vitest 4** 是一组,必须同时升:
  - plugin-react 6 的 peer 是 `vite ^8.0.0`,且内部 `import "vite/internal"`(Vite 8 才导出的子路径)。与 vite 5/6/7 搭配 → `vite build` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
  - vitest 3 的 peer `vite` 是 `^5||^6||^7`,**不含 8**;vitest 4 才是 `^6||^7||^8`。`@vitest/coverage-v8` 的 peer 锁死 vitest 精确版本,所以三包 vitest 与根 coverage-v8 必须同版本。
  - node:`devEngines.runtime.version` = `^22.12.0 || >=24.0.0`(Vite 8 / rolldown / plugin-react 6 的 `engines.node` 均为 `^20.19.0 || >=22.12.0`)。
- `pnpm-workspace.yaml` 设了 `strictPeerDependencies: true`:未满足 peer 时 `pnpm install` **直接失败**,而不是只警告、然后装上一个跑不起来的组合。
- **改 `devEngines` 必须重生成 lockfile**(`pnpm install --lockfile-only`):lockfile 把它记在 `importers["."]` 的 specifier 里,否则 CI 的 `--frozen-lockfile` 直接失败。
- `packages/dashboard/vite.config.ts` 用 `import.meta.dirname`(不是 `__dirname`):Vite 8 的 `configLoader: 'native'` 未来会成为默认,不支持 `__dirname`。

## Lint / Format
- Biome 2.5(单一工具管 lint + format + import 排序),配置在根 `biome.json`。
- 风格:2 空格缩进、lineWidth 100、double quotes、asNeeded 分号、trailingCommas es5。
- pre-commit 由 husky + lint-staged 驱动(`.husky/pre-commit` → `pnpm exec lint-staged`)。
- 已知豁免:CSS 关闭 `noUnknownAtRules`(Tailwind 3);测试文件关闭 `noNonNullAssertion`。
- 注意:Biome 的 `noUnusedImports` / `useExhaustiveDependencies` 修复被标为 unsafe,`--write` 不会自动应用,需人工判断(曾误判 React import 为可删)。

## 测试
- 框架 vitest;测试文件与源码同目录(co-located `src/**/*.test.ts`)。
- 时间相关用例用 `vi.useFakeTimers()`。
- 需要替换运行时:向 `runtimeRegistry` 注册一个唯一 name 的 fake runtime,不要覆盖内置 `claude`。
- 覆盖率门槛写在各包 `vitest.config.ts` 的 `coverage.thresholds`,是**防倒退的基线锁**,不是目标:
  - core 90/85/90/90(实测 98.58/91.5/97.18/99.16),exclude `src/types/**`、`src/agents/**`、`src/index.ts`、`src/testing/**`
  - cli 50/45/40/50(commands/init.ts、run.ts、serve.ts 尚未覆盖)
  - dashboard 42/35/32/42(仅 server 侧,DashboardServer.ts 尚未覆盖)
  - 注意:vitest 4 的 v8 provider **把从未被加载的文件的 branches/functions 也计入分母**,所以升级到 vitest 4 时这两项会大跌(已按新口径重新标定,不是覆盖率真的退了)。
- 事件类型:core 的 `MultiClawEvent` 新增了 `orchestration:warning`;消费方 switch 需有 default 兜底。

## 环境坑(pnpm)
- 当前 `nodeLinker` 是 **isolated**(不是 hoisted)。新增依赖后 `.bin` 软链可能缺失或指向不存在目录,报 `vitest: command not found`。**再跑一次 `pnpm install` 通常自愈**,不要手工补软链。
- **增量 `pnpm install` 可能把新加的平台二进制错写进 `node_modules/.modules.yaml` 的 `skipped` 数组**(实测:`@rolldown/binding-darwin-arm64@1.2.13` 被跳过 → `vite build` 报 `Cannot find native binding`)。`pnpm install --force` 一次性修好;干净目录安装不复现,所以 CI(干净安装)不受影响。排查手法:`grep -n skipped node_modules/.modules.yaml`。
- **`pnpm -r <script>` 会先校验并自动补齐依赖**(pnpm 12 的 verifyDepsBeforeRun)。若 `node_modules` 与 lockfile 不一致——例如手工放进 `node_modules/@biomejs/cli-darwin-arm64` 的那个二进制——它会隐式跑一次 install、`+24 -19` 重新链接 `.bin`。此时若 vitest 正在启动,就会出现「no tests / 1 error」的**假失败**(已实测复现)。单独重跑对应包即绿,不是代码问题。
- 本机 pnpm store 偶发写入失败(尤以 `@biomejs/cli-darwin-arm64` 为甚),重装通常能成功。

## 待办(已识别,未修复)
- cli 的 `commands/init.ts`、`run.ts`、`serve.ts` 与 dashboard 的 `server/DashboardServer.ts` 仍无单测。
- 覆盖率门槛可随覆盖提升逐步上调。
