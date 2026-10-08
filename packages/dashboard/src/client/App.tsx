import React, { useState, useEffect } from "react"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { useWebSocket } from "./hooks/useWebSocket"
import { useOrchestrationStore } from "./store/useOrchestrationStore"
import { StageList } from "./components/StageList"
import { LogPanel } from "./components/LogPanel"

export function App() {
  const apply = useOrchestrationStore((s) => s.apply)
  const { name, running, success, totalDuration } = useOrchestrationStore()
  const [selected, setSelected] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)

  useWebSocket(apply)

  useEffect(() => {
    if (!running) { setElapsed(0); return }
    const start = Date.now()
    const id = setInterval(() => setElapsed(Date.now() - start), 1000)
    return () => clearInterval(id)
  }, [running])

  const statusBadge = running
    ? <Badge className="bg-green-500 hover:bg-green-500/80">运行中</Badge>
    : success === undefined
      ? <Badge variant="secondary">等待中</Badge>
      : success
        ? <Badge className="bg-green-500 hover:bg-green-500/80">完成</Badge>
        : <Badge variant="destructive">存在失败</Badge>

  const displayDuration = totalDuration != null
    ? totalDuration
    : running ? elapsed : null

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="flex items-center justify-between px-6 py-3 border-b">
        <h1 className="text-base font-semibold">
          MultiClaw{name && <span className="text-muted-foreground font-normal"> · {name}</span>}
        </h1>
        <div className="flex items-center gap-3 text-sm">
          {displayDuration != null && (
            <span className="text-muted-foreground">
              ⏱ {(displayDuration / 1000).toFixed(1)}s
            </span>
          )}
          {statusBadge}
        </div>
      </header>
      <main className="flex-1 flex gap-4 p-4 overflow-hidden">
        <div className="w-80 overflow-auto">
          <StageList onSelect={setSelected} selectedId={selected} />
        </div>
        <Separator orientation="vertical" />
        <div className="flex-1 overflow-hidden">
          <LogPanel agentId={selected} />
        </div>
      </main>
    </div>
  )
}
