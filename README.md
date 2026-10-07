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
  <img src="https://raw.githubusercontent.com/RyabykinIlya/dsh-openrouter-spend/v0.3.2/docs/popover.png" width="340" alt="Spend popover"><br>
  <sub>The popover: range and API-key filters, today's spend per model, daily bars, prepaid balance and lifetime spend.</sub>
</p>

- **Chip under the composer** — `session/day`: what this chat spent today over the whole day's spend, for the selected range and API key (today, 7 days, or 30 days).
- **Chip popover** — range and API-key filters, today's spend per model, a daily bar chart across the window, prepaid balance and lifetime spend.
- **Settings → OpenRouter spend** — store or clear the management key, pick the display currency (USD, or RUB at the cbr.ru rate), set the refresh interval, filter by API key.

The host half caches the summary for `refreshSeconds` and coalesces concurrent refreshes, so any number of open tabs cost one OpenRouter query per refresh window. When a refresh fails, the last good figures stay on screen and the reason is shown instead of an empty panel.

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
dsh plugin --profile web add github:RyabykinIlya/dsh-openrouter-spend#v0.3.2
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

Viewing preferences (display currency, per-key filter, refresh interval override) are browser-local (`localStorage`).

## What the numbers are

- Figures are `total_usage` — USD OpenRouter actually billed — from `POST /api/v1/analytics/query`, grouped per UTC day by API key and model.
- "Today" is the current UTC day.
- Balance is `total_credits − total_usage` from `GET /api/v1/credits`: what remains of prepaid credits.
- The 7-day and 30-day ranges cover at most `historyDays` days; keep `historyDays ≥ 30` for full coverage.
- RUB display converts those USD figures at the cbr.ru daily rate, read host-side and cached for `rateRefreshSeconds`. When cbr.ru cannot be reached, the figures stay in USD and the panel says so, with the fetch reason and a hint to check the connection.
- The chip's session half comes from the same `analytics/query`, grouped by `session_id`. The harness stamps each request with its Session id (`x-session-id`), and the host folds each session's delegated subagent sessions into its row, recursively: a delegated child runs as its own session and is billed on its own analytics row, so the figure is this session plus everything it delegated, and the chip shows `session/day`. The `none` bucket (requests sent without a session) is excluded — it belongs to no chat. The account-wide figures (today, 7 and 30 days, per key, per model, per day) already include descendant spend and are unchanged.

## Security

- The management key is stored through the Harness credentials service (`credentials.set`), not in this package's files, and is never echoed back to the browser.
- The summary and credential routes are fenced by the connection trust check. Anyone who passes that check — by default, the browser session on your local Harness port — can read your spend figures. Do not expose the Harness web port publicly without its own authentication.

## License

[MIT](./LICENSE). Unofficial plugin; not affiliated with OpenRouter or DeepSeek.