import React from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type AgentStatus = "pending" | "running" | "retrying" | "success" | "failed" | "skipped"

const STATUS_CONFIG: Record<AgentStatus, {
  label: string
  variant: "secondary" | "default" | "destructive" | "outline"
  className?: string
}> = {
  pending:   { label: "pending",  variant: "secondary" },
  running:   { label: "running",  variant: "default", className: "animate-pulse" },
  retrying:  { label: "retrying", variant: "default", className: "animate-pulse bg-yellow-500 hover:bg-yellow-500/80" },
  success:   { label: "done",     variant: "default",  className: "bg-green-500 hover:bg-green-500/80" },
  failed:    { label: "failed",   variant: "destructive" },
  skipped:   { label: "skipped",  variant: "outline" },
}

export function AgentCard({ agent, onClick, selected }: {
  agent: { name: string; icon?: string; status: string; duration?: number }
  onClick: () => void
  selected?: boolean
}) {
  const cfg = STATUS_CONFIG[agent.status as AgentStatus] ?? STATUS_CONFIG.pending
  return (
    <Card
      onClick={onClick}
      className={cn("cursor-pointer hover:bg-accent transition-colors", selected && "bg-accent ring-1 ring-ring")}
    >
      <CardContent className="flex items-center justify-between p-3">
        <div className="flex items-center gap-2">
          <span>{agent.icon ?? "-"}</span>
          <span className="font-medium text-sm">{agent.name}</span>
        </div>
        <div className="flex items-center gap-2">
          {agent.duration != null && (
            <span className="text-xs text-muted-foreground">
              {(agent.duration / 1000).toFixed(1)}s
            </span>
          )}
          <Badge variant={cfg.variant} className={cn(cfg.className)}>
            {cfg.label}
          </Badge>
        </div>
      </CardContent>
    </Card>
  )
}
