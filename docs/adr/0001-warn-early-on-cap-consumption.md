---
status: "accepted"
date: 2026-10-07
decision-makers: maintainer
consulted: none
informed: plugin users
---

# Warn early on cap consumption, not on percent of limit remaining

## Context and Problem Statement

The composer chip carries a status dot whose only meaning today is data health: `ok`
(business blue), `loading` (grey), `stale` (amber), `error` and `no-credential` (red). Spend
figures refresh every `refreshSeconds`, so the user can see how much was spent but never
whether a cap is about to stop work. OpenRouter enforces per-key limits and returns 402 when
one is hit, so the failure is abrupt and, without a signal, unannounced.

The obvious trigger — warn when only a small percent of the limit remains — fails on the
user's own example: at a $1000 limit, warning at $100 left is too early, and at a $10 limit,
warning at $1 left is too late. Both are the same 10% of remaining headroom, so the
percentage itself is the wrong quantity. A metric is needed that fires early enough to act on
at any limit size.

The decisive measurement is the *shape* of the spend. Against a live account (2026-10-07),
one key with a $10 daily cap burned nothing on its median day, but its heaviest evening
consumed about a third of the cap in a single hour, then roughly half the cap in the next
one, and exhausted the whole cap inside one evening. That inverts the intuition behind a
small-remaining threshold: **on a bursty account the last quarter of a cap is spent within
one hour**, so a threshold placed at 75% or 90% consumed has effectively no lead time.

## Decision Drivers

* One rule must behave sensibly for a $2 cap and a $1000 cap alike.
* A periodic limit that has just refilled is healthy; the signal must not punish that.
* A key with no recent traffic must not raise a warning.
* The warning must arrive early enough to finish, defer, or reroute work — which on a bursty
  account means well before the consumed fraction is high. The user's stated preference is to
  err early.
* The metric should be computed from data already fetched, with no extra request.
* A warning that fires constantly is worse than none: it trains the user to ignore it.

## Considered Options

