<p align="center">
  <img src="icon.svg" width="88" alt="OpenRouter spend icon">
</p>

<h1 align="center">dsh-openrouter-spend</h1>

<p align="center">
  在 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 中显示 OpenRouter 支出 —
  来自 OpenRouter 自有分析 API 的实际美元账单，而非基于本地表格的令牌估算。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-openrouter-spend"><img src="https://img.shields.io/npm/v/dsh-openrouter-spend?style=flat-square" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/dsh-openrouter-spend?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-2f6feb?style=flat-square" alt="DeepSeek Harness plugin">
</p>

<p align="center">
  <a href="README.md">English</a> | 中文 | <a href="README.ru.md">Русский</a>
</p>

## 功能介绍

<p align="center">
  <img src="https://raw.githubusercontent.com/RyabykinIlya/dsh-openrouter-spend/main/docs/chip2.png" width="640" alt="Spend chip under the composer"><br>
  <sub>编辑器下方的芯片：当前对话今日支出 / 今日总支出，以及会话的令牌和上下文统计数据。</sub>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/RyabykinIlya/dsh-openrouter-spend/v0.3.2/docs/popover.png" width="340" alt="Spend popover"><br>
  <sub>弹出窗口：时间范围和 API 密钥过滤器、今日每个模型的支出、每日条形图、预付余额和累计支出。</sub>
</p>

- **编辑器下方的芯片** — `会话/今日`：当前对话今日的支出占全天支出的比例，支持选择时间范围和 API 密钥（今日、7天或30天）。
- **芯片弹出窗口** — 时间范围和 API 密钥过滤器、今日每个模型的支出、时间窗口内的每日条形图、预付余额和累计支出。
- **设置 → OpenRouter spend** — 存储或清除管理密钥、选择显示货币（美元或按 cbr.ru 汇率的卢布）、设置刷新间隔、按 API 密钥过滤。

主机端缓存摘要 `refreshSeconds` 秒并合并并发刷新，因此任意数量的打开标签页在每个刷新窗口内只需查询 OpenRouter 一次。当刷新失败时，最后的有效数据保留在屏幕上，原因显示在空面板的位置。

## 系统要求

- DeepSeek Harness web 配置文件。插件需要 `credentials`、`webServer` 和 `connection` 服务，在没有这些服务的配置文件（例如 headless）中保持非活动状态。
- OpenRouter **管理 API 密钥** — OpenRouter 仪表板 → Settings → Management API Keys → Create New Key（[OpenRouter 文档](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)）。普通推理密钥会被拒绝：`403 Only management keys can perform this operation`。

## 安装

从 npm 安装（`web` 是默认的图形界面配置文件；如果使用其他配置文件，请使用您自己的配置文件名称）：

```sh
dsh plugin --profile web add dsh-openrouter-spend
```

从 GitHub 安装（纯 JavaScript，无构建步骤和构建脚本权限）：

```sh
dsh plugin --profile web add github:RyabykinIlya/dsh-openrouter-spend#v0.3.2
```

然后打开 Settings → OpenRouter spend 并粘贴管理密钥。

## 配置

每个字段都可以在配置文件的 `cordis.patch.yml` 行中覆盖；模式在激活时验证该行并指出有问题的字段。

| 字段 | 默认值 | 范围 | 含义 |
| --- | --- | --- | --- |
| `credentialRef` | `OPENROUTER_MGMT_API_KEY` | 非空字符串 | 持有管理密钥的凭据引用 |
| `apiBase` | `https://openrouter.ai/api/v1` | `https://` URL | OpenRouter REST API 根地址 |
| `refreshSeconds` | `60` | 10–3600，整数 | OpenRouter 刷新之间的秒数 |
| `historyDays` | `30` | 2–366，整数 | 摘要窗口涵盖的历史天数，包括今天 |
| `cbrUrl` | `https://www.cbr.ru/scripts/XML_daily.asp` | `https://` URL | 用于读取卢布汇率的 CBR 每日汇率表 |
| `rateRefreshSeconds` | `3600` | 60–86400，整数 | cbr.ru 汇率读取之间的秒数 |
| `timeoutMs` | `15000` | 1000–120000，整数 | 针对 OpenRouter 和 cbr.ru 的每个请求截止时间 |

查看首选项（显示货币、按密钥过滤器、刷新间隔覆盖）是浏览器本地的（`localStorage`）。

## 数字含义

- 数据为 `total_usage` — OpenRouter 实际计费的美元 — 来自 `POST /api/v1/analytics/query`，按 UTC 天、API 密钥和模型分组。
- "今日"是当前的 UTC 天。
- 余额是来自 `GET /api/v1/credits` 的 `total_credits − total_usage`：预付信用的剩余部分。
- 7天和30天范围最多涵盖 `historyDays` 天；保持 `historyDays ≥ 30` 以实现完整覆盖。
- 卢布显示按 cbr.ru 每日汇率转换这些美元数据，在主机端读取并缓存 `rateRefreshSeconds` 秒。当无法访问 cbr.ru 时，数据保持美元显示，面板会说明原因并提示检查连接。
- 芯片的会话部分来自同一 `analytics/query`，按 `session_id` 分组。Harness 用会话 ID（`x-session-id`）标记每个请求，因此对话的成本是其自身的数据；芯片显示 `会话/今日`。`none` 桶（无会话发送的请求）被排除 — 它不属于任何对话。

## 安全性

- 管理密钥通过 Harness 凭据服务（`credentials.set`）存储，而不是在此包的文件中，并且永远不会回显到浏览器。
- 摘要和凭据路由受连接信任检查保护。通过该检查的任何人 — 默认情况下，本地 Harness 端口上的浏览器会话 — 都可以读取您的支出数据。未经自己的身份验证，请勿公开 Harness Web 端口。

## 许可证

[MIT](./LICENSE)。非官方插件；与 OpenRouter 或 DeepSeek 无关联。
