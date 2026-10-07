---
status: "accepted"
date: 2026-10-07
decision-makers: maintainer
consulted: none
informed: plugin users
---

# Count a session's subagent descendants in the session spend figure

## Context and Problem Statement

The chip shows a `session/day` pair: the left figure is what this chat cost, the right is the
whole account's day. The left figure is read as "what this chat cost", but it only ever covers
the session's own requests.

The cause is in how the id reaches OpenRouter. Every LLM request carries the identity of the
agent that makes it (`sessionId: this.session.id`, `packages/core/agent-loop/src/agent.ts`),
and pi-ai sends that id as `x-session-id` on OpenRouter endpoints. The harness does not
configure that header: `dsh-llm-pi-ai` withholds `sendSessionAffinityHeaders` and
`sessionAffinityFormat` (`packages/llm/llm-pi-ai/src/catalog.ts`, whose gates mark both
`withhold` — the disposition for a field pi-ai's installed catalog already sets for a named
vendor), so the value arrives from pi-ai's own catalog, which defaults both to the OpenRouter
form. OpenRouter echoes the header into the `session_id` analytics dimension. A delegated
child is its own session — the in-process driver mints a fresh bare UUID for it
(`packages/subagent/subagent-in-process-driver/src/index.ts`) — so it forms its own analytics
row, and `findSession` (`client.js`, matching `row.id === sessionId`,
`session-${sessionId}`, and `sessionId === session-${row.id}`) never picks that row up.

Measured against a live account on 2026-10-07, the gap is not marginal: one parent session's
recorded child (`origin: "subagent"`, `delegationDepth: 1`, and a `parentSession` header
pointing at the parent) had spent roughly 60× the parent's own figure, and that spend was
invisible to the parent's row. Across the same 30-day window most of the account's billed
spend sat in rows carrying no session id at all — a bucket no session figure can ever include
— and the bulk of the remaining rows were bare-UUID child sessions.

The lineage is available without reading logs by hand. The session-query seam registers
`ctx.sessionQuery` and exposes `listSessions`, which returns every logical session header
with `parentSession` and `origin` included (`packages/session-query/session-query`,
`packages/core/session`). The base bundle mounts it with `openAt: never`
(`packages/bundle/base/cordis.patch.yml`), which the bundle's own comment documents as keeping
exact reads and lineage traces available while SQLite is never opened.

`parentSession` alone does not identify delegation. Two distinct child kinds record a parent:
a delegated subagent, which the harness marks `origin: 'subagent'` — the field every
in-process delegation sets (`packages/subagent/subagent`) and the continuation path reuses —
and a **forked** session, created by the session controller's fork command and by
`Session.fork`, which set `parentSession` with `isSeeded: true` and no `origin`. On the
measured corpus the two were an order of magnitude apart — over a hundred delegated children
against 10 forks. A fork is a branch of the same work, not work the parent delegated, so it is
excluded from the rollup; the identity rule for a subagent edge is therefore
`origin === 'subagent'`, not the presence of a parent.

File and symbol references in this record were checked against DSH `0.2.1-alpha.1`
(commit `ba082adc23`); they name symbols rather than line numbers, since the harness is a
moving dependency of this plugin and line numbers rot on the first refactor.

## Decision Drivers

The qualities this decision trades against each other are **accuracy** of the session figure,
**availability** of the summary (a lineage failure may not take it down), and **cost** of a
refresh (no extra OpenRouter request, and no per-tab work). Where they conflict, accuracy wins
over cost: the figure is the product, and one listing per refresh is the price of telling the
truth about it.

* The chip's left figure must answer the question it appears to answer: what this work cost,
  delegation included.
* The host serves one cached summary to every open tab (`refreshSeconds`, one refresh per
  concurrent caller), so the figure cannot be computed per requesting session.
* The session figure must stay a *part* of the day total, never a term added to it: the split
  is auxiliary, and the day, key, and model figures already include all descendants.
