# multiclaw 产品级功能评估：缺口盘点与体验增强机会

> 评估人：许清楚（产品经理） · 日期：2026-10-13 · 版本基线：仓库 HEAD（含 RFC 0001 落地）
> 方法：以三大核心为锚，逐文件核对现状（证据均带路径/行号），再谈增强。
> 约束遵守：不挑战 `AgentRuntime` 已发布接口、core 无 session 概念、TUI 仅 `?` `/` 两个裸键。

---

## 0. 产品定位一句话

**multiclaw 是目前少数把「声明式依赖图 pipeline + 跨 provider 模型分档 + 可回看的 turn-based 终端控制台」三者合一的多 agent 编排 CLI**——它编排的不是"一个更强的 agent"，而是"一支按依赖图并行/串行、且每个角色可跑在不同厂商上的团队"。

差异化不在于单个 agent 多强，而在于**编排层**：`dependsOn` 声明拓扑、`leader` 三态路由决定"这轮要不要全队"、`provider`/`modelTier` 让同一份配置跨 claude/opencode/codex/cursor 自动正确。

---

## 1. 当前能力盘点表

状态定义：**已具备**＝代码中可运行且有测试/文档佐证；**部分**＝能用但有限制或未验证；**缺失**＝无实现。

| # | 能力 | 状态 | 证据（路径:行号） |
|---|------|------|------------------|
| 1 | 声明式 pipeline（`dependsOn` → 拓扑分阶段 → 同阶段并行） | 已具备 | `packages/core/src/orchestrator/StageBuilder.ts`；`Orchestrator.ts:93-162`；README L208-217 |
| 2 | 同阶段并行 + `maxConcurrency` 限流 | 已具备 | `Orchestrator.ts:311-322` |
| 3 | `leader` 三态路由（run / reply / ask） | 已具备 | `packages/core/src/agents/leader.ts`；`Orchestrator.ts:223-258`；`types/leader.ts:9-13` |
| 4 | architect `task-plan.json` 任务分解 + 动态重排阶段 | 已具备 | `Orchestrator.ts:117-135, 324-370`；README L440-478 |
| 5 | 多 provider（claude / opencode / codex / cursor） | 部分（cursor 未真机验证） | `providers/catalog.ts:66-168`；RFC §3.2、§10 V2-V5 |
| 6 | 统一 ACP runtime（`runtime` 恒为 `acp`） | 已具备 | `packages/core/src/runtime/index.ts`；`AcpRuntime.ts` |
| 7 | 模型 tier（strong/balanced/fast）跨 provider 映射 | 已具备 | `catalog.ts:210-213`；`providers/resolve.ts` |
| 8 | 模型真正下发到 agent（`set_config_option`） | 已具备（Phase 2 已落地） | `AcpRuntime.ts:585-605` |
| 9 | `init` 向导（provider / model / 档位 / 逐 agent 覆盖） | 已具备 | `packages/cli/src/commands/init.ts:96-239` |
| 10 | `doctor` 环境体检（含 config provider 解析校验） | 已具备 | `commands/doctor.ts:38-87, 175-182` |
| 11 | TUI 全屏 turn-based conductor loop | 已具备 | `packages/dashboard/src/tui/App.tsx` |
| 12 | 运行中队列（mid-run 输入不丢失） | 已具备 | `App.tsx:264-269, 346-363`；`state.ts` QueueStrip |
| 13 | 历史回看（最近 20 轮，只读不扰动实况） | 已具备 | `state.ts:99-114, 438-476`；`App.tsx:479-499` |
| 14 | 焦点切换 / 流式日志 / 滚动 / 窄终端降级 | 已具备 | `App.tsx:519-582`；`layout.ts`；README L311-313 |
| 15 | 取消（abort 在飞 agent 及其子进程） | 已具备 | `commands/run.ts:40-55`；`Orchestrator.ts:110-114` |
| 16 | 会话历史注入 leader（跨轮上下文） | 已具备 | `state.ts:494-508`；`Orchestrator.ts:37` |
| 17 | **成本 / token 用量可见** | **缺失（数据已算出却被丢弃）** | `AgentOutput.usage/costUsd`（`types/runtime.ts:105-117`）由 `AcpRuntime.ts:625-626` 填充，但 `AgentRunner.ts:72-106` 只取 `.output`，`AgentResult`（`types/agent.ts:64-74`）无对应字段 |
| 18 | **工具调用活动可见**（tool_call / tool_result） | **缺失** | 运行时能发（`types/runtime.ts:25-26`），但 `AgentRunner.ts:89-104` 只转发 `message*` 文本 |
| 19 | **失败恢复 / 断点续跑** | **缺失** | `Orchestrator.ts:137-161` 失败即 skip 余下阶段；`resume` 能力（`AgentTask.sessionId`，`types/runtime.ts:90-93`）已实现但 `AgentRunner` 从不传 sessionId |
| 20 | **交付物清单 / 变更 diff** | **缺失** | `report.json` 仅含各 agent output（README L354-357），无"改了哪些文件" |
| 21 | turn 记录导出 | 缺失 | history 仅内存回看（`state.ts:99-114`） |
| 22 | 预算 / 成本上限护栏 | 缺失 | 无 `maxCost` 相关字段（`types/config.ts:19-47`） |
| 23 | 权限交互（human-in-the-loop 审批） | 缺失 | `decidePermission` 自动 fail-closed（`AcpRuntime.ts:150-191`），用户不可见不可控 |
| 24 | 配置预检（依赖环 / 未知 id 提前报错） | 部分 | `doctor` 只校验 provider 解析（`doctor.ts:62-79`）；依赖图问题运行期才降级（`Orchestrator.ts:192-199`） |
| 25 | 机器可读输出（`--json`） | 缺失 | `run` 仅 `--config` / `--no-leader`（`cli/src/index.ts:32-36`） |

