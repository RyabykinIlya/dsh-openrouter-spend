---
status: "accepted"
date: 2026-10-14
decision-makers: maintainer
consulted: none
informed: plugin users
---

# Print the pool balance without its credited total

## Context and Problem Statement

ADR-0007 replaced the balance's bare percentage with a sentence in money and
days and gave it a denominator: `{left} of {limit} left`, where `{limit}` is
`total_credits` — every dollar ever credited — read as "of what was ever
credited". The stated purpose was honesty: a percentage of a pool that refills
only by hand has no period to be a share of, so the credited total was offered
as the scale that made the number mean something.

It does not mean something to the reader. The credited total is printed on
exactly one surface in the whole plugin — that sentence — while the panel shows
two other figures beside it: the remaining balance and the lifetime spend. The
maintainer's own account (2026-10-14) rendered:

```
Account balance                                               97%
████████████████████████████████████████████████████████████░░
2712.12 ₽ of 25268.86 ₽ left · ~3 days at this rate · shared by all keys
Balance: 2712.12 ₽ · Lifetime: 22556.74 ₽
```

`25268.86` is the sum of the two figures the panel prints, and `22556.74` is
ADR-0007's other reading of the same quantity: `total_usage`. So the block
showed three numbers, one of them the sum of the other two, under a phrase —
`Lifetime` — that names spend while sitting next to `Balance`, which names
what is left. The maintainer's reading was «2712.12 ₽ of 25268.86 — неправда»:
`of {limit} left` says *of that much, this much remains*, which invites the
conclusion that 25268.86 ₽ is still available. The alarm exists to say the
opposite.

The forces at stake are legibility and actionability. A warning that names a
figure the reader cannot check — and reads as reassuring — is worse than one
that names fewer figures: the number requiring action (the balance) was
visually outranked by a number ten times larger that requires none.

## Decision

We will print the pool's sentence in money and days only, with no denominator:

* `limitSentence` takes an optional `{ pool: true }` and renders the new key
  `limitBalanceLeft` — `{left} left` / `Осталось {left}` / `剩余 {left}`. The
  credited total never reaches the sentence.
* Key caps keep `limitLeft` — `{left} of {limit} left`. A cap is a figure the
  reader set in OpenRouter and can see again; the subtraction is checkable.
* The four balance toast strings (`limitToastBalanceWarn`, `_Critical`, and
  their `NoEstimate` variants) lose `of {limit} left` the same way, and the
  `limit` argument leaves those calls. The key toast keeps its `{limit}`.
* The popover's `Balance:` line loses its ` · Lifetime: {totalUsage}` half. The
  reader asked what is left, not what has been spent, and the spend figure is
  the one that made the credited total look derivable.
* The now-unused `lifetime` dictionary key is removed from en, zh and ru.

The balance's level, its runway metric, its thresholds, its hysteresis, the
recent-pace escalation, the dot's rank and the toast's trigger are all
unchanged from ADR-0007 — this record changes rendering only.

## Alternatives Considered

- **Label the denominator instead of dropping it** — `осталось 2712.12 ₽ (из
  25268.86 ₽ пополнений)`. Rejected: it keeps a figure the reader cannot check
  anywhere else, spends a wide line on a number that requires no action, and
  fixes a misreading by adding words to it.
- **Show both figures the panel can verify** — `2712.12 ₽ осталось ·
  израсходовано 22556.74 ₽`. Rejected: it is a change of subject. The block
  exists to say how much work the pool still buys, and "spent so far" is not
  that. It would also leave `Lifetime` and the spent figure as the panel's
  headline for a pool that is running out.
- **Keep `Lifetime` and drop only the sentence's denominator** — Rejected:
  `Lifetime: 22556.74 ₽` beside `Balance: 2712.12 ₽` is the pair that invites
  summing, and it was on screen next to the sentence the maintainer doubted.

## Consequences

- Good: the block states one actionable figure, the pool's dollar value, and
  the days it buys. Nothing on the panel is a number the reader cannot derive.
- Good: `{limit}` and `{left}` keep one meaning each — the key cap keeps the
  denominator, the pool never has one — so the placeholder vocabulary stops
  being overloaded across two different kinds of cap.
- Bad: the row no longer says how far the balance has fallen in absolute
  terms. A reader cannot tell a pool at 10% of its first top-up from one at 10%
  of its twentieth. The meter's fill and the `limitBalanceHint` tooltip are what
  remain, and neither carries a figure.
- Bad: churn across the shipped string surface — a new dictionary key in three
  languages, four edited toast strings, one removed key, and the design doc's
  verbatim tables, all of which the doc-sync test compares in both directions.
- Neutral: the credited total still travels in the payload and is still what
  the meter's consumed share is computed from; it is simply never printed.

## Revisit When

If readers report that the balance sentence gives them no sense of scale — a
pool that has been topped up many times looks identical to one near its first
top-up — the fix is a labelled, checkable figure (a top-up history line), not
the unlabelled denominator this record removes.
