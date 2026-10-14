---
status: "accepted"
date: 2026-10-12
decision-makers: maintainer
consulted: none
informed: plugin users
---

# Raise a key's limit from the popover through the management key

## Context and Problem Statement

ADR-0001 shipped the limit warning as an alarm, and [the design
doc](../design/limit-notice.md) closed its non-goals with an explicit sentence:

> No automatic mitigation — the plugin does not switch keys, disable one, or
> raise a limit. It reports.

That sentence was written when the only credential the plugin held was
understood as a **read** credential. It is not: the same management key that
reads `/keys` also carries `PATCH /keys/{hash}`, and the warning's own subject —
a cap that is about to stop work — has exactly one useful action beside it.

The requesting user put it plainly:

> можно через management key увеличивать лимит по ключу? типа кнопку сделать в
> поповере чтобы увеличить лимит. вот у меня допустим 10$->15$ и чтобы была
> кнопка когда к лимиту подходим

The gap the request names is not cosmetic. A warning that ends in "open the
OpenRouter dashboard, find the key, edit the cap, come back" is a warning whose
action costs more than the alarm; the toast is dismissed and the cap runs out.
The distance between *being told* and *acting* is the whole value of an alarm
that fires days early.

Two constraints shape the answer before any option is weighed:

* **The hash must never reach the browser.** `readKeyLimits` emits exactly four
  fields per key — `limit`, `limitRemaining`, `limitReset`, `disabled` — and the
  record's `hash`, `label` and `creator_user_id` stay host-side, because this
  repo and its payloads are public. A raise needs the hash; therefore the raise's
  request must name the key the way the payload does, **by name**, and the host
  must resolve it.
* **A name is ambiguous by construction.** ADR-0002 names duplicated key names as
  the join's known risk and resolves it for the *published* map by dropping every
  duplicated entry. A raise cannot take that escape: dropping means refusing to
  act, and OpenRouter identifies a record by hash alone.

## Decision Drivers

* The action must cost one click from the surface that raised the alarm.
* The browser must keep receiving only the fields it already receives; no hash,
  label or creator may travel, in either direction.
* A raise must be a raise: the route must be unable to lower a cap, because a
  mistyped "lower it" behind a button labelled *raise* spends money silently.
* The offered figure must be defensible — a number the user recognises as "enough
  to finish this period", not a round-up chosen to make the button look useful.
* The raise must be visible immediately: a cached pre-raise `limits` beside the
  raise's own confirmation is the one reply that would make the feature look
  broken while it worked.

## Considered Options

* Keep the plugin read-only, as the design doc's non-goals promised.
* Deep-link to the OpenRouter dashboard's key page and let the user edit there.
* Raise the limit from the popover and the toast, through the management key.

## Decision Outcome

Chosen option: "raise the limit from the popover and the toast", because it is
the only option that closes the distance between the alarm and its action, and
the credential that raises the alarm already holds the permission to act on it.

Concretely:

* **`POST /openrouter-spend/key-limit`**, a third route beside the summary and
  the credential write, fenced by the same `ctx.connection.requestRejection`
  check and answering `405` with `allow: POST` to anything else. Its body is
  `{ name, limit }` — the **name**, never the hash, which is exactly the
  identifier the popover already renders.
* **The host resolves the name to a hash** through the same `/keys` walk the
  limits read uses (`queryKeyRows`, shared by both readers). Ambiguity here is
  judged over **every** key carrying the name, not only the limited ones
  `readKeyLimits` publishes: a raise names a record, and a name is not a record
  identifier. A duplicated name is refused with the fix named — rename all but
  one in OpenRouter — rather than resolved by last-wins, which would raise an
  arbitrary cap.
* **Only a raise is accepted, and only a bounded one.** `limit` must be finite,
  above zero, greater than the current limit, and at most `RAISE_MAX_FACTOR` (10)
  times it. The lower bound is what makes the button honest; the upper bound is
  the one typo the wire cannot tell from intent — a leaked trailing zero — and it
  is refused with the reason rather than spent.
* **A key with no finite limit is refused, naming the real fix.** There is no cap
  to raise, so the sentence says to set one in OpenRouter first; silently creating
  a cap of the posted size would be a different action than the one requested.
* **The offer is dynamic, not a fixed preset** (`suggestedRaise` in `client.js`).
  A period cap that is burning fast offers **cap + the period's burn so far** —
  enough to finish this period at the pace that raised the alarm, so a `$10/day`
  key at `$8.50` burned offers `$18.5`. Anything else — a slow period, or a
  lifetime cap whose pace is daily and not periodic — offers **×1.5**, enough
  headroom to see the next warning coming without doubling a budget somebody set
  on purpose. Every offer is rounded to **dimes** (OpenRouter carries two
  decimals) and is at least a dime above the cap, so it is always a raise.
* **A custom field sits beside the offer**, because the rule above is a good
  default and not a substitute for typing a figure. It accepts a comma as the
  decimal separator, rounds to dimes, and disables its button for any value at or
  below the current cap — with the reason in its `title`, so a disabled control
  is explained rather than silent.
* **Two surfaces carry it: the popover's raise row and the toast's raise
  button.** The toast is the escalation itself, so the figure beside *Dismiss* is
  the one action that keeps the cap from stopping work. Both share `raiseTo`, so
  the two cannot promise different numbers. The **balance** toast has no raise:
  the pool has no cap to raise, and "top up" is its action.
