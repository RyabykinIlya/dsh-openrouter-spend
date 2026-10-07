<p align="center">
  <img src="icon.svg" width="88" alt="OpenRouter spend icon">
</p>

<h1 align="center">dsh-openrouter-spend</h1>

<p align="center">
  Учёт расходов OpenRouter в
  <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> —
  реальные списания в долларах из API аналитики OpenRouter, а не оценки токенов из локальной таблицы.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-openrouter-spend"><img src="https://img.shields.io/npm/v/dsh-openrouter-spend?style=flat-square" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/dsh-openrouter-spend?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-2f6feb?style=flat-square" alt="DeepSeek Harness plugin">
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | Русский
</p>

## Что вы получаете

<p align="center">
  <img src="https://raw.githubusercontent.com/RyabykinIlya/dsh-openrouter-spend/main/docs/chip2.png" width="640" alt="Spend chip under the composer"><br>
  <sub>Чип под полем ввода: расходы этого чата за сегодня / всего за день, рядом со статистикой токенов и контекста сессии.</sub>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/RyabykinIlya/dsh-openrouter-spend/v0.3.2/docs/popover.png" width="340" alt="Spend popover"><br>
  <sub>Поповер: фильтры по периоду и API-ключам, расходы по моделям за сегодня, график по дням, остаток предоплаты и общие расходы.</sub>
</p>

- **Чип под полем ввода** — `сессия/день`: сколько потратил этот чат сегодня из общих дневных расходов для выбранного периода и API-ключа (сегодня, 7 дней или 30 дней).
- **Поповер чипа** — фильтры по периоду и API-ключам, расходы по моделям за сегодня, столбчатая диаграмма по дням, остаток предоплаты и общие расходы за всё время.
- **Настройки → OpenRouter spend** — сохранение или очистка управляющего ключа, выбор валюты отображения (USD или RUB по курсу ЦБ РФ), интервал обновления, фильтр по API-ключу.

Серверная часть кеширует сводку на `refreshSeconds` и объединяет одновременные обновления, поэтому любое количество открытых вкладок стоит один запрос к OpenRouter на окно обновления. Когда обновление не удаётся, последние корректные данные остаются на экране, а причина отображается вместо пустой панели.

## Требования

- Web-профиль DeepSeek Harness. Плагину нужны сервисы `credentials`, `webServer` и `connection`, он остаётся неактивным в профилях без них (например, headless).
- **Управляющий API-ключ** OpenRouter — OpenRouter dashboard → Settings → Management API Keys → Create New Key ([документация OpenRouter](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)). Обычный ключ для инференса отклоняется: `403 Only management keys can perform this operation`.

## Установка

Из npm (`web` — стандартный профиль с графическим интерфейсом; используйте собственное имя профиля, если у вас другое):

```sh
dsh plugin --profile web add dsh-openrouter-spend
```

Из GitHub (чистый JavaScript, без этапа сборки и разрешения на build-скрипты):

```sh
dsh plugin --profile web add github:RyabykinIlya/dsh-openrouter-spend#v0.3.2
```

После этого откройте Settings → OpenRouter spend и вставьте управляющий ключ.

## Конфигурация

Любое поле можно переопределить в строке `cordis.patch.yml` профиля; схема валидирует строку при активации и указывает некорректное поле.

| Поле | По умолчанию | Границы | Значение |
| --- | --- | --- | --- |
| `credentialRef` | `OPENROUTER_MGMT_API_KEY` | непустая строка | Ссылка на учётные данные, хранящая управляющий ключ |
| `apiBase` | `https://openrouter.ai/api/v1` | URL с `https://` | Корень REST API OpenRouter |
| `refreshSeconds` | `60` | 10–3600, целое | Секунды между обновлениями OpenRouter |
| `historyDays` | `30` | 2–366, целое | Дней истории в окне сводки, включая сегодня |
| `cbrUrl` | `https://www.cbr.ru/scripts/XML_daily.asp` | URL с `https://` | Таблица дневных курсов ЦБ РФ для курса RUB |
| `rateRefreshSeconds` | `3600` | 60–86400, целое | Секунды между чтениями cbr.ru |
| `timeoutMs` | `15000` | 1000–120000, целое | Таймаут запроса к OpenRouter и cbr.ru |

Настройки просмотра (валюта отображения, фильтр по ключу, переопределение интервала обновления) локальны для браузера (`localStorage`).

## Что означают цифры

- Данные — это `total_usage` — USD, которые реально списал OpenRouter — из `POST /api/v1/analytics/query`, сгруппированные по UTC-дням, API-ключам и моделям.
- «Сегодня» — это текущий день по UTC.
- Баланс — это `total_credits − total_usage` из `GET /api/v1/credits`: остаток предоплаченных кредитов.
- Диапазоны 7 и 30 дней охватывают максимум `historyDays` дней; оставьте `historyDays ≥ 30` для полного покрытия.
- Отображение в RUB конвертирует USD-данные по дневному курсу cbr.ru, который читается на стороне сервера и кешируется на `rateRefreshSeconds`. Когда cbr.ru недоступен, данные остаются в USD, а панель это показывает с причиной и подсказкой проверить соединение.
- Половина чипа для сессии берётся из того же `analytics/query`, сгруппированного по `session_id`. Harness маркирует каждый запрос идентификатором сессии (`x-session-id`), а серверная часть складывает в строку сессии расходы всех делегированных ей сессий-субагентов, рекурсивно: делегированный потомок выполняется как отдельная сессия и тарифицируется в собственной строке аналитики, поэтому показатель — это данная сессия плюс всё, что она делегировала, и чип показывает `сессия/день`. Корзина `none` (запросы без сессии) исключена — она не принадлежит ни одному чату. Общие показатели по аккаунту (сегодня, 7 и 30 дней, по ключам, по моделям, по дням) уже включают расходы потомков и не меняются.

## Безопасность

- Управляющий ключ хранится через сервис учётных данных Harness (`credentials.set`), не в файлах этого пакета, и никогда не возвращается браузеру.
- Маршруты сводки и учётных данных защищены проверкой доверия соединения. Любой, кто пройдёт эту проверку — по умолчанию сессия браузера на вашем локальном порту Harness — может читать ваши данные о расходах. Не выставляйте веб-порт Harness публично без собственной аутентификации.

## Лицензия

[MIT](./LICENSE). Неофициальный плагин; не связан с OpenRouter или DeepSeek.
