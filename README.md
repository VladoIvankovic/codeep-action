# Codeep Review — GitHub Action

Run the [Codeep](https://www.npmjs.com/package/codeep) offline code reviewer on your pull requests — **inline annotations** + a **sticky summary comment**, with a configurable severity gate.

It's a thin CI wrapper around the Codeep CLI's `review` subcommand: deterministic, **offline, no API key**. The action scopes the review to the PR's changed files and renders the results.

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
| `github-token` | `${{ github.token }}` | Token to read PR files + post the comment. |

## Outputs

| Output | Description |
|--------|-------------|
| `score` | Codeep score 0–100 (empty when skipped). |
| `total-issues` | Total issues found (`0` when skipped/clean). |
| `exit-code` | `codeep review` exit code (`0` passed, `1` tripped). |
| `skipped` | `true` when no review ran (not a PR, or no reviewable files). |

```yaml
      - uses: VladoIvankovic/codeep-action@v1
        id: codeep
      - run: echo "Score ${{ steps.codeep.outputs.score }}, issues ${{ steps.codeep.outputs.total-issues }}"
        if: always()
```

## Fork PRs (important)

On pull requests **from forks**, GitHub forces `GITHUB_TOKEN` to **read-only** regardless of the `permissions:` block — by design. The review still runs and you still get **inline annotations + a pass/fail check**; only the summary **comment** is skipped (you'll see a `::warning::` in the log). **Findings are never lost.**

> **Do not switch to `pull_request_target` just to comment on fork PRs.** That trigger runs with a write token; checking out and executing untrusted PR code under it leaks the token and your secrets. If you must comment on fork PRs, use the two-workflow `workflow_run` pattern (see GitHub Security Lab, "pwn requests").

## How it relates to the Codeep CLI

This action wraps the `codeep` npm package's `review` subcommand:

```sh
codeep review [files...] --json --fail-on <error|warning|info|none>
```

The same deterministic, offline reviewer you can run locally or in any CI. The action just scopes it to the PR diff and renders the output. See the [Codeep CLI](https://www.npmjs.com/package/codeep) and `codeep review --help`.

## Security notes

- File paths are passed to the CLI via an **args array** (`shell: false`) with a `--` separator and a `./`-prefix guard against option injection; traversal/absolute/NUL paths are dropped.
- Comment writes are **best-effort**; the pass/fail check derives **solely** from `codeep review`'s exit code.
- Zero runtime dependencies beyond Node 20 built-ins.

## Versioning

Pin the action (`@v1` or a commit SHA) and `codeep-version` for reproducible reviews. Patch/minor updates land on the `v1` tag.

## License

MIT © Vlado Ivankovic
