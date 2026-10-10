# 发布流程

[English](./RELEASING.md)

`multiclaw` 会发布三个包:

| 包名 | 作用 |
| --- | --- |
| `@multiclawcli/core` | 编排引擎 |
| `multiclaw` | 命令行工具(CLI) |
| `@multiclawcli/dashboard` | 实时 Web 面板 |

三个包**锁步发布**——版本号永远一致。这由 `.changeset/config.json` 里的 `fixed` 组保证。

发布由 [Changesets](https://github.com/changesets/changesets) 驱动,并且**由人工手动触发**。
合并 Pull Request 不会自动发布任何东西。

---

## 第一部分 —— 如果你要提 Pull Request

### 什么时候必须加 changeset

当你的改动影响任一已发布包(`@multiclawcli/core`、`multiclaw`、`@multiclawcli/dashboard`)的
**运行行为或公开 API** 时。

### 什么时候不需要加

改动只涉及以下内容时:

- 测试(`*.test.ts`)
- CI、workflow 或工具链配置
- 文档
- 私有包 `examples/dev-team`

> 拿不准就加一个。多加一个 changeset 的成本很低;漏加会静默地少发一次版本。

### 怎么加

```bash
pnpm changeset
```

这个命令会依次问你三件事:

1. **哪些包变了** —— 空格键选择,回车确认。
2. **bump 类型** —— `major` / `minor` / `patch`。
3. **一段说明** —— 用一两句话从用户视角描述这次改动。这段文字会直接进入 CHANGELOG,
   所以请写给用户看,而不是写给 reviewer 看。

它会生成一个 `.changeset/<随机名>.md` 文件。**请把这个文件和你改的代码一起提交。**

一个 changeset 长这样:

```markdown
---
"@multiclawcli/core": minor
"multiclaw": patch
---

当 `task-plan.json` 无法解析时,发出 `orchestration:warning` 事件。
```

### 怎么选 bump 类型

在包还处于 `0.x` 阶段时:

| 类型 | 适用场景 |
| --- | --- |
| `patch` | 修 bug、不改变 API 的内部重构 |
| `minor` | 新功能、行为变更,以及任何用户能感知到的改动 |
| `major` | 破坏性变更(在 API 稳定之前尽量不用) |

因为三个包属于同一个 `fixed` 组,**其中最高的 bump 会胜出并应用到全部三个包**。比如
`multiclaw` 写 `patch`、`@multiclawcli/core` 写 `minor`,最终三个包都会按 `minor` 发布。

### 忘了加会怎样

什么都不会发生。你的 PR 正常合并、CI 全绿,但**不会产生任何发布**——版本号就是不动。

这是本流程唯一无法自动兜住的失败模式,所以只要 PR 动到了已发布包,reviewer 就应该主动确认
changeset 是否存在。

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

> **分支保护:** workflow 会把 `chore: release` 提交**直接推送到 `main`**。如果 `main` 开启了
> 分支保护(要求必须走 PR 或必须通过状态检查),需要允许 GitHub Actions 应用绕过这些规则;
> 否则推送会被拒绝,发布就停在这一步。

### 发版操作

1. 打开 **Actions → Release → Run workflow**。
2. 分支保持 `main`。
3. **Dry run** 不勾选。
4. 点击 **Run workflow**。

整个发布就这些。没有 PR 要合并,也不需要手输版本号。

### 先预览(可选)

勾选 **Dry run**,会执行构建和版本号变更,但**不提交、不推送、不发布**。运行日志会打印出最终的
diff,方便你在真正发布前核对版本号和 CHANGELOG 措辞。

### workflow 具体做了什么

1. **检出 `main`**,并拉取**全量历史**(`fetch-depth: 0`)。这一步**只为 CHANGELOG 的署名**服务:
   为了写出形如 `- abc1234: 修复某某问题` 的条目,changesets 会对每个 changeset 文件执行
   `git log --diff-filter=AC --follow --max-count=1 .changeset/<id>.md`,找出是哪个 commit 添加了它。
   浅克隆下边界 commit 看不到父提交,changesets 只能退化成循环加深克隆(`git fetch
   --deepen=50`)——更慢,而且可能直接失败。
2. **没有待发布 changeset 时直接失败**——没有东西可发就是操作失误,而不是空跑。
3. **构建所有包**(`pnpm -r build`)。
4. **应用版本号与 CHANGELOG**(`pnpm version-packages`,即 `changeset version`)。被消费的
   `.changeset/*.md` 会在此刻删除,内容已归档进各包的 `CHANGELOG.md`。
5. **提交并推送**版本变更到 `main`,commit message 为 `chore: release`。
6. **发布到 npm**(`pnpm release`,即 `changeset publish`)。
7. **推送发布 tag** —— `changeset publish` 会在本地创建形如 `@multiclawcli/core@0.4.0` 的 tag,
   但**不会自己推送**,所以需要这一步。

> **为什么不直接从 commit 历史推导发布内容?** 第 1 步和第 2 步其实互不相干。`fetch-depth: 0`
> 只负责让 CHANGELOG **标注**上引入该改动的 commit。而**「发什么、版本号走多远」是由 changeset
> 文件决定的**,历史回答不了这个问题:一个 commit 不会说明自己是 `patch`、`minor` 还是 `major`;
> 它不包含面向用户的说明文字;它也分不清哪些提交根本不该发版(文档、CI、测试的提交不应该
> bump 任何东西);而且当多个 PR 堆在一起时,历史并不知道上一次发布到哪里为止。这个判断由人
> 在 PR 里做出,changeset 文件就是它的记录方式。
>
> 所以 workflow 永远无法从历史里发现**「漏加 changeset」**——它唯一能看到的,是**一个待发布
> changeset 都没有**,因此才选择直接失败。

### 怎么确认成功

- workflow 运行是绿的。
- `main` 上有一条 `chore: release` 提交。
- `npm view @multiclawcli/core version` 返回新版本号。
- 远端存在形如 `@multiclawcli/core@0.4.0` 的 tag。

### 失败了怎么办

每一步都是幂等的,**直接重跑一次 workflow 即可**:

- 在提交之前失败 → `main` 上什么都没变,重跑就是干净的开始。
- 发布过程中失败 → 可能已经有部分包发出去了。`changeset publish` 会跳过 registry 上已存在的
  版本,所以重跑会把剩下的补完。
- 推送 tag 失败 → 重跑,已存在的 tag 会被跳过。

---

## 版本规则

`.changeset/config.json`:

```json
{
  "fixed": [["@multiclawcli/core", "@multiclawcli/dashboard", "multiclaw"]],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch"
}
```

- `fixed` 让三个已发布包共用同一个版本号。
- `updateInternalDependencies: "patch"` 让内部依赖范围在依赖变动时同步更新。

`dev-team-example` 是私有包,永远不发布。

---

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| workflow 报 "No pending changesets" | 所有 changeset 都已被消费 | 用 `pnpm changeset` 加一个,合并后再发版 |
| 发布时报 `EOTP`、`401 Unauthorized` 或 `404 Not Found` | 注册表没有接受 OIDC 身份 | 核对 npmjs.com 上的 trusted publisher:owner、repository 和 **workflow 文件名 `release.yml`** 必须完全一致,且 job 保留 `id-token: write`;同时确认环境里没有 `NPM_TOKEN` / `~/.npmrc` |
| 报 `EPUBLISHCONFLICT` | 该版本已存在于 npm | 重跑;已发布的版本会被跳过 |
| 合并 PR 后版本号没变 | 该 PR 没有 changeset | 这是预期行为,见上文「忘了加会怎样」 |

---

## 补充说明

- 本 workflow **不会**创建 GitHub Release。`changeset publish` 只创建并推送 git tag。如果也想要
  GitHub Release,在「Push release tags」之后追加一个 `gh release create` 步骤即可。
- 没有新版本可发时,`changeset publish` 是空操作;但 workflow 的前置检查会让你不会意外走到这一步。

---

## 速查

| 命令 | 作用 |
| --- | --- |
| `pnpm changeset` | 创建一个 changeset |
| `pnpm version-packages` | `changeset version` —— 把 changeset 应用到版本号与 CHANGELOG |
| `pnpm release` | `changeset publish` —— 把未发布的版本发到 npm |
| `.github/workflows/release.yml` | 发布 workflow(手动触发) |
| `.github/workflows/ci.yml` | 每个 Pull Request 都会跑的质量门禁 |