> 关键观察：**#17、#18、#19 三项是"能力已在底层存在、只差接线"**——这是投入产出比最高的一类缺口，因为不需要新增协议或改接口。

---

## 2. 功能缺口清单（P0 / P1 / P2）

优先级口径：**P0 = 削弱三大核心或构成明显体验断层；P1 = 显著提升日常体验；P2 = 锦上添花。**

### P0

| # | 缺口 | 用户痛点场景 | 为什么值得做 | 与核心的关系 |
|---|------|-------------|-------------|-------------|
| P0-1 | **成本 / token 用量不可见** | 团队用 claude（opus 架构 + haiku 评审）混合跑，一轮 10 agent 结束，用户完全不知道花了多少、哪个 agent 最贵 | 数据**已经算出来了**（`AgentOutput.usage/costUsd`，`AcpRuntime.ts:625-626`），只是被 `AgentRunner` 丢弃；补齐是纯 plumbing | 直接支撑核心②多 provider——跨厂商成本差异正是多 provider 的**核心卖点**，看不见等于卖点失效 |
| P0-2 | **失败恢复 / 断点续跑缺失** | fullstack 10-agent pipeline 跑到第 8 个（tester）失败 → 余下全 skip；headless `run` 每轮独立时间戳目录（`run.ts:23-24`），重跑从零、白烧前面 7 个 agent 的钱 | 底层 `session/load` 续跑**已实现**（`AcpRuntime.ts:539-557`），只差把 sessionId 从上一轮传到下一轮 | 直接支撑核心①编排——长 pipeline 的可靠性是编排价值的底线 |
| P0-3 | **工具调用活动不可见** | 用户盯着 stream 面板"watch them run"，却只看到模型的自述文字，看不到它实际 `Grep` 了什么、`Edit` 了哪个文件、`Bash` 跑没跑通 | 运行时已发 `tool_call`/`tool_result`（`types/runtime.ts:25-26`），被 `AgentRunner.ts:93-97` 过滤；README 的 stream 示例（L230-235）展示的正是这类行，代码与文档存在落差 | 支撑核心③ TUI——"watch them run"的**核心承诺**就是看得见 agent 在做什么 |

