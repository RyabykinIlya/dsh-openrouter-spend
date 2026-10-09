# Design: limit notice

How the plugin tells a user their cap is about to stop work. The *why* — which metric
triggers, and where the limit is read from — is [ADR-0001](../adr/0001-warn-early-on-cap-consumption.md)
and [ADR-0002](../adr/0002-read-per-key-limits-from-the-management-keys-endpoint.md).
This document is the workings: states, thresholds, copy, motion, and how a notice is retired.

Rendered mockup: [`docs/mockups/limit-notice.html`](../mockups/limit-notice.html) and its
[PNG](../mockups/limit-notice.png). Both carry the same synthetic figures and copy as this
document; where they disagree, this document wins.

## What exists today

The chip's dot means data health and nothing else (`client.js`):

| `data-state` | Color | Meaning |
|---|---|---|
| `ok` | business blue | figures are fresh |
| `loading` | grey | first reply has not arrived |
| `stale` | amber | refresh failed; last good figures shown |
| `error`, `no-credential` | red | request failed, or no management key |

The blue dot therefore does not mean "all good" in a spending sense — only that the numbers
are current. This design adds two states beside them rather than overloading `ok`.

## States

Two new `data-state` values, both reused by the dot and by the popover block:

| Level | `data-state` | Dot | Meaning |
|---|---|---|---|
| warn | `limit-warn` | amber | periodic: 40% or more consumed, and the reset does not arrive first. Lifetime: ≤ 3 days of runway |
| critical | `limit-critical` | red | periodic: 80% or more consumed, and the reset does not arrive first. Lifetime: ≤ 1 day of runway |

The percent consumed sets a **candidate** level; an imminent reset can only demote it, never
promote. That is why 90% consumed with the reset inside the hour is `warn` and not `critical`
— the two conditions are not alternatives, they are an escalation and a veto.

`none` is a level, not a state: when there is no limit, no management key, or not enough
history, the dot keeps its existing `ok`, and no block is rendered. **The absence of a limit
is not a healthy limit**; nothing is shown because nothing is known.

Precedence, when two apply: `error` and `no-credential` outrank the limit states (a broken
reading is worse news than a full budget), and a limit state outranks `stale` — stale figures
with a nearly-exhausted cap still need to say so.

## Thresholds

Per ADR-0001, the branch is chosen by `limit_reset`:

| `limit_reset` | Metric | warn | critical |
|---|---|---|---|
| `null` (lifetime) | runway: `remaining ÷ median daily spend` | ≤ 3 days | ≤ 1 day |
| `daily` / `weekly` / `monthly` | share of the cap consumed this period: `used ÷ limit` | ≥ 40% | ≥ 80% |

Both branches report the runway at the **recent peak hourly burn** as the actionable figure:
`remaining ÷ max hourly spend`, where the window is **7 trailing days, excluding the current
hour**. A consumed share says where the user is; that quotient says how long the money lasts
if the current pace repeats.

The maximum is deliberately the noisiest estimator available, and that is a tension with the
median the lifetime branch uses for its daily rate. It is kept because the two answer different
questions: the median daily rate estimates the *typical* pace, while this figure answers "how
fast can the remainder go", where the worst recent hour is the relevant bound. The cost is a
tendency to overstate the urgency on a key whose single heavy hour was an outlier — accepted
here, and the reason this number is shown as rounded text rather than as the level itself.

**Time to reset moderates escalation.** A cap that refills within the hour is not an
emergency even at 80% consumed, so the state stays `warn` when the reset lands before the
projected exhaustion. For a `daily` cap the boundary is **UTC midnight — 03:00 MSK**; see
"Reset boundary" below.

Hysteresis: entering `warn` at 40% means leaving it at 38%, not at 39.999% — a margin of **2
percentage points of the cap**, which is 5% of the 40% threshold. Without it, a key spending
steadily sits on the boundary and flickers the dot on every poll. The lifetime branch needs
the same margin in its own units, and needs it more: a median runway moves in whole days, so
`warn` entered at 3 days is left at 4, and `critical` entered at 1 day is left at 1.5.

