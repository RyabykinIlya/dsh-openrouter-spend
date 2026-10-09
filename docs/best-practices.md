# Best practices — lessons from the 0.4.1 review-and-fix cycle

In October 2026 everything shipped after npm `0.3.2` was reviewed line by line:
52 findings across the server half, the browser half, tests, docs and the
release process. All are fixed now. This document records **why** each rule in
`AGENTS.md` exists — each lesson is a bug class that actually shipped, with the
guard that now catches it. When you are tempted to skip a rule, the cost of
skipping it is listed here.

Findings IDs (`M1`, `m8`, `N5`, …) refer to
`docs/review/0.4.1-review-findings.md`.

## Contracts between producers and consumers

**M1 — a consumer read a field the producer never returned.** `limitState`
returned `limitReset` only in some branches; the Toast read `state.limitReset`
to name the refill period, the `undefined` fell through the ternary, and every
periodic-cap toast introduced itself as "lifetime's limit". Silent, plausible,
wrong. *Rule: when one function's result feeds another, the shape is a
contract.* Guard: `repo-guard` pins each `limitState` branch's exact key set and
asserts every `state.X` read in `client.js` is covered by the union of shapes.

**m8 — the halves disagreed on the failure vocabulary.** The host classified
4xx failures as `request`; the client's `failureLabelKey` had no such case and
rendered "the reason is unknown" over a detail line naming the truth. *Rule:
every code one half emits, the other half must handle.* Guard: `repo-guard`
drives `describeFailure` across its branches and requires a translated sentence
in all three languages for every code, `host` included.

**Shape variance must be deliberate.** `limitState` returns different keys per
branch (`runwayDays` only on the lifetime branch, `consumed`/`imminent` only on
the periodic one). That is fine — but every read of an optional field must be
guarded (`days !== undefined`) and the shapes must be pinned so a field cannot
quietly vanish.

## Async state and races

**M4 — cache invalidation raced an in-flight read.** `POST /credential` reset
`cached = undefined`, then awaited `current()` — which returned the **existing**
in-flight promise (started with the old key); its completion repopulated the
cache. The save was answered with the old key's figures and they stayed for a
full TTL. *Rule: any "reset state" operation concurrent with an async operation
needs a generation counter or ownership check.* Fixed with a `generation`
bumped on writes; a stale read's completion never writes the cache. Guard: a
route-level race test with a gated promise (and a scratch reproduction,
`/tmp/ors-race.mjs`).

**Escaping promises and rejections.** A rejected promise created before its
`catch` attaches in the same turn surfaces as an unhandled rejection and kills
test runs nondeterministically. *Rule: create rejections inside thunks* —
`() => Promise.reject(...)` inside the fetch stub, not a parked promise.

**Coalescing windows are behaviour, not clutter.** The client's 1-second fetch
coalescing means a "second poll" legitimately reuses the first reply; a test
that assumes two fetches fails for the right reason in the wrong direction.
*Rule: know your concurrency semantics before asserting on request counts.*

## Third-party APIs

**M5 — endpoint defaults are invisible traps.** A bare `GET /keys` excludes
disabled and expired keys by default, ignores pagination and lists only the
default workspace. A disabled key with a cap silently vanished from the limit
view. *Rule: state your scope explicitly in the request (`include_disabled=true`,
`offset` walk) and document what you deliberately exclude.* Guard: route tests
pin the pagination walk and the exact request shape.

**m2/m1 — the server's hints beat local guesses.** 429 responses carry
`Retry-After` / `X-RateLimit-Reset`; a fixed local ladder retried into another
429. And one shared `AbortSignal.timeout` covered seven requests though the
config promised "per-request". *Rule: honour stricter server hints; make the
timeout match the documentation.*

## Error handling and containment

**M6 — auxiliary failures took the summary down.** The `limitsError` /
`burnError` catches existed but **no test pinned them**; mutation testing showed
deleting the catch left the suite green while a failed `/keys` read turned the
whole chip stale. *Rule: containment paths are behaviour — pin them with a test
that fails when the containment is removed.* Guard: `summary-route.test.mjs`
covers all four `*Error` paths; 14/14 mutations killed.

**"Could not read" ≠ "none exist".** A failed limits read omits `limits`
entirely; an empty `limits` object means "no key carries a limit". The client
treats them differently and the payload must keep the distinction.

**Error messages are product.** Refusals must name the knob to turn and carry
the upstream body slice — a bare `403` helps nobody.

## Tests as evidence

**Mutation-verify, or your test proves nothing.** Several original tests passed
on broken code: a toast test that checked an un-expanded element (returned
`undefined` whether or not a toast showed — it could never fail), CSS tests that
pinned wording instead of the computed cascade, a claim of "integration test"
that never existed. *Rule: revert the fix in a scratch copy and watch the test
go red. If it stays green, rewrite it.*

