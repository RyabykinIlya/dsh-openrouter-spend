# Architecture Decision Records

Why `dsh-openrouter-spend` is built the way it is: the decisions behind the limit
warning, what was rejected, and when to revisit. Each record is short — the reasoning
lives here, the UI detail lives in [the design doc](../design/limit-notice.md).

| # | Title | Status | Date |
|---|-------|--------|------|
| 0000 | Record architecture decisions | accepted | 2026-10-07 |
| 0001 | Warn early on cap consumption, not on percent of limit remaining | accepted | 2026-10-07 |
| 0002 | Read per-key limits from the management `/keys` endpoint | accepted | 2026-10-07 |
| 0003 | Count a session's subagent descendants in the session spend figure | accepted | 2026-10-07 |
| 0004 | Ship the limit warning behind a setting that defaults to off | accepted | 2026-10-07 |
| 0005 | Surface a failed refresh and the schedule of the next attempt | accepted | 2026-10-09 |
| 0006 | Scope the chip's session/day pair to one API key | accepted | 2026-10-11 |
| 0007 | Judge the account balance by runway, not as information only | accepted | 2026-10-12 |

## Conventions

- One file per decision: `NNNN-kebab-case-title.md`.
- Numbers are never reused; accepted records are immutable — to change a decision, write a
  new record that supersedes the old one and flip the old one's status. Never delete.
- One exception, while the package is pre-1.0: a decision that has never shipped in a tagged
  release may be amended in place with a dated amendment section recording what was withdrawn
  and why (ADR-0001's 2026-10-09 amendment withdrawing the pre-cap floor is the precedent).
  Once a tagged release carries the decision, supersede instead.
- Status keywords stay in English (`proposed`, `accepted`, `superseded by ADR-NNNN`) so they
  stay greppable.
- Records are written in English, matching the README and CHANGELOG.
