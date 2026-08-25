# Codeep Review — GitHub Action

Run the [Codeep](https://www.npmjs.com/package/codeep) offline code reviewer on your pull requests — **inline annotations** + a **sticky summary comment**, with a configurable severity gate.

It's a thin CI wrapper around the Codeep CLI's `review` subcommand: deterministic, **offline, no API key**. The action scopes the review to the PR's changed files and renders the results.

The one exception is the optional [`fix`](#fixing-what-it-finds) input, which hands the findings to an agent — that runs a model, and needs a key. Reviewing never does.

## What it does

On each pull request it:

1. Resolves the PR's **changed files** via the GitHub REST PR-files API (robust to shallow clones — no `git diff` depth issues).
2. Runs `codeep review <files> --json --fail-on <level>` (the same reviewer you can run locally).
3. Posts a single **self-updating** summary comment (score, severity table, issues grouped by file).
4. Emits **inline annotations** on the changed lines.
5. **Fails the check** when an issue at or above `fail-on` is found (or stays green with `fail-on: none`).

## Quick start

Add `.github/workflows/codeep-review.yml` to your repo:

```yaml
name: Codeep Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write   # needed to post the summary comment

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: VladoIvankovic/codeep-action@v1
        with:
          fail-on: error          # error | warning | info | none
          codeep-version: latest  # pin (e.g. "2.5.0") for reproducible reviews
```

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `codeep-version` | `latest` | npm version/dist-tag of `codeep` to run. Pin for reproducibility. |
| `fail-on` | `error` | Severity that fails the check: `error` \| `warning` \| `info` \| `none`. `none` = informational only. |
| `comment` | `true` | Post/update the sticky PR summary comment. |
| `annotate` | `true` | Emit inline annotations for each issue. |
| `files` | `""` | Space-separated file list to review, overriding PR-derived changes. Leave empty for normal use. |
| `max-annotations` | `50` | Cap on inline annotations emitted. |
| `max-issues-per-file` | `10` | Issues shown per file in the comment before `...and N more`. |
| `fix` | `false` | Hand the findings to an agent and open a pull request with the result. See [Fixing what it finds](#fixing-what-it-finds). |
| `fix-min-severity` | `warning` | Lowest severity a fix may act on: `error` \| `warning`. Suggestions are never eligible. |
| `fix-branch-prefix` | `codeep/fix` | Branch prefix for fix pull requests. The reviewed PR's number is appended. |
| `fix-timeout` | `600` | Seconds the fix agent may run (minimum 60). Separate from the review's own, much tighter bound. |
| `github-token` | `${{ github.token }}` | Token to read PR files + post the comment. |
| `dashboard-token` | `""` | Optional scoped Codeep CI token for [team analytics](#team-analytics-optional). Empty = disabled. |
| `dashboard-url` | `https://codeep.dev` | Dashboard base URL that receives analytics. Override only for self-hosted. |

## Outputs

| Output | Description |
|--------|-------------|
| `score` | Codeep score 0–100 (empty when skipped). |
| `total-issues` | Total issues found (`0` when skipped/clean). |
| `exit-code` | `codeep review` exit code (`0` passed, `1` tripped). |
| `skipped` | `true` when no review ran (not a PR, or no reviewable files). |
| `fix-pr` | URL of the pull request opened by `fix`, or empty when none was. |

```yaml
      - uses: VladoIvankovic/codeep-action@v1
        id: codeep
      - run: echo "Score ${{ steps.codeep.outputs.score }}, issues ${{ steps.codeep.outputs.total-issues }}"
        if: always()
```

## Fixing what it finds

Off by default. With `fix: true` the action hands what the review found to an agent, lets it edit the code, and **opens a second pull request** against the branch under review.

```yaml
permissions:
  contents: write        # to push the fix branch
  pull-requests: write   # to open the fix PR and post the comment

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: VladoIvankovic/codeep-action@v1
        with:
          fix: true
          fix-min-severity: warning
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**The key goes in `env`, not `with`.** Reviewing needs none; the fix agent runs a model and does. Any provider Codeep supports works — set that provider's own variable (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, and so on). Without one the action says so and skips the fix rather than failing quietly.

### What it will not do

- **Never pushes to the branch under review.** Your PR is left exactly as you left it; fixes arrive as a separate PR you can read, amend, or close.
- **Never merges anything.**
- **Never touches suggestions.** Only `error` and `warning` — acting on opinion produces churn and buries the findings that matter.
- **Never runs on fork PRs.** GitHub issues a read-only token there, so pushing a branch cannot work.
- **Runs with no shell, no git, no network.** The agent gets file editing and the test runner, enforced by the same capability boundary as any custom Codeep agent — not by asking it nicely in a prompt.

The fix step runs *after* the review is reported, and **never changes the check's outcome**. A failed fix cannot turn a passing review red.

### If the fix runs out of time

Reviewing is regex over a diff and finishes in seconds. A fix reads files, edits them and runs your test suite, so it gets its own budget — `fix-timeout`, 600 seconds by default. Running out is reported as a warning and the check keeps the review's result.

If you hit it regularly, raise `fix-timeout` or narrow what the agent takes on with `fix-min-severity: error`.

## Fork PRs (important)

On pull requests **from forks**, GitHub forces `GITHUB_TOKEN` to **read-only** regardless of the `permissions:` block — by design. The review still runs and you still get **inline annotations + a pass/fail check**; only the summary **comment** is skipped (you'll see a `::warning::` in the log). **Findings are never lost.**

> **Do not switch to `pull_request_target` just to comment on fork PRs.** That trigger runs with a write token; checking out and executing untrusted PR code under it leaks the token and your secrets. If you must comment on fork PRs, use the two-workflow `workflow_run` pattern (see GitHub Security Lab, "pwn requests").

## Team analytics (optional)

Set `dashboard-token` to send a **compact per-PR review summary** to your Codeep dashboard, where the **Reviews** view charts score trends, issue counts, per-repo health and review hotspots across your team.

Mint a scoped CI token in the dashboard (Settings → CI tokens), store it as a repo/org secret, and pass it:

```yaml
      - uses: VladoIvankovic/codeep-action@v1
        with:
          fail-on: error
          dashboard-token: ${{ secrets.CODEEP_DASHBOARD_TOKEN }}
```

- **Only counts leave the runner** — score, severity/category tallies, the worst-offender file paths, PR number, author and commit SHA. **No source code and no issue messages are sent.**
- The token is **scoped**: it can post review events but **cannot read your API keys or sessions**, and is **revocable** any time from the dashboard.
- It's **fire-and-forget**: posting failures (network, fork PR, revoked token) are logged as a notice and **never** change the review's pass/fail outcome. Bounded to a 5-second timeout.
- **Fork PRs are skipped** — GitHub withholds secrets from fork-PR workflows, and a fork's run is never attributed to the base repo's analytics.

## How it relates to the Codeep CLI

This action wraps the `codeep` npm package's `review` subcommand:

```sh
codeep review [files...] --json --fail-on <error|warning|info|none>
```

The same deterministic, offline reviewer you can run locally or in any CI. The action just scopes it to the PR diff and renders the output. See the [Codeep CLI](https://www.npmjs.com/package/codeep) and `codeep review --help`.

## Security notes

- File paths are passed to the CLI via an **args array** (`shell: false`) with a `--` separator and a `./`-prefix guard against option injection; traversal/absolute/NUL paths are dropped.
- Comment writes are **best-effort**; the pass/fail check derives **solely** from `codeep review`'s exit code.
- Team analytics (when enabled) sends **counts only** over TLS via a **scoped, revocable** token; never source, never your API keys.
- Zero runtime dependencies beyond Node 24 built-ins.

## Versioning

Pin the action (`@v1` or a commit SHA) and `codeep-version` for reproducible reviews. Patch/minor updates land on the `v1` tag.

## License

MIT © Vlado Ivankovic
