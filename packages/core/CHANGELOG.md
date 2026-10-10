# @multiclawcli/core

## 0.4.0

### Minor Changes

- 9b51eb3: Stop silently swallowing task-plan failures, and make leader-plan parsing robust.
  
  - `@multiclawcli/core`: the orchestrator now emits an `orchestration:warning` event when
    `task-plan.json` exists but cannot be parsed, or has no `tasks` array, instead of dropping the
    error in an empty `catch`. It still degrades gracefully by running the original agent set.
  - `@multiclawcli/core`: the leader's plan is extracted with a brace-aware scanner rather than a
    regular expression, so nested JSON objects or braces inside string values no longer break
    agent selection.
  - `multiclaw`: the console reporter renders `orchestration:warning` events.