The earlier draft of this design carried an absolute floor — no escalation while more than
~10 requests of headroom remained. **It is removed from the periodic branch**, because on the
measured key, where a request costs about a thousandth of a dollar, it suppressed the warning
on the very evening the cap was exhausted. The early thresholds are what keep the signal
quiet; a request floor is not.

### Reset boundary

`limit_reset: daily` means the **UTC** calendar day, so the cap refills at 03:00 MSK during
Moscow summer time. This is measured, not documented: `/keys` reports `usage_daily` per key,
and it matched the sum of that key's hourly analytics over the UTC day to within the lag
between the two calls, while a rolling 24-hour window would not have matched. Neither `/keys`
nor `/credits` exposes a timezone or a reset timestamp.

Consequences for the copy: "resets at midnight" is wrong for a Moscow user and reads worst
just after local midnight, when the cap is still spent but the label claims it has refilled.
The block states the boundary in local time instead.


## Popover block

One block, placed directly under the balance line and above the range switcher — the
existing order is figure, requests, balance, range, key row, model table. The block sits
between balance and range because it is a fact about the same money the balance is.

```
API key limit · build-bot                                        40%
████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
$4.10 of $10 used today · resets 03:00 · ~2 h left at this rate
```

Anatomy:

* **Label** — `API key limit` plus the key's name, tinted with the existing per-key
  `keyTint` color so it matches the key row below.
* **Percentage** — the share of the cap consumed, right-aligned, tabular figures. It is the
  summary; the sentence underneath carries the actionable part.
* **Meter** — a 5px track, the fill in the level's color. It shows *consumed*, so the bar
  fills as the cap approaches. It was previously drawn as remaining; consumed is the honest
  reading once the trigger is a consumed share, and it matches the percentage beside it.
* **Sentence** — the branch-specific line, described below.

The percentage stays secondary on purpose. "40%" does not tell a user what to do; "~2 h left
at this rate" does.

### Sentence per branch

Lifetime (`limit_reset: null`) — remaining, requests, and days:

| Level | Sentence |
|---|---|
| ok | `$6.40 of $25 left · ≈ 320 requests · ~8 days at this rate` |
| warn | `$2.40 of $25 left · ~3 days at this rate` |
| critical | `$0.80 of $25 left · under a day at this rate` |

The lifetime rows assume a rate of **$0.80/day**, which is what makes the three land where they
do: 6.40 ÷ 0.80 = 8 days, 2.40 ÷ 0.80 = 3 days (exactly the `warn` threshold), 0.80 ÷ 0.80 = 1
day (exactly the `critical` threshold). The rate was not stated at first, and a `$2.50` figure
sat in the `warn` row — 3.125 days, which is *above* the 3-day threshold, so it renders `none`.
The row contradicted the rule beside it and could not be checked without the rate.

The request count is dropped at warn and critical: past the threshold the user needs the time
estimate, and the count competes with it for the one line available.

Periodic (`daily` / `weekly` / `monthly`) — the cap refills, so the line speaks about the
current period, its reset, and how long the remainder lasts at the current pace. The remaining
money is always stated: it is what the user asked for, and the consumed share alone never
answers "how much is left":

| Level | Sentence |
|---|---|
| ok | `$7.90 of $12 left · resets 03:00` |
| warn | `$7.20 of $12 left · 40% used · resets 03:00 · ~2 h at this rate` |
| critical | `$2.40 of $12 left · 80% used · ~25 min at this rate` |
| warn, reset imminent | `$1.20 of $12 left · 90% used · resets in 20 min` |

The last row is the moderation rule: at 90% consumed with the reset inside the hour, the state
stays `warn` and the sentence names the reset instead of an alarm, because waiting is the
correct action.

When the lifetime branch drops the request count past a threshold, the periodic branch keeps
the money: it is the one figure that is true in both readings — remaining, not consumed — so
it survives every level.

