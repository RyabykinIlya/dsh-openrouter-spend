# ADR-0004: Ship the limit warning behind a setting that defaults to off

- Status: accepted
- Date: 2026-10-07
- Deciders: maintainer

## Context

The limit warning adds a chip state that can pulse, a block in the popover, and optionally a
toast. Its trigger threshold (ADR-0001) is calibrated on a single bursting day from one
account: 40% of a daily cap, resting on one observation, with the margin over ordinary work
described in that record as thin. A threshold that is wrong in the noisy direction produces
repeated warnings on ordinary days, and a warning that fires constantly is worse than none —
it teaches the user to ignore the dot entirely, including when it is right.

The maintainer is also the first user, and wants to run the feature against real work before
anyone else meets it.

## Decision

We will ship the limit warning behind a setting (`ors.limitNotice`) that is **off by default**.

* It is a browser-local viewing preference stored beside `ors.keyId`, `ors.intervalSeconds`,
  and `ors.currency`, and toggled in the existing Settings section.
* Off means: no limit states are derived, the chip dot keeps its current behaviour exactly, and
  no limit block, toast, or pulse is rendered. The feature is invisible, not merely muted.
* The host half still fetches `/keys` and includes the limits in the payload when the setting
  is off. The fetch is one cached request shared by every tab, and gating it per-browser would
  make one tab's request count depend on another tab's preference. The gate is presentation
  only.
* Default-off is a rollout position, not a permanent one. Flipping the default to on is a
  one-line change once the threshold has been observed on more than one exhausting day.

## Alternatives Considered

- **Default on** — rejected for now: it puts an unproven threshold in front of every user, and
  the failure mode of a noisy alarm is losing the signal permanently rather than annoying once.
- **No setting at all, on by default, tuned before release** — rejected because the tuning data
  does not exist yet; it requires exhausting days the account has not produced.
- **An environment or host-level flag instead of a user setting** — rejected as the wrong
  audience: the person who wants to trial it is the same person at the same install, and a
  host flag cannot be flipped while working.

## Consequences

- Good: the threshold gets exercised against real spend with no blast radius, which is the only
  way it stops resting on one observation.
- Good: shipping behind an off switch means the feature, the ADRs, and the UI can be reviewed
  and merged in one change without waiting for calibration.
- Bad: default-off means the feature is effectively undiscoverable — most users never open
  Settings, so the warning reaches nobody until the default flips. This is the intended cost
  and the reason to flip it deliberately rather than never.
- Bad: two code paths persist, an off path that is exercised constantly and an on path that is
  exercised by whoever enables it; a regression in the on path can go unnoticed until the
  default change.
- Neutral: the `/keys` fetch runs whether or not the feature is visible, so a deployment
  without a management key still logs the same 403-shaped warning as it would with the feature
  enabled.

## Revisit When

The threshold has been observed crossing on more than one exhausting day, and no warning was
reported as spurious on an ordinary day. At that point flip the default and delete this
record's premise, leaving the setting in place for users who want to silence it individually.