* Percent of limit remaining
* Percent of cap consumed, with late thresholds (warn at 75%, critical at 90%)
* Runway in days at a median daily burn
* Projected period usage (spend so far extrapolated linearly to the period's end)

## Decision Outcome

Chosen option: "early cumulative share of the cap for periodic limits, runway in days for
lifetime limits", because only this combination fires with usable lead time on a bursty
account while staying silent on every ordinary day.

We will branch the metric on `limit_reset`:

* **`limit_reset` is `daily` / `weekly` / `monthly`** — the metric is the share of the cap
  already consumed in the current period: `used_<period> ÷ limit`. Warn at **40%**, critical
  at **80%**. The threshold is a config field (`warnConsumedFraction`, default `0.4`) so a
  deployment can tune it without an edit; the reasoning for the default is below.
* **`limit_reset` is `null`** (lifetime cap) — the metric is runway in days:
  `limit_remaining ÷ median daily spend`. Warn at ≤ 3 days, critical at ≤ 1 day.

Both branches report, as the actionable figure, the **runway at the recent peak hourly
burn**: `limit_remaining ÷ max hourly spend`, over a 7-day trailing window. A cumulative
percentage says where the user is; this says how long the money lasts if the current pace
repeats, which is what the warning is for. The maximum is the noisiest available estimator and
is chosen knowingly: it answers "how fast can the remainder go", not "what is typical", and it
is rendered as rounded text rather than used as the level itself.

**Time to reset moderates escalation.** A periodic cap that resets within the hour is not an
emergency even at 80% consumed — the user waits. We escalate to critical only when the
projected exhaustion lands materially before the reset; when the reset is imminent, the state
stays `warn` and the copy says so.

**The consumed share is the only trigger.** Three time-based formulations were built and
measured against the same 30 days of hourly data, and all three lost. The intuition behind them
is sound — a $1000 monthly cap at 40% consumed on day 3 is a worse position than the same share
on day 28 — but the time axis could not be promoted from moderator to trigger:

| Rule | Formulation | Measured outcome |
|---|---|---|
| C | `remaining ÷ peak burn < hours to reset` | Fires at 00:00 on **every** day, including two days with zero spend: the budget resets while yesterday's peak does not |
| C1 | `remaining ÷ recent burn < hours to reset`, recent burn > 0 | 3 days fired where 1 exhausted — 2 false positives — and **no extra lead**: on the exhausting day it fired in the same hour as the plain 40% threshold |
| D | `consumed ÷ elapsed ≥ factor`, elapsed ≥ 1 h | At factor 1.5 fires **one hour after** the cap was crossed; at 2.0 and above it never fires at all |

The failure of C and C1 is structural rather than a matter of tuning: a periodic cap resets its
remainder and does not reset its burn rate, so any ratio between the two is discontinuous at
the boundary — precisely where a trigger must be reliable.

**Known limitation, accepted.** For a `monthly` cap the consumed share under-warns early in the
period and over-warns late in it. No key with a monthly cap was available to measure against, so
no code path is written for it: an unverified branch for an untestable case would be worse than
the gap. Recorded here as the first thing to revisit with a monthly-key measurement.

**No absolute-request floor on the periodic branch.** An earlier draft suppressed warnings
while more than ~10 requests of headroom remained. Measured against the live key, that floor
silenced exactly the case the feature exists for: at a per-request cost of about one and a
half thousandths of a dollar, a single dollar of headroom is hundreds of requests, so the
floor blocked the warning on the very evening the cap was exhausted. The floor's intent —
not crying wolf over arithmetic on a cap one call can consume — is served instead by the
early thresholds and by the fact that `warn` is deliberately quiet.

The threshold default of 40% is calibrated, and the calibration is a trade-off, not a
derivation:

| Consumed threshold | Lead time before the cap fell | Days fired, over 29 closed days |
|---|---|---|
| 30% | ~6 h | 2 — one of them a day that ended at a third of the cap |
| **35–40%** | **~6 h** | **1 — only the day the cap was exhausted** |
| 50% | ~4 h | 1 — only the exhausting day |
| 60% | ~1 h | 1 — only the exhausting day |
| 75% / 90% | **0** — same hour as the exhaustion | 1 — the warning arrives with the failure |

40% buys six hours of lead where a 75% threshold buys none, at the same noise cost as 50%.
Below 35% the threshold starts catching ordinary days: the busiest non-exhausting day in the
window ended at roughly a third of the cap, so a 30% threshold fires on work that was never
at risk.

Two constraints on the inputs remain load-bearing:

* **The burn rate is a median of complete days, not a mean, and today is excluded.** One
  expensive session moves a mean for a week.
* **History predating the limit's creation is not used.** A key's `updated_at` records when
  its limit was set; spend before that date happened under no cap, and treating it as evidence
  of the current pace predicts exhaustion the cap makes impossible. The measured account
  contained exactly this case — its heaviest historical day predates its limit.

The state is subject to hysteresis: once a level is entered it is left only when the metric
clears the threshold by a margin, so a key hovering at the boundary does not oscillate the
dot on every poll.

### Consequences

* Good, because the warning arrives with hours of lead on the only day that mattered in the
  measured window, which is what the user asked for: earlier rather than later.
* Good, because it stays silent on ordinary days — one firing in 29 closed days, and that one
  was a genuine exhaustion.
* Good, because the inputs (`byKey` daily series, `credits`) already exist in the summary
  payload; the feature adds no request of its own.
* Bad, because 40% is calibrated on a single burst day from one account. On a steadier
  profile the same threshold fires with much more lead *and* much more often: an account
  whose normal day already consumes 40% of its cap will see a warning every day, and the
  threshold would need raising. This is the weakest point of the decision and the first thing
  to revisit with more data.
* Bad, because the margin over ordinary work is thin by construction: in the measured window
  the busiest non-exhausting day finished about a sixth below the 40% mark, so a slightly
  busier normal day would have warned.
* Bad, because the margin is chosen to buy lead time at the cost of precision; a `critical`
  state reached on a burst carries roughly no warning of its own, since the last fifth of a
  cap goes inside the same hour. `critical` means "you are about to be stopped", not "plan
  ahead".
* Neutral, because the branch is only as accurate as `limit_reset`; a key whose limit is
  edited in the OpenRouter dashboard changes category on the next poll.
* Neutral, because a lifetime cap and a periodic cap now answer different questions, so the
  popover's sentence differs by branch (see the design doc).

### Confirmation

The rule is a pure function of the payload, so its cases belong in the repo's test suite
(`npm test` → `node --test tests/*.test.mjs`, the harness added for the session rollup). Until
they are written, the confirmation is review plus a manual check against a live account:

* a daily key at 41% consumed warns and at 39% does not;
* the same key at 81% is critical; the same key at 80% with the reset inside the hour is `warn`;
* a lifetime key whose runway crosses 3 days warns, and the same key with a `daily` reset does
  not;
* a key whose only spend precedes its limit's `updated_at` stays at `none`;
* a key with headroom worth hundreds of requests but a high consumed share still **warns** —
  the request floor the earlier draft had must not reappear;
* the dot maps each level to its documented color.

## Revisit When

* A key with a **monthly** cap becomes available: measure whether the consumed share warns too
  early on day 3 of the period, and if so add the time-to-reset moderator to that branch only.
* More than one exhausting day has been observed: the 40% default rests on a single burst day,
  and the table above shows 30% and 40% sharing a lead time, so the value is not yet pinned.
* OpenRouter documents the reset boundary or its timezone: this decision derives the boundary
  from `usage_daily` matching the UTC day, which is evidence, not a contract.

## Pros and Cons of the Options

### Percent of limit remaining

* Good, because it needs no history: `limit_remaining ÷ limit` is available on the first
  poll, so a brand-new key is covered immediately.
* Good, because it is trivially explainable — "you have 12% left".
* Bad, because it does not transfer across magnitudes: 10% of a $1000 cap is $100, which is
  weeks of ordinary use, while 10% of a $10 cap is $1, which one request can consume. Both the
  user's stated complaints are this single failure.
* Bad, because with a periodic reset it describes the wrong thing entirely: a daily cap sits
  near 100% remaining every time it refills, so the warning is either constant or useless.

### Percent of cap consumed, late thresholds

* Good, because it uses the same quantity as the chosen option — consumed share — so it is
  equally scale-free and needs no daily history.
* Bad, because it fails at the only thing a warning must do: measured on the exhausting day,
  a 75% and a 90% threshold both fired in the same hour the cap ran out, giving zero usable
  lead. A threshold the failure overtakes is not a warning.

### Runway in days at a median burn

* Good, because it is exact on a steadily used lifetime cap and expresses the answer the user
  acts on: "two days left", not "28% left".
* Bad, because a median daily burn of zero — the normal state of an intermittently used key —
  yields infinite runway and no warning ever, which was the measured behaviour of most active
  keys on the account.
* Bad, because for a resetting limit "days until empty" asks the wrong question: the cap
  refills, and the risk is running out inside the current period.

### Projected period usage

* Good, because it needs only the current period's spend and the elapsed fraction, so it
  works before any history exists.
* Good, because it is the intuitive reading of "on pace to exceed".
* Bad, because on a bursty account it produces fiction: on the measured evening it reported a
  projection of more than one and a half times the cap for a day that had not yet spent half
  of it, and the user can act on none of that. It describes a hypothetical day, while the
  useful question is how long the remaining money lasts at the current pace.
* Bad, because it is most confident exactly when it is least informed: early in a period, one
  small charge extrapolated over the remaining hours yields a large and meaningless number.

## More Information

The UI treatment — states, copy, meter, motion, and how a notice is retired — is specified in
[the design doc](../design/limit-notice.md). The limit source is
[ADR-0002](0002-read-per-key-limits-from-the-management-keys-endpoint.md).

Behaviour recorded here was observed against a live account on 2026-10-07, from hourly
analytics over a 30-day window. Exact account figures are deliberately not reproduced; the
shapes they established are the ratio between an hour's burn and a daily cap, and the count of
days that crossed each candidate threshold. OpenRouter's analytics API is in beta, and the
hourly granularity used for this measurement is not what the plugin reads at runtime; if
`limit_reset` gains new values, the branch in this decision is incomplete, not wrong.
