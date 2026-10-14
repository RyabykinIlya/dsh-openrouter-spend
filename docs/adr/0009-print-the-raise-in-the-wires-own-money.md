---
status: "accepted"
date: 2026-10-13
decision-makers: maintainer
consulted: none
informed: plugin users
---

# Print the raise in the wire's own money, with the display currency as an echo

## Context and Problem Statement

ADR-0008 shipped the raise with the offer button labelled through the panel's
ordinary money formatter — the one that converts USD to RUB for a reader who
chose RUB. The number it *sent* was the same figure in USD, unconverted, because
a key's `limit` is a USD quantity upstream. The label and the wire therefore
carried different numbers, and nothing said so.

The maintainer hit it within minutes of the button going live:

> 1300 это в рублях, Raise предефолт предлагает 2114.67 тоже в рублях, но
> openrouter принимает видимо в долларах

and, from the same session, the wire's own refusal of the typed figure:

> Could not raise: the new limit (1300) is past 10x the current (15); a raise
> that large is refused as a likely typo

Read against the code, both messages describe one fault. At the reader's rate
(2114.67 ÷ 15 ≈ 140.98 ₽/$):

* the offer button printed **2114.67 ₽** and posted **15** — the same money, two
  numbers, neither labelled with its unit;
* the custom field's placeholder printed **1409.80 ₽** (`over {limit}`, formatted
  with the same converter) and treated what was typed as **USD**. So `1300` read
  as a value *below* the cap the placeholder had just shown, while the route
  received **$1300** — 87× the cap, and past the `10×` typo guard, which is the
  refusal quoted above.

The failure mode is not arithmetic. The offer was correct and the guard did its
job. The fault is the **conversion boundary**: a figure that is about to be sent
was rendered through a converter that belongs to figures that were *read*. Every
number a write submits must be legible as the number the account will hold.

This matters beyond one button. `limit`, and every guard around it — raise-only,
the `10×` ceiling, the dimes floor — are USD by contract. Any future write
surface (lowering a cap, disabling a key) inherits the same rule, so the boundary
is worth fixing once and stating.

## Decision Drivers

* **What is sent must be what is shown.** A label that promises one number and
  posts another is a lie the reader cannot detect, and here it produced a
  refusal the reader could not explain.
* **A write must not depend on an auxiliary read.** The RUB rate comes from
  cbr.ru on its own clock and can be missing; the panel already falls back to USD
  presentation and says why. An action whose *value* depends on that rate would
  change meaning — or become impossible — when the rate is down.
* **The account's unit is not the reader's unit.** The limit is a USD setting;
  the spend is the reader's money. Both readings are legitimate, of different
  things.
* **The reader still has to judge the size.** "Is $15 a lot?" is answered in the
  currency the reader thinks in, so dropping the display currency entirely costs
  something real.
* **Rounding must not create phantom raises.** A limit is carried in units of
  $0.10 upstream. A reader-currency input has to be rounded back to that grid,
  and a round trip that lands on the current cap would be refused as "not a
  raise" while the typed figure looked larger.

## Considered Options

* Print the raise in USD only, and send USD (the corrected status quo).
* Print the raise in the display currency and convert to USD on send.
* Print the raise in USD with the display-currency equivalent beside it, as an
  echo that disappears when no rate is available.

## Decision Outcome

Chosen option: "print the raise in USD with the display-currency equivalent as an
echo", because it is the only option where the number on the button and the
number on the wire are the same number, while the reader still sees the size in
their own money.

Concretely:

* **`makeMoney` grows `fmtUsd`** — `fmtMoney(value, 'USD')`, the display currency
  bypassed. It is the only formatter a write path may use, and the one the raise
  row's offer, the field's placeholder, the field's refusal reason and the
  toast's button all go through.
* **The offer carries the echo** through one new dictionary key,
  `raiseToRub`: `Raise to {amount} · ≈ {rub}`. `{amount}` is the USD figure that
  will be sent; `{rub}` is the same money at the rate the sentence above is
  already using. `raiseTo` stays as the no-rate form, so the echo is additive
  rather than a second copy of the sentence.
* **The echo is a read-only decoration.** It is rendered only when the panel has
  a rate (`money.rub`), it is never parsed back, and it never reaches the route.
  With cbr.ru down the panel falls back to USD and the label degrades to exactly
  the USD-only wording — no third state, no missing figure, nothing to explain.
* **The custom field stays USD, and says so.** Its label is already
  `Custom limit, USD` and its placeholder names the cap in dollars
  (`over $12.00`). The field is where the maintainer's mistake happened, and the
  fix is to make its unit unmistakable rather than to accept either unit: a field
  that guesses its unit is the bug, not the cure.
