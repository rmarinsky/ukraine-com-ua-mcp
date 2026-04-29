# ukraine-com-ua-mcp

> [English version](README.md)

MCP-сервер (Model Context Protocol) для **ukraine.com.ua** — найбільшого
хостингу та реєстратора доменів в Україні. Обгортає їхній напівофіційний
HTTP API `adm.tools`, дозволяючи керувати доменами, DNS, поштовими скриньками
та SSL-сертифікатами з будь-якого MCP-клієнта (Claude Desktop, Claude Code,
Cursor, …) звичайною українською або англійською.

> Статус: **рання, але production-shaped версія** (v0.1.x). Tier 1–4 tools
> реалізовано. У `adm.tools` API немає публічного OpenAPI specа і він може
> змінюватися без попередження — див. [Обмеження](#обмеження).

## Навіщо

Веб-інтерфейс ukraine.com.ua нормальний для разової роботи, але незручний
для рутинних задач: додати SPF/DKIM/DMARC, делегувати DNS на Cloudflare,
аудит застарілої зони. Цей MCP-сервер виставляє ці операції як інструменти,
які LLM може викликати, коли ви опишете зміну в чаті. Той самий use case, що
й офіційний Cloudflare MCP server, але для зон `.ua` і `.com.ua`, які
обслуговуються через `adm.tools`.

## Що вміє

| Tool                            | Що обгортає                    |
|---------------------------------|--------------------------------|
| `check_domain_availability`     | `domain/check`                 |
| `list_domains`                  | `dns/list` (cached 1h)         |
| `list_dns_records`              | `dns/records_list`             |
| `backup_dns_zone`               | `dns/records_list` + snapshot на диск |
| `create_dns_record`             | `dns/record_add`               |
| `update_dns_record`             | `dns/record_edit`              |
| `delete_dns_record` 🔥          | `dns/record_delete`            |
| `restore_dns_zone` 🔥           | diff + replay з бекапу         |
| `get_balance`                   | `billing/balance_get`          |

🔥 = деструктивні: вимагають `confirm: true` у вхідних параметрах. Опис
інструменту вказує LLM спершу підтвердити з вами в чаті.

Усі write tools (`create_dns_record`, `update_dns_record`, `delete_dns_record`)
вимагають свіжого `backup_id` від `backup_dns_zone`. Це гарантія, що зона
не зміниться непомітно між читанням і записом. Деталі — у [`docs/uk/backup.md`](docs/uk/backup.md).

Поверхня tools навмисно вузька. Adm.tools видалив низку endpoint-ів, які
старіші PHP-референси досі документують (NS edit, DNSSEC, MX preset, domain
register, mailbox CRUD, SSL — усі повертають HTTP 400 «handler not found»
станом на 2026-04-29). Див. [`docs/api-endpoints.md`](docs/api-endpoints.md)
для повного списку і кладовища мертвих endpoint-ів. Знайшли новий?
Спочатку перевірте на живій АПІ (`bun run src/cli.ts call <action>`),
потім PR.

## Формат відповіді

Tool responses йдуть через двоканальний паттерн MCP:

- **`content[].text`** (читає LLM) — за замовчуванням **TOON**
  ([Token-Oriented Object Notation](https://github.com/toon-format/toon)).
  Табличні масиви однотипних об'єктів стискаються до CSV-зі-схемою — це
  приблизно **на 40% менше токенів**, ніж JSON, з порівнянною або кращою
  recall на LLM-бенчмарках.
- **`structuredContent`** (для програмних споживачів) — завжди звичайні
  JSON-сумісні об'єкти. Downstream MCP tools, які пайплайнять результати,
  не змінюються.

Параметри для read tools:

| Параметр   | Тип                   | Ефект                                                                 |
|------------|-----------------------|-----------------------------------------------------------------------|
| `format`   | `"toon"` \| `"json"`  | Повернути text channel у JSON. Default `"toon"`.                      |
| `verbose`  | `boolean`             | Не застосовувати lean projection — повернути усі поля. Default `false`. |
| `limit`    | `number` (1–500)      | Розмір сторінки. Тільки для list tools.                               |
| `offset`   | `number` (≥0)         | Зміщення. Використовуйте `next_offset` з попередньої відповіді.       |

Помилки лишаються JSON у `text` — вони невеликі, а діагностика простіша,
коли формат універсальний.

## Швидкий старт

### 1. Отримати API-токен

Зайдіть на <https://adm.tools/user/api/> і створіть токен.

### 2. Додати до MCP-клієнта

#### Claude Desktop

Редагуйте `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) або `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "ukraine-com-ua": {
      "command": "bunx",
      "args": ["@rmarinsky/ukraine-com-ua-mcp"],
      "env": {
        "ADM_TOOLS_TOKEN": "your_token_here"
      }
    }
  }
}
```

Якщо у вас не встановлений Bun, замініть `bunx` на `npx`.

#### Claude Code

```bash
claude mcp add ukraine-com-ua \
  --env ADM_TOOLS_TOKEN=your_token_here \
  -- bunx @rmarinsky/ukraine-com-ua-mcp
```

#### Cursor

У `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ukraine-com-ua": {
      "command": "bunx",
      "args": ["@rmarinsky/ukraine-com-ua-mcp"],
      "env": { "ADM_TOOLS_TOKEN": "your_token_here" }
    }
  }
}
```

### 3. Спробувати

У Claude:

> Покажи мої домени на ukraine.com.ua і DNS-записи для `example.com.ua`.

Claude викличе `list_domains`, знайде відповідний `id`, потім викличе
`list_dns_records` з тим id.

## Локальна розробка

```bash
bun install
cp .env.example .env             # вставте свій токен
bun run dev                      # MCP-сервер у stdio mode (Ctrl-C щоб вийти)
bun run cli list-domains         # standalone CLI
bun run cli check rmarinsky.com.ua
bun run cli call dns/list        # raw passthrough на будь-який endpoint
bun run validate                 # typecheck + lint + tests
```

## Конфігурація (env vars)

| Змінна                            | Обов'язкова | Default                | Нотатки                                         |
|-----------------------------------|-------------|------------------------|-------------------------------------------------|
| `ADM_TOOLS_TOKEN`                 | так         | —                      | Bearer-токен з `https://adm.tools/user/api/`    |
| `ADM_TOOLS_BASE_URL`              | ні          | `https://adm.tools`    | Override для self-hosted проксі                 |
| `ADM_TOOLS_TIMEOUT_MS`            | ні          | `15000`                | Таймаут на запит                                |
| `ADM_TOOLS_MAX_RETRIES`           | ні          | `3`                    | Повтори на 5xx і 429                            |
| `ADM_TOOLS_DOMAIN_CACHE_TTL_MS`   | ні          | `3600000`              | TTL in-memory кешу для `list_domains`           |
| `ADM_TOOLS_LOG_FILE`              | ні          | —                      | Файл логу запитів (токен завжди редактується)   |
| `ADM_TOOLS_ENABLE_WRITE_TOOLS`    | ні          | `true`                 | `false` — лишити тільки read-only tools         |
| `ADM_TOOLS_BACKUP_DIR`            | ні          | `./dns-backups`        | Куди зберігати JSON-снапшоти зон                |
| `ADM_TOOLS_BACKUP_MAX_AGE_MS`     | ні          | `600000`               | Скільки `backup_id` валідний (10 хв за замовч.) |
| `ADM_TOOLS_REQUIRE_BACKUP`        | ні          | `true`                 | `false` — `backup_id` стає опціональним         |