**No real-clock budgets.** A countdown asserted `/0:1[0-9]/` against
`Date.now() + 15s` — a 5-second flake window. Fixed clocks made it exact
(`/0:15/`), a strengthening, not a weakening.

**Beware brittle extraction.** Slicing a dictionary block by "4000 chars from
`ru: {`" breaks on a re-indent. Parse structurally (brace matching) or capture
through the real seam (`locale.register`).

**Mocks mirror protocol, not strings.** My own harness taught this twice:
`u.endsWith('/keys')` broke the moment the URL gained `?include_disabled=…`, and
`headers: { get: () => '1234' }` fed a phantom 1234-second `Retry-After` into
the new retry logic. The product was right; the mock was stale. *Rule: match by
path semantics, return `undefined` for unknown headers.*

## Documentation and release hygiene

**M8 — links to files that do not exist or are untracked.** The CHANGELOG linked
ADR-0005 while it was still untracked (the link 404s at publish); a test cited
a screenshot that was never committed as its "real-browser evidence". *Rule:
never cite evidence that is not in the repo; commit what you link before you
tag.* Guard: the link checker resolves every local path in docs and requires it
to be git-tracked (it caught exactly this live during its own introduction).

**M9 — refs pinned to older tags while describing newer features.** The READMEs
documented 0.4.x behaviour while the install command fetched `#v0.3.2`.
*Rule: bump version, README refs and CHANGELOG in one change.* Guard:
`repo-guard` compares every pinned ref against `package.json`'s version and
requires a CHANGELOG entry for it.

**M7 — install-time lifecycle scripts are consumer-facing.**
`postinstall: "lefthook install || true"` ran for every registry install,
printed `command not found`, and masked real failures. *Rule: dev tooling lives
in `prepare` (clone-only) or docs; a published package ships no
`preinstall`/`install`/`postinstall`.* Guard: `repo-guard` forbids them.

**m26 — implicit packaging is fragile.** `README.ru.md` / `README.zh.md` /
`README.i18n.yaml` shipped only via npm's implicit `README*` auto-include; a
rename would silently drop them. *Rule: name every shipped file in `files`.*
Guard: `repo-guard` checks the list (globs allowed).

**Hash checks prove "unchanged", not "equivalent".** `verify-translation-sync`
compares content hashes against `README.i18n.yaml`; `--write` blesses any
divergence. Fine as a tripwire, useless as a proof. *Rule: know what your check
actually guarantees, and say so in its docs.*

## Configuration hygiene

**N5 — redundant overrides pin stale values.** `cordis.patch.yml` set three
knobs to exactly their schema defaults: harmless today, silently wrong if a
default moves. *Rule: the patch configures only what is site-specific.* Guard:
every patch key must exist in the `Config` schema.

**m3 — cross-field validation.** `warnConsumedFraction ≥ criticalConsumedFraction`
made the warn tier unreachable. *Rule: validate relationships between fields at
activation, not just each field's range.*

**m4 — joins by mutable labels.** Duplicate key names last-won in the limits
map, misattributing spend. *Rule: a join by user-editable name must detect
duplicates and say so* (now `limitsNote`).

## Time

**m12 — zone-less timestamps parse in local time.** `date__hour` strings
(`2026-10-09T09:00:00`) were parsed as local time; the 7-day window skewed by
the reader's UTC offset. *Rule: parse with explicit zone (append `Z` for bare
UTC stamps) and pin it with a test whose expectations shift under the wrong
parsing.*

## Process (multi-agent development)

**Partition the worktree before writing.** Two fix agents editing `client.js`
and the same test files simultaneously detected the collision themselves; the
resolution was exclusive file ownership (one got `docs/design/limit-notice.md`
only). *Rule: assign exact files per agent; a coordinator resolves collisions
fast — clobbered edits cost more than idle time.*

**"Failed" notifications can be transient.** Two agents reported as failed and
resumed on retry, finishing their work. *Rule: verify state in the worktree
before re-dispatching or taking over.*

**Evidence beats narration.** The reports that carried mutation runs, exact
counts and file:line references were the ones that survived cross-checking;
claims without artifacts (the missing screenshot) became findings themselves.

## The five-minute checklist before you say "done"

1. Reverted your fix in a scratch copy → your new test went red?
2. Full `npm test` green, `verify-translation-sync` green?
3. Every doc link you touched resolves to a committed file?
4. READMEs' `#v` refs match `package.json`? CHANGELOG has the entry?
5. For parallel work: did you stay inside your file partition and report with
   evidence?
