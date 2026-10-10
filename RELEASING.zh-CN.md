# 发布流程

[English](./RELEASING.md)

`multiclaw` 会发布三个包:

| 包名 | 作用 |
| --- | --- |
| `@multiclawcli/core` | 编排引擎 |
| `multiclaw` | 命令行工具(CLI) |
| `@multiclawcli/dashboard` | 实时 Web 面板 |

三个包**锁步发布**——版本号永远一致,由 `Bump Version` workflow 一起推动。

发布**由人工手动触发,分两步**:维护者先跑 `Bump Version`,它会开出一个发布 PR;合并这个 PR
会触发 `Release`,由它完成发布。合并普通 PR 不会发布任何东西。

---

## 第一部分 —— 如果你要提 Pull Request

不需要为发布做任何额外的事,也不用写 changeset 文件。

请把 **PR 标题**写成 [Conventional Commits](https://www.conventionalcommits.org/) 风格
(`feat:`、`fix:`、`chore:` …)。每次发布的 release notes 由 GitHub 依据「上一次发布以来合并的 PR
标题」生成,所以标题就是用户最终看到的内容。

**你的改动会不会发出去,是在维护者发版时才决定的**,而不是在 PR 合并时——合并进来的改动只是等着
下一次版本变更。

---

## 第二部分 —— 如果你要发版(维护者)

### 前置条件

发布使用 **npm trusted publishing(OIDC 可信发布)**。本仓库里没有任何 npm token ——既没有
`NPM_TOKEN` secret,workflow 也不会写 `~/.npmrc`。需要在 npmjs.com 上满足两件事:

1. **每个要发布的包都配置了 trusted publisher。** 打开包的设置页
   (`https://www.npmjs.com/package/<包名>/access` → **Trusted Publisher** → **GitHub
   Actions**),按下表填写:

   | 字段 | 值 |
   | --- | --- |
   | Organization or user | `shipengqi` |
   | Repository | `multiclaw` |
   | Workflow filename | `release.yml` —— 只填文件名,**不要**填 `.github/workflows/release.yml` |
   | Environment name | 留空 |
   | Allowed actions | 允许 `npm publish` |

   这些值是**精确匹配**的(区分大小写)。workflow 文件一旦改名,几个月后发布就会静默失败,
   所以每次重命名 `release.yml` 都要回头核对这一项。

   三个包都要配:`@multiclawcli/core`、`multiclaw`、`@multiclawcli/dashboard`。

2. **workflow 必须保留 `id-token: write`。** 这个权限是发布步骤换取短期 OIDC 身份的前提;
   少了它注册表会直接拒绝,而且没有退路。

> **不要添加 `NPM_TOKEN` secret,也不要把 token 写进 `~/.npmrc`。** 环境里一旦有 token,
> 包管理器就会走旧的 token 鉴权路径,OIDC 交换根本不会发生 —— 即使 trusted publishing 配置
> 完全正确,发布也会报鉴权失败。

### 分支保护

`main` 上有规则集,要求所有改动必须走 PR。两个 workflow 都是围绕这一点设计的,因此**不需要配置
任何 bypass**:

| workflow 推送的内容 | 会被规则集拦截吗 |
| --- | --- |
| `release/v<version>` 分支 | 不会——规则集只作用于 `refs/heads/main` |
| `v<version>` tag | 不会——规则集只作用于分支 |
| 版本变更本身 | 它是通过**合并发布 PR** 落到 `main` 的,这正是规则集要求的方式 |

有两点需要知道:

- **发布 PR 不会跑 CI。** 由 `GITHUB_TOKEN` 触发的事件不会启动新的 workflow 运行,而 PR 正是用它
  开的,所以 `ci.yml` 不会在发布 PR 上跑。目前这没有影响,因为规则集只要求走 PR、**不要求状态检查**。
  但如果你以后加了 required status checks,发布 PR 就会无法合并:要么在规则集上保留一个 bypass
  actor,要么改用非 `GITHUB_TOKEN` 的凭据开 PR(自建 GitHub App 的 installation token 或
  fine-grained PAT),让 CI 能正常触发。
- 发布 PR 里**只有**版本号。它发布的代码,在此前引入这些改动的 PR 里已经过评审和测试。

### 发版操作

1. 打开 **Actions → Bump Version → Run workflow**。
2. 分支保持 `main`,选择 **bump 类型**(`patch`、`minor` 或 `major`)。
3. 点击 **Run workflow**。它会开出一个标题为 `chore: release vX.Y.Z` 的 PR。
4. 审阅这个 PR(三个版本号),然后**合并它**。
5. 合并会触发 **Actions → Release**:发布到 npm、推送 `vX.Y.Z` tag、创建 GitHub Release。

全程不需要手输版本号——版本号由 bump 类型决定。

### 怎么选 bump 类型

在包还处于 `0.x` 阶段时:

| 类型 | 适用场景 | 示例 |
| --- | --- | --- |
| `patch` | 修 bug、不改变 API 的内部重构 | `0.3.2` → `0.3.3` |
| `minor` | 新功能、行为变更,以及任何用户能感知到的改动 | `0.3.2` → `0.4.0` |
| `major` | 破坏性变更(在 API 稳定之前尽量不用) | `0.3.2` → `1.0.0` |

三个包共用一个版本号,所以**一次 bump 会同时作用于三个包**。如果它们当前版本不一致,workflow 会
直接拒绝运行。

### workflow 具体做了什么

**`Bump Version` —— `workflow_dispatch`(你点了按钮):**

1. **检出 `main`。**
2. **改写版本号**:把 `packages/core`、`packages/cli`、`packages/dashboard` 的 `version` 字段改成
   下一个版本号。除此之外什么都不动——不改 lockfile,也不构建。这里**有意不构建**:真正的构建放在
   `Release` 里,针对真正落到 `main` 的那个提交,而不是放在一个随后就被丢弃的 runner 上。
3. **推送 `release/v<version>` 分支**,并**开出发布 PR**。重跑是安全的:分支会被 `--force` 刷新,
   已存在的 PR 会自动带上新提交。

**`Release` —— `pull_request: closed`,即该 PR 被合并时:**

4. **构建所有包**(`pnpm -r build`),针对合并后的提交。
5. **把三个包发布到 npm。**
6. **打 tag** —— `v<version>`,版本号读自 `packages/core/package.json`。三个包锁步,一个版本号
   就能代表整次发布。
7. **创建 GitHub Release**(`gh release create --generate-notes`),release notes 由 GitHub 依据
   上一次发布以来合并的 PR 生成。

> **为什么发布步骤留在 `release.yml` 里。** npm trusted publishing 匹配的是 **workflow 文件名**
> ——`release.yml`。把发布拆到单独的 `publish.yml` 会让发布静默失败,直到你在 npmjs.com 上把三个包
> 全部重新配置一遍;所以这里是两个 workflow,但负责发布的那个必须保留这个名字。

> **为什么只打一个 `v<version>` tag。** 本仓库一直是一次发布对应一个 `v<version>` tag 和一个
> GitHub Release,而且三个包本来就共用一个版本号,再打包级 tag 只会增加噪音。

### 怎么确认成功

- `Bump Version` 的运行是绿的,并且有一个 `chore: release vX.Y.Z` 的 PR 被开出来。
- 合并它之后,`Release` 的运行是绿的。
- `main` 上有一条 `chore: release vX.Y.Z` 提交。
- `npm view @multiclawcli/core version` 返回新版本号。
- 远端存在 `vX.Y.Z` tag,且 `gh release view vX.Y.Z` 能看到对应的 GitHub Release。

### 失败了怎么办

每一步都是幂等的,**重跑即可**——但重跑哪个取决于停在哪:

- **`Bump Version` 在推送分支之前失败** → 哪里都没变,直接从 Actions 重跑 workflow。
- **`Bump Version` 在推送分支之后失败** → 重跑 workflow;它会刷新分支,并复用已存在的 PR。
- **`Release` 失败** → 打开那次运行,点 **Re-run failed jobs**。原始的 `pull_request` 事件载荷会被
  保留,所以 job 的 `if` 条件依然成立;而且 `pnpm publish` 会跳过 registry 上已存在的版本,重跑会把
  剩下的补完。已存在的 tag 和 release 同样会被跳过。

---

## 版本规则

- 三个已发布包**锁步**共用同一个版本号。`Bump Version` workflow 负责保证这一点:三者版本不一致时
  直接失败,一致时一起 bump。
- `examples/dev-team` 是私有包,永远不发布。`Release` workflow 只发布 `packages/*`。

---

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Bump Version` 报 "Packages are out of sync" | 三个 `package.json` 的版本号不一致 | 先提一个 PR 把它们对齐,再重新跑 bump |
| 发布时报 `EOTP`、`401 Unauthorized` 或 `404 Not Found` | 注册表没有接受 OIDC 身份 | 核对 npmjs.com 上的 trusted publisher:owner、repository 和 **workflow 文件名 `release.yml`** 必须完全一致,且 job 保留 `id-token: write`;同时确认环境里没有 `NPM_TOKEN` / `~/.npmrc` |
| 报 `EPUBLISHCONFLICT` | 该版本已存在于 npm | 重跑;`pnpm -r publish` 会跳过已发布的版本 |
| 发布 PR 上没有任何 CI 检查 | 预期行为——用 `GITHUB_TOKEN` 开的 PR 不会触发 workflow | 只要规则集不要求状态检查就不用管。如果确实需要 CI,改用 GitHub App installation token 或 fine-grained PAT 开这个 PR |
| 合并之后 `Release` 没有运行 | 被合并 PR 的 head 分支名不是以 `release/v` 开头 | 合并名为 `release/vX.Y.Z` 的分支;或者重新跑一次 `Bump Version` 拿一个新的 PR |

---

## 补充说明

- 每次发布都会为 `v<version>` tag 创建一个 GitHub Release,release notes 由 GitHub 依据合并的 PR
  生成。请把 PR 标题写清楚——它就是 release notes。
- 仓库里**没有 `CHANGELOG.md`**,也没有 changeset 文件。每次发布的说明都放在 GitHub Release 里。

---

## 速查

| 命令 | 作用 |
| --- | --- |
| `.github/workflows/bump-version.yml` | 第一步 —— 开出发布 PR(手动触发) |
| `.github/workflows/release.yml` | 第二步 —— 发布 PR 合并后执行发布 |
| `.github/workflows/ci.yml` | 每个 Pull Request 都会跑的质量门禁 |
