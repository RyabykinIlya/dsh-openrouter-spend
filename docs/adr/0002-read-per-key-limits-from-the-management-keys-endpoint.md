---
status: "accepted"
date: 2026-10-07
decision-makers: maintainer
consulted: none
informed: plugin users
---

# Read per-key limits from the management `/keys` endpoint

## Context and Problem Statement

The plugin polls `POST /analytics/query` for billed spend and `GET /credits` for the prepaid
balance, both with a management key. Neither reports a per-key limit: the summary's ceiling
awareness is limited to `total_credits − total_usage`, which is the account's shared pool and
says nothing about an individual key's cap. ADR-0001 needs a limit and its reset semantics to
choose a warning threshold, so the limit must be read from somewhere and joined to the key
the user is tracking.

The join is the risk. `analytics/query` groups by `api_key_id`, and a key's identity in
OpenRouter is a 64-character `hash`. If `api_key_id` carries that hash, a limit can be
attached to a spend row without ambiguity; if it carries the human-readable `name`, the join
is by name and inherits the name's uniqueness assumptions. Which one it is decides whether
this feature is a lookup or a guess.

## Decision Drivers

* The limit must attach to the same key the spend figures already come from, or the meter
  shows one key's headroom beside another key's spending.
* The limit must describe the *tracked* key, not the credential the plugin authenticates
  with — those are different keys, and conflating them would report the management key's
  own (usually absent) cap.
* A user without a management key must keep the plugin working; the limit is an addition,
  not a new requirement.
* A failure to read limits must not take the spend summary down with it.

## Considered Options

* `GET /key` — the limits of the key used to authenticate
* Manual entry of the limit in Settings
* `GET /keys` — the full key list, joined to analytics by name

## Decision Outcome

Chosen option: "`GET /keys` — the full key list, joined to analytics by name", because it is
the only source that reports the tracked key's limit together with its reset period, and the
join was verified against a live account rather than assumed.

We will read `GET /keys` on the same cadence as the rest of the summary and attach, per key,
`limit`, `limit_remaining`, `limit_reset`, and `disabled`. **Those four fields are the whole of
what ships to the browser.** The key records themselves stay in the host: no `hash`, `label`,
`creator_user_id`, `created_at`, `last_used_at`, or per-period `usage*` breakdowns enter the
payload. The effective headroom shown to the user is:

```
headroom = min(key limit_remaining, account balance)
```

The balance is a hard cap on every key at once — when it reaches zero, every key stops
regardless of its own limit — so a meter that shows only the key limit would be optimistic
in exactly the scenario that matters most. Both figures are already available: the balance
comes from the `/credits` call the plugin already makes.

The join was confirmed empirically on 2026-10-07: `api_key_id` in `analytics/query` carries
the key **name**, not the hash. Every name in the analytics window was present in `/keys` and
none was orphaned, and the same-day figures agreed across the two endpoints to within the
gap between the two requests. Because this is an observed behaviour of a beta API rather
than a documented contract, the merge keeps a build-time-verifiable invariant: a key with
non-zero spend that has no match in `/keys` is reported as unmatched rather than silently
assigned a limit.

Failure is isolated the way the existing session split already is: a rejected or
unauthorized `/keys` call lands in a `limitsError` field on the summary, the spend figures
survive intact, and the UI hides the limit block instead of showing zeros.

### Consequences

* Good, because the limit block reuses the existing poll and cache rather than adding a
  request per refresh; one refresh still serves every open tab.
* Good, because a wrong join is visible instead of silent: the unmatched-key counter and the
  cross-endpoint daily comparison agree only when the join is right.
* Bad, because it makes the plugin's management-key dependency load-bearing for a second
  feature: without a management key the limit block is permanently absent, and the chip
  cannot warn about a limit it cannot see.
* Bad, because `/keys` returns every key on the account, including keys unrelated to this
  installation. The plugin narrows by **shape, not by key**: the browser payload carries the
  four limit fields per key and nothing else (see Decision Outcome). Narrowing to the tracked
  key alone is not available to the host — `ors.keyId` is a browser-local preference while the
  summary is cached host-side and shared by every open tab, so one tab's choice must not decide
  what another tab fetches, and the "tightest limited key" view needs every key's limit anyway.
* Neutral, because the added figures ride in the existing cached payload; there is no new
  cache to invalidate when the management key changes.

### Confirmation

An integration test asserts that a `byKey` row with non-zero spend and no matching name in
the `/keys` fixture is surfaced as unmatched. A unit test asserts the effective headroom is
the minimum of the key's remaining and the account balance. A test asserts a 403 from `/keys`
produces a summary with `limitsError` set and unmodified spend figures. A test asserts the
**payload shape**: every entry in `limits` carries exactly the four documented fields, and no
`hash`, `label`, or `creator_user_id` appears anywhere in the serialized summary.

## Pros and Cons of the Options

### `GET /key`

* Good, because it is a single documented call requiring no account-wide listing.
* Bad, because it describes the key that authenticated the request — here, the management
  key — not the tracked inference key. It answers a question nobody asked and cannot answer
  the one that matters.
* Bad, because it would silently mislead: a management key typically has no limit, so the
  feature would read as "no limit" on an account whose inference keys all have one.

### Manual entry of the limit in Settings

* Good, because it needs no API surface at all and cannot be broken by a beta endpoint.
* Good, because it works for a limit the API cannot express (a spend policy tracked outside
  OpenRouter).
* Bad, because it drifts the moment the limit is edited in the dashboard, and a stale limit
  produces confidently wrong warnings — the worst failure mode for an alarm.
* Bad, because it moves the reset period onto the user as well; entering a number without its
  period reproduces the ambiguity ADR-0001 exists to resolve.

### `GET /keys` joined by name

* Good, because it is authoritative and self-updating: it reports the limit and the reset
  period as configured, so an edit in the dashboard is reflected on the next poll.
* Good, because the same response carries `usage_daily` per key, giving an independent
  cross-check of the analytics-derived figure and thereby of the join itself.
* Bad, because it is the widest surface of the three: an account-wide listing whose response
  grows with the number of keys, and whose `name` field is a human label that a user can
  edit or duplicate — the join must tolerate a rename by reporting unmatched, not by guessing.

## More Information

The trigger that consumes these limits is [ADR-0001](0001-warn-early-on-cap-consumption.md);
the presentation is [the design doc](../design/limit-notice.md).

The `limit_reset: null` case was found to mean a lifetime cap, with
`limit_remaining = limit − usage`; for `daily`, `weekly`, and `monthly` it is
`limit − usage_<period>`. Verified on every limited key of a live account on 2026-10-07.

### Amendment, 2026-10-07

The Consequences section originally required the host to "narrow to the tracked key" and
forbade putting the key list in the browser payload. That requirement was wrong, not merely
imprecise: `ors.keyId` is a browser-local preference and the summary is a single host-side
cache shared by every open tab, so the host has no tracked key to narrow by, and narrowing by
one tab's choice would make another tab's payload depend on it. The requirement is replaced by
a shape constraint — the four limit fields per key, and nothing else. The decision itself
(GET /keys, joined by name, `min(key remaining, balance)`) is unchanged.
