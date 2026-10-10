# Releasing

[中文](./RELEASING.zh-CN.md)

`multiclaw` ships three published packages:

| Package | What it is |
| --- | --- |
| `@multiclawcli/core` | Orchestration engine |
| `multiclaw` | The CLI |
| `@multiclawcli/dashboard` | Interactive terminal console (TUI) |

All three are versioned **in lockstep** — they always share the same version, and the
`Bump Version` workflow moves them together.

Releasing is **manual and takes two steps**: a maintainer runs `Bump Version`, which opens a
release pull request; merging that pull request runs `Release`, which publishes. Merging an
ordinary pull request never publishes anything.

---

## Part 1 — If you are opening a pull request

There is nothing release-specific to do. There are no changeset files to write.

Keep the **pull request title** in [Conventional Commits](https://www.conventionalcommits.org/)
style (`feat:`, `fix:`, `chore:` …). GitHub builds the release notes for each release from the
titles of the pull requests merged since the previous one, so the title is what users end up
reading.

Whether a change ships is decided when a maintainer cuts the next release, not when your pull
request merges — a merged change simply waits for the next version bump.

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

### Branch protection

`main` is protected by a ruleset that requires changes to go through a pull request. Both
workflows are built around that, so **no bypass configuration is needed**:

| What the workflows push | Covered by the ruleset? |
| --- | --- |
| the `release/v<version>` branch | no — the ruleset only targets `refs/heads/main` |
| the `v<version>` tag | no — the ruleset only targets branches |
| the version bump itself | it reaches `main` by **merging the release pull request**, which is exactly what the ruleset asks for |

Two consequences worth knowing:

- **The release pull request shows no CI checks.** GitHub does not start workflow runs for events
  caused by `GITHUB_TOKEN`, and that token is what opens the pull request — so `ci.yml` never runs
  on it. That is harmless today, because the ruleset requires a pull request but **no** status
  checks. If you ever add required status checks, the release pull request becomes unmergeable:
  either keep a bypass actor on the ruleset, or open the pull request with a token that is not
  `GITHUB_TOKEN` (a GitHub App installation token or a fine-grained PAT) so that CI does run.
- The release pull request contains **only** version numbers. The code it ships was already
  reviewed and tested in the pull requests that introduced it.

### Cutting the release

1. Open **Actions → Bump Version → Run workflow**.
2. Keep the branch set to `main` and pick the **bump type** (`patch`, `minor` or `major`).
3. Press **Run workflow**. It opens a pull request titled `chore: release vX.Y.Z`.
4. Review the pull request (the three version numbers) and **merge it**.
5. Merging starts **Actions → Release**, which publishes to npm, pushes the `vX.Y.Z` tag and
   creates the GitHub Release.

There is no version number to type — the bump type chooses it.

### Choosing the bump type

While the packages are on `0.x`:

| Type | Use for | Example |
| --- | --- | --- |
| `patch` | Bug fixes and internal refactors with no API change | `0.3.2` → `0.3.3` |
| `minor` | New features, behaviour changes, anything a user would notice | `0.3.2` → `0.4.0` |
| `major` | Breaking changes (reserved until the API stabilises) | `0.3.2` → `1.0.0` |

All three packages share one version, so a single bump type applies to all of them. The
workflow refuses to run when they are not already in sync.

### What the workflows do

**`Bump Version` — `workflow_dispatch` (you pressed the button):**

1. **Checks out `main`.**
2. **Rewrites the `version` field** of `packages/core`, `packages/cli` and
   `packages/dashboard` to the next version. Nothing else changes — no lockfile, no build.
   There is deliberately no build here: the packages are built in `Release`, on the commit
   that actually lands on `main`, rather than on a runner that gets thrown away.
3. **Pushes the `release/v<version>` branch** and **opens the release pull request**. Re-running
   for the same version is safe: the branch is refreshed with `--force` and an already-open pull
   request simply picks up the new commit.

**`Release` — `pull_request: closed`, when that pull request is merged:**

4. **Builds every package** (`pnpm -r build`) on the merged commit.
5. **Publishes** the three packages to npm.
6. **Tags the release** — `v<version>`, read from `packages/core/package.json`. The three
   packages are locked in step, so one number describes the whole release.
7. **Creates the GitHub Release** for that tag (`gh release create --generate-notes`), with
   notes generated by GitHub from the pull requests merged since the previous release.

> **Why the publish step lives in `release.yml`.** npm trusted publishing matches the **workflow
> filename** — `release.yml`. Splitting publishing into its own `publish.yml` would silently
> break publishing until all three packages are reconfigured on npmjs.com, so the two steps are
> separate workflows but the publishing one keeps its name.

> **Why only one `v<version>` tag.** This repository has always published a single `v<version>`
> tag and one GitHub Release per release, and the three packages share one version anyway, so a
> per-package tag would only add noise.

### Verifying

- The `Bump Version` run is green and a `chore: release vX.Y.Z` pull request is open.
- After merging it, the `Release` run is green.
- A `chore: release vX.Y.Z` commit is on `main`.
- `npm view @multiclawcli/core version` returns the new version.
- The tag `vX.Y.Z` exists on the remote and `gh release view vX.Y.Z` shows the GitHub Release.

### If it fails

Every step is idempotent, so **run it again** — but which "it" depends on where it stopped:

- **`Bump Version` failed before the branch was pushed** → nothing changed anywhere; re-run the
  workflow from the Actions tab.
- **`Bump Version` failed after pushing the branch** → re-run the workflow; it refreshes the
  branch and reuses the existing pull request.
- **`Release` failed** → open that run in the Actions tab and use **Re-run failed jobs**. The
  original `pull_request` payload is preserved, so the job's `if` conditions still match, and
  `pnpm publish` skips versions that are already on the registry — so a re-run finishes whatever
  is left. Tags and releases that already exist are skipped too.

---

## Versioning rules

- The three published packages are versioned **in lockstep**: they always share one version. The
  `Bump Version` workflow enforces this — it aborts when the manifests disagree, and bumps all
  three at once.
- `examples/dev-team` is private and is never published. The `Release` workflow publishes
  `packages/*` only.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Bump Version` fails with "Packages are out of sync" | The three `package.json` files do not share a version | Align them in a pull request, then run the bump again |
| `EOTP`, `401 Unauthorized` or `404 Not Found` while publishing | The registry did not accept the OIDC identity | Check the trusted publisher on npmjs.com: owner, repository and **workflow filename `release.yml`** must match exactly, and the job must keep `id-token: write`. Also confirm no `NPM_TOKEN` / `~/.npmrc` is present |
| `EPUBLISHCONFLICT` | That version is already on npm | Re-run; `pnpm -r publish` skips versions that are already published |
| The release pull request shows no CI checks | Expected — a pull request opened with `GITHUB_TOKEN` does not start workflow runs | Nothing to fix while the ruleset requires no status checks. If you need CI on it, open the pull request with a GitHub App installation token or a fine-grained PAT |
| `Release` did not run after merging | The merged pull request's head branch did not start with `release/v` | Merge a branch named `release/vX.Y.Z`; run `Bump Version` again to get a fresh pull request |

---

## Notes

- A GitHub Release is created for every release, for the `v<version>` tag, with notes generated
  by GitHub from the merged pull requests. Keep pull request titles descriptive — they become
  the release notes.
- There is **no `CHANGELOG.md`** and there are no changeset files. The per-release notes live in
  the GitHub Release.

---

## Reference

| Command | What it does |
| --- | --- |
| `.github/workflows/bump-version.yml` | Step 1 — opens the release pull request (manual) |
| `.github/workflows/release.yml` | Step 2 — publishes on merge of the release pull request |
| `.github/workflows/ci.yml` | The quality gate that runs on every pull request |
