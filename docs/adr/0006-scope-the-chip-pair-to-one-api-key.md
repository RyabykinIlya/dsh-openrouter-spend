---
status: "accepted"
date: 2026-10-11
decision-makers: maintainer
consulted: none
informed: plugin users
---

# Scope the chip's session/day pair to one API key

## Context and Problem Statement

The chip under the composer shows `session/day`: this chat's spend over the day's spend. Both
figures were read from different scopes, and nothing forced them to describe the same money.

The left figure came from the session split (`bySession`, `sessionRow.todayUsd`) and the right
from the account's day (`todaySpend.usd`). Meanwhile the popover beside it — one click away, in
the same component — reported the *tracked key's* day in its head, and its per-model table was
scoped to that key too. So the chip's denominator and the panel's head were two different
numbers describing two different things, and the chip's pair was not a share of anything.

Reported against a live account on 2026-10-10: the chip read `36.44/89.93 ₽` while the popover
head read `36.53 ₽`. The three figures were all correct and all different — the session subtree
(0.4292 USD), the tracked key's day (0.4302 USD), and the whole account's day (1.0592 USD). The
right half of the pair, 89.93, was the account total, and the popover head, 36.53, was key `dh`;
the pair compared a chat against a pool the chat is only a small part of.

Two more failure modes surfaced in the same report, both of them the "could not read reads as
zero" class the host already guards against for limits and burn:

* A chat whose spend is entirely billed to a delegated subagent has no *own* row for today, and
  `mergeSessions` gives a window-only row `todayUsd: 0`. Combined with a lineage fold that had
  not run, the chip showed `0.00/89.93` — indistinguishable from a chat that spent nothing.
* The host publishes `lineageError` when the fold fails, and `sessionsError` when the split
  cannot be read at all, but no surface rendered either: the chip silently lost its pair, and the
  reason never reached the reader.

## Decision Drivers

* The pair must be internally consistent: a numerator and a denominator drawn from one key.
* It must agree with the popover it belongs to, whose scope is the tracked API key.
* Honest degradation beats a plausible-looking wrong number: a single figure is better than a
  pair that mixes scopes.
* No new upstream request, and no widening of what the payload carries: key names stay the only
  key vocabulary the browser sees (ADR-0002's narrowing rule).
* "Could not read" must never render as "zero".

## Considered Options

* **Make the pair `session today / account today`.** The shipped behaviour; rejected because it
  contradicted the popover head and answered a question no reader has.
* **Make the pair `session today / tracked key today`, resolving the key from the session row.**
  Chosen. The key dimension is added to the existing session query, so the session's own key is
  known, and the tracked key from Settings takes precedence because the popover is scoped to it.
* **Collapse a multi-key session to its largest key.** Rejected: it invents an attribution the
  data does not support. A session that billed two keys genuinely has no single-key day, so the
  pair is refused and the single figure stands.
* **Compute the pair from the per-key model rows instead.** Rejected: `byKey[].todayModels` is
  scoped to a key but not to a session, so it cannot supply the numerator.

## Decision

`querySessions` requests `['api_key_id', 'session_id']`, and every session row carries the key
that billed it. `mergeSessions` accumulates a per-key split (`todayKeys`) alongside the totals,
and `rollupSessions` folds that split through the delegation tree with the money it splits, so a
parent whose child ran on another key reports both keys rather than the parent's alone.

The browser resolves **one** key for the pair, in this order: the tracked key from Settings if
set; otherwise the session's own key when the session used exactly one. It then renders the
session's share of that key against that key's day. Where no single key can be named — no
session row, no split published, no tracked key on a multi-key session, no `byKey` row for the
resolved key, or a non-positive denominator — the chip shows one scoped figure instead of a pair.
The pair is also suppressed when `lineageError` is set, because the session figure then excludes
delegated spend and would understate against a complete day.

`sessionsError` and `lineageError` are rendered in the popover as their own notes, naming the
reason, so a dropped pair is never silent.

## Consequences

* The chip agrees with the panel: with key `dh` tracked and this chat on `dh`, the pair reads
  `36.44/36.53 ₽`, and the popover head reads `36.53 ₽`.
* A chat on a key other than the tracked one reads `0.00/<that key's day>`. That is arithmetically
  honest — the chat spent nothing there — and it is the visible signal that the tracked key is
  not the one this chat uses.
* The session query returns one row per session *and* key rather than per session. Measured
  against a live account on 2026-10-10: 271 sessions came back as 275 rows over 30 days and 22
  rows for today, against the existing 1000-row ceiling. The ceiling is unchanged.
* A session that spans keys shows no pair, so the reader loses the ratio in exactly the case
  where it would be least meaningful.
* The chip's pair no longer follows the popover's range filter: it was and remains a today
  figure. The README's older claim that the pair followed "the selected range" was wrong and has
  been corrected rather than implemented, because a per-range session split would cost an extra
  upstream query per range for a figure the reader did not ask for.
* Thresholds, the toast, the burn window and the limit block are untouched: this decision changes
  which key the chip's money is drawn from, not how a limit is judged.

## Non-goals

* Splitting the session figure across a multi-key session. The pair is refused instead, and a
  future change that wants to show it would need a per-key-per-session user interface, not a
  collapsed number.
* Replacing the account-wide figures anywhere else. Today, 7 and 30 days, per key, per model and
  per day still include every key, which is what makes them account figures.
