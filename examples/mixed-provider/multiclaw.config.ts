import { agents, defineConfig } from "multiclaw"

/**
 * Mixed-provider team — each agent can run on a different provider, because
 * `runtime` is always `acp` and `provider` selects the agent product.
 *
 * `multiclaw init` (v1) generates a single `defaults.provider` for the whole
 * team, but the core fully supports per-agent providers like this. Use it when
 * you want, say, a fast OpenCode model for the grunt work and Claude Opus for
 * architecture and review.
 */
export default defineConfig({
  name: "Mixed Provider Demo",
  workDir: "./workspace",
  // Default the team to OpenCode; override per agent below.
  defaults: {
    provider: "opencode",
    model: "opencode/big-pickle",
  },
  leader: agents.leader({ provider: "claude", model: "haiku" }),
  agents: [
    // Architecture on Claude Opus for higher-quality design.
    agents.architect({ provider: "claude", model: "opus" }),
    // Implementation on a fast OpenCode model (falls back to defaults).
    agents.backendDeveloper({ dependsOn: ["architect"] }),
    // Review on Claude Sonnet for careful diff reading.
    agents.codeReviewer({ provider: "claude", model: "sonnet", dependsOn: ["backend-developer"] }),
  ],
})
