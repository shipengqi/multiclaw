# Batch 4「上下文」独立验证报告

> 验证人：严过关（Yan）· QA 工程师
> 日期：2026-10-13
> 仓库：`/Users/C5406922/code/multiclaw`（HEAD `e8b45f8`，Batch 4 改动为工作区未提交改动）
> 设计说明：`deliverables/software-company/multiclaw-batch4-plan-2026-10-13.md`
> 立场：独立证伪，不盖章。所有断言均为自写，未复用工程师用例。

---

## 判定

**PASS WITH ISSUES**

- 工程师「全绿、IS_PASS: YES」的核心事实**成立**：`renderUpstreamOutputs` 的省略计数**真实**、
  `Prompt` 的 1:1 替换**成立**、只注入 success、preset 不变量成立、无既有测试被削弱、全量质量门禁通过。
- 发现 **2 项 P2 文档/边界不一致** + **1 项 P2 防御性代码说明**，均不影响本批功能正确性，无需返工，
  建议随手修（见「遗留问题清单」）。
- **无 P0 / P1**。

### 遗留问题清单

| 级别 | 问题 | 位置 | 影响 |
|------|------|------|------|
| **P2** | `MAX_UPSTREAM_CHARS` 注释称「the whole rendered block」的 ceiling，但代码只对**拼接后的 entries** 限流；完整渲染串（含 `## What upstream produced` 标题与尾换行）最多可达 **4028**，超出常量 28。 | `packages/core/src/utils/upstream.ts:30`（注释）vs `:105`（实现） | 提示词实际长度上限为 4000+标题≈4028；纯文档/命名不一致，无功能影响。 |
| **P2** | `{{upstreamOutputs}}` 独占一行时，空值渲染会**残留一个空行**（模板中该行变成空行）。设计已排除「悬空标题」，但未处理「空行」。 | 11 个 preset 的 `TASK` 模板 + `renderUpstreamOutputs` 返回 `""` | 提示词多一个无害空行；无悬空 `##` 标题（已逐条验证）。 |
| **P2（说明）** | `Prompt` 的 `\r` 清理**非 1:1**（`shown.length < value.length`）。若 `\r` 到达 `Prompt`，光标会偏移 `\r` 个数。但 `App.insert` 已归一化，且**无任何其他路径**能把 `\r` 写进 `line.text`。 | `packages/dashboard/src/tui/components/prompt.tsx:35` | 当前**不可达**；仅当未来有调用方绕过 `insert` 才成风险。属防御性代码，建议加注释而非删改。 |

---

## 验证环境与方法说明

- 所有独立断言脚本写在 `/tmp`（V1/V2/V3/V4）或**临时置于包内、运行后立即删除**（V5/V6/dist 校验，
  因需 JSX/Ink 的 ESM 解析）。
- **临时改动与恢复**：为 V5/V6 渲染真实 `Prompt`/`App`，临时新增了 3 个验证脚本
  （`packages/dashboard/verify-b4-v5.manual.tsx`、`packages/dashboard/verify-b4-v6.manual.tsx`、
  `packages/core/verify-dist.mts`），**均已删除**。另为 V2.3 临时执行 `git stash` / `git stash pop`。
  验证后确认：`git stash list` 为空、`git rev-parse HEAD` 仍为 `e8b45f8`、`git status --porcelain`
  与初始完全一致（19 个 `M` + 4 个 `??`）。**未 commit，未修改任何源码。**
- **dist 新鲜度**：发现 `packages/core/dist/index.js`（mtime 09:16:22）**早于**源码
  `upstream.ts`（mtime 09:21:09）。因此**先 `pnpm build` 再跑 dashboard 测试**（dashboard 通过
  `@multiclawcli/core` → dist 解析）。V8 末尾用 dist 的 `Orchestrator` 复验注入行为，确认 dist 与源码一致。

---

## V1 `renderUpstreamOutputs` 的数学与边界（最高优先级）

### 【验证方法】
自写脚本 `/tmp/verify-v1.ts`、`/tmp/verify-v1b.ts`、`/tmp/verify-v1c.ts`，直接 import 源码
`packages/core/src/utils/upstream.ts`。对单条结果：从渲染串中**解析标记里的 N**，独立计算
「真实被略去的字符数 = 原文长度 − 保留头长 − 保留尾长」，断言相等；并用重建恒等式
`keptHead + 原文中段 + keptTail === 原文` 交叉验证。缩进区分法：条目格式为
`- <name> (<id>):\n  <body>`，续行前缀固定为 **2 个空格**，去掉前缀即得原文。

### 【实际结果】
```
=== constants ===
PASS  MAX_UPSTREAM_ENTRY_CHARS === 600
PASS  MAX_UPSTREAM_CHARS === 4000
=== V1.5 empty input ===
PASS  renderUpstreamOutputs([]) === ''
PASS  no dangling heading on empty
=== V1.6 determinism ===
PASS  two calls byte-identical  :: len=952
=== V1.2 single-entry length ceiling (599/600/601/5000/50000) ===
PASS  len 599: body ≤ 600  :: body.len=599
PASS  len 600: body ≤ 600  :: body.len=600
PASS  len 601: body ≤ 600  :: body.len=599
PASS  len 5000: body ≤ 600  :: body.len=600
PASS  len 50000: body ≤ 600  :: body.len=600
=== V1.1 elided count must be truthful ===
PASS  len 601:  N=28     real=28
PASS  len 1234: N=662    real=662
PASS  len 5000: N=4428   real=4428
PASS  len 50000:N=49429  real=49429
PASS  len 123456:N=122886 real=122886
PASS  （每例均含：starts with original head / ends with original tail / kept+N===original / reconstruction===original）
=== V1.1b digit-boundary sweep (600,601,610,900,999,1000,1001,10000,10001,100000,100001) ===
PASS  digit-boundary sweep: every marker count truthful  :: bad=0
=== V1.3 continuation indent is exactly 2 spaces ===
PASS  V1.3 continuation indent is exactly 2 spaces
   raw block repr: "\n## What upstream produced\n\n- tester (tester):\n  HEAD_LINE\n  body-line-1\n  body-line-2\n  TAIL_LINE\n"
=== V1.4 budget ===
PASS  newest entry kept (agent-19) / oldest dropped (agent-0)
PASS  joined entries ≤ MAX_UPSTREAM_CHARS  :: bodyOnly=3749
=== V1.8 constants actually used ===
PASS  boundary exactly at 600 (600 intact) / (601 compacted)
```

