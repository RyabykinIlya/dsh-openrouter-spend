# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-10-12

### Added

- **Account balance warning**: the prepaid balance — the pool every key spends from, unlimited keys included — is now judged like the lifetime cap it is, instead of being shown as information only. Its level is the runway it buys at the median daily account burn over the trailing week: warn at three days or less, critical at one day or less, with an escalation on the mean of the last three closed days so a ramp is caught before the median notices it a week late. A critical balance holds the chip's dot over a key whose own limit is comfortably unspent, takes the popover's block with the money, the days and the denominator — `$6.58 of $241 left · under a day at this rate · shared by all keys` — instead of the old bare `3% · shared by all keys`, and fires a toast that names the pool and the action ("top up"). The block carries a tooltip saying what the pool is, and the meter now fills with the consumed share of the credited total, matching the key meters. The balance toast is retired as seen "for ever" — only a real top-up re-arms it — and survives a tracked-key switch. See [ADR 0007](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0007-judge-the-account-balance-by-runway.md).

### Fixed

- The chip's `session/day` pair now names **one API key on both halves**: this chat's spend on a key over that same key's day. It used to divide the chat's figure by the whole account's day, so the chip read `36.44/89.93 ₽` while the popover right beside it reported the tracked key's day, `36.53 ₽` — two different scopes presented as one ratio. The pair follows the key selected in the popover, or the session's own key when no key is selected and the session used exactly one. When no single key can be named — the session split could not be read, the lineage fold failed, the resolved key has no row, or one session spans several keys — the chip shows a single figure in the same scope instead of a pair. See [ADR 0006](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0006-scope-the-chip-pair-to-one-api-key.md).
- A chat whose spend is billed entirely to a delegated subagent no longer reads `0.00` in the chip's session half. Such a session has no own row for today, so the merge gave it a zero day total; today's own figures now fill the window total for an id the window read did not mention.
- A failed session split (`sessionsError`) and a failed lineage fold (`lineageError`) are now named in the popover instead of silently costing the chip its pair. Both mean "could not read", which must never look like "spent nothing".
- The README claimed the chip's pair followed the selected range; it is, and has always been, a today figure. Corrected in all three languages.

### Changed

- The session split query carries the `api_key_id` dimension, so the host can attribute each session's spend to the key that billed it. The split travels in the payload as each row's `todayKeys`.

## [0.4.1] - 2026-10-09

### Added

- The failed-refresh state now says what went wrong and when the next automatic attempt is due. The popover shows a sentence naming the fault — unreachable network, timeout, rejected key, rate limit, server error, unexpected reply — the raw detail underneath it, a live countdown to the next attempt, and a **Retry now** button. The chip's tooltip carries the same sentence and countdown, and its accessible name says why the figures are stale. See [ADR 0005](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0005-surface-a-failed-refresh-and-its-retry-schedule.md) (the ADR log ships with the repository, not the npm package).
- The host classifies a failed refresh (`describeFailure`) into `errorCode` beside the raw `error`, so the browser names the fault in the reader's language instead of repeating `fetch failed`.
- A retry ladder: the first attempt after a failure comes 15 seconds later, the second after 30, and then the ordinary `refreshSeconds`. The host announces it as `nextRefreshAt` and the browser polls on that field, so the shorter retry is real rather than a promise a fixed interval ignores. A successful read resets the ladder.
- `GET /openrouter-spend/summary?force=1` reads past the host's cache for the popover's Retry. Concurrent callers still share one read, and a forced read is floored at two seconds so a held-down button cannot become a stream of upstream queries.

### Changed

- A reply that never arrived is a state the chip shows rather than a silent no-op. A non-OK response — for example the plugin's own route answering 502 — and a client-side network failure both surface the reason, the countdown, and the Retry button; previously the poller kept the old figures and said nothing at all.

## [0.4.0] - 2026-10-08

### Added

