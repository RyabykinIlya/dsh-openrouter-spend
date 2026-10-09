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

## Conventions

- One file per decision: `NNNN-kebab-case-title.md`.
- Numbers are never reused; accepted records are immutable — to change a decision, write a
  new record that supersedes the old one and flip the old one's status. Never delete.
- Status keywords stay in English (`proposed`, `accepted`, `superseded by ADR-NNNN`) so they
  stay greppable.
- Records are written in English, matching the README and CHANGELOG.