**V1.4 反例（证明完整串可越界）**，`/tmp/verify-v1c.ts` 暴力扫描：
```
MAX full block length = 4028 (bodyLen=148, entries=26)
MAX_UPSTREAM_CHARS = 4000
overshoot = 28
=> FULL rendered string EXCEEDS the documented 'whole rendered block' ceiling
Example over-budget: bodyLen=556, entries=8, full=4004
```

### 【结论】
- **省略计数真实（V1.1）**：`compact()` 用 `elided = trimmed.length − keep`，而实际保留的正是
  `head + tail = keep` 个字符，二者恒等；重建恒等式在 601 / 1234 / 5000 / 50000 / 123456 及全部
  位数边界上均成立。**没有硬编码伪造**。
- 单条结果长度恒 ≤ 600（599/600/601/5000/50000 全过）。
- 头尾都在：以原文头起、以原文尾止，缩进为精确 2 空格。
- 空输入 `=== ""` 且不含标题；确定性成立；空/纯空白/阈值边界不抛错。
- `MAX_UPSTREAM_ENTRY_CHARS`/`MAX_UPSTREAM_CHARS` 均被真实引用（源码中 600/4000 仅出现在常量声明行）。
- **唯一瑕疵（P2）**：`MAX_UPSTREAM_CHARS` 是「entries 之和」的上界，而非「完整渲染串」的上界；
  完整串最大 4028。工程师的用例其实已把标题算在预算之外（`HEADING` 常量），属**有意**选择，
  但与常量注释措辞矛盾。**功能无影响。**

---

## V2 「无上游时行为不变」的独立证伪

### 【验证方法】
`/tmp/verify-v23.mts`：构造单 stage run，捕获下游 agent 的 prompt；再用 `(orch as any).contextManager`
读取构造后的键值。V2.3 用 `git stash`（仅 tracked）跑同一脚本取得改动前 prompt，`diff` 对比后 `git stash pop`。

### 【实际结果】
```
=== V2.2 constructor sets upstreamOutputs to '' ===
PASS  key 'upstreamOutputs' exists
PASS  value is ''  :: ""
PASS  conversation also present and ''
=== V2.1 single-stage run: no upstream section, no literal placeholder ===
PASS  prompt has no heading  :: "BEFORE\n\nAFTER"
PASS  prompt has no literal placeholder
PASS  prompt preserves surrounding text
```
V2.3 改动前 vs 改动后（同脚本、同 `agents.architect()` 模板）：
```
$ diff /tmp/prompt-before.txt /tmp/prompt-after.txt
10a11
> 
```
上下文（before 21 行 / after 22 行）：
```
BEFORE 8: [The following agents will run in this pipeline (id: name):]
       9: [architect: Architect]
      10: []
      11: [## Task]
AFTER  8: [The following agents will run in this pipeline (id: name):]
       9: [architect: Architect]
      10: []
      11: []        <-- 唯一差异：模板新增那一行渲染成的空段
      12: [## Task]
```

### 【结论】
- 单 stage 下游 prompt **既无** `## What upstream produced`，**也无**字面量 `{{upstreamOutputs}}`。
- 构造后 `contextManager` 中 `upstreamOutputs` 键**存在且为 `""`**（与 `conversation` 同约定）。
- 无上游场景下改动前/后 prompt 全文**仅差一行空段** —— 完全落在任务允许的差异内。
- **恢复确认**：`git stash pop` 后 `git stash list` 为空、HEAD 不变、`git status` 与初始一致。

---

## V3 只注入 success 的产出

### 【验证方法】
`/tmp/verify-v23.mts`：stage 0 放 `ok-agent`（产出含 `OK_MARKER`）与 `bad-agent`（抛错），
`continueOnError: true`，stage 1 为 `down`，捕获下游 prompt。

### 【实际结果】
```
=== V3.1 only successful agents enter the upstream block ===
PASS  downstream prompt contains OK_MARKER
PASS  downstream prompt does NOT contain FAILED_MARKER (bad agent name)
PASS  downstream prompt has the heading (one success exists)
PASS  bad-agent id not named as producer
=== V3.2 all of stage 0 fail -> no upstream section downstream ===
PASS  downstream prompt has NO heading
PASS  downstream prompt has NO literal placeholder
=== V3.3 cancelled result excluded from upstream (filter is success-only) ===
PASS  only success kept  :: ["S_OK"]
```

### 【结论】
- 失败 agent 的产出**不进**上游块（下游含 `OK_MARKER`、不含失败者名字）。
- stage 0 全失败 → 下游无上游段（走 `renderUpstreamOutputs([])` 路径）。
- **cancelled / skipped 不进上游块**：全仓 `upstreamOutputs` 只有两处写入
  （`Orchestrator.ts:43` 构造 `""`、`:124` 循环写入），循环处谓词为
  `filter((r) => r.status === "success")`（`:127`）——**只放行 success**，无别处把
  cancelled/skipped 计入。补充事实：`skipped` 从不进 `results`（只发 `agent:skipped` 事件）；
  `cancelled` 虽进 `results`，但中止会 `break` 循环，故其后的 stage 根本不会运行。
  **双重保证：即使能进下游，也会被 success 谓词挡掉。**

---

## V4 preset 不变量

### 【验证方法】
`/tmp/verify-v4.mts`：遍历 `agents` 命名空间；对每个非 leader preset 断言含 `{{upstreamOutputs}}`、
leader 不含；检查占位符**独立成行**、**无悬空 section 标题**；并做**拼写误写**扫描
（`{{upstreamOutput}}` / 大小写变体）。

