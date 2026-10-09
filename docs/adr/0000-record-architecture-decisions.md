# ADR-0000: Record architecture decisions

- Status: accepted
- Date: 2026-10-07
- Deciders: maintainer

## Context

The plugin grew from one figure under the composer into a set of decisions that are not
obvious from the code: which number triggers a warning, where a limit is read from, and why
a chip dot changes color. Two of those decisions were made against a real OpenRouter
account and depend on API behaviour that is documented unevenly and may change. Without a
written record, the next reader sees a `limitState` function that branches on `limit_reset`
and has no way to tell whether the branch is a considered choice or an accident.

## Decision

We will keep a log of architecture decisions in `docs/adr/`, one decision per file, in MADR
format for decisions with comparable alternatives and the lean Nygard style for the rest.
Empirical claims about OpenRouter behaviour record how they were observed, and anything not
observed is marked as an assumption rather than stated as fact.

## Consequences

- Good: the reasoning for the limit-warning rules survives the session in which it was
  formed, including the measurements that rejected the obvious alternatives.
- Bad: a decision touching OpenRouter's API carries a date and needs rechecking; the log can
  go stale silently if nobody revisits it.
- Neutral: the log is part of the published package repository, so the records are public.
  No account figures, key names, or credentials may appear in them.

## Revisit When

The log is more work than it saves — for instance if records start being written after the
fact as justification rather than during the decision. Check at the next major version.
