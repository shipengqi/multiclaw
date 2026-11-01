# TUI 内部结构（packages/dashboard）

- Ink，exports 只有 `"./tui"`；`startTui` 用 alternate screen，非 TTY 抛错。
- 状态两层：`TurnView` 与 `TuiState extends TurnView { name; history; view? }`；面板只吃 `TurnView`，prop 叫 `turn`。`history` 只存被顶替的轮次（上限 20）；`snapshot()` 逐字段写出；`view` 是 detached copy。
- 文字结束（reply/ask）→ `ReplyPanel` 接管 body，状态行 `✓ answered`/`? needs your input`，绝不写 done。
- keymap：提示符持有焦点 → 裸键让位于打字；`?`/`/` 是裸键，外加"请求挂起且输入行为空"时的审批菜单。运行中提交=入队；取消（ctrl+c / /cancel）连队列一起清。
- **交互条**：`request_permission` 与 `elicitation/create` 不替换 body，dock 在 prompt 上方（`Rule` 分隔）。行数走 `computeLayout({interactionRows})`，被 `barRoom = rows - chrome - MIN_BODY_ROWS - 1` 夹住（否则短终端 Ink 会从树底裁掉 prompt）；`< MIN_INTERACTION_ROWS(4)` 整块不画、hint 退回命令式。权限=菜单：`↑↓`/`1-9` 移光标、`enter` 提交、`esc` 交还键盘（`released` 按 shortId 键控，新请求复位）；**无默认选中**，enter 单按永不批准。问题=逐字段表单，文本/数字字段复用 prompt 当编辑器（`withDraft` 存、`focusField` 取）；`enter` 逐字段前进、最后一格提交。纯逻辑在 `tui/interaction.ts`。
- 流里 tool 行：`\n› Name <summary>\n`（kind `tool`）+ `  ✓/✗ <首行>`（成功是 `tool-detail`，只 /verbose 显示；失败必显示）。summary 走 `utils/toolSummary.ts`（首行 + 120 列截断，永不抛）。
- `conversationTurns(state)` 从 `history` + 当前轮派生，只收 `phase==="complete"`；`App.startTurn` 经 `stateRef` 读（deps 不含 state，直读会 stale）。**dashboard 测的是 `dist`**：改了 core 先 `pnpm build`。
- **输入行自己断行**：`Prompt` 不能把文本拆成 before/cell/tail 三个兄弟 `<Text>`（Ink 只对文本换行，光标是独立 flex item，会滞留首行右端）。`promptLines(value, cursor, width)` 按**字符**断行，`caret` 存**行内下标**（宽字符 1 下标 2 列），续行用 `MARKER_WIDTH`(2) 空格缩进，`MAX_PROMPT_ROWS=5` 超出滚动跟随光标。行数经 `promptRowCount()` → `computeLayout({promptRows})` 计入 `reserved`（Ink 布局前量不出换行高度，漏算会让 body 溢出被 Yoga 压缩）。
- 渲染集成测试不要用固定 sleep：非交互下 Ink 只在 unmount 时写帧 → 只能 ① `driveFrame` 的 `ready`/`thenReady` 等 app 给的 promise；② `vi.waitFor` 轮询外部事实（history 文件、session 已关）。`settleMs` 撞落盘/落帧曾让 `App.sessions`/`App.session` 并行全量稳定红。