### 【实际结果】
```
presets: leader, architect, productManager, backendDeveloper, frontendDeveloper, tester,
         reviewer, archDesignReviewer, uiDesigner, uiDesignReviewer, codeReviewer, devops  (count=12)
=== V4.1 ===  leader 无；其余 11 个各含 1 次  —— 全 PASS
=== V4.2 typo hunt ===  12 个 preset 均无拼错  —— 全 PASS
=== V4.3 placeholder is on its OWN line, no dangling section heading ===
PASS  architect: placeholder is alone on its line  :: "{{upstreamOutputs}}"
PASS  architect: no dangling heading when empty
（11 个非 leader preset 逐一 PASS）
=== V4.4 占位符前一行（上下文）===
   architect          prev = "{{pipelineAgents}}"
   productManager     prev = "{{requirement}}"
   backendDeveloper   prev = "{{agentPlan}}"
   frontendDeveloper  prev = "{{agentPlan}}"
   tester             prev = "{{agentPlan}}"
   reviewer           prev = "{{requirement}}"
   archDesignReviewer prev = "{{file:api-spec.md}}"
   uiDesigner         prev = "{{agentPlan}}"
   uiDesignReviewer   prev = "{{file:ui-design.md}}"
   codeReviewer       prev = "{{file:api-spec.md}}"
   devops             prev = "{{agentPlan}}"
```

### 【结论】
- 除 leader 外 11 个 preset 的 `taskPrompt` 均含 `{{upstreamOutputs}}`，leader **不含**。
- 占位符**独立成行**、前后**无额外 section 标题** → 空值**不会**留悬空 `## ...` 标题（逐条验证）。
- 无拼写误写（不会因错别字导致占位符以字面量进提示词）。
- **附带发现（P2）**：占位符独立成行 → 空值时该行变空行，残留 1 个空行（见 V2.3 的 `10a11`）。
  设计已排除悬空标题，但未处理空行；属无害装饰问题。

---

## V5 `Prompt` 的 1:1 替换与 caret（重点）

### 【验证方法】
临时脚本 `packages/dashboard/verify-b4-v5.manual.tsx`（`FORCE_COLOR=1`，与 vitest 同配置），
渲染真实 `Prompt` 组件，`stripAnsi` 后测量 `before+cell+tail === shown`，并直接检查原始 ANSI 里
`\u001b[7m`（inverse）落在哪个字符上。**用例全部自写**（`cursor=2` 落在 `\n` 等）。

### 【实际结果】
```
=== V5.1 1:1 — shown length must equal value length (no \r) ===
PASS  len("ab\ncd")=5 -> shown=5  :: shown="ab↵cd"
PASS  len("a\nb")=3   -> shown=3  :: shown="a↵b"
PASS  len("a\n\nb")=4 -> shown=4  :: shown="a↵↵b"
PASS  len("\n")=1     -> shown=1  :: shown="↵"
PASS  len(20x+\n+20y)=41 -> shown=41
（每例：no real newline in output / one glyph per \n）
=== V5.2 caret sits ON the newline cell (cursor=2 on 'ab\ncd') ===
PASS  inverse marker lands on the newline glyph  :: "\u001b[36m› \u001b[39mab\u001b[7m↵\u001b[27mcd\n"
PASS  before === 'ab'
PASS  shown === 'ab↵cd'
=== V5.3 caret AFTER the newline (cursor=3) ===
PASS  inverse wraps 'c'  :: "...ab↵\u001b[7mc\u001b[27md\n"
=== V5.4 consecutive newlines 'a\n\nb' at cursor 1/2/3 ===
PASS  cursor=1: inverse on "↵"  :: "...a\u001b[7m↵\u001b[27m↵b\n"
PASS  cursor=2: inverse on "↵"  :: "...a↵\u001b[7m↵\u001b[27mb\n"
PASS  cursor=3: inverse on "b"  :: "...a↵↵\u001b[7mb\u001b[27m\n"
=== V5.5 ghost判定 ===
PASS  empty: placeholder shown / caret onto first placeholder char 'd'
PASS  '\n': placeholder NOT shown / shows the newline glyph
=== V5.6 \r removal is NOT 1:1 (theoretical) ===
   value="a\r\nb" len=4 -> shown="a↵b" len=3
PASS  \r IS stripped from display
PASS  shown.length !== value.length (so caret would drift if \r arrived)
=== RESULT: ALL PASS ===
```

### 【结论】
- **1:1 成立**：对 `ab\ncd`、`a\nb`、`a\n\nb`、`\n`、含长行的多组输入，`shown.length === value.length`
  （`\n`→`↵` 一字符换一字符），且输出中**无真实换行**。→ caret 算术零改动的声明**成立**。
- 光标落在换行符上（`cursor=2`，`ab\ncd`）：`inverse` 精确落在 `↵` 上，`before="ab"`、`tail="cd"`。
- 光标在换行符之后（`cursor=3`）：`inverse` 落在 `c`。
- 连续换行 `a\n\nb` 的 cursor 1/2/3 逐位正确。
- `ghost` 判定正确：`value===""` → placeholder 分支；`value==="\n"` → **非** ghost。
- **`\r` 说明（P2）**：`\r` 清理**非 1:1**（`shown` 短于 `value`）。但**独立确认整条路径**：
  `Prompt` 仅被 `App.tsx:827` 使用，`value={line.text}`；`setLine` 的**全部**调用点为
  `EMPTY_LINE` / `insert`（`char.replace(/\r\n?/g,"\n")` 归一化）/ `backspace`/`deleteForward`（切片）/
  `move`/`moveTo`（仅改 cursor）。**无任何路径能把 `\r` 写入 `line.text`**（初值 `EMPTY_LINE` 亦无）。
  故 `\r` 清理当前**不可达**，非真实风险；建议在注释里点明「1:1 前提是调用方已归一化」。

---

## V6 提交的 requirement 保留换行

### 【验证方法】
临时脚本 `packages/dashboard/verify-b4-v6.manual.tsx`，用 `driveFrame` 驱动**真实 `App`**，
runtime 的 leader `taskPrompt="{{requirement}}"`，故 leader 收到的 prompt **就是**提交的 requirement。

### 【实际结果】
```
=== V6.1 paste 'a\nb' preserves the newline ===
PASS  requirement === 'a\nb'  :: "a\nb"
PASS  NOT flattened to 'a b'
=== V6.2 Windows line ending 'a\r\nb' -> 'a\nb' ===
PASS  requirement === 'a\nb' / no CR remains
=== V6.3 lone CR 'a\rb' -> 'a\nb' ===
PASS  requirement === 'a\nb'
=== V6.4 single-line regression: insert at caret ===
PASS  'ac' + left + 'b' === 'abc'
=== V6.5 single-line regression: backspace deletes before caret ===
PASS  'abc' + left left + backspace === 'bc'
=== V6.6 multi-line stack trace kept whole ===
PASS  requirement === "Error: boom\n  at a.ts:1\n  at b.ts:2"
=== V6.7 paste starting with '/' and containing a newline ===
   leader prompt = ""
   frame mentions 'unknown agent'? true
=== V6.8 '/agents' style pure command still works ===
PASS  pure command does not reach the leader
```

