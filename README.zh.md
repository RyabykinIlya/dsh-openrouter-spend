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
  <img src="https://raw.githubusercontent.com/RyabykinIlya/dsh-openrouter-spend/main/docs/popover.png" width="340" alt="Spend popover"><br>
  <sub>弹出窗口：时间范围和 API 密钥过滤器、今日每个模型的支出、每日条形图、预付余额和累计支出。截图拍摄于 0.4.0 新增的限额区块和刷新失败状态之前，这两者的样子见[通知设计稿](docs/mockups/limit-notice.html)。</sub>
</p>

- **编辑器下方的芯片** — `会话/今日`：当前对话今日在同一个 API 密钥上的支出，占该密钥今日支出的比例；跟随所选密钥。两个数字属于同一个密钥（见 [ADR 0006](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0006-scope-the-chip-pair-to-one-api-key.md)）。
- **芯片弹出窗口** — 时间范围和 API 密钥过滤器、今日每个模型的支出、时间窗口内的每日条形图、预付余额和累计支出。
- **设置 → OpenRouter spend** — 存储或清除管理密钥、选择显示货币（美元或按 cbr.ru 汇率的卢布）、设置刷新间隔、按 API 密钥过滤。
- **限额提醒** — 默认关闭。在设置中开启后，弹出窗口会显示所跟踪密钥的限额还剩多少：已用比例、按当前速度剩余额度还能用多久，以及限额何时重置。随着限额逼近，芯片上的圆点先变黄再变红，级别升级时弹出一次通知。
- **账户余额提醒** — 预付余额按它本来的 lifetime 限额来评估：当它按账户支出的中位速度撑不到三天（不到一天——或按最近三天的平均——即为严重）时，圆点会告警，弹出窗口的余额块会说明金额以及它能撑多久——「剩余 $6.58 · 按此速度不足一天 · 所有密钥共用」——而不是一个孤零零的百分比，或一个面板上别处都看不到的总数，通知也会提示充值。评估方法见 [ADR 0007](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0007-judge-the-account-balance-by-runway.md)，措辞见 [ADR 0010](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0010-print-the-pool-balance-without-its-credited-total.md)。
- **提高限额** — 限额块（以及触发时的通知）提供不让限额中断工作的操作：一键即可用同一个管理密钥提高密钥的支出限额。建议金额取决于金额与消耗速度——消耗较快的周期限额取限额加上本周期已消耗额，其他情况取一倍半——旁边还有自定义金额输入框。只接受提高，且最多为当前限额的 10 倍；本身没有限额的密钥需先在 OpenRouter 中设置。日限额 `$10`、已消耗 `$8.50` 时建议 `$18.5`。建议金额以账户本身的货币（USD）显示——发送的就是这个数字——您的显示货币作为只读参考紧随其后：「提高到 $15.00 · ≈ 2114.67 ₽」；cbr.ru 不可用时该参考会消失。见 [ADR 0008](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0008-raise-a-key-limit-from-the-popover.md)。

主机端缓存摘要 `refreshSeconds` 秒并合并并发刷新，因此任意数量的打开标签页在每个刷新窗口内只需查询 OpenRouter 一次。当刷新失败时，最后的有效数据保留在屏幕上，原因显示在空面板的位置：面板会说明故障原因，倒计时到下次自动尝试（首次失败后 15 秒，之后 30 秒，然后恢复普通间隔），并提供**立即重试**按钮以立刻重新读取。

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
dsh plugin --profile web add github:RyabykinIlya/dsh-openrouter-spend#v0.6.0
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
| `warnConsumedFraction` | `0.4` | 0.05–0.95 | 周期性限额已用比例达到该值时提升警告级别 |
| `criticalConsumedFraction` | `0.8` | 0.1–1 | 周期性限额已用比例达到该值时提升严重级别 |
| `burnWindowDays` | `7` | 1–30，整数 | 为估算剩余时间而读取的小时级消耗天数 |

查看首选项（显示货币、按密钥过滤器、刷新间隔覆盖、限额提醒开关）是浏览器本地的（`localStorage`）。限额提醒在开启前一直关闭。

`burnWindowDays` 每小时、每个密钥读取一行。超过 5000 行时读取会被拒绝，而不是被截断，因此较长的窗口与大量同时活跃的密钥无法并存：剩余时间估算会报告该拒绝并指出此设置，解决办法就是调小 `burnWindowDays`。

## 数字含义

- 数据为 `total_usage` — OpenRouter 实际计费的美元 — 来自 `POST /api/v1/analytics/query`，按 UTC 天、API 密钥和模型分组。
- "今日"是当前的 UTC 天。
- 余额是来自 `GET /api/v1/credits` 的 `total_credits − total_usage`：预付信用的剩余部分。
- 7天和30天范围最多涵盖 `historyDays` 天；保持 `historyDays ≥ 30` 以实现完整覆盖。
- 卢布显示按 cbr.ru 每日汇率转换这些美元数据，在主机端读取并缓存 `rateRefreshSeconds` 秒。当无法访问 cbr.ru 时，数据保持美元显示，面板会说明原因并提示检查连接。
- 芯片的会话部分来自同一 `analytics/query`，按 `session_id` 和 `api_key_id` 分组。Harness 用会话 ID（`x-session-id`）标记每个请求，主机端会把该会话委派的子代理会话递归归并到它的行中：委派的子会话作为独立会话运行，并在自己的分析行中计费，因此该数字是"本会话加上它委派的全部内容"，芯片显示 `会话/今日`。`none` 桶（无会话发送的请求）被排除 — 它不属于任何对话。账户级数据（今日、7天、30天、按密钥、按模型、按天）已经包含后代支出，保持不变。
- 芯片这一对数字都只属于**同一个 API 密钥**：本对话在该密钥上的支出，与该密钥当天的支出之比。密钥取自弹出窗口中选择的密钥；若未选择且该会话只用一个密钥，则取会话自身的密钥。当无法确定密钥时 — 会话拆分读取失败、归属合并失败、所选密钥在数据中没有对应行，或单个会话跨多个密钥 — 芯片改为显示同一口径的单个数字，并在弹出窗口中说明原因。参见 [ADR 0006](https://github.com/RyabykinIlya/dsh-openrouter-spend/blob/main/docs/adr/0006-scope-the-chip-pair-to-one-api-key.md)。

## 安全性

- 管理密钥通过 Harness 凭据服务（`credentials.set`）存储，而不是在此包的文件中，并且永远不会回显到浏览器。
- 摘要、凭据和提高限额路由受连接信任检查保护。通过该检查的任何人 — 默认情况下，本地 Harness 端口上的浏览器会话 — 都可以读取您的支出数据并提高密钥限额。未经自己的身份验证，请勿公开 Harness Web 端口。
- 提高限额时，管理密钥通过 `Authorization` 请求头发送，请求体中只带密钥**名称**；其 hash 由主机端解析，不会传到浏览器。

## 许可证

[MIT](./LICENSE)。非官方插件；与 OpenRouter 或 DeepSeek 无关联。