* **A completed raise retires the host cache** and the client refreshes with
  `?force=1` — the same override the popover's *Retry* uses. Without this, the
  first poll after a raise would be answered from a cache entry written before it
  and would render the old cap beside the raise's own confirmation.

Refusal mapping: `not-found` → `404`, `ambiguous` / `no-limit` / `invalid` →
`400`, no credential → `409`, and anything the `PATCH` itself said → `502` with
upstream's own words, which this half must not invent for a reply it never saw.

### Consequences

* Good, because the alarm and its action now sit on one screen: the escalation
  that used to end in a dashboard errand ends in one click.
* Good, because the payload contract is unchanged — the raise travels by name and
  the hash never leaves the host, so the public-surface rule that produced
  `readKeyLimits`' four fields survives the write path.
* Good, because the offer is derived from the same figures the sentence prints
  (`limitUsdRounded`, `periodBurnUsd`), so the button and the sentence cannot
  disagree about what the cap is.
* Bad, because the plugin now **writes to a paid account**. A misclick spends
  money, where every previous release could only spend the user's attention.
  Mitigated by the raise-only bound, `RAISE_MAX_FACTOR`, and the dimes floor —
  not eliminated.
* Bad, because a raise is not reversible from the plugin: lowering a cap is
  deliberately impossible here, so a raise made by mistake must be undone in the
  dashboard. The asymmetry is chosen (a lowering button behind a raising label is
  worse), and it is the one asymmetry a user can be surprised by.
* Bad, because the dynamic offer needs a pace to be interesting: on a period cap
  whose `periodBurnUsd` is zero or unavailable, and on every lifetime cap, the
  offer collapses to `×1.5`, which is a rule rather than a measurement.
* Neutral, because a raise is not recorded anywhere: the plugin has no history of
  limit changes, and the next poll simply reports the new cap.
* Neutral, because both surfaces are behind the existing opt-in (`ors.limitNotice`,
  ADR-0004). The route itself is always registered; what ships off is the surface
  that offers the button.

### Confirmation

`tests/key-limit.test.mjs` pins the route end to end against the stubbed Cordis
context and a scripted backend: the `PATCH` names the resolved hash and carries
only `{ limit }`, the management key rides the `Authorization` header and never
the URL, every refusal kind maps to its status, a successful raise is visible in
the summary that follows it, and the client's `suggestedRaise` /
`parseRaiseInput` are driven directly.

The load-bearing fixes were **mutation-verified** — the fix reverted in a scratch
copy, the suite confirmed red: forcing `suggestedRaise`'s fast branch off reddens
three tests, removing the raise-only bound reddens two, and dropping the cache
retire after a successful `PATCH` reddens one.

## Revisit When

* OpenRouter changes the `PATCH /keys/{hash}` contract, or adds a limit field the
  raise should carry (`limit_reset`, `include_byok_in_limit`).
* A key outside the default workspace needs raising: the walk lists one
  workspace's keys, so such a key surfaces as "limit unknown" and cannot be
  raised from here (the same limitation ADR-0002 accepted for reading).
* Someone asks for the lowering direction, or for a raise proportional to the
  runway rather than to the period burn. Both are deliberate omissions, and
  either would be a new record rather than an amendment.

## Pros and Cons of the Options

### Keep the plugin read-only

* Good, because it cannot spend money, and the design doc already promised it.
* Bad, because the promise was written when the credential was understood as a
  read key, and it is not one — the permission was always there.
* Bad, because it leaves the alarm's action off-screen: the reader who is told
  the cap will run out at 03:00 must go and find the key in a dashboard first.

### Deep-link to the OpenRouter dashboard

* Good, because it writes nothing and needs no new route.
* Good, because the dashboard is where a limit's reset schedule and BYOK
  inclusion can be edited, which this route deliberately does not touch.
* Bad, because the link still costs a navigation, a search for the key, and a
  return — the errand the request was about, with one click saved.
* Bad, because the key's name is not a URL: the dashboard has no addressable
  per-key page, so the "link" would be the key list and a manual search.

### Raise from the popover, through the management key

* Good, because the action sits on the surface that raised the alarm, at the
  figure the sentence beside it already justifies.
* Good, because the name→hash resolution happens host-side, so the payload's
  four-field contract is untouched.
* Bad, because it gives the plugin write access to a paid account, and the
  raise-only bound is the only thing between a typo and a spent balance.

## More Information

The UI rendering — the raise row's anatomy, the offer rule, the custom field, and
which surface carries which action — is [the design
doc](../design/limit-notice.md), section "Raising the limit". The warning this
acts on is [ADR-0001](0001-warn-early-on-cap-consumption.md); the name-to-key join
and the workspace limitation are
[ADR-0002](0002-read-per-key-limits-from-the-management-keys-endpoint.md); the
opt-in gate both surfaces sit behind is
[ADR-0004](0004-gate-the-limit-warning-behind-a-default-off-setting.md); the
balance, which has no cap to raise, is
[ADR-0007](0007-judge-the-account-balance-by-runway.md).

The route shapes are OpenRouter's own: `PATCH /api/v1/keys/{hash}` accepts
`limit` alongside `name`, `disabled`, `limit_reset` and `include_byok_in_limit`
([OpenRouter: update an API
key](https://openrouter.ai/docs/api/api-reference/api-keys/update-an-api-key)).
This record sends `limit` alone — the narrowest body that performs the requested
action — and the design doc's non-goal sentence is amended by this record rather
than by an edit to that document's history.