### 【结论】
- 粘贴 `"a\nb"` → 提交的 requirement 是 `"a\nb"`（**不是** `"a b"`）。
- `"a\r\nb"` 与 `"a\rb"` 均归一化为 `"a\nb"`（无 `\r` 残留）。
- 单行回归：中间插入、backspace 均落在光标处（非「永远在末尾」）。
- **`\n` 对 `parseCommand`/`menuQuery`/`isCommandLine` 的影响（实际构造）**：粘贴
  `"/focus\nagent1"` → `isCommandLine`（`startsWith("/")`）为真 → `parseCommand` 用
  `text.slice(1).trim().split(/\s+/)`，`\n` 视同空白 → 解析为 `name="focus", args=["agent1"]`
  → 执行 `/focus agent1` → 界面提示 `unknown agent: agent1`（leader 未运行）。`menuQuery` 因
  `/\s/.test(rest)` 为真而返回 `undefined`（面板关闭）。**结论：可接受** —— 以 `/` 开头即进入命令模式，
  换行与空格在此等价；且该行为是既有的（`isCommandLine` 未改），本批未引入新风险。纯命令
  `/agents` 仍正常，不会误触发一轮 run。

---

## V7 测试有没有被削弱

### 【验证方法】
`git diff` 全部 `*.test.ts` / `*.test.tsx`；全仓 grep 跳过/独占标记；grep 快照断言。

### 【实际结果】
```
$ git diff -- '*.test.ts' '*.test.tsx' | grep -E '^-[^-]'
(no removed lines at all)

$ git diff --stat -- '*.test.ts' '*.test.tsx'
 packages/core/src/agents/index.test.ts             | 14 ++++
 packages/core/src/orchestrator/Orchestrator.run.test.ts | 64 ++++++++++++++++
 packages/dashboard/src/tui/App.run.test.tsx        | 89 ++++++++++++++++++++++
 packages/dashboard/src/tui/components.test.tsx     | 16 ++++
 4 files changed, 183 insertions(+)

$ grep -rn "\b(it|test|describe)\.(skip|todo|only)\b|\b(xit|xdescribe|xtest)\b" packages
(No matches found)
$ grep -rn "toMatchSnapshot|toMatchInlineSnapshot|toMatchFileSnapshot" .
(No matches found)
```
`components.test.tsx` 的 16 行全部为新增：1 行 `import { GLYPH } from "./theme"` + 2 条新用例
（`draws a pasted newline as the newline glyph`、`keeps the caret on the cell under it when it sits on a newline`），
**无任何既有断言被改动**。

### 【结论】
- **没有任何既有断言被删除/放宽/跳过**（测试文件 183 行全为新增，`grep '^-[^-]'` 零命中）。
- 全仓 `it.skip` / `it.todo` / `.only` / `xit` / `xdescribe` / `xtest` **0 命中**。
- `components.test.tsx` 的 `import { GLYPH }` 确为**纯 import 追加**。
- 全仓**无快照测试**（独立复核 `toMatchSnapshot`/`toMatchInlineSnapshot`/`toMatchFileSnapshot` 均 0 命中）。
- 工程师「未改既有断言、只追加」的说法**核实为真**。

---

## V8 全量质量门禁

### 【验证方法】
`pnpm lint` / `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm test:coverage`；
跑 dashboard 前先 `pnpm build`（因 dist 曾早于源码）。

### 【实际结果】
```
===== LINT =====      $ biome check .
Checked 126 files in 52ms. No fixes applied.                       (EXIT 0)
===== BUILD =====     core index.js 81.86 KB / dashboard tui.js 64.01 KB / cli index.js 31.25 KB  (EXIT 0)
===== TYPECHECK ===== tsc × 3 packages, no errors                   (EXIT 0)
===== TEST (recursive pnpm test) =====
  core:      Test Files 22 passed (22)   Tests 340 passed (340)
  dashboard: Test Files  8 passed (8)    Tests 323 passed (323)
  cli:       Test Files  9 passed (9)    Tests  81 passed (81)      (EXIT 0, 2m53s)
```
覆盖率（`test:coverage`，阈值 core 90/85/90/90、cli 50/45/40/50、dashboard 90/85/90/90）：
```
core      All files 97.13 | 92.53 | 94.88 | 98.03   —— 全过；upstream.ts 100/100/100/100；Orchestrator.ts 100/98.59/100/100
dashboard All files 99.36 | 96.26 | 100   | 99.61   —— 全过
cli       All files 76.07 | 70.08 | 75.80 | 76.61   —— 全过
```
dist 新鲜度复验（用 dist 的 `Orchestrator` 跑两 stage）：
```
PASS  dist Orchestrator injects upstream block
   downstream prompt head: "\n## What upstream produced\n\n- First (first):\n  DIST_UPSTREAM_OK\n"
```

### 【结论】
- `lint` / `build` / `typecheck` / `test` / `test:coverage` **全绿**；三个包覆盖率**均不破线**。
- dashboard 测的是 core 的 dist —— 已确认**先 build 再测**，且 dist 行为与源码一致。
- **过程说明（非缺陷）**：首次 `pnpm test | tail` 曾因资源压力被 SIGKILL（exit 137）；单独分包重跑
  全部通过，随后**无管道重跑 `pnpm test` 亦 EXIT 0**。判定为环境瞬时内存压力，**与本次改动无关**，
  已用真实输出为证。

---

## 附：验证用脚本与命令（可复现）

- `/tmp/verify-v1.ts`、`/tmp/verify-v1b.ts`、`/tmp/verify-v1c.ts` → V1
- `/tmp/verify-v23.mts` → V2/V3
- `/tmp/verify-v4.mts` → V4
- （临时，已删）`packages/dashboard/verify-b4-v5.manual.tsx` → V5；`.../verify-b4-v6.manual.tsx` → V6；
  `packages/core/verify-dist.mts` → dist 校验
