# AGENTS.md — development instructions for dsh-openrouter-spend

Instructions for AI agents and humans working in this repository. They encode
the lessons of the 0.4.1 review-and-fix cycle; the reasoning behind each rule
lives in `docs/best-practices.md`. If a rule here conflicts with reality, fix
this file in the same change — stale instructions are worse than none.

## What this is

A DeepSeek Harness (DSH) plugin showing what the OpenRouter account actually
charged: a spend chip under the composer and a popover/Settings breakdown by
model, API key and day. English is the language of code, commits, changelog and
documentation (see CONTRIBUTING.md); READMEs are mirrored in ru/zh.

## Layout and seams

| Path | What it is |
| --- | --- |
| `index.js` | Cordis server half. `apply(ctx, config)` registers `GET /openrouter-spend/summary`, `POST /openrouter-spend/credential` and `POST /openrouter-spend/key-limit` (the raise, ADR-0008), polls the OpenRouter API. Pure helpers are exported for tests. |
| `client.js` | Browser half, a **plain script body** registered through `window.__ModuleLoader__` — not an ES module. Pure helpers ride on the plugin object so tests can reach them. |
| `locale/*.json` | Plugin display metadata only. The UI dictionaries are inline in `client.js` (en/zh/ru) and are registered through `locale.register`. |
| `tests/` | `node:test` suites. Two seams exist: import from `../index.js`, and load `client.js` through the module-loader seam (`runInNewContext` + stubbed `window.__ModuleLoader__`, then `captured.factory(...)`). Dictionaries are read via a `locale.register` capture in `api.apply` — never by slicing the source. |
| `scripts/verify-translation-sync.mjs` | Hash-based change detector for the three READMEs. It proves "unchanged since last `--write`", NOT cross-language equivalence. |
| `docs/adr/` | Architecture Decision Records. One file per decision; the table in `docs/adr/README.md` indexes them. |
| `docs/design/` | Design docs whose string tables quote shipped copy **verbatim** — a test enforces this in both directions. |
| `docs/review/` | Review records (findings, lessons). Excluded from doc-link guards because they cite missing artifacts as evidence. |
| `cordis.patch.yml` | Profile patch. Configure only schema fields; redundant overrides of defaults are forbidden (a guard checks this). |

## Commands

```sh
npm test                                    # full suite (node --test tests/*.test.mjs)
node --test tests/<file>.test.mjs           # one suite (use while working in parallel)
node scripts/verify-translation-sync.mjs    # README hash check
node scripts/verify-translation-sync.mjs --write   # re-record AFTER editing any README
npm --cache /tmp/npmcache-review pack --dry-run    # tarball contents
npx lefthook install                        # git hooks (opt-in; never automatic)
```

In this environment npm's default cache is broken — always pass
`--cache /tmp/npmcache-review` when npm is genuinely needed. Prefer plain `node`.

## Code conventions

- **Comments state the reason and the trade-off**, not what the line does. The
  codebase reads as an argument; keep it that way.
- **Refuse, don't truncate.** Every row/size ceiling rejects with an error
  message that names the config knob to turn (`narrow config.burnWindowDays`).
  A partial split misreports cost; a refusal is honest.
- **Narrow at the wire boundary.** Read exactly the fields the payload needs
  (`readRow`, `readKeyLimits`); record fields that must never travel to the
  browser (hash, label, creator). This repo and its payloads are public.
- **Contain auxiliary failures.** Independent reads fail into their own
  `*Error` field (`limitsError`, `burnError`, `sessionsError`, `lineageError`)
  via the spread-merge pattern; a failed auxiliary read must never take the
  summary down. Never confuse "could not read" with "none exist" — a failed
  limits read omits `limits` entirely.
- **State your third-party API scope explicitly.** Defaults are invisible
  traps: the `/keys` request sets `include_disabled=true` and paginates with
  `offset`; expired keys are excluded on purpose and the comment says why.
  Honour server hints (`Retry-After`, `X-RateLimit-Reset`) over local
  scheduling where they are stricter.