### P1

| # | 缺口 | 用户痛点场景 | 为什么值得做 | 与核心的关系 |
|---|------|-------------|-------------|-------------|
| P1-1 | 运行前 **dry-run / 计划预览** | 敲一句需求前不知道 leader 会选哪几个 agent、会分几阶段，只能跑起来（且已开始烧钱）才知道 | leader 决策在 `resolveTurn` 已产出（`Orchestrator.ts:223-258`），预览只需把决策**先渲染不执行** | 核心①③ |
| P1-2 | **交付物摘要 / 变更清单** | run 完只打印一行日志路径（`run.ts:35`），用户要自己进 `workDir/.multiclaw/runs/...` 翻文件才知道产出了什么 | 交付是编排的终点，缺一个"这轮产出了什么"的收口 | 核心① |
| P1-3 | **模型下发告警在 TUI 不可见** | 用户配了 provider 不支持的 model id，`AcpRuntime.ts:591-593` 只写 `process.stderr`，TUI 控制台里**毫无提示**，用户以为模型生效了 | 已有 warning 事件类型 `orchestration:warning`（`types/event.ts:35-39`）现成可用，接上即可 | 核心② |
| P1-4 | **`init` 生成的配置不含 leader** | 新用户 `init` → 直接 `multiclaw` 进控制台，却发现"问一句就得到回答 / 不用全队"的能力**不存在**（`AGENT_BLOCKS` 只列 pipeline agents，`init.ts:8-34` 无 `agents.leader()`） | 三态路由是 README 重点宣传的卖点（L260-263），默认配置却关掉了它，首因体验即打折 | 核心①③ |
| P1-5 | **turn 记录导出** | 想把某轮的 requirement / roster / 输出 / leader 回复存成 markdown 交付或归档，只能手动复制终端 | 控制台已是"工作发生地"，缺一个导出出口 | 核心③ |

### P2

| # | 缺口 | 用户痛点场景 | 为什么值得做 | 与核心的关系 |
|---|------|-------------|-------------|-------------|
| P2-1 | 成本预算上限（`maxCostUsd` 护栏） | 担心一句模糊需求触发全队高配模型，想设个"花到 X 美元就停" | 有了 P0-1 的用量数据后，护栏是自然延伸 | 核心② |
| P2-2 | 控制台跨重启会话持久化 | 关掉再打开 `multiclaw`，历史 20 轮全丢 | history 仅内存（`state.ts:99-114`）；可在 **TUI/CLI 层**落地 jsonl，不触碰 core 无 session 的约束 | 核心③ |
| P2-3 | 队列项可编辑 / 删除 | 运行中排了 3 条跟进，发现第 2 条写错了，无法单独撤回 | 队列已有 UI（QueueStrip），补操作即可 | 核心③ |
| P2-4 | `run --json` 机器可读输出 | CI 里想直接解析结果，只能读深目录下的 `report.json` | 降低 headless 集成门槛 | 核心① |
| P2-5 | 配置预检（依赖环 / 未知 id / 重名） | 依赖图写错，运行期才降级成"按声明顺序跑"（`Orchestrator.ts:192-199`），用户未必注意到 warning | 把错误提前到 `doctor` 阶段 | 核心① |
| P2-6 | 权限交互 UI（审批 Write/Bash） | 想让 agent 写文件前先给自己过目 | `decidePermission` 现为自动 fail-closed，安全基线成立；交互式审批属增强 | 核心②③ |

---

## 3. 用户旅程断点分析