- 运行示例：`npx tsx /tmp/verify-v1.ts`；
  `FORCE_COLOR=1 npx tsx --tsconfig packages/dashboard/tsconfig.json <harness>`

**最终状态**：HEAD `e8b45f8` 未变；工作区与初始一致（19 `M` + 4 `??`）；未 commit；未修改源码。

---

# §Round 2 —— 定向复核（F1/F2/F3 + 断言收紧判定）

> 触发：工程师按 Round 1 的 3 条 P2 做了小改动。本轮只验 4 点（R2-1 ~ R2-4），不铺开。
> 时间：2026-10-13；HEAD 仍 `e8b45f8`。

## 改动概览（我方独立核对）
- `packages/core/src/utils/upstream.ts`：新增 `HEADER`/`TRAILER` 与私有 `block(entries)`；
  限流判据 `entries.join("\n").length` → **`block(entries).length`**（对完整返回串限流）；
  `MAX_UPSTREAM_CHARS` 文档补「标题与尾部换行都计入」；空值分支加注释。**仅注释 + 上述逻辑改动。**
- `packages/dashboard/src/tui/components/prompt.tsx`：仅**扩写注释**（代码行逐字不变，见 R2-3）。
- `packages/core/src/utils/upstream.test.ts`（未跟踪）：删 `HEADING` 常量、改一条断言、加一条用例。

## 判定

**PASS**（F1 修复有效，断言为**合法收紧**；无新增 P0/P1/P2）

---

## R2-1 那条被改的断言是**收紧**还是**放宽**？ → **合法收紧**

### 【验证方法】
`upstream.test.ts` 是**未跟踪**文件，`git diff` 对其为空。故把我 Round 1 读到的原始内容逐字写入
`/tmp/upstream.test.round1.ts`，与当前文件做 `diff -u`。

### 【实际结果】
```
$ git diff -- packages/core/src/utils/upstream.test.ts
(空 —— 文件未跟踪，无 HEAD 版本可比)
$ diff -u /tmp/upstream.test.round1.ts packages/core/src/utils/upstream.test.ts
@@ 删除：
-/** The block's own framing, which is charged on top of the character budget. */
-const HEADING = "\n## What upstream produced\n\n".length + 1
@@ 改动（同一用例 "drops the oldest outputs..."）：
-    // The budget covers the entries; the heading is charged on top of it.
-    expect(block.length).toBeLessThanOrEqual(MAX_UPSTREAM_CHARS + HEADING)
+    // The budget covers the whole rendered block, heading included.
+    expect(block.length).toBeLessThanOrEqual(MAX_UPSTREAM_CHARS)
     expect(block).toContain("ENTRY-9")
     expect(block).not.toContain("ENTRY-0")
@@ 新增：
+  it("keeps the whole rendered block within the budget", () => { … 8 × 476 … ≤ MAX_UPSTREAM_CHARS })
```

### 【逐点判定】
- **旧断言断的是什么**：`block.length ≤ MAX_UPSTREAM_CHARS + HEADING` = `≤ 4029`（把标题 29 字算在预算之外）。
- **新断言断的是什么**：`block.length ≤ MAX_UPSTREAM_CHARS` = `≤ 4000`（**返回串本身**）。
- **对象**：两者断言的是**同一个对象** `block.length`（返回串长度），并非「覆盖更大对象」。
- **强弱**：新界（4000）**严格强于**旧界（4029）——任何满足新断言的实现必满足旧断言，反之不然。
  → **不是放宽，是收紧。**
- **是否丢掉对 entries 的约束**：**没有**。`toContain("ENTRY-9")`（最新保留）与
  `not.toContain("ENTRY-0")`（最旧丢弃）两条 entries 约束**原样保留**。
- **是否降级算子**：无。`toBeLessThanOrEqual` 未变；未删任何断言（`diff` 中除上述外无其他删除）。
- **工程师的理由是否成立**：成立。旧断言在 F1 收紧语义后确实**自相矛盾**（它允许 4029，与新承诺
  「返回串 ≤ 4000」冲突）。**改得对。**

### 【结论】**合法收紧**。新断言比旧断言更强，且未丢失任何既有约束。

---

## R2-2 独立复验 F1 的新承诺（自写用例）

### 【验证方法】
`/tmp/verify-r2.ts`（自写，未复用工程师用例）。构造输入断言 `renderUpstreamOutputs(x).length ≤ 4000`，
并模拟 OLD 逻辑对比。

### 【实际结果】
```
=== R2-2a 我 Round-1 的反例（8 条 × 单字符 id × 556 字）===
   unconstrained full (no dropping) = 4572
   OLD code returned length         = 4004  (7 entries)   ← Round 1 实测的越界值
   NEW returned length              = 3436                 ← 现在 ≤ 4000 ✅
PASS  NEW returned <= 4000  :: 3436
PASS  NEW dropped at least one entry
=== R2-2b 工程师用例（8 × 476）===
   returned length = 3528   (NEW)      —— 而 OLD 为 4028（见下）
=== R2-2c 恰好卡边界（构造 full == 4000：12 条 × body 319）===
   returned length = 4000
PASS  exactly 4000 kept intact  :: 4000
PASS  all 12 entries present
=== R2-2d 刚超一点（暴力找最小越界输入：n=26, body=141, unconstrainedFull=4006）===
   NEW returned length = 3853 (dropped 1)
PASS  returned <= 4000 / dropped >= 1 entry
=== R2-2e 穷举扫描 body∈[1,600] × n∈[1,26] ===
   max returned length over sweep = 4000 (n=12 body=319)
PASS  sweep: max <= 4000
=== R2-2f 单条 600 上限仍生效 ===
PASS  len 599/600/601/5000/50000: body <= 600
=== R2-2g 省略计数仍真实（重建恒等式）===
PASS  len 601:   N === real elided  :: N=28
PASS  len 50000: N === real elided  :: N=49429
PASS  （两例 reconstruction === original 均成立）
=== R2-2h 空输入 ===
PASS  renderUpstreamOutputs([]) === ''
```
OLD 逻辑对 8 × 476 的模拟（`npx tsx -e`）：`OLD returned: 4028 entries: 8`（`join(8)=3999 ≤ 4000` 故不丢弃）。
→ 工程师「回退时报 `expected 4028 to be less than or equal to 4000`」的说法**核实为真**：
新用例在旧逻辑下**确实会红**。

