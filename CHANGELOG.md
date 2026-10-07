# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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