| 环节 | 现状 | 摩擦点 |
|------|------|--------|
| **① `multiclaw init`** | 5 问向导（name / preset / provider / model / workDir），`init.ts:96-239` | ⚠️ **不写 `leader`**：生成的配置天然没有三态路由（P1-4）。⚠️ 无 `--yes` 非交互模式，脚本/CI 无法脚手架。⚠️ cursor 标 present 与否依赖未验证的 `confirm`（RFC V2） |
| **② 首次 `multiclaw run "..."`** | headless 跑完整 pipeline，打印日志路径 | ⚠️ 无 dry-run，直接消耗 token（P1-1）。⚠️ 失败信息仅走 exit code + 日志文件，无结构化 stdout（P2-4）。⚠️ 每轮独立目录，失败即弃（P0-2） |
| **③ 进入 TUI `multiclaw`** | 全屏控制台，首屏显示团队 roster（`state.ts:208-219`） | ⚠️ 若配置来自 `init` 则**无 leader**，看不到"reply/ask"能力，卖点缺席（P1-4）。✅ `?`/`/` 可发现性良好 |
| **④ 长任务运行中** | team 面板 + stream + 队列 + 计时 | ⚠️ 看不到成本/token（P0-1）。⚠️ 看不到工具调用，只有自述文字（P0-3）。⚠️ 无法只取消单个 agent（`ctrl+c` 取消整轮，`App.tsx:450-467`）。⚠️ 进度只有 `done/total`，无 ETA |
| **⑤ 交付结果** | 日志写入 `workDir/.multiclaw/runs/run-<ts>/`，路径打印一次（`run.ts:35`） | ⚠️ 无"产出/变更了哪些文件"的收口清单（P1-2）。⚠️ 无导出（P1-5）。⚠️ report.json 埋在深目录 |
| **⑥ 二次迭代** | 同一 workDir 复用文件，`task-plan.json` 每轮清空（`Orchestrator.ts:209-213`） | ✅ 同目录复用体验好。⚠️ history 仅内存、上限 20、重启即丢（P2-2）。⚠️ 无法对上一轮失败点续跑（P0-2） |

---

## 4. 体验增强功能建议（重点章节）

> 排序原则：先做"底层已具备、只差接线"的（低成本高回报），再做新增能力。
> 遵守约束：新能力**一律走 `/` 命令或已有命名键**（`tab`/方向键），**不新增裸键**；用量数据走既有 `AgentOutput` 字段，**不加宽 `AgentRuntime`**。

| # | 功能名 | 一句话价值 | 最小可用形态 | 复杂度 | 优先级 |
|---|--------|-----------|-------------|--------|--------|
| E1 | **成本与用量面板** | 跑完就知道这轮花了多少 token / 多少钱，谁最贵 | 把 `AgentOutput.usage/costUsd` 透传进 `AgentResult` + 一个 `agent:usage` 事件；team 面板每行尾部显示 `12.3k tok · $0.42`；新增 `/cost` 汇总本轮 | **M** | **P0** |
| E2 | **失败续跑 `--resume` / `/retry <id>`** | 失败不用从头再来，接着跑或只重跑挂掉的那个 | `run` 增 `--resume <runId>`（复用上轮 sessionId）；TUI 增 `/retry <id>` 只重跑失败 agent；复用已实现的 `session/load`（`AcpRuntime.ts:539-557`） | **M** | **P0** |
| E3 | **工具活动流** | 看得见 agent 真正在 Grep / Edit / Bash 什么 | 把 `tool_call`/`tool_result` 事件接入 stream（或独立 lane），默认折叠、`/verbose` 展开；只改 `AgentRunner.ts:89-104` 的过滤条件 | **S/M** | **P0** |
| E4 | **交付物摘要** | run 结束一行告诉你产出了什么 | 结束时扫描本轮 `workDir` 新增/修改文件（mtime 对比 run 起点）+ 列各 agent 主产物；写入 `report.json` 并打印 | **S/M** | **P1** |
| E5 | **计划预览 / dry-run** | 跑之前先看 leader 选谁、分几阶段 | `run --dry-run`：跑 leader 但不执行 pipeline，打印决策；TUI 侧在提交后、执行前短暂展示决策行 | **S** | **P1** |
| E6 | **模型告警进控制台** | 配错模型时当场可见，而不是静默跑默认 | `AcpRuntime.ts:591-593` 的 stderr 改发 `orchestration:warning`（事件类型已存在，`types/event.ts:35-39`） | **S** | **P1** |
| E7 | **turn 导出 `/export`** | 把某一轮存成 markdown 交付/归档 | `/export [n] [path]`：把 requirement / roster / stream / reply 序列化为 md | **S** | **P2** |
| E8 | **成本预算护栏** | 花到上限自动停，避免失控 | config 增 `maxCostUsd`；累计 cost 超阈值时 `abort`，复用既有取消路径（`Orchestrator.ts:110-114`） | **M** | **P2** |
| E9 | **会话持久化** | 关掉再打开，历史还在 | TUI 层把 history 落 jsonl（`workDir/.multiclaw/sessions/`），启动时载入；不触碰 core 无 session 约束 | **M** | **P2** |