### 【结论】
- **F1 修复有效**：完整返回串恒 ≤ 4000（穷举扫描最大正好 4000，说明预算被精确、无浪费地利用）。
- Round 1 反例（8 × 556）从 OLD 的 **4004** 降到 NEW 的 **3436**；工程师用例（8 × 476）OLD **4028** → NEW **3528**。
- 恰好 4000 的构造被**原样保留**（不误丢）；刚越界的最小输入正确丢 1 条。
- `MAX_UPSTREAM_ENTRY_CHARS`（单条 600）**仍生效**，未被 F1 破坏。
- 省略计数**仍真实**（重建恒等式抽验 601/50000 通过）。

---

## R2-3 注释是否与代码一致（F2/F3）

### 【实际结果】
- **F2（`prompt.tsx`）**：新注释写明「1:1 是**调用方**保证的前提：`App.insert` 把行尾归一化为 `\n`，
  故到达此处的 `value` 永不含 `\r`；清 `\r` 仅防御且**非 1:1**，一旦 `\r` 真到达 `cursor` 就会错位，
  修法应在更上游而非此处糊弄」。**与我 Round 1 的独立结论逐字吻合，准确。**
  代码行 `shown/ghost/before/cell/tail` 与我 Round 1 快照**逐字相同**（仅注释扩写）：
  ```
  const shown = value.replace(/\r/g, "").replace(/\n/g, GLYPH.newline)
  const ghost = value === ""
  const before = shown.slice(0, cursor)
  const cell = ghost ? placeholder.slice(0, 1) : shown.slice(cursor, cursor + 1)
  const tail = ghost ? placeholder.slice(1) : shown.slice(cursor + 1)
  ```
  `git diff` 对 HEAD 显示的是**整批**改动（Round 1 的代码 + Round 2 的注释），无法单独剥离；
  但逐字比对代码行证明 **R2 只动了注释**。
- **F3（`upstream.ts` 空值分支）**：注释「空返回是刻意的、与 `renderConversation` 一致；模板把占位符
  单独成行，故缺段只留一个无害空行而非悬空标题；不要特例化」。**准确。**
  行为**未变**：`renderUpstreamOutputs([]) === ""`（R2-2h），模板侧仍是「留 1 空行、无悬空标题」
  （Round 1 V4.3 已逐条验证 11 个 preset，模板未再改）。

### 【结论】两条注释均与代码/行为一致，且 R2 **未改动任何逻辑**（仅注释）。

---

## R2-4 全量门禁 + 无残留

### 【实际结果】
```
lint      : biome check . — Checked 126 files, No fixes applied        (EXIT 0)
build     : core/dashboard/cli 三包 tsup 成功                          (EXIT 0)
typecheck : tsc × 3 — no errors                                        (EXIT 0)
test      : core 341 | dashboard 323 | cli 81  = 745 全过              (EXIT 0)
            （core +1：upstream.test.ts 由 5 → 6 tests）
coverage  : core      97.14 / 92.53 / 94.91 / 98.03  (阈值 90/85/90/90)  ✅
            dashboard 99.36 / 96.26 / 100   / 99.61  (阈值 90/85/90/90)  ✅
            cli       76.07 / 70.08 / 75.80 / 76.61  (阈值 50/45/40/50)  ✅
            upstream.ts 100/100/100/100；Orchestrator.ts 100/98.59/100/100
skip/todo/only/xit : 全仓 0 命中
快照断言            : 0 命中（唯一命中在我方报告文本内，非测试代码）
```
- **测试 diff**：tracked 测试文件仍为 `14/64/89/16`（183 行全新增，无删除）——**与 Round 1 完全一致**，
  无意外改动。本批新增的 `upstream.test.ts` 仅含 F1 相关改动（见 R2-1 diff）。
- **工作区**：19 `M` + 4 `??`。**说明一处期望偏差**：team-lead 预期「2 untracked」，
  实际为 4 —— `deliverables/` 与 `scripts/` 是**自 Round 1 之前就存在的团队产物目录**（非本次新增），
  真正属于本批的新增未跟踪文件确为 `upstream.ts` / `upstream.test.ts` 两个。**无异常。**
- **临时文件**：本轮验证脚本**全部写在 `/tmp`**（`/tmp/verify-r2.ts`、`/tmp/upstream.test.round1.ts`），
  **未在仓库内新增任何文件**；仓库工作区与 Round 1 结束时一致。**未 commit。**

### 【结论】全量门禁全绿、覆盖率不破线、无 skip/only、无快照、无意外改动、无仓库残留。

---

## Round 2 总结

| 项 | 结论 |
|----|------|
| **R2-1 断言改动性质** | **合法收紧**（同一对象 `block.length`，界 4029→4000，entries 约束未丢，无算子降级、无删除） |
| R2-2 F1 新承诺 | **有效**（穷举最大恰 4000；反例 4004→3436；边界精确；单条 600 与省略计数均未受影响） |
| R2-3 注释一致性 | **准确**（F2/F3 注释与代码/行为一致；R2 仅动注释） |
| R2-4 门禁 | **全绿**（745 测试；三包覆盖率不破线；0 skip/only；0 快照；无残留） |

**判定：PASS。** Round 1 的 3 条 P2 已按预期收敛（F1 语义收紧并配更严断言；F2/F3 补注释），
**无遗留问题**，可提交。

---

# §F4 —— 单条 entry 预算修复的对抗性复核（F4）

> 触发：team-lead 要求**推翻** F4，而非复述。目标：`entry()` 渲染后 ≤ `MAX_UPSTREAM_ENTRY_CHARS`（600）。
> 时间：2026-10-13；HEAD 仍 `e8b45f8`。所有扫描脚本自写（`/tmp/verify-f4*.ts`），未复用工程师用例。

## 判定

**PASS WITH ISSUES**（1 项 P2：收敛性**注释**对长 label 退化路径的表述不实；现实 label 下不变量成立、无回归）

---

## F4-1 核心不变量：渲染后单条 entry ≤ 600 —— 实测