`today` is the period word: `this week` for `weekly`, `this month` for `monthly`. The reset
time is rendered in the browser's local zone from the known UTC-midnight boundary — `03:00`
for Moscow — never as "midnight", which would be wrong for most of the world and worst for
this user specifically.

There is deliberately **no "on pace to use $X" projection**. On the measured evening that
reading announced more than one and a half times the cap for a day that had not yet spent
half of it — a hypothetical the user cannot act on, and most confident exactly when it is
least informed. The consumed share plus the runway at peak rate says the same thing without
inventing a forecast.

### When the account balance is the binding cap

`headroom = min(key limit_remaining, account balance)` per ADR-0002. When the balance is
smaller, the block says so, because "the key has $5 left" is misleading when the shared pool
is nearly gone:

```
Account balance                                          88%
██████████████████████████████████████████████████████████████
$1.68 of $14.00 left · shared by all keys
```

The label changes to `Account balance`, the meter shows the balance against the account's
total, and the sentence names the shared-pool fact rather than a reset. The key limit, when
present, is not shown in this state — one number beats two when the user needs to act.

### With "All keys" selected

`ors.keyId` empty means the user is not tracking one key, so there is no single key limit.
The block then shows the account balance line above, and adds the tightest keyed limit only
when that is closer than the balance:

```
API key limit · batch-key                                 47%
▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
$6.40 of $25 left · the tightest limited key
```

*This is a design choice, not a constraint from the ADRs* — the alternative is to show
nothing when no single key is selected, on the grounds that "the tightest key" is not a
concept the user asked for. Flagged here as the decision most likely to want reversing.

### Nothing to show

The block is absent — not zeroed — when any of these holds, and the dot stays `ok`:

* no management key (`no-credential` already replaces the chip),
* the tracked key has `limit: null` and the account balance is healthy,
* fewer than 3 complete days of history for a lifetime cap (no median to divide by).

The third case is the common one on a new install. Absence is the correct rendering: an empty
meter reading "0%" would claim a budget that does not exist.

### When the key cannot be matched

`GET /keys` is joined to the analytics rows by name (ADR-0002). A key renamed in the
OpenRouter dashboard, or two keys sharing a name, breaks that join for the affected key.

This case is **not** silent, because silence is indistinguishable from health: with no limit
block and a blue dot, the user reads a missing limit as a healthy one — the exact mistake the
level table warns against. The block therefore renders with what is known and names the gap:

```
API key limit · build-bot                                        —
                                                          ────────
Limit unknown: this key's name did not match the account's key list.
```

The meter is drawn empty and greyed rather than filled, the percentage is `—` instead of a
number, and the sentence is the `limitUnavailable` string. No limit state is derived, so the
dot stays `ok` — but the popover no longer implies that everything is fine.

## Chip

The chip text does not change. It carries the session/day pair and the dot; adding a second
number would crowd the dock and duplicate the popover. The dot is the entire at-a-glance
signal, which is why it may blink — briefly — and why the popover must not.

### Motion

Blinking is rationed. A dot that always blinks is wallpaper, and a notice that repeats every
poll is ignored within a day.

```css
@media (prefers-reduced-motion: no-preference) {
  .ors-chip-dot[data-state="limit-critical"] { animation: ors-pulse 1.6s ease-in-out 3; }
  .ors-chip-dot[data-state="limit-warn"]     { animation: ors-pulse 1.6s ease-in-out 2; }
}
@keyframes ors-pulse { 50% { opacity: .25; } }
```

Rules:

* **Finite, by iteration count** — 3 pulses for critical, 2 for warn, then the level color
  stays. The dot never pulses indefinitely: an alarm that never stops is not an alarm.
* **Suppressed under `prefers-reduced-motion`** — the level color alone still carries the
  state, so nothing is lost for a user who has asked for less motion.
* **Colour is never the only carrier.** The popover states the level in words, the dot has
  an `aria-label`, and the chip's `title` mentions the level. This matters for the same
  reason as reduced motion: the signal must survive being unseeable.

### Retirement — "seen"

