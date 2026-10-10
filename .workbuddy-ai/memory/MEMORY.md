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
- 发布:changesets 驱动。`pnpm changeset`(写变更) → `pnpm version-packages` → `pnpm release`;CI 由 `.github/workflows/release.yml`(changesets/action)自动开 Version Packages PR。三包锁步(fixed 组)。

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
  - core 90/85/90/90(实测约 99/96/97),exclude `src/types/**`、`src/agents/**`、`src/index.ts`、`src/testing/**`
  - cli 45/70/75/45(commands/init.ts、run.ts、serve.ts 尚未覆盖)
  - dashboard 35/80/55/35(仅 server 侧,DashboardServer.ts 尚未覆盖)
- 事件类型:core 的 `MultiClawEvent` 新增了 `orchestration:warning`;消费方 switch 需有 default 兜底。

## 环境坑(pnpm)
- pnpm 12 + `node-linker=hoisted`:新增依赖后 `.bin` 软链可能缺失或指向不存在目录,报 `vitest: command not found`。**再跑一次 `pnpm install` 通常自愈**,不要手工补软链。
- 不要在测试运行时并发 `pnpm install`,会出现「no tests / 1 error」的假失败。
- 本机 pnpm store 偶发写入失败(尤以 `@biomejs/cli-darwin-arm64` 为甚),重装通常能成功。

## 待办(已识别,未修复)
- cli 的 `commands/init.ts`、`run.ts`、`serve.ts` 与 dashboard 的 `server/DashboardServer.ts` 仍无单测。
- 覆盖率门槛可随覆盖提升逐步上调。
