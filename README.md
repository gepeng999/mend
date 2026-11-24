# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gepeng999/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gepeng999/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

AI models write code edits in four different formats, and every agent harness grows its own applier for one of
them. mend is a single command-line tool that reads all four to one written contract ([SPEC.md](SPEC.md)):

- **unified diffs**, including hunks whose line numbers drifted from the file they patch;
- **SEARCH/REPLACE blocks** (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`);
- **V4A patches** (`*** Begin Patch` … `*** End Patch`, with Add / Delete / Update / Move sections);
- **JSON edits** — `create`, `str_replace` and `insert` tool calls, as one array or as JSON Lines.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file; omit it (or pass `-`) to read the patch from standard input. The working directory is
the root of the tree of text files the patch applies to. `--format` is `unified`, `search-replace`, `v4a`,
`json`, or `auto` (the default) to detect the format from the patch itself. `--check` reports exactly what a
real run would, but writes nothing. `--strict` turns off the fuzzy matching tiers below.

## How matching works

An edit names old lines; mend looks for them at the first of three tiers that finds them:

0. every line exactly equal;
1. equal once trailing spaces and tabs are removed;
2. equal once leading and trailing spaces and tabs are removed — and the replacement lines are re-indented
   to the file's own indentation.

Unified hunks pick the occurrence nearest the position their header names. SEARCH/REPLACE blocks must match
exactly once. V4A chunks search forward from a cursor, optionally after an anchor line, with an end-of-file
form. Every change is all-or-nothing: if any edit fails, mend prints one `error: <code> <path>` line per failed
edit plus a `failed: k of n edits` summary, exits 1, and writes nothing. On success it prints one line per
changed path (`A`, `D`, `M`, or `R old -> new` for a move) and an `ok: n files` summary, and exits 0. Usage,
unreadable-patch, format and parse problems exit 2 with a single `error:` line.

## Development

Node 22 and its standard library only; there is nothing to install. The public practice set grades the CLI
exactly the way the bounty does:

    node check.ts <practice.json>

`runner.ts` is the trial runner: when `MAKEFUN_ENV_URL` is set, `main.ts` hands over to it, and it runs the
CLI on each check the environment lists in a fresh directory and posts the results back.

## License

MIT — see [LICENSE](LICENSE).
