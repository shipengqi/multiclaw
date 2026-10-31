import { resolveCommand } from "../providers/resolve"
import { runtimeRegistry } from "../runtime"
import type { AgentDefinition } from "../types/agent"
import type { MultiClawConfig } from "../types/config"
import type { AgentRuntime, RuntimeInfo } from "../types/runtime"
import { abortError } from "../utils/abort"

const TOOLS_PROVENANCE = Symbol.for("multiclaw.toolsProvenance")
type ToolsProvenance =
  | { explicit: true }
  | { explicit: false; reference: string[] | undefined; snapshot: readonly string[] }
type TrackedAgent = AgentDefinition & { [TOOLS_PROVENANCE]?: ToolsProvenance }

/** Record factory defaults without altering the tools array passed to the runtime. */
export function markPresetTools(
  agent: AgentDefinition,
  overrides?: Partial<AgentDefinition>
): AgentDefinition {
  const provenance: ToolsProvenance =
    overrides?.tools !== undefined
      ? { explicit: true }
      : {
          explicit: false,
          reference: agent.tools,
          snapshot: Object.freeze([...(agent.tools ?? [])]),
        }
  Object.defineProperty(agent, TOOLS_PROVENANCE, {
    value: Object.freeze(provenance),
    enumerable: true,
  })
  return agent
}

/** Spreads retain provenance; equal replacement arrays and in-place edits are explicit. */
export function hasExplicitTools(agent: AgentDefinition): boolean {
  if (agent.tools === undefined) return false
  const provenance = (agent as TrackedAgent)[TOOLS_PROVENANCE]
  if (!provenance || provenance.explicit) return true
  return (
    agent.tools !== provenance.reference ||
    agent.tools.length !== provenance.snapshot.length ||
    agent.tools.some((tool, index) => tool !== provenance.snapshot[index])
  )
}

/** Validate the entire configured team before routing, execution, or workspace cleanup. */
export async function validateToolsPolicy(
  config: MultiClawConfig,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  const { signal } = options
  const checkAbort = () => {
    if (signal?.aborted) throw abortError()
  }
  checkAbort()
  const agents = [
    ...(config.leader && config.useLeader !== false ? [config.leader] : []),
    ...config.agents,
  ]
  const descriptions = new Map<AgentRuntime, Map<string, RuntimeInfo>>()
  for (const agent of agents) {
    checkAbort()
    if (!hasExplicitTools(agent)) continue
    const runtime = runtimeRegistry.get(agent.runtime ?? "acp")
    const command = resolveCommand(agent, config)
    let commands = descriptions.get(runtime)
    if (!commands) {
      commands = new Map()
      descriptions.set(runtime, commands)
    }
    let info = commands.get(command)
    if (!info) {
      let onAbort: (() => void) | undefined
      const cancelled = new Promise<never>((_, reject) => {
        if (!signal) return
        onAbort = () => reject(abortError())
        signal.addEventListener("abort", onAbort, { once: true })
      })
      try {
        // The race observes late probe rejections even after cancellation wins.
        info = await Promise.race([runtime.describe({ command }), cancelled])
      } catch (error) {
        checkAbort()
        throw error
      } finally {
        if (onAbort) signal?.removeEventListener("abort", onAbort)
      }
      checkAbort()
      commands.set(command, info)
    }
    if (!info.capabilities.tools) {
      throw new Error(
        `Agent "${agent.name}" (${agent.id}), runtime "${runtime.name}", resolved command "${command}" cannot enforce explicit tools. Select a provider that supports tools restrictions or remove the explicit tools setting; the policy will not be relaxed.`
      )
    }
  }
  checkAbort()
}
