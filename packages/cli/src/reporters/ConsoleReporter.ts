import type { EventBus, MultiClawEvent } from "@multiclawcli/core"

// Degraded to plain ASCII when NO_COLOR is set, TERM=dumb, or stdout is not a TTY (pipe/CI).
const isFancy =
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  process.stdout.isTTY === true

const S = isFancy
  ? { ok: "✓", fail: "✗", run: "›", retry: "↻", skip: "⊘", warn: "⚠", bullet: "·" }
  : { ok: "+", fail: "x", run: ">", retry: "~", skip: "-", warn: "!", bullet: "*" }

const C = isFancy
  ? {
      reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
      cyan: "\x1b[36m", green: "\x1b[32m",
      yellow: "\x1b[33m", red: "\x1b[31m", purple: "\x1b[35m",
    }
  : {
      reset: "", bold: "", dim: "",
      cyan: "", green: "",
      yellow: "", red: "", purple: "",
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
        console.log(`${C.cyan}${S.bullet} Agents: ${e.payload.totalAgents}  Stages: ${e.payload.stages.length}${C.reset}\n`)
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
        process.stdout.write(`  ${e.payload.chunk}`)
        break
      }
      case "agent:complete": {
        const d = (e.payload.duration / 1000).toFixed(1)
        console.log(`${C.green}${S.ok} ${e.payload.agentName} done (${d}s)${C.reset}`)
        break
      }
      case "agent:failed": {
        console.log(`${C.red}${S.fail} ${e.payload.agentName} failed: ${e.payload.error}${C.reset}`)
        break
      }
      case "agent:skipped": {
        console.log(`${C.yellow}${S.skip} ${e.payload.agentName} skipped${C.reset}`)
        break
      }
      case "agent:retrying": {
        console.log(`${C.yellow}${S.retry} ${e.payload.agentName} retry ${e.payload.attempt}/${e.payload.maxAttempts}: ${e.payload.error}${C.reset}`)
        break
      }
      case "orchestration:complete": {
        const { success, totalDuration, agentResults } = e.payload
        const line = (isFancy ? "═" : "=").repeat(50)
        const edge = isFancy ? ["╔", "║", "╚", "╗", "╝"] : ["+", "|", "+", "+", "+"]
        const title = success ? `${S.ok} All done` : `${S.warn} Done (with failures)`
        console.log(`\n${C.bold}${C.purple}${edge[0]}${line}${edge[3]}`)
        console.log(`${edge[1]}  ${title.padEnd(48)}${edge[1]}`)
        console.log(`${edge[2]}${line}${edge[4]}${C.reset}`)
        const nameWidth = Math.max(8, ...agentResults.map((r) => r.agentName.length))
        const totalStr = `${(totalDuration / 1000).toFixed(1)}s`
        console.log(`  ~ ${"Total".padEnd(nameWidth)}   ${totalStr.padStart(7)}`)
        for (const r of agentResults) {
          const icon = r.status === "success" ? S.ok : S.fail
          const color = r.status === "success" ? C.green : C.red
          const dur = `${(r.duration / 1000).toFixed(1)}s`
          console.log(`  ${color}${icon}${C.reset} ${r.agentName.padEnd(nameWidth)}   ${dur.padStart(7)}`)
        }
        console.log()
        break
      }
    }
  }
}