**建议落地顺序**：E6（改 2 行）→ E3（改 1 处过滤）→ E1（plumbing，解锁 E8）→ E2（复用已实现能力）→ E4/E5 → 其余。

---

## 5. 竞品参照

| 维度 | **multiclaw** | Claude Code | Cursor CLI (`agent`) | opencode | aider | Codex CLI |
|------|---------------|-------------|----------------------|----------|-------|-----------|
| 形态 | 编排 CLI + 全屏 TUI | 终端 agent（含 subagents） | IDE 内 + CLI（ACP） | 开源终端 agent（TUI） | 终端 pair-programmer | 终端 agent |
| **多 agent 编排** | ✅ 声明式依赖图 pipeline（`dependsOn` → 拓扑分阶段） | ⚠️ subagents/agent teams，非声明式依赖图 | ⚠️ 有限 | ❌ 单 agent | ❌ 单 agent loop | ⚠️ 云端并行 |
| **跨 provider 混编** | ✅ 单队内逐 agent 选 claude/opencode/codex/cursor | ❌ 仅 Anthropic | ❌ 仅 Cursor 模型 | ⚠️ 多模型但同一 harness | ⚠️ 多模型单 agent | ❌ 仅 OpenAI |
| **模型分档抽象** | ✅ tier（strong/balanced/fast）跨 provider 映射 | ⚠️ 逐 agent 指定 | ⚠️ | ⚠️ | ✅ 弱/强模型分工 | ⚠️ |
| 路由/意图分流 | ✅ leader 三态 run/reply/ask | ⚠️ 靠主 agent 判断 | — | — | — | — |
| 控制台体验 | ✅ turn-based conductor、队列、历史回看 | ✅ 强 | ✅ IDE 内 | ✅ TUI 强 | ✅ git 集成强 | ✅ 沙箱 |
| **成本/用量可见** | ❌（数据已算出未展示） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 沙箱/权限审批 | ❌（fail-closed 自动决策） | ✅ 权限提示 | ✅ | ✅ | ⚠️ | ✅ 沙箱 |
| git 集成 / auto-commit | ❌ | ⚠️ | ⚠️ | ⚠️ | ✅ 强 | ⚠️ |
| 生态成熟度 | ❌ 新（npm 包） | ✅ 高 | ✅ 高 | ✅ 中高 | ✅ 高 | ✅ 高 |

**multiclaw 的差异化优势（要守住）**
1. **唯一"声明式依赖图 + 跨 provider 混编"**：竞品要么单厂商，要么单 agent，要么编排不可声明。
2. **tier 抽象让同一份配置跨厂商自动正确**——换 provider 不用重写 12 个 agent。
3. **leader 三态路由**把"要不要动用全队"变成编排的第一等公民，避免"打招呼烧掉一支团队"。