Opening the popover retires the current notice. Concretely, the pill writes
`ors.seenLimit` = `` `${keyId}:${level}:${periodStart}` `` on open, where `periodStart` is the
current day for `daily`, the ISO week for `weekly`, the month for `monthly`, and the literal
`ever` for a lifetime cap.

The pulse then runs only when the current key is at or above the level it has not been seen
at *for this period*. Consequences:

* A key parked at 2 days of runway stops announcing itself after the first look, and the dot
  keeps its amber color.
* The next period re-arms it: a daily cap exhausted yesterday warns again today, which is
  correct because the budget is genuinely new.
* A lifetime cap that is seen once stays quiet, which is the intended trade — the user knows.
* An escalation from warn to critical re-notifies regardless, because the level is part of
  the key.

Stored in `localStorage` beside the existing viewing preferences (`ors.keyId`,
`ors.intervalSeconds`, `ors.currency`), and read-only in private mode like them.

### The feature ships off

The whole limit notice — dot states, block, toast — sits behind a browser-local preference
(`ors.limitNotice`) that defaults to **off** (ADR-0004). Off means the dot behaves exactly as it
does today and no block is rendered: the feature is invisible, not muted. The setting lives in
the existing Settings section beside the currency and refresh controls.

Consequence for the rest of this document: every rendering rule below is conditional on the
preference being on. The `/keys` fetch is not — it runs regardless, because the summary is
cached host-side and shared by every tab, so one tab's request count must not depend on another
tab's preference.

## Copy and locale

The three UI languages are registered inline in `client.js` through
`ctx.locale.register(NS, { en, zh, ru })`. The `locale/*.json` files carry only the plugin
listing's `meta.title` and `meta.description` and are not touched by this feature.

New keys, with the form the Russian and Chinese blocks should take:

| Key | en | ru | zh |
|---|---|---|---|
| `limitKey` | `API key limit` | `Лимит ключа` | `密钥限额` |
| `limitBalance` | `Account balance` | `Баланс аккаунта` | `账户余额` |
| `limitLeft` | `{left} of {limit} left` | `Осталось {left} из {limit}` | `剩余 {left}，共 {limit}` |
| `limitUsedPeriod` | `{used} of {limit} used {period}` | `Израсходовано {used} из {limit} {period}` | `{period}已用 {used}/{limit}` |
| `limitConsumed` | `{percent}% of {period}'s {limit} used` | `Израсходовано {percent}% лимита {limit} {period}` | `{period}已用 {percent}%/{limit}` |
| `periodToday` | `today` | `сегодня` | `今天` |
| `periodWeek` | `this week` | `на этой неделе` | `本周` |
| `periodMonth` | `this month` | `в этом месяце` | `本月` |
| `limitResets` | `resets {when}` | `сброс {when}` | `{when}重置` |
| `limitResetsIn` | `resets in {minutes} min` | `сброс через {minutes} мин` | `{minutes} 分钟后重置` |
| `limitLeftAtRate` | `~{duration} left at this rate` | `~{duration} при таком темпе` | `按此速度约剩 {duration}` |
| `limitApproxRequests` | `≈ {count} requests` | `≈ {count} запросов` | `约 {count} 个请求` |
| `limitDaysAtRate` | `~{days} days at this rate` | `~{days} дней при таком темпе` | `按此速度约 {days} 天` |
| `limitUnderADay` | `under a day at this rate` | `меньше суток при таком темпе` | `按此速度不足一天` |
| `limitShared` | `shared by all keys` | `общий для всех ключей` | `所有密钥共用` |
| `limitTightest` | `the tightest of {count} limited keys` | `самый жёсткий из {count} ключей с лимитом` | `{count} 个限额密钥中最紧的` |
| `limitUnavailable` | `Key limits unavailable: {reason}` | `Лимиты ключей недоступны: {reason}` | `无法获取密钥限额：{reason}` |
| `limitUnknownMatch` | `Limit unknown: this key's name did not match the account's key list.` | `Лимит неизвестен: имя ключа не совпало со списком ключей аккаунта.` | `限额未知：该密钥名称未匹配到账户密钥列表。` |

