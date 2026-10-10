import type { StageInfo } from "@multiclawcli/core"
import React from "react"
import { cn } from "@/lib/utils"

type Status = "pending" | "running" | "retrying" | "success" | "failed" | "skipped"

const LEADER_BAR: Record<Status, string> = {
  pending: "bg-muted-foreground/20",
  running: "bg-violet-500 animate-pulse",
  retrying: "bg-yellow-500 animate-pulse",
  success: "bg-violet-400",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/20",
}

const STAGE_BAR: Record<Status, string> = {
  pending: "bg-muted-foreground/20",
  running: "bg-blue-500 animate-pulse",
  retrying: "bg-yellow-500 animate-pulse",
  success: "bg-green-500",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/20",
}

const NAME_COLOR: Record<Status, string> = {
  pending: "text-muted-foreground",
  running: "text-foreground",
  retrying: "text-yellow-600",
  success: "text-foreground",
  failed: "text-destructive",
  skipped: "text-muted-foreground/50",
}

const STATUS_LABEL: Record<Status, string> = {
  pending: "pending",
  running: "running",
  retrying: "retrying",
  success: "",
  failed: "failed",
  skipped: "skipped",
}

const STATUS_LABEL_COLOR: Record<Status, string> = {
  pending: "text-muted-foreground/50",
  running: "text-blue-500",
  retrying: "text-yellow-500",
  success: "text-green-500",
  failed: "text-destructive",
  skipped: "text-muted-foreground/40",
}

const LEADER_LABEL_COLOR: Record<Status, string> = {
  ...STATUS_LABEL_COLOR,
  running: "text-violet-500",
  success: "text-violet-400",
}

function stageAggregate(stage: StageInfo, agents: Record<string, { status: string }>): Status {
  const ss = stage.agents.map((a) => (agents[a.id]?.status ?? "pending") as Status)
  if (ss.some((s) => s === "failed")) return "failed"
  if (ss.some((s) => s === "running" || s === "retrying")) return "running"
  if (ss.every((s) => s === "success")) return "success"
  if (ss.every((s) => s === "skipped")) return "skipped"
  return "pending"
}

interface AgentInfo {
  id: string
  name: string
  icon?: string
  model?: string
  taskTitle?: string
  status: string
  duration?: number
}

function AgentRow({
  agent,
  isSelected,
  onClick,
  labelColor,
}: {
  agent: AgentInfo
  isSelected: boolean
  onClick: () => void
  labelColor: Record<Status, string>
}) {
  const status = agent.status as Status
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 w-full px-2 py-1.5 text-left transition-colors rounded",
        "hover:bg-accent",
        isSelected && "bg-accent"
      )}
    >
      <span className="text-sm leading-none shrink-0">{agent.icon ?? "-"}</span>
      <div className="flex-1 min-w-0">
        <div className={cn("text-[11px] font-medium truncate", NAME_COLOR[status])}>
          {agent.name}
        </div>
        {agent.taskTitle && (
          <div className="text-[8px] text-muted-foreground truncate">{agent.taskTitle}</div>
        )}
        <div className="flex items-center justify-between gap-2 text-[9px]">
          <div className={cn(labelColor[status])}>
            {agent.duration != null
              ? `${(agent.duration / 1000).toFixed(1)}s`
              : STATUS_LABEL[status]}
          </div>
          {agent.model && (
            <span className="text-muted-foreground text-[8px] truncate">{agent.model}</span>
          )}
        </div>
      </div>
    </button>
  )
}

export function PipelineBar({
  leaderIds,
  leaderAgents,
  stages,
  agents,
  onSelect,
  selectedId,
}: {
  leaderIds: string[]
  leaderAgents: Record<string, AgentInfo>
  stages: StageInfo[]
  agents: Record<string, AgentInfo>
  onSelect: (id: string) => void
  selectedId?: string | null
}) {
  const hasLeader = leaderIds.length > 0
  const hasPipeline = stages.length > 0
  const leaderRunning = leaderIds.some((id) => leaderAgents[id]?.status === "running")
  if (!hasLeader && !hasPipeline) return null

  return (
    <div className="flex items-stretch gap-0 overflow-x-auto">
      {/* Leader card */}
      {hasLeader &&
        leaderIds.map((id) => {
          const agent = leaderAgents[id] ?? { id, name: id, status: "pending" }
          const status = agent.status as Status
          return (
            <div key={id} className="shrink-0 w-[130px] rounded-md border bg-card overflow-hidden">
              <div className={cn("h-1 w-full", LEADER_BAR[status])} />
              <div className="px-2 pt-1 pb-0.5">
                <span className="text-[9px] uppercase tracking-wide text-muted-foreground/70 font-semibold">
                  Leader
                </span>
              </div>
              <AgentRow
                agent={agent}
                isSelected={selectedId === id}
                onClick={() => onSelect(id)}
                labelColor={LEADER_LABEL_COLOR}
              />
            </div>
          )
        })}

      {/* Connector: "generating" dots while leader is running, "generated" arrow once pipeline is ready */}
      {hasLeader && (
        <div className="flex flex-col items-center justify-center shrink-0 px-2 gap-0.5 self-center">
          {hasPipeline ? (
            <>
              <span className="text-[8px] uppercase tracking-wide text-muted-foreground/50">
                generated
              </span>
              <div className="flex items-center">
                <div className="w-5 h-px border-t border-dashed border-muted-foreground/30" />
                <svg
                  aria-hidden="true"
                  width="5"
                  height="7"
                  viewBox="0 0 5 7"
                  className="text-muted-foreground/40 shrink-0"
                >
                  <path d="M0 0 L5 3.5 L0 7 Z" fill="currentColor" />
                </svg>
              </div>
            </>
          ) : leaderRunning ? (
            <>
              <span className="text-[8px] text-violet-400 animate-pulse">generating</span>
              <div className="flex items-center gap-0.5">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-1 h-1 rounded-full bg-violet-400 animate-bounce"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>
      )}

      {/* Pipeline stage cards */}
      {hasPipeline &&
        stages.map((stage, idx) => {
          const ss = stageAggregate(stage, agents)
          return (
            <React.Fragment key={stage.stageIndex}>
              {idx > 0 && (
                <div className="flex items-center self-center shrink-0">
                  <div className="w-3 h-px bg-border" />
                  <svg
                    aria-hidden="true"
                    width="5"
                    height="7"
                    viewBox="0 0 5 7"
                    className="text-muted-foreground/40 shrink-0"
                  >
                    <path d="M0 0 L5 3.5 L0 7 Z" fill="currentColor" />
                  </svg>
                </div>
              )}
              <div className="shrink-0 w-[130px] rounded-md border bg-card overflow-hidden">
                <div className={cn("h-1 w-full", STAGE_BAR[ss])} />
                <div className="py-1">
                  {stage.agents.map((a) => {
                    const agent = agents[a.id] ?? {
                      id: a.id,
                      name: a.name,
                      icon: a.icon,
                      status: "pending",
                    }
                    return (
                      <AgentRow
                        key={a.id}
                        agent={agent}
                        isSelected={selectedId === a.id}
                        onClick={() => onSelect(a.id)}
                        labelColor={STATUS_LABEL_COLOR}
                      />
                    )
                  })}
                </div>
              </div>
            </React.Fragment>
          )
        })}
    </div>
  )
}