**明显短板（要补）**
1. **成本/用量完全不可见**——在多 provider 场景这是致命短板，且数据现成（P0-1）。
2. **无沙箱、无权限审批交互**——安全与信任感弱于 Claude Code / Codex。
3. **无 git 集成**——交付环节弱于 aider。
4. **单厂商深度**：Claude Code 的 hooks / CLAUDE.md 记忆 / 权限体系更厚；multiclaw 靠"编排"而非"单 agent 能力"取胜，需守住这条线。

---

## 6. 不做什么（划定边界，避免范围膨胀）

1. **不做通用 chat / 对话式 agent**——TUI 是 turn-based conductor（README L219-224），不是聊天框；引入自由对话会瓦解"一轮=一次完整编排"的模型。
2. **不新增裸键**——尊重 `?` `/` 仅两个保留键的决策（README L265-269）；所有新能力走 `/` 命令或既有命名键，保证"打字不撞快捷键"。
3. **不加宽 `AgentRuntime` 接口**（已发布导出，加宽即破坏性变更）——用量/探测一律走自由函数与既有 `AgentOutput` 字段（RFC §4.2、§11）。
4. **不在 core 引入 session 概念**——会话持久化放 TUI/CLI 层（`types/config.ts:26-33` 明确 core 无 session）。
5. **不做 IDE / 编辑器插件**——差异化在 CLI 编排层，不分散到 IDE 战场。
6. **不在 `AcpRuntime` 写 provider 特有分支**——一律经 catalog（RFC §6.4）。
7. **v1 不做权限审批 UI 的大改**——`decidePermission` 的 fail-closed 是安全基线（`AcpRuntime.ts:150-191`），交互式审批列为 P2，需单独设计，不与本期混做。

---

## 7. 待确认问题（需作者拍板）

1. **成本/用量是否纳入近期范围？** 数据现成、plumbing 成本低，但需确认 ACP `usage_update` / `cost` 在各 provider 的真实可用性（同 RFC §10 V1 的验证方式）。**这是投入产出比最高的单点。**
2. **`init` 是否应默认写入 `leader: agents.leader()`？** 当前不写，导致新用户首次体验缺失核心卖点（P1-4）。若要改，需确认与"init 不加 leader 相关问题"的既有决策（RFC §7.2）不冲突——**建议"默认加、不额外提问"**。
3. **失败恢复的语义选哪种？** `run --resume <runId>`（复用 session 续跑整轮）vs TUI `/retry <id>`（只重跑失败 agent）vs 两者都做？是否要顺带调整 `continueOnError` 的现有语义（`Orchestrator.ts:137-161`）？
4. **是否引入成本护栏 `maxCostUsd`？** 它会新增一条 Orchestrator 中止路径（复用 `abort`），需确认是否接受对 core 的这一改动。
5. **cursor provider 的真机验证（RFC §10 V2-V5）是否阻塞本次发布？** 未验证时它在 `init` 里会以"未验证"状态出现，可能误导用户。

---

### 附：本次评估的证据锚点速查

- 用量/成本被丢弃：`types/runtime.ts:105-117`（有字段）→ `AcpRuntime.ts:625-626`（已填充）→ `AgentRunner.ts:72-106`（只取 `.output`）→ `types/agent.ts:64-74`（`AgentResult` 无字段）
- 工具调用被过滤：`types/runtime.ts:25-26`（有事件）→ `AgentRunner.ts:89-104`（只转发文本）
- 续跑能力未接线：`types/runtime.ts:90-93` + `AcpRuntime.ts:539-557`（已实现）→ `AgentRunner` 从不传 `sessionId`
- 失败即弃：`Orchestrator.ts:137-161`；headless 独立目录 `run.ts:23-24`
- 模型告警进 stderr：`AcpRuntime.ts:591-593`（事件类型 `types/event.ts:35-39` 现成）
- init 不含 leader：`init.ts:8-34`（`AGENT_BLOCKS` 无 `agents.leader()`）