- **Security:** the management key appears only in the `Authorization` header —
  never in URLs, logs or payloads. Routes are fenced by
  `ctx.connection.requestRejection`. Dynamic-key maps use `Object.create(null)`
  or `Map` (a key named `__proto__` must not vanish).

## Testing rules

- **Every behaviour change ships with a regression test in the same change.**
- **Mutation-verify important fixes**: revert the fix in a scratch copy and
  confirm the new test goes red. A suite that stays green on broken code proves
  nothing. (Several 0.4.1 tests were rewritten after mutation checks exposed
  assertions that could never fail.)
- **Never weaken or delete an assertion to go green.** If an assertion is
  genuinely wrong, fix it minimally and say so in the report.
- **No network. No real clocks.** Stub `fetch` and `Date.now`/fake clocks; a
  countdown assertion with a real-clock budget is a flake waiting to happen.
- **Mocks mirror protocol, not URLs**: match by path semantics (a query string
  will appear), make `headers.get` return `undefined` for unknown headers (a
  blanket `'1234'` becomes a parsed `Retry-After`), and create rejections
  inside thunks so `catch` attaches in the same turn.
- **Assertions print the actual value** and pin exact refusal messages, plural
  forms and placeholder sets — the strings are shipped product.
- The guards in `tests/repo-guard.test.mjs` run in `npm test` and the pre-push
  hook; they encode the M1/M7/M8/M9/m24/m26/N5 bug classes. Read the file
  before touching package metadata, docs links, dictionaries or `limitState`'s
  shape.

## i18n rules

- Three inline dictionaries (en/zh/ru) must keep **identical key sets**; plural
  keys follow CLDR: en `base`+`_one`, zh `base`, ru `base`+`_one`+`_few`.
- After editing any `README*.md`, run `verify-translation-sync.mjs --write` and
  confirm the check passes. Translate all three in the same change.
- `docs/design/limit-notice.md` tables quote shipped strings **verbatim** (the
  design-doc test compares per language). When copy changes, update the doc
  rows — never change shipped strings to match the doc.
- Placeholder sets are contract: `{reason}`, `{time}`, `{name}`, `{percent}`,
  `{estimate}`, `{left}`, `{limit}`, `{amount}`, `{rub}` must survive every
  translation. `{amount}` is the figure a raise SENDS and `{rub}` its echo in the
  display currency (ADR-0009) — a value that reaches a write path is never
  rendered through the currency converter.
  The raise's keys (`raise*`, ADR-0008) are part of this vocabulary: they are
  quoted verbatim in the design doc's table, and the deployment's own doc guard
  reads every `^(limit|period|raise)` key.

## Release checklist

1. Bump `package.json` version **and** the `#vX.Y.Z` refs in all three READMEs
   in the same change (a guard enforces this).
2. Add a `## [X.Y.Z]` CHANGELOG entry describing user-visible changes.
3. `git status` clean — every file the docs link to must be committed before
   the tag (the link guard enforces this too).
4. `npm test`, `node scripts/verify-translation-sync.mjs`,
   `npm --cache /tmp/npmcache-review pack --dry-run` — confirm the tarball
   carries exactly what `package.json` `files` promises.
5. Tag `vX.Y.Z`, then `npm publish`.

## Parallel agents in one worktree

- **Partition by file before writing.** Two agents editing `client.js` or the
  same test file will clobber each other; assign exact file ownership and keep
  to it. When you detect a collision, stop writes and ask the coordinator.
- Run only your owned test files mid-flight (`node --test tests/x.test.mjs` —
  not the full suite); the coordinator runs the full suite at integration.
- **No `git commit`/`git tag`/`git push`** unless the coordinator says so.
  Scratch files go under `/tmp` only.
- Report per task ID: what changed (file:line), how it was verified, what was
  skipped and why. "Done" without evidence is not done.