### 【验证方法】
`entryLen(o) = renderUpstreamOutputs([o]).length − HEADER.length − 1`。四组独立扫描：
随机（20 万次，含 `\n \r \t` 空格、多行）、密集换行扫描、600 边界扫描、现实 label 网格。

### 【实际结果】
```
=== Q1a random scan (realistic labels, name/id 1-20 chars, output ≤4000, charset incl \n\r\t) ===
   scanned 200000 random inputs; max entry = 600 ; violations (>600) = 0
=== Q1b dense-newline sweep (0..700 newlines × seg {1,2,5,50}) ===
   local max = 600
=== Q1c exact boundary around body 600 (590..620, single line) ===
   local max = 599
=== Q2c realistic-label grid (name≤80, id≤80, outLen∈{0,1,599,600,601,5000}, nl∈{0,1,5,50,300,600}) ===
   max entry = 600 ; violations = 0
```
**实测最大 entry = 600（现实 label 下），0 反例。**

### 【结论】对现实 label（name/agentId 为常规标识符）**不变量成立**，且预算被精确利用（可达 600）。

---

## F4-2 攻击收敛性证明 —— **有反例**（长 label 退化路径）

### 【证明的两条腿】
1. 非退化路径：`compact` 返回 ≤ max ⇒ `len(body2) ≤ budget − 2N`；且 head2 是 head1 前缀、tail2 是 tail1 后缀 ⇒ `N' ≤ N`。⇒ `label + body2 + 2N' ≤ label + budget = 600`。**我独立复算：成立。**
2. 退化路径（`budget − 2N < reserved`，`keep=0`）：`compact` 返回**仅 marker**，其长度**并不** ≤ 传入 max。故第 1 步的 `body.length ≤ budget − 2N` **失效**。

### 【反例（实测）】
把 name 拉长以放大 label，固定超长 output（5000 字）：
```
first violating label.length = 573
label.len=572 -> entry=600      (恰好边界)
label.len=573 -> entry=601      ← 首个越界
label.len=591 -> entry=619
label.len=600 -> entry=628
```
`entry tail`：`"...nnnnn ():\n  … (5000 characters elided) …"` —— 退化路径确实只留 marker，但 `entry = label.length + markerLen`（markerLen = 24 + 位数，此例 28）。

### 【该路径下的 entry 上界】
- 退化路径 `entry = label.length + markerLen`，`markerLen = 24 + digits(trimmed.length)` ≤ ~31（现实字符串）。
- 因此 `entry ≤ 600` 当且仅当 `label.length ≤ 600 − markerLen ≈ 572`。
- **label 长度是否有界？代码里没有上界** —— `label = "- ${name} (${agentId}):\n  "`，完全由 name/agentId 决定。
  `label.length ≥ 573` 需要 `name + agentId ≈ 565` 字符。现实 agent 定义不可能；但**代码未强制**。

### 【是否「一趟重算后仍越界」？】**是**。label.length ≥ 573 时，第二次 `compact` 因 `budget − 2N` 仍 < reserved 而返回同一 marker，重算无改善，entry 仍 > 600。
> 注：这**不是 F4 引入的回归** —— 修复前 `entry = label + indent(compact(out,600))` 同样越界且**严重得多**（同一 label=591、单行 5000 字输出，修复前 entry ≈ 591+600 = 1191）。F4 是**严格改善**，只是未闭合「超长 label」这一角落。

### 【结论】**收敛性证明在非退化路径成立；退化路径下证明的那一步失效，真实上界为 `label.length + markerLen`。** 对现实 label（≪ 572）仍 ≤ 600；仅当 label ≥ 573 才越界 —— 理论反例成立，现实不可达，且非回归。

---

## F4-3 未破坏既有行为

```
=== Q3a block budget sweep (body∈[1,600] × n∈[1,26]) ===   max block = 4000 ; 越界 0
=== Q3b multi-line block sweep (dense newlines) ===          max block = 3772 ; 越界 0
=== Q3c 20 条 × 300 字 ===  kept=12（旧实现同输入仅 6 条），newest kept / oldest dropped / 保留的是连续后缀
=== Q3d elided 恒等式（去缩进后）===
   [single-line 5000] N=4439 real=4439 ; head prefix ✓ ; tail suffix ✓
   [multi-line]       N=5404 real=5404 ; head prefix ✓ ; tail suffix ✓
   [dense-newline]    N=702  real=702  ; head prefix ✓ ; tail suffix ✓
```
- **block 预算 ≤ 4000 仍成立**（穷举 max 恰 4000）。
- **丢最旧、留最新**仍正确，保留的是**连续后缀**。
- **entry 变短后确实多保留条目**（同输入 6 → 12 条）——**符合预期**：预算按字符数而非条数，entry 变短自然能多容纳；策略仍是「丢最旧」。
- **省略计数恒等式仍成立**（单行/多行/密集换行三例，去缩进后 N === 真实略去，且头前缀/尾后缀成立）。

---

## F4-4 注释与文档准确性 —— **有夸大**

- `MAX_UPSTREAM_ENTRY_CHARS` 文档：「Ceiling on a single rendered entry … the whole bullet」。**对 label ≤ ~572 准确**；作为**绝对** ceiling 则被 F4-2 的反例证伪（未提 label 需有界）。属**轻微夸大**。
- `entry()` 内收敛性注释：三点问题——
  1. 「One recomputation is enough — no loop needed」：在退化路径**不成立**（重算返回同一 marker，长 label 下仍越界）。
  2. 「`compact` returns at most `max` characters, so the second body is at most `budget − 2N`」：退化路径**为假**（注释下一句其实已承认，但前一句仍以「at most max」作推理前提）。
  3. 「…returns just the elision marker, **which is far under the ceiling**」：**marker 本身**确实 ≪ 600，但**entry = label + marker** 不保证 ≤ 600；注释把「marker 在 ceiling 下」混同于「entry 在 ceiling 下」。**这是本轮最需要点明的失实之处。**

### 【结论】注释在现实范围内方向正确，但把「非退化路径的证明」写成了**无条件**结论，遗漏「label 有界」这一前提，属 P2。

---

## F4-5 回退证据真实性 —— **属实**

### 【验证方法】
`cp` 备份当前 `upstream.ts`，把 `entry()` 临时改回修复前版本（`compact(output.output, 600)` + 直接缩进），
跑 `npx vitest run src/utils/upstream.test.ts`，随后 `cp` 还原并核对 SHA256。

