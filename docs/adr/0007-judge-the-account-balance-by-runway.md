---
status: "superseded by ADR-0010"
date: 2026-10-12
decision-makers: maintainer
consulted: none
informed: plugin users
---

# Judge the account balance by runway, not as information only


> **Superseded in part by [ADR-0010](0010-print-the-pool-balance-without-its-credited-total.md)**
> (2026-10-14). The runway metric, thresholds, escalation, dot rank and toast
> trigger below still hold. The **rendering** of the balance does not: the
> sentence no longer carries `total_credits` as its denominator, the toast
> strings lose `of {limit} left`, and the popover's `Balance:` line no longer
> shows `Lifetime:`. See that record for why the denominator read as
> reassurance rather than as an alarm.

## Context and Problem Statement

ADR-0001 added the limit warning for per-key caps and left the account balance
out of it on a stated reading: *the shared pool is informational rather than
alarmed*. The balance is what `/credits` reports — `total_credits − total_usage`
— the prepaid pool every key spends from, and it never refills on a schedule.

That reading failed on the maintainer's own account (2026-10-11, measured through
the plugin's own wire shapes — `/credits`, `/keys?include_disabled=true`, and
the hourly analytics window):

* The balance was **$6.58 ≈ 500 ₽** against $241 ever credited, with the recent
  closed days burning $0.20 → $0.29 → $0.80 → $1.48 → $2.98 → $5.65 → $15.17 →
  $20.64 — a median of about $2.2/day and a **last-three-day pace of about
  $13.8/day**, which is under a day of runway.
* The tracked key (`dh`, $10/day) sat at **31% consumed** — correctly below the
  40% warn threshold. A daily cap that refills is not the news.