- Limit warning: a limit block in the popover showing what is left of a tracked key's limit, with the share consumed, an estimate of how long the remainder lasts at the current pace, and the refill moment. The block appears when a key is selected and the limit notice is enabled. See [ADR 0001](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0001-warn-early-on-cap-consumption.md), [ADR 0002](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0002-read-per-key-limits-from-the-management-keys-endpoint.md) and [ADR 0004](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0004-gate-the-limit-warning-behind-a-default-off-setting.md) (the ADR log ships with the repository, not the npm package).
- Two new chip-dot states (`limit-warn`, `limit-critical`) with a finite pulse animation that respects `prefers-reduced-motion`. The dot colour is doubled by text in the popover so colour is never the sole carrier of the level.
- A Settings switch that enables the limit warning feature. Ships off by default.
- Frame-wide toast notification on limit escalation (`none` → `warn`, `none` → `critical`, `warn` → `critical`). The toast fires only once per escalation and can be dismissed or clicked to open the popover. Opening the popover or dismissing the toast marks the escalation as seen.
- Config knobs `warnConsumedFraction`, `criticalConsumedFraction`, and `burnWindowDays` for tuning limit thresholds and the burn rate calculation window.
- The README now ships in Chinese and Russian (`README.zh.md`, `README.ru.md`) alongside the English one, with a language switcher linking the three versions at the top of each. `CONTRIBUTING.md` documents the contribution workflow and the English-only release policy, and a translation-verification script (`npm run verify-translation`) records the three READMEs' content hashes in `README.i18n.yaml` so an unnoticed edit is caught before commit.

### Changed

- The chip's `session/day` session half now covers the session's whole delegated subtree, folded in recursively. A delegated subagent runs as its own DSH session and is billed on its own analytics row, so its spend used to be invisible to the parent chat's figure; the host now attributes each session row the spend of every descendant it delegated, grandchildren included. The account-wide figures (today, 7 and 30 days, per key, per model, per day) already included descendant spend and are unchanged. See [ADR 0003](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0003-count-subagent-descendants-in-session-spend.md) (the ADR log ships with the repository, not the npm package).

## [0.3.2] - 2026-10-07

### Changed

- The composer chip screenshot in the README now shows the `session/day` pair. The file is renamed to `docs/chip2.png` (a fresh raw URL, so the GitHub CDN cannot serve the stale image) and is read from `main`, so the README updates with the branch instead of waiting for a new tag.

## [0.3.1] - 2026-10-07

### Removed

- The per-session cost table in the popover: raw session ids overflowed the panel and were unreadable. The chip's `session/day` pair is the only session surface; the per-session split still feeds it.

## [0.3.0] - 2026-10-06

### Added

- The composer chip reads `session/day` — this chat's spend today over the whole day's total (`$0.60/$1.50`, `51.00/127.50 ₽` in RUB). The session's cost comes from `analytics/query` grouped by `session_id`; requests sent without a session (`none`) are excluded.
- A per-session cost table in the popover: window totals, today's figure, and the current chat's row highlighted.
- The session split fails soft: when it cannot be read (for example past the 1000-row ceiling), the summary and the chip's day figure stay, with the reason kept in the payload.

## [0.2.0] - 2026-10-06

### Added

- Display currency in Settings: USD (default) or RUB, converted at the cbr.ru daily rate. The rate is read host-side with its own cache (`rateRefreshSeconds`), so a rate fetch never delays the spend summary.
- When cbr.ru cannot be reached, RUB falls back to USD with a visible note — "check that cbr.ru is reachable" — plus the fetch reason.
- `cbrUrl` and `rateRefreshSeconds` config fields.

### Fixed

- A negative prepaid balance prints at money precision instead of four decimals.

## [0.1.2] - 2026-10-05

### Added

- Screenshots of the composer chip and the spend popover in the README.

## [0.1.1] - 2026-10-05

### Fixed

- `credentialRef` rejects a blank reference at activation (schema pattern).
- README states the real placement of each figure (chip popover vs. Settings), the Management API key path in the OpenRouter dashboard, UTC-day semantics, and `historyDays` range coverage.

## [0.1.0] - 2026-10-05

### Added

- Spend chip under the composer with today's cost; popover with 7/30-day ranges, per-API-key filter, per-model table, daily bar chart, prepaid balance, and lifetime spend.
- Settings page: management-key storage and clear, browser-local refresh interval and per-key filter.
- `config` schema (`credentialRef`, `apiBase`, `refreshSeconds`, `historyDays`, `timeoutMs`) validated at activation.
- English, Russian, and Chinese display metadata and UI copy.