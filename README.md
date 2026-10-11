<p align="center">
  <img src="icon.svg" width="88" alt="OpenRouter spend icon">
</p>

<h1 align="center">dsh-openrouter-spend</h1>

<p align="center">
  OpenRouter spend inside
  <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> —
  billed USD from OpenRouter's own analytics API, not token estimates priced from a local table.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-openrouter-spend"><img src="https://img.shields.io/npm/v/dsh-openrouter-spend?style=flat-square" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/dsh-openrouter-spend?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-2f6feb?style=flat-square" alt="DeepSeek Harness plugin">
</p>

<p align="center">
  English | <a href="README.zh.md">中文</a> | <a href="README.ru.md">Русский</a>
</p>

## What you get

<p align="center">
  <img src="https://raw.githubusercontent.com/RyabykinIlya/dsh-openrouter-spend/main/docs/chip2.png" width="640" alt="Spend chip under the composer"><br>
  <sub>The chip under the composer: this chat's spend over the day's total, next to the session's token and context stats.</sub>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/RyabykinIlya/dsh-openrouter-spend/main/docs/popover.png" width="340" alt="Spend popover"><br>
  <sub>The popover: range and API-key filters, today's spend per model, daily bars, prepaid balance and lifetime spend. The screenshot predates the limit block and the failed-refresh state added in 0.4.0 — the [limit-notice mockup](docs/mockups/limit-notice.html) shows how those look.</sub>
</p>

- **Chip under the composer** — `session/day`: what this chat spent today on one API key over that same key's spend today, following the selected key. Both figures name one key (see [ADR 0006](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0006-scope-the-chip-pair-to-one-api-key.md)).
- **Chip popover** — range and API-key filters, today's spend per model, a daily bar chart across the window, prepaid balance and lifetime spend.
- **Settings → OpenRouter spend** — store or clear the management key, pick the display currency (USD, or RUB at the cbr.ru rate), set the refresh interval, filter by API key.
- **Limit warning** — off by default. Turn it on in Settings and the popover shows how much of the tracked key's limit is left: the share consumed, how long the remainder lasts at the current pace, and when the cap refills. The chip's dot turns amber and then red as the cap approaches, and a toast fires once when the level escalates.

The host half caches the summary for `refreshSeconds` and coalesces concurrent refreshes, so any number of open tabs cost one OpenRouter query per refresh window. When a refresh fails, the last good figures stay on screen and the reason is shown instead of an empty panel: the popover names the fault, counts down to the next automatic attempt (15 seconds after the first failure, then 30, then the ordinary interval), and offers **Retry now** to read again immediately.

## Requirements

- DeepSeek Harness web profile. The plugin needs the `credentials`, `webServer`, and `connection` services and stays inactive in profiles without them (for example, headless).
- An OpenRouter **Management API key** — OpenRouter dashboard → Settings → Management API Keys → Create New Key ([OpenRouter docs](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)). A regular inference key is rejected: `403 Only management keys can perform this operation`.

## Install

From npm (`web` is the default web-GUI profile; use your own profile name instead if you run one):

```sh
dsh plugin --profile web add dsh-openrouter-spend
```

From GitHub (plain JavaScript, no build step and no build-script permission):

```sh
dsh plugin --profile web add github:RyabykinIlya/dsh-openrouter-spend#v0.4.1
```

Then open Settings → OpenRouter spend and paste the management key.

## Configuration

Every field can be overridden in the profile's `cordis.patch.yml` row; the schema validates the row at activation and names the offending field.

| Field | Default | Bounds | Meaning |
| --- | --- | --- | --- |
| `credentialRef` | `OPENROUTER_MGMT_API_KEY` | non-empty string | Credentials reference holding the management key |
| `apiBase` | `https://openrouter.ai/api/v1` | `https://` URL | OpenRouter REST API root |
| `refreshSeconds` | `60` | 10–3600, integer | Seconds between OpenRouter refreshes |
| `historyDays` | `30` | 2–366, integer | Days of history the summary window covers, today included |
| `cbrUrl` | `https://www.cbr.ru/scripts/XML_daily.asp` | `https://` URL | CBR daily-rates sheet read for the RUB rate |
| `rateRefreshSeconds` | `3600` | 60–86400, integer | Seconds between cbr.ru rate reads |
| `timeoutMs` | `15000` | 1000–120000, integer | Per-request deadline against OpenRouter and cbr.ru |
| `warnConsumedFraction` | `0.4` | 0.05–0.95 | Share of a periodic cap consumed that raises the warning level |
| `criticalConsumedFraction` | `0.8` | 0.1–1 | Share of a periodic cap consumed that raises the critical level |
| `burnWindowDays` | `7` | 1–30, integer | Trailing days of hourly burn read for the runway estimate |

Viewing preferences (display currency, per-key filter, refresh interval override, the limit-warning switch) are browser-local (`localStorage`). The limit warning stays off until it is turned on.

`burnWindowDays` reads one row per hour and key. Past 5000 rows the read is refused rather than truncated, so a long window combined with many simultaneously active keys does not mix: the runway estimate reports the refusal and names this setting, and narrowing `burnWindowDays` is the fix.

## What the numbers are

- Figures are `total_usage` — USD OpenRouter actually billed — from `POST /api/v1/analytics/query`, grouped per UTC day by API key and model.
- "Today" is the current UTC day.
- Balance is `total_credits − total_usage` from `GET /api/v1/credits`: what remains of prepaid credits.
- The 7-day and 30-day ranges cover at most `historyDays` days; keep `historyDays ≥ 30` for full coverage.
- RUB display converts those USD figures at the cbr.ru daily rate, read host-side and cached for `rateRefreshSeconds`. When cbr.ru cannot be reached, the figures stay in USD and the panel says so, with the fetch reason and a hint to check the connection.
- The chip's session half comes from the same `analytics/query`, grouped by `session_id` and `api_key_id`. The harness stamps each request with its Session id (`x-session-id`), and the host folds each session's delegated subagent sessions into its row, recursively: a delegated child runs as its own session and is billed on its own analytics row, so the figure is this session plus everything it delegated, and the chip shows `session/day`. The `none` bucket (requests sent without a session) is excluded — it belongs to no chat. The account-wide figures (today, 7 and 30 days, per key, per model, per day) already include descendant spend and are unchanged.
- Both halves of the chip's pair name **one API key**: this chat's spend on it, over that same key's day. The key is the one selected in the popover, or the session's own key when no key is selected and the session used exactly one. When the key cannot be named — the session split could not be read, the lineage fold failed, no selected key matches any row, or a single session spans several keys — the chip shows a single scoped figure instead of a pair, and the popover says why. See [ADR 0006](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0006-scope-the-chip-pair-to-one-api-key.md).

## Security

- The management key is stored through the Harness credentials service (`credentials.set`), not in this package's files, and is never echoed back to the browser.
- The summary and credential routes are fenced by the connection trust check. Anyone who passes that check — by default, the browser session on your local Harness port — can read your spend figures. Do not expose the Harness web port publicly without its own authentication.

## License

[MIT](./LICENSE). Unofficial plugin; not affiliated with OpenRouter or DeepSeek.