## Безпека: backup-режим

Усі мутації DNS вимагають свіжого `backup_id`, який ви отримуєте через
`backup_dns_zone`. Це precondition: якщо зона змінилась між бекапом і
вашим write-викликом — мутація відхиляється з ясним повідомленням.

Робочий процес: `backup_dns_zone` → `delete_dns_record(backup_id=...)`.
Якщо щось пішло не так — `restore_dns_zone(backup_id=...)` робить diff
поточної зони з бекапом і replays зміни.

Повна документація: [`docs/uk/backup.md`](docs/uk/backup.md).

## Підводні камені

- **`subdomain_id` ≠ `domain_id`.** Коли оновлюєте/видаляєте DNS-запис,
  передавайте поле `id` з того *запису* (його «subdomain id»), а **не**
  id батьківського домену. Найменування невдале, але так працює API.
- **`@` для root, `*` для wildcard.** Як у стандартному zone-файлі.
- **MX-пресети не включають SPF/DKIM/DMARC.** Після `set_mx_preset` майже
  завжди треба зробити ще три виклики `create_dns_record` для тих TXT.
- **DNSSEC блокує зміну NS.** Спочатку `disable_dnssec`, зачекайте,
  потім `change_nameservers`. Інакше API повертає невиразну помилку.
- **Обмеження `.ua` registry.** Custom NS-хости на `.ua` доменах мають
  бути попередньо зареєстровані у `.ua` registry. Cloudflare / Hetzner /
  deSEC nameservers працюють без налаштування; довільні хости — ні.
