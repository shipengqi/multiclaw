# Releasing

[中文](./RELEASING.zh-CN.md)

`multiclaw` ships three published packages:

| Package | What it is |
| --- | --- |
| `@multiclawcli/core` | Orchestration engine |
| `multiclaw` | The CLI |
| `@multiclawcli/dashboard` | Live web dashboard |

All three are versioned **in lockstep** — they always share the same version. This is
enforced by a `fixed` group in `.changeset/config.json`.

Releases are driven by [Changesets](https://github.com/changesets/changesets) and are
**started by hand**. Nothing is published automatically when a pull request is merged.

---

## Part 1 — If you are opening a pull request

### You must add a changeset when

your change affects the **runtime behaviour or public API** of any published package
(`@multiclawcli/core`, `multiclaw`, `@multiclawcli/dashboard`).

### You do not need one when

the change only touches:

- tests (`*.test.ts`)
- CI, workflows or tooling configuration
- documentation
- the private `examples/dev-team` package

> When in doubt, add one. An extra changeset is cheap; a missing one silently skips a
> release.

### How to add one

```bash
pnpm changeset
```

The CLI asks three things:

1. **Which packages changed** — space to select, enter to confirm.
2. **The bump type** — `major`, `minor` or `patch`.
3. **A summary** — one or two sentences describing the change from a user's point of
   view. This text becomes the CHANGELOG entry, so write it for users, not for reviewers.

It writes a file named `.changeset/<random-name>.md`. **Commit that file together with
your code.**

A changeset looks like this:

```markdown
---
"@multiclawcli/core": minor
"multiclaw": patch
---

Emit an `orchestration:warning` event when `task-plan.json` cannot be parsed.
```

### Choosing the bump type

While the packages are on `0.x`:

| Type | Use for |
| --- | --- |
| `patch` | Bug fixes and internal refactors with no API change |
| `minor` | New features, behaviour changes, anything a user would notice |
| `major` | Breaking changes (reserved until the API stabilises) |

Because the three packages form a `fixed` group, the **highest** bump among them wins and
is applied to all three. A `patch` on `multiclaw` plus a `minor` on `@multiclawcli/core`
releases **all three** as a `minor`.

### What happens if you forget

Nothing. Your pull request merges, CI stays green, and no release is produced — the
version simply never moves. This is the one failure mode the process cannot catch on its
own, so reviewers should look for a changeset whenever a published package is touched.

---

## Part 2 — If you are cutting a release (maintainers)

### Prerequisites

Publishing uses **npm trusted publishing (OIDC)**. There is no npm token anywhere in this
repository — no `NPM_TOKEN` secret, no `~/.npmrc` in the workflow. Two things must be true
on npmjs.com:

1. **Each published package has a trusted publisher configured.** On the package's settings
   page (`https://www.npmjs.com/package/<package>/access` → **Trusted Publisher** → **GitHub
   Actions**) fill in:

   | Field | Value |
   | --- | --- |
   | Organization or user | `shipengqi` |
   | Repository | `multiclaw` |
   | Workflow filename | `release.yml` — the bare filename, **not** `.github/workflows/release.yml` |
   | Environment name | leave blank |
   | Allowed actions | allow `npm publish` |

   These are matched **exactly**, including case. A renamed workflow file silently breaks
   publishing months later, so re-check this field whenever `release.yml` is renamed.

   Repeat for all three packages: `@multiclawcli/core`, `multiclaw`, `@multiclawcli/dashboard`.

2. **The workflow keeps `id-token: write`.** That permission is what lets the publish step
   mint a short-lived OIDC identity. Without it the registry rejects the request and there is
   no fallback.

> **Do not add an `NPM_TOKEN` secret or write a token into `~/.npmrc`.** A token in the
> environment makes the package manager take the legacy token path, the OIDC exchange never
> runs, and the publish fails with an authentication error even though trusted publishing is
> configured correctly.

> **Branch protection:** the workflow pushes the `chore: release` commit straight to `main`. If
> `main` is protected by required pull requests or required status checks, allow the GitHub Actions
> app to bypass those rules — otherwise the push is rejected and the release stops there.

### Cutting the release

1. Open **Actions → Release → Run workflow**.
2. Keep the branch set to `main`.
3. Leave **Dry run** unchecked.
4. Press **Run workflow**.

That is the entire release. There is no pull request to merge and no version number to
type.

### Previewing first (optional)

Tick **Dry run** to build and apply the version bumps **without** committing, pushing or
publishing. The run prints the resulting diff, so you can confirm the version numbers and
the CHANGELOG wording before doing it for real.

### What the workflow does

1. **Checks out `main`** with **full history** (`fetch-depth: 0`). This exists purely for
   CHANGELOG attribution: to render an entry like `- abc1234: Fix the thing`, changesets runs
   `git log --diff-filter=AC --follow --max-count=1 .changeset/<id>.md` to find the commit that
   added each changeset file. On a shallow clone the boundary commit has no visible parent, so
   changesets falls back to deepening the clone (`git fetch --deepen=50`) in a loop — slower,
   and it can fail outright.
2. **Refuses to continue when there are no pending changesets** — a release with nothing
   to release is a mistake, not a no-op.
3. **Builds every package** (`pnpm -r build`).
4. **Applies version bumps and CHANGELOG entries** (`pnpm version-packages`, which runs
   `changeset version`). The consumed `.changeset/*.md` files are deleted at this point;
   their text lives on in the per-package `CHANGELOG.md`.
5. **Commits and pushes** the bump to `main` as `chore: release`.
6. **Publishes** the bumped packages to npm (`pnpm release`, which runs
   `changeset publish`).
7. **Pushes the release tags** — `changeset publish` creates tags such as
   `@multiclawcli/core@0.4.0` locally but does not push them itself.

> **Why not just derive the release from git history?** Steps 1 and 2 are unrelated.
> `fetch-depth: 0` only lets the CHANGELOG *label* an entry with the commit that introduced
> it. Deciding *what ships and how far the version moves* is what the changeset files do, and
> history cannot answer that: a commit does not say whether it is a `patch`, `minor` or
> `major`; it carries no user-facing prose; it does not know which commits are release-worthy
> at all (docs, CI and test commits should bump nothing); and when several PRs pile up,
> history has no idea where one release ends and the next begins. That call is made by a human
> in the pull request, and the changeset file is how it is recorded.
>
> So the workflow can never detect a *missing* changeset from history — the only thing it can
> see is that there is **nothing pending at all**, which is why it refuses to run.

### Verifying

- The workflow run is green.
- A `chore: release` commit is on `main`.
- `npm view @multiclawcli/core version` returns the new version.
- Tags like `@multiclawcli/core@0.4.0` exist on the remote.

### If it fails

Every step is idempotent, so **simply run the workflow again**:

- Failed before the commit → nothing changed on `main`; a re-run starts clean.
- Failed during publish → some packages may already be published. `changeset publish`
  skips versions that already exist on the registry, so a re-run finishes the rest.
- Failed pushing tags → re-run; tags that already exist are skipped.

---

## Versioning rules

`.changeset/config.json`:

```json
{
  "fixed": [["@multiclawcli/core", "@multiclawcli/dashboard", "multiclaw"]],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch"
}
```

- `fixed` keeps the three published packages on one shared version.
- `updateInternalDependencies: "patch"` bumps internal dependency ranges when a
  dependency moves.

`dev-team-example` is private and is never published.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Workflow fails with "No pending changesets" | Every changeset was already consumed | Add one with `pnpm changeset`, merge it, then release |
| `EOTP`, `401 Unauthorized` or `404 Not Found` while publishing | The registry did not accept the OIDC identity | Check the trusted publisher on npmjs.com: owner, repository and **workflow filename `release.yml`** must match exactly, and the job must keep `id-token: write`. Also confirm no `NPM_TOKEN` / `~/.npmrc` is present |
| `EPUBLISHCONFLICT` | That version is already on npm | Re-run; already-published versions are skipped |
| The version did not change after merging a PR | The pull request had no changeset | Expected behaviour — see "What happens if you forget" |

---

## Notes

- The workflow does **not** create a GitHub Release. `changeset publish` creates and pushes
  git tags only. To add GitHub Releases, append a `gh release create` step after
  "Push release tags".
- `changeset publish` is a no-op when there is nothing new to publish, but the workflow's
  early check means you should never reach that state by accident.

---

## Reference

| Command | What it does |
| --- | --- |
| `pnpm changeset` | Create a changeset |
| `pnpm version-packages` | `changeset version` — apply changesets to versions and CHANGELOGs |
| `pnpm release` | `changeset publish` — publish unpublished versions to npm |
| `.github/workflows/release.yml` | The release workflow (manual) |
| `.github/workflows/ci.yml` | The quality gate that runs on every pull request |
