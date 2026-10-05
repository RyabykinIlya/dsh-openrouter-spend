# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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