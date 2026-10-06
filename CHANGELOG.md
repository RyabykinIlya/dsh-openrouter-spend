# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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