<p align="center">
  <img src="icon.svg" width="88" alt="OpenRouter spend icon">
</p>

<h1 align="center">dsh-openrouter-spend</h1>

<p align="center">
  Real <a href="https://openrouter.ai">OpenRouter</a> spend inside
  <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> —
  billed money from OpenRouter's own analytics, not a token estimate priced from a local table.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-openrouter-spend"><img src="https://img.shields.io/npm/v/dsh-openrouter-spend?style=flat-square" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/dsh-openrouter-spend?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-2f6feb?style=flat-square" alt="DeepSeek Harness plugin">
</p>

- A live spend chip under the composer: today's cost, with a popover for the last 7 and 30 days.
- A Settings page with the daily bar chart, a per-model table, per-API-key totals, and the remaining prepaid balance.
- One cached poll per refresh window: several open tabs cost one request to OpenRouter.

## Requirements

- DeepSeek Harness with the web GUI (the plugin is inactive in headless profiles: it needs the `credentials`, `webServer`, and `connection` services).
- An OpenRouter **management API key** — Settings → API keys → Management in the OpenRouter dashboard. A regular inference key cannot read analytics.

## Install

From npm:

```sh
dsh plugin --profile demo add dsh-openrouter-spend
```

From GitHub (no build step, so no build-script permission is needed):

```sh
dsh plugin --profile demo add github:RyabykinIlya/dsh-openrouter-spend#v0.1.0
```

Then open Settings → OpenRouter spend in the GUI and store the management key. Done — the chip starts filling in.

## Configuration

Every field can be overridden in the profile's `cordis.patch.yml` row; the schema validates the row at activation and names the offending field.

| Field | Default | Bounds | Meaning |
| --- | --- | --- | --- |
| `credentialRef` | `OPENROUTER_MGMT_API_KEY` | non-empty string | Credentials reference holding the management key |
| `apiBase` | `https://openrouter.ai/api/v1` | `https://` URL | OpenRouter REST API root |
| `refreshSeconds` | `60` | 10–3600, integer | Seconds between OpenRouter refreshes |
| `historyDays` | `30` | 2–366, integer | Days of history the summary window covers, today included |
| `timeoutMs` | `15000` | 1000–120000, integer | Per-request deadline against OpenRouter |

Viewing preferences (per-key filter, refresh interval override) are browser-local and never leave your machine.

## How it works

The host half queries `POST /api/v1/analytics/query` (`total_usage` and `request_count`, split by API key and model, per UTC day) and `GET /api/v1/credits`, caches the summary for `refreshSeconds`, and serves it to the browser half. When a refresh fails, the last good figures stay on screen and the reason is shown instead of an empty panel.

## Security

- The management key is stored through the Harness credentials service (`credentials.set`), not in this package's files, and is never echoed back to the browser.
- The summary and credential routes are fenced by the connection trust check. Anyone who can pass that check — by default, the browser session on your local Harness port — can read your spend figures. Do not expose the Harness web port publicly without its own authentication.

## License

[MIT](./LICENSE). Unofficial plugin; not affiliated with OpenRouter or DeepSeek.

## По-русски

Плагин для DeepSeek Harness: под полем ввода показывает реальные расходы аккаунта OpenRouter за сегодня (данные из официальной аналитики OpenRouter), а в настройках — график по дням, разбивку по моделям и API-ключам и остаток предоплаченных кредитов. Установка: `dsh plugin --profile demo add dsh-openrouter-spend`, затем Settings → OpenRouter spend → ввести управляющий ключ (Management API key из кабинета OpenRouter).