### 【实际结果（回退后原文）】
```
 ❯ src/utils/upstream.test.ts (8 tests | 3 failed) 3ms
     × compacts an oversized output by keeping its head and its tail
     × keeps a multi-line entry within the ceiling after its indent is added
     × stays within the ceiling when the indent cost exceeds the budget
 FAIL ... compacts an oversized output ...  AssertionError: expected 611 to be less than or equal to 600
 FAIL ... keeps a multi-line entry ...      AssertionError: expected 718 to be less than or equal to 600
 FAIL ... stays within the ceiling ...      AssertionError: expected 1753 to be less than or equal to 600
 Test Files  1 failed (1)
      Tests  3 failed | 5 passed (8)
```
### 【结论】**与工程师声称的 `3 failed | 5 passed`、`expected 611/718/1753 ≤ 600` 逐字一致，属实。**
还原核对：`upstream.ts` 与备份 SHA256 均为 `685ed737…ac6b6`，**逐字节恢复**。

---

## F4-6 断言改动性质 —— **合法收紧**

### 【验证方法】
`upstream.test.ts` 未跟踪，`git diff` 为空；把我 Round 2 读到的版本写入 `/tmp/upstream.test.round2.ts` 后 `diff -u`。

### 【实际结果】
```
+ const HEADER = "\n## What upstream produced\n\n"          （新增常量）
+ function entryOf(block) { return block.slice(HEADER.length, -1) }  （新增 helper）
  it("compacts an oversized output ..."):
    expect(body.length).toBeLessThanOrEqual(MAX_UPSTREAM_ENTRY_CHARS)   ← 原有，保留
+   expect(entryOf(block).length).toBeLessThanOrEqual(MAX_UPSTREAM_ENTRY_CHARS)  ← 新增（更强）
+ it("keeps a multi-line entry within the ceiling after its indent is added")   ← 新用例
+ it("stays within the ceiling when the indent cost exceeds the budget")         ← 新用例
```
### 【逐点判定】
- 改动为**纯新增**：原 `body ≤ 600` 断言**保留**，另加 `entry ≤ 600`（entry 是 body 的超集对象 ⇒ **更强**）；再补 2 条新用例。
- **无删除、无算子降级、无放松**。
- 旧实现下这 3 条**确实会红**（F4-5 实测），故新断言**有效**。

### 【结论】**合法收紧**。

---

## F4-7 门禁与残留

```
lint      : biome check . — 126 files, No fixes applied        (EXIT 0)
build     : 三包 tsup 成功                                      (EXIT 0)
typecheck : tsc × 3 — no errors                                 (EXIT 0)
test      : core 343 (+2) | dashboard 323 | cli 81 = 747 全过    (EXIT 0)
coverage  : core 97.15/92.56/94.91/98.05 | dashboard 99.36/96.26/100/99.61 | cli 76.07/70.08/75.80/76.61
            upstream.ts 100/100/100/100（阈值 core 90/85/90/90、cli 50/45/40/50、dashboard 90/85/90/90 全不破）
skip/todo/only/xit : 0 命中 ; 快照断言 : 0 命中
```
- **工作区**：19 `M` + 4 `??`。**期望偏差说明**：team-lead 预期「2 untracked」，实际 4 ——
  `deliverables/` 与 `scripts/` 是 Round 1 之前就存在的团队产物目录；本批真正新增的未跟踪文件仍只有
  `upstream.ts` / `upstream.test.ts` 两个。**无异常。**
- **无仓库内临时文件**：本轮脚本全部写在 `/tmp`（`verify-f4.ts`、`verify-f4-q3.ts`、`upstream.test.round2.ts`、
  `upstream.f4.backup.ts`）。回退复现的临时源码改动**已逐字节还原**（SHA256 核对通过）。
- HEAD 仍 `e8b45f8`。**未 commit。**

---

## F4-8 跨包影响

- 全仓仅 `Orchestrator.run.test.ts` 断言 upstream block 的**内容**（`toContain("UPSTREAM_MARKER")`、
  `toContain("## What upstream produced")`、`not.toContain(...)`），均为**包含性**断言，**不依赖长度**；
  entry 变短不影响它们（core 343 全过）。
- `agents/index.test.ts` 只断言占位符存在性，无关长度。
- **无任何测试对 block 的确切长度/条目数做硬断言**（除 `upstream.test.ts` 自身，其断言已随 F4 更新）。

### 【结论】无跨包失真。

---

## F4 总结

| 项 | 结论 |
|----|------|
| **F4-1 不变量（现实 label）** | **成立**：20 万随机 + 网格扫描，实测最大 entry = **600**，0 反例 |
| **F4-2 收敛性证明** | 非退化路径**成立**；退化路径证明的那一步**失效**，真实上界 `label.length + markerLen`。**反例：label.length ≥ 573 ⇒ entry > 600**（需 name+agentId≈565 字符，现实不可达，**非回归**） |
| F4-3 既有行为 | block ≤ 4000 ✓；丢最旧/留最新 ✓；entry 变短多留条目**符合预期**；省略计数恒等式 ✓ |
| F4-4 注释 | **有夸大**（P2）：把非退化路径的证明写成无条件结论，漏「label 有界」前提；「marker 在 ceiling 下」≠「entry 在 ceiling 下」 |
| F4-5 回退证据 | **属实**（`3 failed｜5 passed`、`611/718/1753 ≤ 600` 逐字一致；已逐字节还原） |
| F4-6 断言改动 | **合法收紧**（纯新增更强断言 + 2 新用例，无放松） |
| F4-7 门禁/残留 | **全绿**（747 测试，覆盖率不破线，0 skip/only，0 快照，无残留，未 commit） |
| F4-8 跨包 | 无失真 |

**判定：PASS WITH ISSUES。** F4 对现实输入**有效且必要**（修复前多行 entry 可越界至 1753），
且为严格改善；唯一遗留是 **P2 注释夸大** —— 建议把「One recomputation is enough」与
`MAX_UPSTREAM_ENTRY_CHARS` 的绝对措辞收敛为「前提是 label 长度有限 / 现实规模」，或显式说明
`entry ≤ label.length + markerLen` 的退化上界。**非阻塞，可提交。**
