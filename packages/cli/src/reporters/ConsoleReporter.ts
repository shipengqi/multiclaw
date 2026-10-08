import type { EventBus, MultiClawEvent } from "@multiclaw/core"

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m",
  cyan: "\x1b[36m", green: "\x1b[32m",
  yellow: "\x1b[33m", red: "\x1b[31m", purple: "\x1b[35m",
}

export class ConsoleReporter {
  attach(eventBus: EventBus): () => void {
    return eventBus.subscribe((e) => this.handle(e))
  }

  private handle(e: MultiClawEvent): void {
    switch (e.type) {
      case "orchestration:start": {
        const line = "═".repeat(50)
        console.log(`\n${C.bold}${C.purple}╔${line}╗`)
        console.log(`║  🤖 ${e.payload.name.padEnd(46)}║`)
        console.log(`╚${line}╝${C.reset}`)
        console.log(`${C.cyan}🔢 Agents: ${e.payload.totalAgents}  |  Stages: ${e.payload.stages.length}${C.reset}\n`)
        break
      }
      case "stage:start": {
        console.log(`${C.cyan}${"─".repeat(16)} Stage ${e.payload.stageIndex + 1} ${"─".repeat(16)}${C.reset}`)
        break
      }
      case "agent:start": {
        console.log(`${C.purple}${e.payload.icon ?? "▶"} [${e.payload.agentName}] starting...${C.reset}`)
        break
      }
      case "agent:output": {
        process.stdout.write(`  ${e.payload.chunk}`)
        break
      }
      case "agent:complete": {
        const d = (e.payload.duration / 1000).toFixed(1)
        console.log(`${C.green}✅ ${e.payload.agentName} done (${d}s)${C.reset}`)
        break
      }
      case "agent:failed": {
        console.log(`${C.red}❌ ${e.payload.agentName} failed: ${e.payload.error}${C.reset}`)
        break
      }
      case "agent:skipped": {
        console.log(`${C.yellow}⏭️  ${e.payload.agentName} skipped${C.reset}`)
        break
      }
      case "agent:retrying": {
        console.log(`${C.yellow}🔄 ${e.payload.agentName} retry ${e.payload.attempt}/${e.payload.maxAttempts}: ${e.payload.error}${C.reset}`)
        break
      }
      case "orchestration:complete": {
        const { success, totalDuration, agentResults } = e.payload
        const line = "═".repeat(50)
        const title = success ? "🎉 All done" : "⚠️  Done (with failures)"
        console.log(`\n${C.bold}${C.purple}╔${line}╗`)
        console.log(`║  ${title.padEnd(47)}║`)
        console.log(`╚${line}╝${C.reset}`)
        console.log(`  ⏱️  Total: ${(totalDuration / 1000).toFixed(1)}s`)
        for (const r of agentResults) {
          const icon = r.status === "success" ? "✅" : "❌"
          console.log(`     ${icon} ${r.agentName.padEnd(20)} ${(r.duration / 1000).toFixed(1)}s`)
        }
        console.log()
        break
      }
    }
  }
}