- **Баланс ≠ безкоштовно.** `register_domain` і `create_mailbox` коштують
  грошей. Завжди викликайте `get_balance` перед платними діями.

## Модель безпеки

Кожен деструктивний tool вимагає `confirm: z.literal(true)`:

- `delete_dns_record` (зміни повільно відкочувати через кеші)
- `restore_dns_zone` (replay може частково впасти, лишивши проміжний стан)

Опис tool-а вказує Claude спочатку підтвердити зміну з вами в чаті, лише
потім надсилати `confirm: true`. Можна також примусово увімкнути read-only
режим змінною `ADM_TOOLS_ENABLE_WRITE_TOOLS=false`, яка повністю прибирає
деструктивні tools зі списку зареєстрованих.

Додатково всі write tools захищені preconditioned-backup механізмом
(див. [Безпека: backup-режим](#безпека-backup-режим) вище).

## Обмеження

- **Немає публічного OpenAPI specа.** Endpoint-и реверсують з
  [офіційного PHP reference-у](https://github.com/ukraine-com-ua/API) і
  [community PHP wrapper-а](https://github.com/kudinovfedor/ukraine-api).
  Adm.tools може змінити форму відповіді без попередження; повідомляйте
  про поломки через GitHub issues.
- **Немає документації по rate-лімітах.** Клієнт повторює 5xx і 429 з
  експоненціальним backoff, але опублікованого rate-limit budget немає.
- **Немає webhooks.** Усе polling. Свій watcher робіть самі, якщо треба.
- **Немає Terraform-провайдера.** Для Terraform-driven DNS делегуйте
  DNS на Cloudflare і використовуйте ukraine.com.ua тільки як реєстратора.
- **EPP не виставлено.** Це обгортка тільки для HTTP API. Прямий EPP
  доступ потребуватиме окремого пакета.

## Поза межами

- Browser-автоматизація / скрапінг adm.tools web UI.
- Database CRUD (легко знести продакшн із чату).
- FTP user management (нішово).

## Внесок

Див. [CONTRIBUTING.md](CONTRIBUTING.md). Коротка версія:

1. Додайте метод клієнта у `src/admtools.ts` плюс типи у `src/types.ts`.
2. Зареєструйте tool у `src/server.ts` (опціонально команду в `src/cli.ts`).
3. Додайте unit-тест у `test/admtools.test.ts`, який перевіряє form-encoded
   тіло і URL.
4. Оновіть `docs/api-endpoints.md` — поміняйте рядок з `⬜` на `✅`.
5. `bun run validate` має пройти перед PR.

## Ліцензія

MIT — див. [LICENSE](LICENSE).
