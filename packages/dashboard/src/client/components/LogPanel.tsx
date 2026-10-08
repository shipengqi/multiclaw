import React, { useEffect, useRef } from "react"
import { useOrchestrationStore } from "../store/useOrchestrationStore"

export function LogPanel({ agentId }: { agentId: string | null }) {
  const agents = useOrchestrationStore((s) => s.agents)
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolled = useRef(false)
  const logs = agentId ? agents[agentId]?.logs ?? "" : ""
  const agentName = agentId ? agents[agentId]?.name : null

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    userScrolled.current = el.scrollHeight - el.scrollTop - el.clientHeight > 50
  }

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
            <p className="text-zinc-400 mb-3 text-xs">📄 {agentName} 日志</p>
            <pre className="whitespace-pre-wrap leading-relaxed">{logs}</pre>
          </>
        ) : (
          <p className="text-zinc-500">← 选择一个 Agent 查看实时日志</p>
        )}
      </div>
    </div>
  )
}
