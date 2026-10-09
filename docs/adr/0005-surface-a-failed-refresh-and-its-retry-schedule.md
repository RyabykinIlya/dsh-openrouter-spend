# ADR-0005: Surface a failed refresh and the schedule of the next attempt

- Status: accepted
- Date: 2026-10-09
- Deciders: maintainer

## Context

The chip's amber dot means "the last good figures are still on screen, but the latest read
failed". The popover printed the wire's own message under the figures — typically
`fetch failed` — and nothing else. There was no way to ask for a fresh read, and no statement
of when the poll would try again. The poll interval was a fixed `refreshSeconds`, invisible to
the reader, and the host reset its cache clock on failure, so the next real query landed on
the next tick of a timer nobody could see.

The first read of a session is the one most likely to fail: the harness can start before its
VPN, proxy, or DNS is up, so the very first query to OpenRouter throws at the socket. The
reader then watches an amber chip for a full interval, with no way to hurry it and no way to
tell a dead network from a rejected key.

## Decision

We will make a failed refresh self-describing and recoverable.

* The host classifies the failure (`describeFailure`) into `network`, `timeout`, `auth`,
  `rate-limit`, `server`, `request`, `data`, or `unknown`, and ships the code next to the raw
  message in `errorCode` / `error`. The browser renders a sentence from the code in the
  reader's language and keeps the raw detail underneath it.
* The host schedules the retry: the first attempt after a failure comes 15 seconds later, the
  second after 30, and then the ordinary `refreshSeconds`. The ladder never exceeds
  `refreshSeconds`, so a deliberately short interval is not stretched. A successful read
  resets it.
* The host announces the schedule in the payload as `nextRefreshAt` (and `lastAttemptAt`), and
  the browser polls on that field instead of a fixed interval. An explicit interval preference
  still governs healthy reads; a failed read follows the host's ladder, because that is where
  the ladder lives.
* The popover shows the sentence, the raw detail, a live countdown to the next attempt, and a
  **Retry now** button. The chip's tooltip carries the same sentence and countdown, and its
  accessible name says why the figures are stale.
* **Retry now** asks the host to read past its cache (`GET /summary?force=1`). A forced read
  still joins an in-flight read and is floored at two seconds, so the button is an override of
  the cache and not of the coalescing.
* A reply that never arrived is a state rather than a silent no-op: a non-OK response and a
  client-side network failure both surface the same block, with the client's own ladder
  standing in when the host itself is unreachable.

## Alternatives Considered

- **A Retry button with no schedule** — rejected: the reader still cannot tell whether the
  plugin is about to recover on its own, so every failure becomes a manual act.
- **A countdown with no button** — rejected: a failure that does not clear leaves nothing to do
  but wait, and the common cause (a socket that was not up yet) is exactly the one where
  waiting is pointless.
- **A client-side fixed retry, no host change** — rejected: the host owns the upstream query
  and the cache. A client-side ladder would disagree with the cache TTL, and with several tabs
  open it would multiply queries against a service that is already failing.
- **Exponential backoff capped above `refreshSeconds`** — rejected: the figures are what the
  reader is waiting for. Backing off past the ordinary cadence punishes the person waiting and
  protects nobody, because the host already coalesces every tab into one query.
- **A toast or notification on failure** — rejected: a refresh failure is ambient state, not an
  event. It would interrupt for something the chip already shows, and the limit toast
  (ADR-0004) is reserved for the escalation that actually stops work.

## Consequences

- Good: the amber dot now explains itself. A reader can tell "my VPN is down" from "the key was
  rejected" without reading a log, and can act on both.
- Good: the fast first retry turns the ordinary start-up failure into a 15-second wait instead
  of a full interval, which is the case that prompted this record.
- Good: the schedule has one owner. The browser no longer guesses a cadence the host might not
  follow.
- Bad: the retry ladder exists twice — authoritative in the host, mirrored in the browser for
  the case where the host never answered at all. Drift between them is possible, and both sides
  are pinned by tests for that reason.
- Bad: one more field in the payload and one more query parameter on the route, which is more
  surface for a payload this repository publishes.
- Neutral: the forced read is floored at two seconds and skips the cache. A user who holds the
  button down gets the same figures rather than a stream of upstream queries.

## Revisit When

The retry timings should become configurable per deployment, or a failure should reach the
reader somewhere other than the chip — a desktop notification, or the harness log they already
read. Either change moves the schedule out of this record's shape rather than extending it.