* **Nothing that is sent is rounded for display.** The dimes grid is applied once,
  to the value the reader typed or the offer computed, before it is shown and
  before it is posted — never as a display-time rounding that could disagree with
  the wire.

### Consequences

* Good, because the label is now a promise the wire keeps: `$15.00` is sent as
  `15`, whatever the panel is displaying.
* Good, because the reader keeps the size in their own terms: `≈ 2114.67 ₽` is
  answered by the same rate as the sentence above, so the two cannot drift.
* Good, because a missing rate costs the echo and nothing else — the row is fully
  functional with no rate at all, which is what "a write must not depend on an
  auxiliary read" means in practice.
* Bad, because the panel now mixes currencies on one line by design: the spend
  sentence says `₽` and the button beside it says `$`. That is honest — two
  different quantities — but it is a reading a first-time user has to accept, and
  the echo is what makes it acceptable rather than confusing.
* Bad, because an echo is one more string in three languages, and one more row
  the design doc has to quote verbatim. The doc guard's `^(limit|period|raise)`
  filter already requires it, so a forgotten translation fails `npm test` rather
  than shipping as English.
* Neutral, because the typed figure is still rounded to dimes: a reader who types
  `15.04` gets `15.0`, and that was already true before this record.
* Neutral, because a reader who prefers RUB will now read two units on the raise
  row. The alternative — converting their input — is rejected below, not
  overlooked.

### Confirmation

`tests/key-limit.test.mjs` drives the label rule directly: with a rate the offer
names both the dollars that will be sent and their ruble equivalent, without a
rate it names dollars alone, and in USD display it is the plain form. The
placeholder sets are pinned per language as for every other shipped string.

`tests/limit-state.test.mjs` renders the popover with `ors.currency = RUB` and the
same rate the sentence uses, and asserts that the offer button shows the **USD**
figure while the quota sentence beside it shows rubles — the two-currency row this
record chose, checked as a rendered outcome rather than as a helper's return.

The fix was **mutation-verified**: reverting `fmtUsd` to the converting formatter
at the offer site turns the rendered assertion red, confirming the test fails on
exactly the shipped bug rather than on a cosmetic difference.

## Revisit When

* OpenRouter accounts in a currency other than USD, or exposes a per-key limit in
  the account's own currency. The wire's unit is the whole basis of this record,
  so that change reopens it rather than amending it.
* A reader asks to *type* in the display currency. Doing that safely needs the
  reverse conversion, the dimes rounding and the boundary refusals worked
  through — the problems in the rejected option below, not a formatting change.
* A second write surface appears (lowering a cap, disabling a key). It must take
  `fmtUsd` for its submitted figures; the rule is stated here so it is inherited
  rather than rediscovered.

## Pros and Cons of the Options

### Print and send USD only

* Good, because it is the smallest possible rule: one formatter, one unit, no
  translation to add.
* Good, because it is what the code does today, and it is strictly correct.
* Bad, because it drops the reader's own reading of the size: `$15` beside
  `осталось 400 ₽` has to be converted in the head, and the whole point of the
  warning is a quick decision.

### Print the display currency, convert on send

* Good, because the row reads in one unit, matching the panel around it.
* Bad, because the write's value would depend on the rate read: with cbr.ru down
  the action would silently change meaning, and the panel already drops the
  conversion in exactly that case, so this option degrades into the previous one
  anyway.
* Bad, because it cannot round-trip. A limit lives on a $0.10 grid; a ruble input
  has to be rounded back to it, so the typed figure and the stored figure differ,
  and a value a hair above the cap can round onto the cap and be refused as "not
  a raise" — a refusal the reader cannot see coming, which is the class of
  confusion this record exists to remove.
* Bad, because it makes a budget setting move with the exchange rate: the same
  typed number would buy a different amount of spend next month.

### USD with a display-currency echo

* Good, because the sent number and the shown number are the same, which is the
  property the shipped bug broke.
* Good, because the size is still readable in the reader's own money, from the
  same rate the sentence above uses.
* Good, because it degrades cleanly: no rate means no echo, and the row is
  otherwise unchanged.
* Bad, because it puts two units on one line, and because the echo is a string to
  translate and to document.

## More Information

The raise itself — the route, the guards, the offer rule, the custom field and
the two surfaces — is [ADR-0008](0008-raise-a-key-limit-from-the-popover.md);
this record fixes the unit of the figures that decision submits, and refines it
rather than superseding it. The display currency and its cbr.ru fallback are the
panel's existing behaviour, described in [the design
doc](../design/limit-notice.md), section "Raising the limit".

The reader's own figures are quoted above as the reproduction: `2114.67 ₽` for a
`$15` offer at their rate, and the `1300` that the `10×` guard refused. Both come
from the session that reported the fault, not from a measurement invented here.