* Attribution must follow recorded session headers, not id shape: a top-level session is
  minted as `session-${randomUUID()}` while an in-process child is a bare UUID, and a fork
  child is `session-`-prefixed again (`packages/api/session-controller`). No prefix rule
  separates a child from a root.
* A lineage read that fails must degrade to today's behaviour, not take the summary down —
  the same containment `sessionsError` already has.
* No new request to OpenRouter, and no new public shape in the payload beyond the existing
  per-session rows.
* The plugin and the harness are a single system: `dsh-openrouter-spend` is loaded as a DSH
  bundle row and already depends on harness seams (`credentials`, `webServer`, `connection`),
  so taking one more seam is the intended way to reach a harness fact, not a cost to avoid.

## Considered Options

* Host-side subtree rollup: the host folds each session's descendants into that session's row
* Host ships lineage edges; the client walks the subtree it needs
* A `?session=<id>` parameter that makes the host compute one session's rollup on demand

## Decision Outcome

Chosen option: "Host-side subtree rollup", because the host already owns the one pass over
session headers that the other two options also need, and folding there keeps the payload
shape and the client unchanged.

We will build one `parent → children` map per refresh from a single `listSessions()` call,
keeping only edges where the child's header marks `origin: 'subagent'`, and attribute each
session row the spend of its **entire** delegated subtree, recursively — grandchildren
included, since delegation nests (`delegationDepth` is a recorded integer), and a fixed
depth-1 rule would silently drop exactly the case it exists to fix. Each row keeps its own
figures and gains the subtree's; the chip's `findSession` lookup and pair formatting stay as
they are.

Six constraints are load-bearing:

* **Only delegation edges are folded.** A child is a subagent only when its header says
  `origin: 'subagent'`. A fork records a parent without that field and is a branch of the same
  work, so its spend stays on its own row. Filtering by `parentSession` alone would fold 10
  forks into their parents on the measured corpus and surface at least one synthetic row for a
  session that only ever forked.
* **Row identity stays exact.** Rows are matched to headers by id equality, not by prefix
  tolerance: the `session-` prefix varies between children and roots, so the leniency in
  `findSession` is not a matching rule the host can lean on.
* **The day figure is untouched.** `todaySpend`, `last7`, `last30`, `byDay`, `byKey`, and
  `byModel` come from a query with no `session_id` dimension and already contain descendant
  spend; only `bySession` rows change.
* **A session with delegated children but no row of its own still appears.** A parent whose own
  traffic never reached OpenRouter but whose subagents did must get a row carrying the subtree,
  or the figure is unreachable from exactly the sessions that need it most.
* **Failure is contained.** When the lineage read fails, rows carry own-session figures and
  the payload reports why, mirroring `sessionsError`; the chip keeps rendering. This covers a
  refused fold too: the rollup declines rather than truncating when its output would exceed a
  ceiling, so the caller falls back to own-session figures with a reason instead of serving a
  half-attributed split.
* **The fold is bounded on both axes.** `MAX_SESSION_ROWS` bounds the rows *read*; the rollup
  can emit a row per ancestor, and its ancestor walk is linear in depth. A corrupt corpus — a
  cycle is the obvious case — is therefore bounded by a depth cap rather than left to run, and
  the whole-fold refusal above caps the output. Real delegation nests a handful deep; the
  measured corpus held depths of 1 and 2.

### Consequences

* Good, because the left figure becomes the cost of the whole branch of work, which is what a
  user comparing this chat against the account's day is actually asking.
* Good, because nothing new is fetched: the lineage comes from one listing already available
  on the session seam, and no OpenRouter request is added.
* Good, because the client and the payload keep their current shape — no traversal, no new
  field for the browser to interpret.
* Bad, because the sum of the session rows does not equal the account total and never did: the
  unattributed bucket belongs to no session at all, so the split understates by construction.
  Recording this is part of the decision, not a defect left unnoticed.
* Bad, because attribution depends on a recorded header. Out-of-process subagent backends
  (ACP, Codex, Claude Code) drive their own processes and create no DSH session record, so
  their spend stays in the `none` bucket and no rollup can reach it.
