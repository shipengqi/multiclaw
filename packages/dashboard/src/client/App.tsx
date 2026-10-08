import React, { useState, useEffect, useRef } from "react"
import { Badge } from "@/components/ui/badge"
import { useWebSocket } from "./hooks/useWebSocket"
import { useOrchestrationStore } from "./store/useOrchestrationStore"
import { PipelineBar } from "./components/PipelineBar"
import { LogPanel } from "./components/LogPanel"

export function App() {
  const apply = useOrchestrationStore((s) => s.apply)
  const { name, running, success, totalDuration, stages, agents, preflightAgentIds, preflightBuffer } =
    useOrchestrationStore()
  const [selected, setSelected] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const autoSelectedRef = useRef(false)

  useWebSocket(apply)

  useEffect(() => {
    if (!running) { setElapsed(0); return }
    const start = Date.now()
    const id = setInterval(() => setElapsed(Date.now() - start), 1000)
    return () => clearInterval(id)
  }, [running])

  // Auto-select leader the moment it appears as running
  useEffect(() => {
    if (autoSelectedRef.current) return
    for (const [id, agent] of Object.entries(preflightBuffer)) {
      if (agent.status === "running") {
        setSelected(id)
        autoSelectedRef.current = true
        return
      }
    }
  }, [preflightBuffer])

  // Reset auto-select flag at the start of each new run
  useEffect(() => {
    if (running) autoSelectedRef.current = false
  }, [running])

  const leaderIds = preflightAgentIds.length > 0 ? preflightAgentIds : Object.keys(preflightBuffer)
  const leaderAgents = preflightAgentIds.length > 0 ? agents : preflightBuffer

  const hasPipelineBar = leaderIds.length > 0 || stages.length > 0

  const statusBadge = running
    ? <Badge className="bg-green-500 hover:bg-green-500/80">Running</Badge>
    : success === undefined
      ? <Badge variant="secondary">Waiting</Badge>
      : success
        ? <Badge className="bg-green-500 hover:bg-green-500/80">Done</Badge>
        : <Badge variant="destructive">Failed</Badge>

  const displayDuration = totalDuration != null ? totalDuration : running ? elapsed : null

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="flex items-center justify-between px-6 py-3 border-b shrink-0">
        <h1 className="text-base font-semibold">
          MultiClaw{name && <span className="text-muted-foreground font-normal"> · {name}</span>}
        </h1>
        <div className="flex items-center gap-3 text-sm">
          {displayDuration != null && (
            <span className="text-muted-foreground">{(displayDuration / 1000).toFixed(1)}s</span>
          )}
          {statusBadge}
        </div>
      </header>

      {hasPipelineBar && (
        <div className="border-b px-4 py-3 shrink-0 overflow-x-auto">
          <PipelineBar
            leaderIds={leaderIds}
            leaderAgents={leaderAgents}
            stages={stages}
            agents={agents}
            onSelect={setSelected}
            selectedId={selected}
          />
        </div>
      )}

      <div className="flex-1 overflow-hidden p-4">
        <LogPanel agentId={selected} />
      </div>
    </div>
  )
}
