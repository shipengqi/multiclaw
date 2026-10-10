import { useEffect, useRef } from "react"
import { useOrchestrationStore } from "../store/useOrchestrationStore"

export function LogPanel({ agentId }: { agentId: string | null }) {
  const agents = useOrchestrationStore((s) => s.agents)
  const preflightBuffer = useOrchestrationStore((s) => s.preflightBuffer)
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolled = useRef(false)
  const agentState = agentId ? (agents[agentId] ?? preflightBuffer[agentId]) : undefined
  const logs = agentState?.logs ?? ""
  const agentName = agentState?.name ?? null

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    userScrolled.current = el.scrollHeight - el.scrollTop - el.clientHeight > 50
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: `logs` is an intentional trigger — re-scroll when new output arrives
  useEffect(() => {
    if (userScrolled.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="h-full overflow-auto rounded-lg border bg-zinc-950 text-zinc-100"
    >
      <div className="p-4 font-mono text-sm">
        {agentId ? (
          <>
            <p className="text-zinc-400 mb-3 text-xs">{agentName} logs</p>
            <pre className="whitespace-pre-wrap leading-relaxed">{logs}</pre>
          </>
        ) : (
          <p className="text-zinc-500">Select an agent to view live logs</p>
        )}
      </div>
    </div>
  )
}
