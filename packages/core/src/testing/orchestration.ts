import { AgentRunner } from "../orchestrator/AgentRunner"
import { AgentSessionManager } from "../orchestrator/AgentSessionManager"
import { ContextManager } from "../orchestrator/ContextManager"
import { Coordinator } from "../orchestrator/Coordinator"
import { Orchestrator as Implementation } from "../orchestrator/Orchestrator"
import type { AgentDefinition } from "../types/agent"
import type { MultiClawConfig } from "../types/config"
import type { LeaderDecision } from "../types/leader"
import { abortError } from "../utils/abort"
import { renderConversation } from "../utils/conversation"
import { parseLeaderDecision } from "../utils/leaderDecision"

/** Existing worker/DAG tests inject routing fixtures; real host integration is tested separately. */
export interface TestConfig extends MultiClawConfig {
  coordinatorFixture?: AgentDefinition
  skipRoutingFixture?: boolean
}
class FixtureCoordinator extends Coordinator {
  constructor(
    private fixture: TestConfig,
    private workers: AgentSessionManager
  ) {
    super(fixture)
  }
  private calls = 0
  override async route(request: string, signal?: AbortSignal): Promise<LeaderDecision> {
    const facts = JSON.parse(request)
    const selected = facts.availableAgents as Array<{
      id: string
      name: string
      description?: string
    }>
    const agent = this.fixture.coordinatorFixture
    if (!agent || this.fixture.skipRoutingFixture)
      return { mode: "run", run: selected.map((a) => a.id) }
    const context = new ContextManager({
      ...this.fixture.context,
      requirement: facts.requirement,
      conversation: renderConversation(this.fixture.history),
      latestWork: JSON.stringify(facts.latestWork) ?? "No previous work.",
      availableAgents: selected
        .map((a) => a.id + ": " + a.name + " — " + (a.description ?? ""))
        .join("\n"),
    })
    const result = await new AgentRunner(
      this.eventBus,
      context,
      this.fixture.workDir,
      this.fixture,
      this.workers
    ).run(
      agent,
      signal,
      (facts.recovery || "") + (this.calls++ ? "\nYour previous routing decision was invalid." : "")
    )
    if (result.status === "cancelled") throw abortError()
    if (result.status !== "success") throw new Error(result.error ?? "Fixture failed")
    const decision = parseLeaderDecision(result.output)
    if (decision) return decision
    if (result.output.trim() && !/^[{[]/.test(result.output.trim()))
      return { mode: "reply", message: result.output }
    throw new Error("Invalid fixture decision")
  }
  override async summarize(): Promise<string> {
    return ""
  }
}
export class TestOrchestrator extends Implementation {
  constructor(config: TestConfig, sessions?: AgentSessionManager) {
    const { coordinatorFixture: _, skipRoutingFixture: _skip, ...production } = config
    const workers = sessions ?? new AgentSessionManager()
    super(production, sessions, { coordinator: new FixtureCoordinator(config, workers) })
  }
}