* Bad, because the rollup is only as complete as the header contract behind it. On a DSH build
  whose session headers carry no `parentSession`, the seam exists, the plugin activates, and
  the figure is simply the old understated one — a silent gap rather than a loud failure, and
  the one case this decision cannot detect from inside the plugin.
* Neutral, because the plugin now injects `sessionQuery` alongside `credentials`, `webServer`,
  and `connection`. That is a declaration, not a burden: Cordis starts the row only once the
  service exists, so a build without the seam does not run the plugin half-broken — the row
  stays inactive and the absence is visible in the loader. This plugin is a DSH bundle row and
  is meant to live with the harness; the seam is the sanctioned way to read a harness fact, and
  the alternative — parsing `~/.dsh/sessions` headers itself — would couple the plugin to the
  on-disk session format instead, which is strictly worse.
* Neutral, because the refresh still makes exactly one lineage read: `listSessions` is called
  once per refresh and never per row. The fold that follows costs one ancestor walk per input
  row, so a deep chain is linear in depth rather than free — bounded by the row ceiling the
  analytics query already enforces, and by a depth cap, see below.

### Confirmation

Unit tests over fixture headers and fixture analytics rows: a parent and child pair folds the
child's spend into the parent's row; a three-level chain folds the grandchild too, proving the
recursion; a child whose parent header is absent from the corpus keeps its own row and does not
leak into any ancestor; a session with delegated children but no own row is present with the
subtree figure; a failing lineage read yields own-session figures plus a reported reason; and
the day, key, and model figures are asserted unchanged by the rollup. A test asserts that id
matching is exact, using a `session-`-prefixed child and a bare-UUID child in the same fixture.

The edge filter is pinned separately, on the header shape rather than on money: a header marked
`origin: 'subagent'` yields an edge, and a fork-shaped header — a `parentSession` with
`isSeeded: true` and no `origin`, the shape both fork paths write — yields none, so a fork's
spend can never reach its parent's row.

Against a live account the check is a comparison, not a new measurement tool: pick a session
whose child rows are visible in the analytics split, and assert the chip's left figure equals
the parent row plus its subagent rows — the figure the split shows apart today. The
unattributed bucket is the control: it must not move.

## Pros and Cons of the Options

### Host-side subtree rollup

* Good, because the host is the only place that can do it once for every tab: the summary is
  cached and shared, so a browser cannot ask for "my session" without making the cache
  per-session.
* Good, because the browser stays ignorant of session lineage, which is a harness concept and
  not a display concern.
* Neutral, because each row now means "this session plus the work it delegated" rather than
  "this session's own requests"; that ambiguity is inherent to showing one number per branch,
  and no session list exists in the UI to confuse.

### Host ships lineage edges; the client walks the subtree

* Good, because rows stay strictly truthful — one row is still one session's own spend — and a
  future session list could render the delegation tree without a host change.
* Bad, because it makes a harness-side relationship part of the browser payload's public
  shape, and every reader of that payload must know the traversal rule to interpret a row.
* Bad, because the walk is O(rows) in the browser on every render for a figure the host
  computed anyway.

### `?session=<id>` parameter computed on demand

* Good, because it answers precisely one question with no unused work: only the asking tab's
  subtree is computed.
* Bad, because it defeats the shared poll — the design that lets several open tabs cost one
  refresh (`index.js`, summary route) — turning one cached request into one per tab, each with
  its own listing.
* Bad, because it puts the session id in the browser's request path, so the summary endpoint
  becomes per-caller and its cache key grows a caller-specific dimension.

## More Information

The session-id dimension is OpenRouter's own attribution of the `x-session-id` header; the
plugin reports what OpenRouter billed rather than estimating, which is why a session that
never reaches OpenRouter has no row. Observed behaviour was measured against a live account on
2026-10-07; OpenRouter's analytics API is in beta.

Revisit when OpenRouter's analytics gains a first-class parent/child dimension, when the
out-of-process subagent backends start recording DSH sessions, or when the popover needs to
show a session list — at which point the per-session split stops being a chip-only detail.
