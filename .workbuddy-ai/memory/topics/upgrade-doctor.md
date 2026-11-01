# upgrade / doctor / 真机验证

## `multiclaw upgrade`
- 升级必须打到"当前运行的那一份"所在 prefix（原实现硬编码 `npm install -g`，pnpm 全局装白升）。
- `findPackageRoot()` 从 `import.meta.url` 向上找 `name==="multiclaw"`；`detectInstaller()` 靠路径签名（pnpm/bun/yarn 签名要在通用 `/node_modules/` 之前匹配）。
- 只给 npm/pnpm 实现 `view`+`add -g`，bun/yarn/unknown 报错给手动命令；registry 查询走安装器自己的 `view`（尊重 .npmrc 镜像）；装完 `readInstalledVersion()` 复查。
- `runUpgrade` 接受注入 `exec`/`readVersion` → 测试零 mock。

## doctor
- version 列存解析后的数字（`parseVersion()`），但 `versionFor()` 必须返回原始行（`spec.confirm` 靠词确认身份）。
- 已改 provider 分组 + 标签行；告警复用 `hasExplicitTools`。
- 本机实测：OpenCode 1.19.0 / Claude 0.89.1 / Codex 2.2.2，全 path。

## 真机验证结论
- [x] 默认 allowlist 含 Bash → `rm` 不经审批直接删文件；`tools` 是审批白名单，不是能力上限。
- [x] `session/load` 跨进程续接有效（同 sessionId + `resume:"continue"` 仍记得 7319）。
- [x] steering 两个真 bridge：injected 生效、promptRequired 挡住自起 turn、startedNewTurn 能 cancel、steer 后仍可 prompt；opencode 走 unsupported。
- [ ] `multiclaw init`：无 claude CLI 但装了 `claude-agent-acp` 的环境下的表现。

## 开放问题
- 已同意（2026-10-31）：先补跨轮事实摘要，再加显式工具限制的启动前检查；不加模型调用/弹窗/命令，不隐式批准/重试/切 provider/放宽权限。
- 工具来源：12 个工厂用 enumerable `Symbol.for("multiclaw.toolsProvenance")` 存原数组引用 + 冻结快照。
- 跨轮 `TurnRecord.outcome?`：execution 与 acceptance 分离，TUI 从历史事实派生；旧记录不足则 unknown。