* The chip showed nothing. The popover's balance line read `Account balance … 3%
  · shared by all keys` — a percentage **of nothing in particular** (the share
  left of everything ever credited), with no money and no time in the sentence.
  The user's reading of it was «непонятно, что это значит», which is the
  review failing, not the user.

The failure is structural: the one budget that actually stops work — the pool —
was the one budget the feature explicitly declined to judge. A per-key daily cap
at 31% is genuinely fine *when the pool behind it has a day left*; the
consumed-share branch cannot see that, because it is scoped to the cap it was
given.

## Decision Drivers

* The balance is a **lifetime cap by shape**: it only moves down (spend) and up
  by hand (top-up). ADR-0001 already has a metric for exactly that shape —
  runway in days against a median daily burn — and a reason for it: a lifetime
  percentage is not a figure a decision turns on.
* Unlimited keys spend from the same pool and carry no per-key limit at all, so
  on any account with such a key (the measured one has two), **no key metric can
  ever alarm on the pool**. The gap is not an edge case; it is the default case
  for exactly the keys most able to drain the account.
* The user's stated preference is to know **a couple of days** ahead, to top up
  in time. A median-runway metric answers that directly.
* The warning must not fire on an ordinary healthy balance — the noise cost that
  killed the alternative readings in ADR-0001 applies here unchanged.
* No new upstream request: `credits` and the hourly burn already ride the
  summary payload.

## Considered Options

* Keep the balance informational (the status quo of ADR-0001's design doc).
* Judge the balance by share of the credited total (a percentage alarm).
* Judge the balance by runway at the median daily account burn, with a
  recent-pace escalation.

## Decision Outcome

Chosen option: "runway at the median daily account burn, with a recent-pace
escalation", because it reuses the metric ADR-0001 already calibrated for the
lifetime shape, answers the question the user acts on («сколько дней осталось»),
and stays silent on a healthy balance.

Concretely (`balanceState` in `client.js`):

* **The burn is the account's, not a key's.** The hourly buckets are the union
  of every key's `burnHourly` window — unlimited keys included, because the pool
  is shared. A key with `limit: null` is precisely one that can drain it.
* **The level is runway at the median daily burn over the trailing 7-day window,
  closed UTC days only, today excluded** — same estimator, same window, same
  gate (`≥ 3` closed days before any level is computed) as the lifetime key
  branch. Warn at ≤ 3 days, critical at ≤ 1, same hysteresis in whole days.
* **The recent-pace escalation, and this is the deliberate addition over
  ADR-0001's lifetime branch:** if the **mean of the last 3 closed days** gives
  ≤ 1 day of runway, the level is `critical` regardless of the median. A ramp —
  the measured account's own $0.80 → $5.65 → $15.17 — spends the pool faster
  than the seven-day median admits, and the median would notice a week late,
  after the pool is gone. The 3-day mean is the noisiest short window worth
  trusting; it can only **escalate, never quiet** a level the median raised,
  because a quiet weekend must not talk the alarm down. No hysteresis is applied
  to this escalation: the inputs move only when a UTC day boundary crosses, so
  there is no boundary to flicker on.
* **A balance at or past zero is critical outright.** No window softens that.

Rendering consequences:

* **The dot** carries the stricter of the key and balance alarms
  (`dotState(status, level, balanceLevel)` — balance can only raise).
* **The popover block** goes to the balance when it is the stricter alarm, or
  when nothing else has a block to show. The sentence is money and days
  (`{left} of {limit} left · ~{days} at this rate · shared by all keys`), the
  meter shows the **consumed** share of the credited total — filling like the
  key meters, not counting down a bare ratio — and the block carries a tooltip
  (`limitBalanceHint`) saying what the pool is, because "3%" alone names no
  denominator.
* **A balance toast** fires on the same escalation rule as the key toast
  (`none → warn/critical`, `warn → critical`), retires on the same dismiss and
  open-popover paths, and is seen-keyed under the id `balance` with the `ever`
  anchor — only a top-up that moves the balance re-arms it. It survives a
  tracked-key switch (the pool did not change with the key) and outranks a key
  toast that fires in the same commit.

`{limit}` in the new balance copy is the **total ever credited** (`$241`), read
as "of what was ever credited", which is the honest denominator for a pool that
refills by hand; the placeholder is reused from the key toast, so no new
placeholder is added to the contract.

### Consequences

* Good, because the warning the user asked for arrives days early on exactly
  the measured shape: the account above renders `critical` on the day the chip
  used to be blue.
* Good, because unlimited keys — invisible to every per-key metric — are
  counted in the account burn, so the pool they drain is the thing that alarms.
* Good, because the old "3% left" line becomes a sentence with money, days, and
  a denominator, and its meter matches the key meters' direction.
* Bad, because the recent-pace escalation will occasionally cry critical on a
  three-day burst that the median would have survived — the accepted trade for
  noticing the ramp at all. It says "days at this pace", not "will run out".
* Bad, because the 3-day mean is the noisiest estimator in the feature. It is
  used only to escalate (never to quiet), so its noise is one-directional.
* Neutral, because `periodStartKey`/seen machinery is reused unchanged; the
  balance's period anchor is the literal `ever`.
* Neutral, because a balance alarm outranks a key alarm in the block and the
  toast, so a tracked key's own 40% warn is hidden while the pool binds. One
  number beats two; the action ("top up") does not change with the second.

### Confirmation

* `balanceState` is pure and exported from the factory seam; its cases are in
  `tests/limit-state.test.mjs`, driven the same way `limitState`'s are:
  * a balance with ≤ 1 day of median runway is `critical`, 1 < days ≤ 3 is
    `warn`, more is `none`;
  * the 3-day-mean escalation raises a median-`none` balance to `critical` on
    the measured ramp shape, and never lowers a level;
  * fewer than 3 closed days, or a zero median, yields `none` — no alarm on a
    new install;
  * a balance at zero is `critical` with no window read;
  * `dotState` with a balance level stricter than the key's takes the balance
    colour, and with both `none` keeps the data-health state;
  * the balance toast fires on `none → warn`, retires on dismiss writing
    `balance:warn:ever`, and survives a tracked-key switch;
  * the balance block renders the credited total as `{limit}` and the
    `limitShared` phrase, with the `limitBalanceHint` tooltip attached.
* The strings are pinned by the design-doc guard in both directions (the doc
  quotes them verbatim; the shipped keys must have a row).

## Revisit When

* OpenRouter ships a balance top-up timestamp: the `ever` anchor would then
  become "since the last top-up" and a dismissal would re-arm on a real
  boundary instead of only a moving balance.
* A monthly-capped key becomes measurable (see ADR-0001's own revisit): the
  account-burn union may then want the per-period branch too.
* The recent-pace escalation proves too loud in practice: the window length
  (3) and the escalate-only rule are the tuning knobs, not the median.

## Pros and Cons of the Options

### Keep the balance informational

* Good, because it adds nothing and can be wrong nowhere.
* Bad, because it is wrong where it matters: the one budget that stops work is
  the one the feature declines to judge, and the measured evening proved the
  gap is the common case, not an edge.
* Bad, because "3% left" names no denominator, and the user's own reading of it
  was confusion — a line that confuses is worse than no line.

### Judge the balance by share of the credited total

* Good, because it needs no history and works on the first poll.
* Bad, because the percentage is not a figure a decision turns on — the exact
  argument ADR-0001 made against percent-remaining, and the reading the old
  line already shipped and failed with. 3% of a lifetime total says nothing
  about how long the money lasts; $6 of $241 at $0.80/day is over a week, and at
  $13.80/day it is under a day, and the percentage is identical in both.

### Runway at the median, with a recent-pace escalation

* Good, because it is the metric ADR-0001 already calibrated for the lifetime
  shape, so thresholds carry their measured meaning over.
* Good, because the escalation catches the ramp, which is the measured failure
  mode of the median alone on a growing account.
* Bad, because a median needs history: the first two days of an install stay
  silent, and the escalation's 3-day mean inherits the same gate.
* Bad, because the escalation is one more knob, and the knob is the noisiest
  estimator in the feature (accepted: it can only escalate).

## More Information

The UI rendering — states, the balance block's anatomy, copy, and how a
balance notice is retired — is [the design doc](../design/limit-notice.md),
section "When the account balance is the binding cap". The key metrics this
builds on are [ADR-0001](0001-warn-early-on-cap-consumption.md); the wire shapes
are [ADR-0002](0002-read-per-key-limits-from-the-management-keys-endpoint.md).

Measured against a live account on 2026-10-11/12, through the plugin's own
requests. Exact account figures are reproduced here for the burn *shape* — the
ratio between recent days and the pool — because that ratio is the calibration,
not a secret to protect; the account is the maintainer's own.