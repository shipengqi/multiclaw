import React from "react"
import { Separator } from "@/components/ui/separator"
import { useOrchestrationStore } from "../store/useOrchestrationStore"
import { AgentCard } from "./AgentCard"

export function StageList({ onSelect, selectedId }: { onSelect: (agentId: string) => void; selectedId?: string | null }) {
  const { stages, agents, preflightAgentIds } = useOrchestrationStore()
  return (
    <div className="space-y-4">
      {preflightAgentIds.length > 0 && (
        <>
          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
              Leader
            </p>
            <div className="space-y-2">
              {preflightAgentIds.map((id) => (
                <AgentCard
                  key={id}
                  agent={agents[id] ?? { name: id, status: "pending" }}
                  onClick={() => onSelect(id)}
                  selected={selectedId === id}
                />
              ))}
            </div>
          </div>
          {stages.length > 0 && (
            <div className="flex flex-col items-center gap-1 py-1">
              <div className="w-px h-3 bg-border" />
              <span className="text-xs text-muted-foreground">Pipeline</span>
              <div className="w-px h-3 bg-border" />
            </div>
          )}
        </>
      )}
      {stages.map((stage, idx) => (
        <div key={stage.stageIndex}>
          {idx > 0 && <Separator className="my-3" />}
          <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
            Stage {stage.stageIndex + 1}
          </p>
          <div className="space-y-2">
            {stage.agents.map((a) => (
              <AgentCard
                key={a.id}
                agent={agents[a.id] ?? { name: a.name, icon: a.icon, status: "pending" }}
                onClick={() => onSelect(a.id)}
                selected={selectedId === a.id}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
