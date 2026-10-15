import type { AgentResult, EventBus, MultiClawEvent } from "@multiclawcli/core"

// Degraded to plain ASCII when NO_COLOR is set, TERM=dumb, or stdout is not a TTY (pipe/CI).
const isFancy =
  !process.env.NO_COLOR && process.env.TERM !== "dumb" && process.stdout.isTTY === true

const S = isFancy
  ? { ok: "✓", fail: "✗", run: "›", retry: "↻", skip: "⊘", warn: "⚠", bullet: "·" }
  : { ok: "+", fail: "x", run: ">", retry: "~", skip: "-", warn: "!", bullet: "*" }

const C = isFancy
  ? {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      dim: "\x1b[2m",
      cyan: "\x1b[36m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      red: "\x1b[31m",
      purple: "\x1b[35m",
    }
  : {
      reset: "",
      bold: "",
      dim: "",
      cyan: "",
      green: "",
      yellow: "",
      red: "",
      purple: "",
    }

/** The glyph and colour for one agent's status in the summary table. */
function markFor(status: AgentResult["status"]): { icon: string; color: string } {
  if (status === "success") return { icon: S.ok, color: C.green }
  // A cancelled agent was stopped, not broken — the same muted mark as a skip,
  // never the red cross a real failure earns.
  if (status === "cancelled") return { icon: S.skip, color: C.yellow }
  return { icon: S.fail, color: C.red }
}

export class ConsoleReporter {
  attach(eventBus: EventBus): () => void {
    return eventBus.subscribe((e) => this.handle(e))
  }

  private handle(e: MultiClawEvent): void {
    switch (e.type) {
      case "orchestration:start": {
        const line = (isFancy ? "═" : "=").repeat(50)
        const edge = isFancy ? ["╔", "║", "╚", "╗", "╝"] : ["+", "|", "+", "+", "+"]
        console.log(`\n${C.bold}${C.purple}${edge[0]}${line}${edge[3]}`)
        console.log(`${edge[1]}  ${S.run} ${e.payload.name.padEnd(46)}${edge[1]}`)
        console.log(`${edge[2]}${line}${edge[4]}${C.reset}`)
        console.log(
          `${C.cyan}${S.bullet} Agents: ${e.payload.totalAgents}  Stages: ${e.payload.stages.length}${C.reset}\n`
        )
        break
      }
      case "orchestration:stages": {
        // The architect's plan regrouped the team after the header was printed,
        // so the earlier "Stages: N" is no longer the whole truth. Say so rather
        // than leaving a stale count on screen.
        console.log(
          `${C.dim}${S.bullet} Plan applied — ${e.payload.stages.length} stages${C.reset}`
        )
        break
      }
      case "stage:start": {
        const dash = (isFancy ? "─" : "-").repeat(16)
        console.log(`${C.cyan}${dash} Stage ${e.payload.stageIndex + 1} ${dash}${C.reset}`)
        break
      }
      case "agent:start": {
        console.log(`${C.purple}${S.run} [${e.payload.agentName}] starting...${C.reset}`)
        break
      }
      case "agent:output": {
        // Tool activity is tagged. Headless stdout carries the agent's prose
        // only, so the byte stream is exactly what it was before `kind` existed.
        if (e.payload.kind && e.payload.kind !== "text") break
        process.stdout.write(`  ${e.payload.chunk}`)
        break
      }
      case "agent:complete": {
        const d = (e.payload.duration / 1000).toFixed(1)
        console.log(`${C.green}${S.ok} ${e.payload.agentName} done (${d}s)${C.reset}`)
        break
      }
      case "agent:failed": {
        // A cancelled run arrives on `agent:failed` with `status: "cancelled"`.
        // Saying "failed" for a Ctrl-C would blame the agent for the user's
        // decision, so the line is worded as a stop.
        if (e.payload.status === "cancelled") {
          console.log(`${C.yellow}${S.skip} ${e.payload.agentName} cancelled${C.reset}`)
          break
        }
        console.log(`${C.red}${S.fail} ${e.payload.agentName} failed: ${e.payload.error}${C.reset}`)
        break
      }
      case "agent:skipped": {
        console.log(`${C.yellow}${S.skip} ${e.payload.agentName} skipped${C.reset}`)
        break
      }
      case "agent:retrying": {
        console.log(
          `${C.yellow}${S.retry} ${e.payload.agentName} retry ${e.payload.attempt}/${e.payload.maxAttempts}: ${e.payload.error}${C.reset}`
        )
        break
      }
      case "orchestration:warning": {
        console.log(`${C.yellow}${S.warn} ${e.payload.message}${C.reset}`)
        break
      }
      case "orchestration:complete": {
        const { success, totalDuration, agentResults, reply } = e.payload
        // A turn that ran no pipeline has no table worth printing — the leader's
        // words are the whole result, so they go above the summary box.
        if (reply) {
          const mark = reply.mode === "ask" ? "?" : S.ok
          console.log(`\n${C.cyan}${mark} ${reply.message}${C.reset}`)
        }
        const line = (isFancy ? "═" : "=").repeat(50)
        const edge = isFancy ? ["╔", "║", "╚", "╗", "╝"] : ["+", "|", "+", "+", "+"]
        const title = reply
          ? reply.mode === "ask"
            ? `${S.warn} Needs your input`
            : `${S.ok} Answered`
          : e.payload.cancelled
            ? `${S.skip} Cancelled`
            : success
              ? `${S.ok} All done`
              : `${S.warn} Done (with failures)`
        console.log(`\n${C.bold}${C.purple}${edge[0]}${line}${edge[3]}`)
        console.log(`${edge[1]}  ${title.padEnd(48)}${edge[1]}`)
        console.log(`${edge[2]}${line}${edge[4]}${C.reset}`)
        const nameWidth = Math.max(8, ...agentResults.map((r) => r.agentName.length))
        const totalStr = `${(totalDuration / 1000).toFixed(1)}s`
        // The total cost is printed only when the run reported one: a provider
        // that does not price in USD leaves it undefined, and "$0.00" there would
        // claim a cost that was never measured.
        const cost = e.payload.totalCostUsd
        const costStr = cost === undefined ? "" : `  $${cost.toFixed(2)}`
        console.log(`  ~ ${"Total".padEnd(nameWidth)}   ${totalStr.padStart(7)}${costStr}`)
        for (const r of agentResults) {
          const { icon, color } = markFor(r.status)
          const dur = `${(r.duration / 1000).toFixed(1)}s`
          console.log(
            `  ${color}${icon}${C.reset} ${r.agentName.padEnd(nameWidth)}   ${dur.padStart(7)}`
          )
        }
        if (e.payload.deliverables && e.payload.deliverables.length > 0) {
          console.log(`\n  Deliverables:`)
          for (const file of e.payload.deliverables.slice(0, 5)) {
            console.log(`  ${S.bullet} ${file.path} (${file.status}, ${file.size} bytes)`)
          }
          if (e.payload.deliverables.length > 5) {
            console.log(`  ${S.bullet} … ${e.payload.deliverables.length - 5} more`)
          }
        }
        console.log()
        break
      }
    }
  }
}
