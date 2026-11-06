import * as fs from "node:fs/promises"
import * as path from "node:path"
import {
  COORDINATOR_ID,
  type EventBus,
  imageReference,
  MAX_PROMPT_IMAGES,
  type MultiClawConfig,
  validateRuntimeQuestionContent,
} from "@multiclawcli/core"
import { Box, Text, useApp, useInput, useWindowSize } from "ink"
import { useEffect, useRef, useState } from "react"
import { type ChatMessage, SessionRuntime } from "./chat-session"
import { readClipboard, saveClipboardImage } from "./clipboard"
import { COMMANDS, parseCommand, resolveAgentId } from "./commands"
import { Header, HintBar, Rule } from "./components/chrome"
import { PermissionBar, QuestionForm } from "./components/interaction"
import { StreamPanel, TeamRow } from "./components/panels"
import { Prompt, promptRowCount } from "./components/prompt"
import { renderSegments, truncate, wrapLine } from "./format"
import { splitInputImages } from "./input-images"
import {
  clean,
  commitField,
  type FormState,
  focusField,
  formComplete,
  formContent,
  formFields,
  initialForm,
  jumpPick,
  movePick,
  permissionChoices,
  toggleBoolean,
  toggleChoice,
  withDraft,
} from "./interaction"
import { progress, stripAnsi } from "./state"
import { COLOR, GLYPH, SPINNER } from "./theme"

export type InitialSession = { kind: "new" } | { kind: "resume"; id?: string }
export interface AppProps {
  config: MultiClawConfig
  onTurnStart?: (bus: EventBus, logDir: string) => void | (() => void | Promise<void>)
  runtime?: SessionRuntime
  initialSession?: InitialSession
  onCleanupReady?: (cleanup: () => Promise<void>) => void
}

type Focus = "chat" | "sessions" | "team" | "interaction"

/** Render whole assistant messages before wrapping, preserving Markdown block structure. */
function chatMessageRows(message: ChatMessage, width: number): string[] {
  const cleanText = stripAnsi(message.text).replace(/\p{Cc}/gu, (c) =>
    c === "\n" || c === "\t" ? c : ""
  )
  const content =
    message.role === "assistant"
      ? renderSegments([{ kind: "text", text: cleanText }], width).trimEnd()
      : cleanText
  return `${message.role}: ${content}`.split("\n").flatMap((line) => wrapLine(line, width))
}