`{when}` in `limitResets` is a **rendered local time** (`03:00`), formatted at render, not a
translated word — there is no `resets at midnight` string, because the boundary is UTC
midnight and only local rendering tells the truth for the reader's zone.

`{duration}` in `limitLeftAtRate` is a rendered duration (`2 h`, `25 min`), likewise
formatted rather than translated.

There is no `limitPace` key. An earlier draft had one for the period-end projection; the
projection was rejected in ADR-0001, so the key goes with it.

Pluralization: `limitApproxRequests` and `limitDaysAtRate` need Russian genitive plurals
(`1 запрос` / `2 запроса` / `5 запросов`). The locale layer exposes no plural helper — its
dictionary is a flat `Record<string, string>` with `{name}` substitution only — so an earlier
draft of this design specified the fallback of dropping the count from the primary sentence
rather than shipping "1 запросов". **That fallback is no longer taken**: the form is now
selected in code, because `Intl.PluralRules` is available in every target and a pure selector
is testable without touching the locale layer.

The convention that follows, for any future counted string:

* the **base key is the fallback form** and stays present in all three languages, so an
  unknown locale or a category with no dedicated key still renders a real sentence;
* a language that needs more than one form **adds suffixed keys** — `_zero`, `_one`, `_two`,
  `_few`, `_many`, `_other` — matching the CLDR categories `Intl.PluralRules` returns for
  that language (for Russian: `one` for 1 and 21, `few` for 2–4 and 22–24, `many` for 0 and
  5–20, and `many` doubles as the fallback);
* Chinese needs no suffixed keys at all: it has only the `other` category;
* since `t` returns the key itself on a miss, the selector probes the suffixed key first and
  falls back to the base key when the probe returns its own name.

Rounding: money uses the existing `fmtMoney` precision rules; request counts are rounded to
one significant figure for the approximation (`≈ 140 requests`, not `≈ 138 requests`), and the
consumed percentage is rounded to a whole number so that `40%` reads as the threshold it is.

## The optional toast

Beyond the chip and popover, a level change may raise a frame-wide toast. It is a separate
delivery surface with its own cost, so it is specified but not required by this design.

* **Seat** — a fresh entry in `shell.overlay` (declared by `@deepseek-ai/dsh-client-ui-layout`,
  which ships inside the harness web bundle; no npm dependency is added). The plugin's
  `dsh.client.inject` gains `@deepseek-ai/dsh-client-ui-layout` alongside the two entries it
  already lists.
* **Not** `shell.quota-notice`: that chain routes Chat's own quota-failure codes and offers no
  way for a plugin to push a notice into it.
* **Fires** only on an escalation that has not been seen — `none` → `warn`, `none` →
  `critical`, or `warn` → `critical`. Not on every poll, and not on de-escalation.
* **Copy** — one sentence naming the key, the level, and the action, in the same terms as the
  popover so the two never disagree:
  `Key "build-bot" is at 80% of today's $12 limit — ~25 min left at this rate.` It opens the
  popover on click and retires on dismiss.
* **At most one live notice**; a newer escalation replaces the previous, and the existing
  click-through behaviour of `shell.overlay` means the toast never blocks the composer.

## Accessibility summary

* Dot: `role="img"` with an `aria-label` naming the level, not just a color.
* The chip's `title` includes the level so a tooltip conveys it without opening the popover.
* The popover block's percentage carries the level in text (`28% · warning`), so the meter is
  not the only carrier.
* Escalation announces through an `aria-live="polite"` region; the toast, when present, is
  already an alert.
* Motion respects `prefers-reduced-motion`, and every animated signal has a static colour
  and a text equivalent.

## What this design does not do

* No automatic mitigation — the plugin does not switch keys, disable one, or raise a limit.
  It reports.
* No history of limit changes; only the current value from the last poll.
* No forecast across keys — each key is judged on its own series.
* No per-model limit awareness; OpenRouter's limits are per key.
