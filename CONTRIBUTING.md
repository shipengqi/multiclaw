# Contributing

Thanks for taking the time to contribute. This document describes how to set up the repo, what the
automated checks expect, and what "done" means for a change.

## Prerequisites

- **Node** `^22.12.0 || >=24.0.0` (see `devEngines` in the root `package.json`). The lower bound is
  not arbitrary: Vite 8, rolldown and `@vitejs/plugin-react` 6 all declare `engines.node`
  `^20.19.0 || >=22.12.0`, so Node 22.0–22.11 cannot run the build.
- **pnpm** 12 (`packageManager` is pinned; use `corepack enable` if you don't have it)
- A working `claude` CLI if you want to run the example pipeline end to end

## Getting started

```bash
git clone https://github.com/shipengqi/multiclaw.git
cd multiclaw
pnpm install
```

`pnpm install` also runs `husky`, which installs the pre-commit hook.

> **Strict peer dependencies are on.** `pnpm-workspace.yaml` sets `strictPeerDependencies: true`, so
> `pnpm install` **fails** when a dependency's peer range is not satisfied, instead of printing a
> warning and installing a broken combination anyway. If you hit one, fix the version range or the
> dependency — do not switch the setting off. This is what stops a pairing such as
> `@vitejs/plugin-react@6` (peer `vite ^8`) being installed next to `vite@5`, which otherwise only
> surfaces much later as `ERR_PACKAGE_PATH_NOT_EXPORTED` during `vite build`.

## Repository layout

| Path | Package | Purpose |
|------|---------|---------|
| `packages/core` | `@multiclawcli/core` | Orchestration engine: event bus, stage builder, agent runner, runtimes |
| `packages/cli` | `multiclaw` | The CLI: config loading, commands, reporters |
| `packages/dashboard` | `@multiclawcli/dashboard` | Live web dashboard (React client + WebSocket server) |
| `examples/dev-team` | `dev-team-example` (private) | Runnable example pipeline |

`core` is the only package with no internal dependencies; `cli` and `dashboard` both depend on it.

## Everyday commands

Run these from the repository root:

| Command | What it does |
|---------|--------------|
| `pnpm build` | Build every package (`pnpm -r build`) |
| `pnpm typecheck` | Type-check every package |
| `pnpm test` | Run every package's test suite |
| `pnpm test:coverage` | Same, but enforces the coverage thresholds |
| `pnpm lint` | Biome lint + format check (no writes) |
| `pnpm lint:fix` | Apply safe lint/format fixes |
| `pnpm verify` | `lint` → `build` → `typecheck` → `test` — run this before pushing |
| `pnpm dev:example` | Run the `dev-team` example pipeline |

> **Why `build` comes before `typecheck`:** `cli` and `dashboard` resolve cross-package types from
> `packages/core/dist/*.d.ts`. On a clean checkout, type-checking without building `core` first fails
> with `TS2307: Cannot find module '@multiclawcli/core'`. Do not reorder these steps in CI.

## Quality gates

CI (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request:

1. `pnpm install --frozen-lockfile`
2. `pnpm lint`
3. `pnpm -r build`
4. `pnpm typecheck`
5. `pnpm test:coverage`

The pre-commit hook runs Biome on staged files via `lint-staged`, so formatting and lint problems are
usually caught before they reach CI.

## Definition of Done

A change is ready to merge when **all** of the following hold:

- [ ] `pnpm verify` passes locally.
- [ ] New behaviour is covered by tests, and bug fixes include a regression test that fails without
      the fix.
- [ ] Coverage thresholds are not lowered. They live in each package's `vitest.config.ts`; if you
      genuinely cannot cover new code, raise it explicitly in the PR description rather than
      weakening the threshold silently. A test-runner **major** upgrade can change what the coverage
      provider counts — re-measure, state the new numbers in the PR, and adjust the baseline; that is
      a re-baseline, not a lowering.
- [ ] User-facing changes to a published package come with a changeset (see below).
- [ ] `pnpm lint` is clean — no new warnings.
- [ ] Public API changes are reflected in the relevant `README`.

## Testing

- Tests are **co-located** with the code: `src/**/*.test.ts` next to `src/**/*.ts`.
- We use [Vitest](https://vitest.dev/). Prefer `vi.useFakeTimers()` over real sleeps, and keep
  fixtures in temp directories (`fs.mkdtempSync`) rather than the repo.
- `packages/core/src/testing/helpers.ts` has `makeAgent` / `fakeRuntime` for stubbing the runtime
  registry — reuse it instead of hand-rolling stubs.
- Coverage thresholds are a **baseline lock**, not a target. They exist to stop coverage from sliding
  backwards; raise them as untested areas gain coverage.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) style prefixes, e.g.:

```
feat(core): emit orchestration:warning on malformed task plan
fix(cli): handle a missing config path explicitly
chore(deps): bump vitest to 3.2.7
```

## Changesets

The three published packages are versioned in lockstep (a `fixed` group in `.changeset/config.json`).

Any PR that changes the runtime behaviour or public API of `@multiclawcli/core`,
`@multiclawcli/dashboard` or `multiclaw` must include a changeset:

```bash
pnpm changeset
```

Pick the affected packages and the bump type, then commit the generated `.changeset/*.md` file with
your change. Internal-only changes (tests, CI, docs) do not need one — but a missing changeset on a
published package **silently skips a release**, so when in doubt add one.

## Release process (maintainers)

Releases are **manual**. Merging a PR never publishes anything.

Open **Actions → Release → Run workflow** on `main`. The workflow then applies the pending changesets
(version bumps + CHANGELOGs), commits the bump to `main`, publishes to npm and pushes the release
tags. Tick **Dry run** to preview the resulting diff without committing or publishing.

Publishing uses **npm trusted publishing (OIDC)** — there is no `NPM_TOKEN` secret. The
workflow requests `id-token: write`, and each package has a trusted publisher configured on
npmjs.com with the workflow filename `release.yml`. If you rename that file, update the
trusted publisher to match or publishing will start failing.

See [`RELEASING.md`](./RELEASING.md) (English) or [`RELEASING.zh-CN.md`](./RELEASING.zh-CN.md) (中文)
for the full process, versioning rules and troubleshooting.

## Dependency updates

Dependabot (`.github/dependabot.yml`) opens grouped PRs for npm and GitHub Actions updates every
Monday. Treat these like any other PR: they must pass `pnpm verify`.