export function App({
  config,
  onTurnStart,
  runtime: provided,
  initialSession,
  onCleanupReady,
}: AppProps) {
  const { exit } = useApp()
  const { columns: rawColumns, rows: rawRows } = useWindowSize()
  const [runtime] = useState(() => {
    const r = provided ?? new SessionRuntime(config, { onTurnStart })
    if (initialSession?.kind === "resume" && initialSession.id) r.open(initialSession.id)
    return r
  })
  const [, render] = useState(0)
  const [focus, setFocus] = useState<Focus>(
    initialSession?.kind === "resume" && !initialSession.id ? "sessions" : "chat"
  )
  const [teamOpen, setTeamOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sessionSelection, setSessionSelection] = useState<string>()
  const [agentCursor, setAgentCursor] = useState(0)
  const [cursor, setCursor] = useState(runtime.draft.length)
  const [notice, setNotice] = useState("")
  const [help, setHelp] = useState(false)
  const [deleteId, setDeleteId] = useState<string>()
  const [chatScroll, setChatScroll] = useState(0)
  const [permissionPick, setPermissionPick] = useState<{ id: string; index: number }>()
  const [formEntry, setFormEntry] = useState<{ id: string; form: FormState; draft: string }>()
  const [checkpointDraft, setCheckpointDraft] = useState("")
  const [searchDraft, setSearchDraft] = useState<string>()
  const [caretVisible, setCaretVisible] = useState(true)
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  const mounted = useRef(true)
  const pasting = useRef(false)
  const current = runtime.current
  const front = current?.interactions[0]
  const summaries = runtime.summaries
  const sessionCursor = sessionSelection
    ? Math.max(0, summaries.findIndex((s) => s.id === sessionSelection) + 1)
    : 0
  const columns = Math.max(10, rawColumns)
  const rows = Math.max(4, rawRows)
  const showSidebar = sidebarOpen && columns >= 90
  const showTeam = teamOpen && columns >= (showSidebar ? 145 : 110)
  const sidebarWidth = showSidebar ? 24 : 0
  const teamWidth = showTeam ? Math.min(48, Math.floor(columns * 0.35)) : 0
  const chatWidth = Math.max(1, columns - sidebarWidth - teamWidth)
  const temporary = (focus === "sessions" && !showSidebar) || (focus === "team" && !showTeam)
  const promptWidth = focus === "interaction" || temporary ? columns : Math.max(1, chatWidth - 2)
  const question = front?.kind === "question" ? front : undefined
  const fields = question ? formFields(question.request) : []
  const form = question && formEntry?.id === question.id ? formEntry.form : initialForm()
  const formDraft = question && formEntry?.id === question.id ? formEntry.draft : ""
  const draft =
    focus === "interaction"
      ? question
        ? formDraft
        : front?.kind === "checkpoint"
          ? checkpointDraft
          : ""
      : runtime.draft
  const images = focus === "interaction" || searchDraft !== undefined ? [] : runtime.draftImages
  const promptRows =
    (images.length ? 1 : 0) +
    promptRowCount(draft, Math.min(cursor, draft.length), Math.max(1, promptWidth - 2))
  const showRules = rows >= 8 && rows - promptRows >= 6
  const compactInteraction = focus === "interaction" && rows < 14
  const interactionHeight =
    focus === "interaction" && front && !compactInteraction
      ? Math.min(9, Math.max(3, rows - promptRows - 7))
      : 0
  const bodyHeight = Math.max(
    1,
    rows - promptRows - 2 - (showRules ? 2 : 0) - (notice ? 1 : 0) - interactionHeight
  )
  const showPaneRules = bodyHeight >= 4
  const chatViewport = Math.max(1, bodyHeight - 1 - (showPaneRules ? 1 : 0))
  const spinner = SPINNER[spinnerFrame % SPINNER.length]
  const now = Date.now()
  const ids = config.agents.map((a) => a.id)

  useEffect(() => {
    mounted.current = true
    const off = runtime.subscribe(() => render((n) => n + 1))
    onCleanupReady?.(() => runtime.close())
    const timer = setInterval(() => setCaretVisible((v) => !v), 530)
    const animation = setInterval(() => {
      if (runtime.current?.running) setSpinnerFrame((n) => n + 1)
    }, 120)
    return () => {
      mounted.current = false
      off()
      clearInterval(timer)
      clearInterval(animation)
      if (!provided) void runtime.close().catch(() => {})
    }
  }, [runtime, provided, onCleanupReady])
  useEffect(() => {
    if (focus === "interaction" && !front) setFocus("chat")
  }, [front, focus])
  const report = (error: unknown) => {
    if (mounted.current) setNotice(error instanceof Error ? error.message : String(error))
  }
  const switchSession = (id?: string) => {
    if (id) runtime.open(id)
    else runtime.newChat()
    setAgentCursor(Math.max(0, ids.indexOf(runtime.current?.view.focusId ?? ids[0])))
    setCursor(runtime.draft.length)
    setFocus("chat")
    setChatScroll(0)
    setDeleteId(undefined)
  }
  const insert = (text: string) => {
    const at = Math.min(cursor, draft.length)
    const next = draft.slice(0, at) + text + draft.slice(at)
    if (focus === "interaction" && question) setFormEntry({ id: question.id, form, draft: next })
    else if (focus === "interaction" && front?.kind === "checkpoint") setCheckpointDraft(next)
    else runtime.setDraft(next)
    setCursor(at + text.length)
  }
  const insertMessage = (text: string) => {
    const input = splitInputImages(text)
    if (runtime.draftImages.length + input.images.length > MAX_PROMPT_IMAGES) {
      setNotice(`A message supports up to ${MAX_PROMPT_IMAGES} images`)
      return
    }
    if (input.images.length) runtime.setDraftImages([...runtime.draftImages, ...input.images])
    insert(input.text)
  }
  const command = async (text: string) => {
    const parsed = parseCommand(text)
    if (!parsed) {
      await runtime.submit(text)
      return
    }
    const { name, args } = parsed
    switch (name) {
      case "new":
        switchSession()
        return
      case "focus": {
        const resolved = args[0] ? resolveAgentId(args[0], ids) : { id: ids[0] }
        if ("error" in resolved) throw new Error(resolved.error)
        if (resolved.id) {
          setAgentCursor(ids.indexOf(resolved.id))
          runtime.updateView({ type: "focus:set", agentId: resolved.id })
        }
        setTeamOpen(true)
        setFocus("team")
        return
      }
      case "mode": {
        const mode = args[0]
        if (mode !== "auto" && mode !== "ask" && mode !== "deny")
          throw new Error("/mode auto | ask | deny")
        runtime.setPermissionMode(mode)
        return
      }
      case "verbose":
        runtime.updateView({ type: "verbose:toggle" })
        return
      case "latest":
        setChatScroll(0)
        runtime.updateView({ type: "stream:latest" })
        return
      case "search":
        setSearchDraft(args.join(" "))
        return
      case "pause":
        runtime.pause()
        return
      case "continue":
        runtime.continue()
        return
      case "retry":
        runtime.retry(args[0])
        return
      case "steer": {
        if (!args.length) throw new Error("/steer <agent-id> <instruction>")
        const resolved = resolveAgentId(args[0], ids)
        if ("error" in resolved || args.length < 2)
          throw new Error("/steer <agent-id> <instruction>")
        await runtime.steer(args.slice(1).join(" "), [resolved.id])
        return
      }
      case "edit": {
        const message = [...(current?.messages ?? [])].reverse().find((m) => m.role === "user")
        if (message) {
          runtime.setDraft(message.text)
          setCursor(message.text.length)
        }
        return
      }
      case "replay": {
        if (current?.running) throw new Error("Finish current work before replay")
        const turn = args[0]
          ? current?.view.history.find((t) => t.turn === Number(args[0]))
          : current?.view
        if (!turn?.requirement) throw new Error("No matching turn")
        await runtime.submit(turn.requirement)
        return
      }
      case "export": {
        if (!current) throw new Error("No saved chat")
        const target = args[0]
          ? path.resolve(args[0])
          : path.join(config.workDir, ".multiclaw", "sessions", current.id, "exports", "chat.md")
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(
          target,
          "# " +
            current.title +
            "\n\n" +
            current.messages.map((m) => "## " + m.role + "\n\n" + m.text).join("\n\n")
        )
        setNotice("Exported " + target)
        return
      }
      default:
        throw new Error("Unknown command: /" + name)
    }
  }

  useInput((char, key) => {
    if (key.ctrl && char === "d") {
      setNotice("Closing all sessions…")
      void runtime.close().then(exit).catch(report)
      return
    }
    if (key.ctrl && char === "c") {
      runtime.cancel()
      setNotice("Stopped current work; other sessions continue")
      return
    }
    if (deleteId) {
      if (key.escape) {
        setDeleteId(undefined)
        return
      }
      if (char.toLowerCase() === "y") {
        void runtime
          .remove(deleteId)
          .then(() => setDeleteId(undefined))
          .catch(report)
      }
      return
    }
    if (help) {
      if (key.escape || char === "?") setHelp(false)
      return
    }
    if (key.ctrl && char === "b") {
      setSidebarOpen(true)
      setFocus(focus === "sessions" ? "chat" : "sessions")
      return
    }
    if (key.ctrl && char === "t") {
      if (ids[agentCursor]) runtime.updateView({ type: "focus:set", agentId: ids[agentCursor] })
      setTeamOpen(focus !== "team")
      setFocus(focus === "team" ? "chat" : "team")
      return
    }
    if (key.ctrl && char === "g") {
      if (front) {
        setFocus(focus === "interaction" ? "chat" : "interaction")
        setCursor(0)
      }
      return
    }
    if (key.escape) {
      if (searchDraft !== undefined) {
        setSearchDraft(undefined)
        return
      }
      setFocus("chat")
      setCursor(runtime.draft.length)
      return
    }
    if (focus === "sessions") {
      const total = summaries.length + 1
      if (key.upArrow || key.downArrow) {
        const index = (sessionCursor + (key.upArrow ? -1 : 1) + total) % total
        setSessionSelection(index === 0 ? undefined : summaries[index - 1]?.id)
      }
      if (key.return) {
        try {
          switchSession(sessionSelection)
        } catch (error) {
          report(error)
        }
      }
      if ((key.backspace || key.delete) && sessionCursor > 0) {
        const id = sessionSelection
        if (id) {
          setDeleteId(id)
          setNotice("Delete selected session? y confirms · esc cancels")
        }
      }
      return
    }
    if (focus === "team") {
      if (key.upArrow || key.downArrow) {
        const n =
          (agentCursor + (key.upArrow ? -1 : 1) + Math.max(1, ids.length)) % Math.max(1, ids.length)
        setAgentCursor(n)
        if (ids[n]) runtime.updateView({ type: "focus:set", agentId: ids[n] })
      }
      if (key.return) {
        if (ids[agentCursor]) runtime.updateView({ type: "focus:set", agentId: ids[agentCursor] })
        setFocus("chat")
      }
      if (key.pageUp || key.pageDown)
        runtime.updateView({
          type: "stream:scroll",
          delta: key.pageUp ? 5 : -5,
          width: Math.max(1, teamWidth - 2),
          viewport: bodyHeight,
        })
      return
    }
    if (focus === "interaction" && front) {
      if (front.kind === "permission") {
        const choices = permissionChoices(front.request)
        const selected = permissionPick?.id === front.id ? permissionPick.index : undefined
        if (key.upArrow || key.downArrow)
          setPermissionPick({
            id: front.id,
            index:
              selected === undefined
                ? key.upArrow
                  ? choices.length - 1
                  : 0
                : (selected + (key.upArrow ? -1 : 1) + choices.length) % choices.length,
          })
        else if (/^[1-9]$/.test(char) && Number(char) <= choices.length)
          setPermissionPick({ id: front.id, index: Number(char) - 1 })
        else if (key.return && selected !== undefined) front.settle(choices[selected]?.optionId)
        return
      }
      if (question) {
        const committed = withDraft(fields, form, formDraft)
        const field = fields[form.field]
        const save = (next: FormState, text = formDraft) =>
          setFormEntry({ id: question.id, form: next, draft: text })
        const move = (delta: number, next = committed) => {
          const at = (form.field + delta + fields.length + 3) % (fields.length + 3)
          if (at >= fields.length) {
            save({ ...next, field: at }, "")
            setCursor(0)
          } else {
            const value = focusField(fields, next, at)
            save(value.state, value.draft)
            setCursor(value.draft.length)
          }
        }
        if (key.tab) {
          move(
            key.shift ? -1 : 1,
            field?.kind === "choice" ? commitField(fields, committed) : committed
          )
          return
        }
        if (key.upArrow || key.downArrow) {
          if (field?.choices.length) save(movePick(committed, field, key.upArrow ? -1 : 1))
          else move(key.upArrow ? -1 : 1)
          return
        }
        if (field?.choices.length && /^[1-9]$/.test(char)) {
          save(jumpPick(committed, field, char))
          return
        }
        if (char === " " && field?.kind === "multi") {
          save(toggleChoice(committed, field))
          return
        }
        if (char === " " && field?.kind === "boolean") {
          save(toggleBoolean(committed, field))
          return
        }
        if (key.return) {
          if (field) move(1, field.kind === "choice" ? commitField(fields, committed) : committed)
          else if (form.field === fields.length) {
            const content = formContent(fields, committed)
            if (
              !formComplete(fields, committed) ||
              !validateRuntimeQuestionContent(question.request.requestedSchema, content)
            )
              setNotice("Complete the required question fields")
            else question.settle({ action: "accept", content })
          } else
            question.settle({ action: form.field === fields.length + 1 ? "decline" : "cancel" })
          return
        }
      } else if (front.kind === "checkpoint" && key.return) {
        front.settle(
          checkpointDraft.trim()
            ? { action: "modify", instruction: checkpointDraft }
            : { action: "continue" }
        )
        setCheckpointDraft("")
        return
      }
    }
    if (key.tab && key.shift) {
      const modes = ["ask", "auto", "deny"] as const
      runtime.setPermissionMode(modes[(modes.indexOf(current?.permissionMode ?? "ask") + 1) % 3])
      return
    }
    if (searchDraft !== undefined) {
      if (key.return) {
        if (teamOpen && current?.view.focusId)
          runtime.updateView({
            type: "stream:search",
            query: searchDraft,
            width: teamWidth || columns,
            viewport: bodyHeight,
          })
        else {
          const lines = (current?.messages ?? []).flatMap((m) =>
            chatMessageRows(m, Math.max(1, chatWidth - 2)).map(stripAnsi)
          )
          const reverseIndex = [...lines]
            .reverse()
            .findIndex((l) => l.toLowerCase().includes(searchDraft.toLowerCase()))
          const index = reverseIndex < 0 ? -1 : lines.length - reverseIndex - 1
          setChatScroll(index >= 0 ? Math.max(0, lines.length - index - bodyHeight) : 0)
        }
        setSearchDraft(undefined)
      } else if (key.backspace || key.delete) setSearchDraft(searchDraft.slice(0, -1))
      else if (char && !key.ctrl && !key.meta) setSearchDraft(searchDraft + char)
      return
    }
    if (key.ctrl && char === "v") {
      if (focus === "interaction") {
        setNotice("Paste images into the main chat")
        return
      }
      if (pasting.current) return
      pasting.current = true
      const id = runtime.selectedId
      const originalDraft = runtime.draft
      const originalImages = runtime.draftImages
      const at = Math.min(cursor, originalDraft.length)
      void readClipboard()
        .then(async (content) => {
          if ("image" in content && originalImages.length >= MAX_PROMPT_IMAGES)
            throw new Error(`A message supports up to ${MAX_PROMPT_IMAGES} images`)
          const input =
            "text" in content
              ? splitInputImages(content.text.replace(/\r\n?/g, "\n"))
              : { text: "", images: [await saveClipboardImage(config.workDir, content.image)] }
          if (
            runtime.selectedId !== id ||
            !mounted.current ||
            runtime.draftImages !== originalImages
          )
            return
          if (input.text && runtime.draft !== originalDraft)
            throw new Error("Draft changed while reading clipboard; paste the text again")
          if (originalImages.length + input.images.length > MAX_PROMPT_IMAGES)
            throw new Error(`A message supports up to ${MAX_PROMPT_IMAGES} images`)
          runtime.setDraftImages([...originalImages, ...input.images])
          if (input.text) {
            runtime.setDraft(originalDraft.slice(0, at) + input.text + originalDraft.slice(at))
            setCursor(at + input.text.length)
          }
        })
        .catch(report)
        .finally(() => {
          pasting.current = false
        })
      return
    }
    if (key.ctrl && char === "a") {
      setCursor(0)
      return
    }
    if (key.ctrl && char === "e") {
      setCursor(draft.length)
      return
    }
    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1))
      return
    }
    if (key.rightArrow) {
      setCursor(Math.min(draft.length, cursor + 1))
      return
    }
    if (key.upArrow || key.pageUp) {
      setChatScroll((n) => n + (key.pageUp ? 5 : 1))
      return
    }
    if (key.downArrow || key.pageDown) {
      setChatScroll((n) => Math.max(0, n - (key.pageDown ? 5 : 1)))
      return
    }
    if (key.backspace || key.delete) {
      if (key.meta && focus === "chat" && runtime.draftImages.length) {
        runtime.setDraftImages(runtime.draftImages.slice(0, -1))
        return
      }
      const at = Math.min(cursor, draft.length)
      const text = draft.slice(0, Math.max(0, at - 1)) + draft.slice(at)
      if (focus === "interaction" && question) setFormEntry({ id: question.id, form, draft: text })
      else if (focus === "interaction" && front?.kind === "checkpoint") setCheckpointDraft(text)
      else runtime.setDraft(text)
      setCursor(Math.max(0, at - 1))
      return
    }
    if (key.return) {
      if (key.meta || key.shift) {
        insert("\n")
        return
      }
      if (pasting.current) {
        setNotice("Reading clipboard — wait before sending")
        return
      }
      const input = splitInputImages(draft)
      const attachments = [...runtime.draftImages, ...input.images]
      if (!input.text.trim() && !attachments.length) return
      if (attachments.length > MAX_PROMPT_IMAGES) {
        setNotice(`A message supports up to ${MAX_PROMPT_IMAGES} images`)
        return
      }
      if (attachments.length && parseCommand(input.text)) {
        setNotice(
          "Images attach to messages; remove them with alt+backspace before using a command"
        )
        return
      }
      const text = [input.text.trim(), ...attachments.map(imageReference)]
        .filter(Boolean)
        .join("\n\n")
      runtime.setDraft("")
      runtime.setDraftImages([])
      setCursor(0)
      setChatScroll(0)
      setNotice("")
      void command(text).catch(report)
      return
    }
    if (char === "?" && !draft) {
      setHelp(true)
      return
    }
    if (char && !key.ctrl && !key.meta) {
      const text = char.replace(/\r\n?/g, "\n")
      if (focus === "chat" && text.length > 1) insertMessage(text)
      else insert(text)
    }
  })

  const savedSessionRows = Math.max(1, bodyHeight - 2 - (showPaneRules ? 1 : 0))
  const savedSessionStart = Math.max(0, sessionCursor - savedSessionRows)
  const sessionList = (width: number) => (
    <Box
      width={width}
      flexDirection="column"
      overflow="hidden"
      flexShrink={0}
      paddingX={1}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderRight={showSidebar}
      borderColor={COLOR.muted}
    >
      <Text bold color={focus === "sessions" ? COLOR.accent : undefined}>
        Sessions
      </Text>
      {showPaneRules ? <Rule width={Math.max(1, width - (showSidebar ? 3 : 2))} /> : null}
      <Text
        color={
          !current || (sessionCursor === 0 && focus === "sessions") ? COLOR.accent : COLOR.muted
        }
        bold={!current || (sessionCursor === 0 && focus === "sessions")}
      >
        {sessionCursor === 0 && focus === "sessions" ? GLYPH.caret + " " : "  "}+ New chat
      </Text>
      {summaries.slice(savedSessionStart, savedSessionStart + savedSessionRows).map((s) => (
        <Text
          key={s.id}
          color={
            (sessionSelection === s.id && focus === "sessions") || s.id === runtime.selectedId
              ? COLOR.accent
              : undefined
          }
          bold={(sessionSelection === s.id && focus === "sessions") || s.id === runtime.selectedId}
          wrap="truncate-end"
        >
          {sessionSelection === s.id && focus === "sessions" ? "› " : "  "}
          {clean(s.title || "Untitled")}{" "}
          <Text
            color={
              s.status === "needs input" || s.status === "paused"
                ? COLOR.warn
                : s.status === "failed" || s.status === "unsupported"
                  ? COLOR.error
                  : s.status === "complete"
                    ? COLOR.ok
                    : s.status === "saved" || s.status === "cancelled"
                      ? COLOR.muted
                      : COLOR.accent
            }
          >
            · {s.status}
          </Text>
        </Text>
      ))}
    </Box>
  )
  const rosterRows = Math.min(
    config.agents.length,
    Math.max(1, Math.min(8, Math.floor(bodyHeight / 3)))
  )
  const rosterStart = Math.max(
    0,
    Math.min(agentCursor - rosterRows + 1, config.agents.length - rosterRows)
  )
  const teamList = (width: number) => (
    <Box
      width={width}
      flexDirection="column"
      overflow="hidden"
      flexShrink={0}
      paddingX={1}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderLeft={showTeam}
      borderColor={COLOR.muted}
    >
      <Text bold color={focus === "team" ? COLOR.accent : undefined} wrap="truncate-end">
        Team · ↑↓ choose · esc chat
      </Text>
      {showPaneRules ? <Rule width={Math.max(1, width - (showTeam ? 3 : 2))} /> : null}
      {config.agents.slice(rosterStart, rosterStart + rosterRows).map((a) => (
        <TeamRow
          key={a.id}
          agent={current?.view.agents[a.id] ?? { ...a, status: "pending", logs: [] }}
          focused={ids[agentCursor] === a.id}
          now={now}
          spinner={spinner}
        />
      ))}
      {showPaneRules ? <Rule width={Math.max(1, width - (showTeam ? 3 : 2))} /> : null}
      {current ? (
        <StreamPanel
          state={current.view}
          height={Math.max(1, bodyHeight - 1 - rosterRows - (showPaneRules ? 2 : 0))}
          width={Math.max(1, width - (showTeam ? 4 : 3))}
          now={now}
          spinner={spinner}
        />
      ) : (
        <Text dimColor>No agent output yet</Text>
      )}
    </Box>
  )
  const interaction = (height: number) =>
    front?.kind === "permission" ? (
      <PermissionBar
        request={front.request}
        others={[]}
        cursor={permissionPick?.id === front.id ? permissionPick.index : undefined}
        released={false}
        width={columns}
        maxRows={height}
      />
    ) : question ? (
      <QuestionForm
        request={question.request}
        others={[]}
        fields={fields}
        form={form}
        draft={formDraft}
        width={columns}
        maxRows={height}
      />
    ) : front?.kind === "checkpoint" ? (
      <Box flexDirection="column">
        <Text bold color={COLOR.warn}>
          Checkpoint · {clean(front.request.label)}
        </Text>
        <Text dimColor>Enter continues · type feedback to request changes · esc chat</Text>
      </Box>
    ) : null
  const textLines = current?.messages.flatMap((m) => {
    const label = m.role + ": "
    return chatMessageRows(m, Math.max(1, chatWidth - 2)).map((line, index) => ({
      text: line,
      label: index === 0 ? label.slice(0, line.length) : "",
      labelColor:
        m.kind === "error"
          ? COLOR.error
          : m.kind === "ask"
            ? COLOR.warn
            : m.role === "user"
              ? COLOR.accent
              : m.role === "assistant"
                ? COLOR.ok
                : COLOR.muted,
      color: m.kind === "error" ? COLOR.error : undefined,
      dim: m.role === "system" && m.kind !== "error",
    }))
  }) ?? [
    { text: "New chat", label: "", labelColor: COLOR.accent, color: undefined, dim: true },
    {
      text: "Describe a task or ask a question.",
      label: "",
      labelColor: COLOR.muted,
      color: undefined,
      dim: true,
    },
  ]
  const effectiveScroll = Math.min(chatScroll, Math.max(0, textLines.length - chatViewport))
  const last = textLines.length - effectiveScroll
  const visible = textLines.slice(Math.max(0, last - chatViewport), last)
  const done = current ? progress(current.view) : undefined
  const phaseColor = front
    ? COLOR.warn
    : current?.running
      ? COLOR.accent
      : current?.lastResult && !current.lastResult.success && !current.lastResult.cancelled
        ? COLOR.error
        : current?.lastResult?.success
          ? COLOR.ok
          : COLOR.muted
  const keys =
    focus === "sessions"
      ? "↑↓ select · enter open · esc chat"
      : focus === "team"
        ? "↑↓ agent · pgup/pgdn scroll · enter chat"
        : focus === "interaction"
          ? "↑↓ choose · enter confirm · esc chat"
          : "ctrl+b sessions · ctrl+t team · ctrl+g requests · ctrl+c stop · ctrl+d exit · / commands"
  const runningAgents = Object.values(current?.view.agents ?? {}).filter(
    (a) => a.status === "running" && a.id !== COORDINATOR_ID
  )
  const runningStatus =
    current?.phase === "routing"
      ? "routing…"
      : runningAgents.length > 0
        ? `running: ${runningAgents.map((a) => a.name).join(", ")}`
        : "team running"

  return (
    <Box flexDirection="column" height={rows}>
      {columns >= 70 ? (
        <Header
          name={clean(config.name)}
          right={
            (current?.view.turn ? "turn " + current.view.turn + " · " : "") +
            (current?.phase ?? "ready") +
            " · " +
            (current?.permissionMode ?? "ask")
          }
        />
      ) : (
        <Text wrap="truncate-end">
          <Text bold color={COLOR.accent}>
            {GLYPH.brand} multiclaw
          </Text>
          <Text dimColor> · {clean(config.name)}</Text>
        </Text>
      )}
      {showRules ? <Rule width={columns} /> : null}
      <Box flexDirection="row" height={bodyHeight} flexShrink={0} overflow="hidden">
        {help ? (
          <Box flexDirection="column">
            <Text>Ctrl+B sessions · Ctrl+T team · Ctrl+G answer request</Text>
            <Text>Ctrl+C stop current work · Ctrl+D exit all sessions</Text>
            <Text>Esc returns to chat · Shift+Tab permission mode</Text>
            <Text>Ctrl+V paste image · paste/drop image path · Alt+Backspace remove image</Text>
            {COMMANDS.map((c) => (
              <Text key={c.name}>
                /{c.name} {c.args} · {c.description}
              </Text>
            ))}
            <Text>esc or ? to close</Text>
          </Box>
        ) : compactInteraction ? (
          interaction(bodyHeight)
        ) : temporary ? (
          focus === "sessions" ? (
            sessionList(columns)
          ) : (
            teamList(columns)
          )
        ) : (
          <>
            {showSidebar ? sessionList(sidebarWidth) : null}
            <Box
              flexDirection="column"
              width={chatWidth}
              overflow="hidden"
              flexShrink={0}
              paddingX={1}
            >
              <Text bold color={focus === "chat" ? COLOR.accent : undefined} wrap="truncate-end">
                {clean(current?.title || "Main chat")}
                {current?.running ? (
                  <Text color={COLOR.accent}>
                    {" "}
                    · {spinner} {runningStatus}
                  </Text>
                ) : null}
                {current?.queue.length ? (
                  <Text color={COLOR.warn}>
                    {" "}
                    · {current.queue.length} queued{current.paused ? " (paused)" : ""}
                  </Text>
                ) : null}
                {front ? <Text color={COLOR.warn}> · needs input · Ctrl+G</Text> : null}
              </Text>
              {showPaneRules ? <Rule width={Math.max(1, chatWidth - 2)} /> : null}
              {visible.map((line, i) => (
                <Box key={String(last - visible.length + i)} height={1} flexShrink={0}>
                  <Text wrap="truncate-end" color={line.color} dimColor={line.dim}>
                    {line.label ? (
                      <Text color={line.labelColor} bold>
                        {line.label}
                      </Text>
                    ) : null}
                    {line.text.slice(line.label.length)}
                  </Text>
                </Box>
              ))}
            </Box>
            {showTeam ? teamList(teamWidth) : null}
          </>
        )}
      </Box>
      {showRules ? <Rule width={columns} /> : null}
      {interactionHeight ? (
        <Box height={interactionHeight} overflow="hidden" flexShrink={0}>
          {interaction(interactionHeight)}
        </Box>
      ) : null}
      {notice ? (
        <Text color={COLOR.warn} wrap="truncate-end">
          {notice}
        </Text>
      ) : null}
      <Box paddingLeft={focus === "interaction" || temporary ? 0 : sidebarWidth + 1}>
        <Prompt
          imageCount={images.length}
          value={searchDraft ?? draft}
          cursor={Math.min(cursor, draft.length)}
          caretVisible={caretVisible}
          placeholder={
            focus === "interaction" ? "answer this request…" : "message the coordinator…"
          }
          width={promptWidth}
        />
      </Box>
      {columns >= 110 ? (
        <HintBar
          status={
            <Text color={phaseColor} wrap="truncate-end">
              {front
                ? GLYPH.ask + " needs input"
                : current?.running
                  ? spinner + " " + current.phase
                  : current?.lastResult?.success
                    ? "✓ complete"
                    : current?.lastResult?.cancelled
                      ? "■ cancelled"
                      : current?.lastResult
                        ? "✗ failed"
                        : "ready"}
              {done?.total ? (
                <Text dimColor>
                  {" "}
                  · {done.done}/{done.total} agents
                </Text>
              ) : null}
            </Text>
          }
          keys={keys}
        />
      ) : (
        <Text dimColor wrap="truncate-end">
          {truncate(keys, columns)}
        </Text>
      )}
    </Box>
  )
}
