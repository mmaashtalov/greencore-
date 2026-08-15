# GreenCore Core v0.12

Аппаратно-независимое ядро управления умной теплицей: controller contract, автоматический runtime loop, цифровой двойник, отказоустойчивые сценарии, SQLite-история, аналитика, scoped authorization, rate limiting, bounded simulation queue и live SSE.

## Честный статус

- Физическое оборудование отсутствует и не считается протестированным.
- Пороговые значения в `rules/pilot-rules.json` тестовые, а не агрономически подтверждённые.
- Программный контур замкнут: `GreenCore → Controller Emulator → Digital Twin → telemetry → GreenCore`.
- Runtime snapshot хранится в атомарном JSON для быстрого аварийного восстановления.
- Телеметрия, события, тревоги, команды и simulation reports сохраняются в SQLite.
- Baseline сравнения — `MANUAL_WITHOUT_OPERATOR_INTERVENTIONS`, а не квалифицированный оператор.
- `AUTH_MODE=disabled` предназначен только для локальной разработки. Публичный backend должен использовать `AUTH_MODE=required`.

## Реализовано

- строгая проверка телеметрии, времени, единиц, диапазонов и качества;
- режимы `AUTO`, `MANUAL`, `SAFE`, `OFFLINE`;
- safety interlock насоса, лимит непрерывной работы и TTL команд;
- регистрация контроллеров, ownership, heartbeat и offline timeout;
- идемпотентный терминальный ACK, включая повтор после рестарта;
- Controller Emulator с локальной защитой, fault injection и API key;
- автоматический неперекрывающийся цикл принятия решений;
- детерминированный Digital Twin;
- Scenario Runner и Fault Campaign Runner с машинным PASS/FAIL;
- SQLite migrations, WAL, busy timeout, prepared statements и retention limits;
- историческая аналитика и временные telemetry-агрегаты;
- Decision Journal: policy-решения с `decision_id`, эффектом, правилом, evidence и контекстом команды;
- Bearer / `x-api-key` аутентификация и роли `admin`, `operator`, `controller`;
- fixed-window rate limiting по отдельным классам запросов;
- bounded simulation scheduler с контролируемой очередью;
- SSE live stream с heartbeat, replay и лимитом клиентов;
- тестирование на Node.js 22 и 24;
- production Docker image и container smoke-test.

## Требование

Node.js `22.13+`.

## Запуск

Локальный режим:

```bash
cd core
npm test
npm start
```

Защищённый режим:

```bash
AUTH_MODE=required \
ADMIN_API_KEY='replace-with-long-random-secret' \
OPERATOR_API_KEY='replace-with-another-secret' \
CONTROLLER_API_KEYS='{"controller_primary":"controller-secret"}' \
PUBLIC_READ_ONLY=true \
PUBLIC_SIMULATIONS=false \
CORS_ORIGIN='https://mmaashtalov.github.io' \
npm start
```

Эмулятор:

```bash
CONTROLLER_API_KEY='controller-secret' npm run emulator:controller
```

## Основные переменные

| Переменная | По умолчанию | Назначение |
|---|---:|---|
| `HOST` | `0.0.0.0` | адрес API |
| `PORT` | `3000` | порт API |
| `STATE_FILE` | `data/state.json` | аварийный runtime snapshot |
| `HISTORY_DATABASE` | `data/history.sqlite` | SQLite history database |
| `MAX_SIMULATION_REPORTS` | `50` | reports в памяти |
| `MAX_SIMULATION_HISTORY` | `1000` | reports в SQLite |
| `MAX_TELEMETRY_HISTORY` | `250000` | samples в SQLite |
| `MAX_EVENT_HISTORY` | `100000` | события в SQLite |
| `MAX_ALERT_HISTORY` | `50000` | тревоги в SQLite |
| `MAX_COMMAND_HISTORY` | `100000` | команды в SQLite |
| `MAX_POLICY_DECISION_HISTORY` | `100000` | policy-решения в SQLite |
| `CORS_ORIGIN` | `*` | разрешённый origin dashboard |
| `AUTOMATION_ENABLED` | `true` | автоматический цикл |
| `EVALUATION_INTERVAL_MS` | `5000` | интервал решений |

## API Security

| Переменная | По умолчанию | Назначение |
|---|---:|---|
| `AUTH_MODE` | `disabled` | `disabled` или `required` |
| `ADMIN_API_KEY` | — | полный доступ; обязателен при `required` |
| `OPERATOR_API_KEY` | — | управление, raw history и runtime state |
| `CONTROLLER_API_KEYS` | `{}` | JSON `controller_id → key` |
| `PUBLIC_READ_ONLY` | `false` | public analytics, saved reports и `/live` |
| `PUBLIC_SIMULATIONS` | `false` | public запуск simulation endpoints |

Поддерживаются:

```http
Authorization: Bearer <token>
```

или

```http
x-api-key: <token>
```

Ключи не записываются в rate limiter. Для идентификации используется укороченный SHA-256 fingerprint.

## Rate Limiting

| Переменная | По умолчанию | Класс запросов |
|---|---:|---|
| `RATE_LIMIT_READ_PER_MINUTE` | `240` | analytics, reports, live status |
| `RATE_LIMIT_OPERATOR_PER_MINUTE` | `120` | управление и raw history |
| `RATE_LIMIT_CONTROLLER_PER_MINUTE` | `1200` | heartbeat, telemetry, commands, ACK |
| `RATE_LIMIT_SIMULATION_PER_MINUTE` | `12` | запуск simulations/comparisons |
| `RATE_LIMIT_STREAM_PER_MINUTE` | `30` | новые SSE-подключения |
| `RATE_LIMIT_MAX_IDENTITIES` | `10000` | максимум отслеживаемых identity windows |

Успешные ответы содержат:

```http
RateLimit-Limit: 240
RateLimit-Remaining: 239
RateLimit-Reset: 2026-07-28T18:30:00.000Z
```

При превышении:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
```

```json
{"error":"RATE_LIMITED","message":"Rate limit exceeded for read"}
```

## Simulation overload protection

| Переменная | По умолчанию | Назначение |
|---|---:|---|
| `SIMULATION_MAX_CONCURRENT` | `1` | одновременно выполняемые задачи |
| `SIMULATION_MAX_QUEUE` | `4` | ожидающие задачи |
| `SIMULATION_RETRY_AFTER_SECONDS` | `2` | рекомендация повторной попытки |

При заполненной очереди API отвечает `503 OVERLOADED` и `Retry-After`.

Статус:

```http
GET /simulations/status
```

```json
{
  "active": 1,
  "queued": 3,
  "max_concurrent": 1,
  "max_queued": 4,
  "rejected": 2
}
```

## Live SSE

```http
GET /live
Accept: text/event-stream
```

Доступ регулируется теми же правилами, что public read-only analytics. В приватном режиме клиент должен использовать потоковый `fetch` с Bearer/API-key.

Первым приходит `snapshot`, затем события:

- `automation.cycle`;
- `automation.evaluated`;
- `telemetry`;
- `controller.registered`;
- `controller.heartbeat`;
- `commands.delivered`;
- `command.acknowledged`;
- `mode.changed`;
- `connectivity.changed`;
- `simulation.completed`.

Поддерживается replay через:

```http
Last-Event-ID: 42
```

| Переменная | По умолчанию | Назначение |
|---|---:|---|
| `LIVE_HEARTBEAT_INTERVAL_MS` | `15000` | SSE heartbeat |
| `LIVE_REPLAY_LIMIT` | `100` | replay buffer |
| `LIVE_MAX_CLIENTS` | `100` | одновременные подключения |
| `LIVE_MAX_EVENT_BYTES` | `65536` | максимальный JSON payload события |

Статус:

```http
GET /live/status
```

## SQLite History

Таблицы:

```text
telemetry_history
event_history
alert_history
policy_decision_history
command_history
simulation_reports
schema_migrations
```

Ошибка аналитической записи не останавливает безопасный runtime: recovery snapshot сохраняется отдельно, а `/health` переходит в `degraded`.

## History API

Все raw history routes требуют operator/admin при `AUTH_MODE=required`.

| Метод | Путь | Фильтры |
|---|---|---|
| `GET` | `/history/stats` | — |
| `GET` | `/history/telemetry` | `metric`, `device_id`, `controller_id`, `quality`, `from`, `to`, `limit` |
| `GET` | `/history/events` | `type`, `from`, `to`, `limit` |
| `GET` | `/history/alerts` | `type`, `from`, `to`, `limit` |
| `GET` | `/history/policy-decisions` | `effect`, `policy_id`, `actuator_id`, `action`, `from`, `to`, `limit` |
| `GET` | `/history/commands` | `status`, `actuator_id`, `controller_id`, `action`, `from`, `to`, `limit` |

## Historical Analytics API

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/analytics/catalog` | бакеты и маршруты |
| `GET` | `/analytics/overview` | единая сводка dashboard |
| `GET` | `/analytics/telemetry` | `min/max/avg/count` по времени |
| `GET` | `/analytics/commands` | качество исполнения команд |
| `GET` | `/analytics/alerts` | частота и интервалы тревог |
| `GET` | `/analytics/simulations` | simulation PASS/FAIL |

Бакеты: `1m`, `5m`, `15m`, `1h`, `6h`, `1d`.

## Simulation API

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/simulations/catalog` | каталог сценариев |
| `GET` | `/simulations/status` | очередь и нагрузка |
| `GET` | `/simulations?limit=20` | последние reports |
| `GET` | `/simulations/{report_id}` | полный report |
| `POST` | `/simulations` | scenario/fault campaign |
| `POST` | `/simulations/compare` | AUTO против пассивного baseline |

## Основной API

| Метод | Путь | Доступ |
|---|---|---|
| `GET` | `/health` | public |
| `GET` | `/live` | read/public-read |
| `GET` | `/live/status` | read/public-read |
| `GET` | `/state` | operator/admin |
| `GET` | `/alerts` | operator/admin |
| `GET` | `/events` | operator/admin |
| `GET` | `/policy/catalog` | read/public-read |
| `GET` | `/policy/decisions` | operator/admin |
| `POST` | `/mode` | operator/admin |
| `POST` | `/connectivity` | operator/admin |
| `POST` | `/manual-commands` | operator/admin |
| `POST` | `/evaluate` | operator/admin |

### Controller Contract v1

| Метод | Путь | Доступ |
|---|---|---|
| `GET` | `/controllers` | operator/admin |
| `POST` | `/controllers/register` | свой controller/admin |
| `POST` | `/controllers/{id}/heartbeat` | свой controller/admin |
| `GET` | `/controllers/{id}/configuration` | свой controller/admin |
| `GET` | `/controllers/{id}/commands` | свой controller/admin |
| `POST` | `/controllers/{id}/telemetry` | свой controller/admin |
| `POST` | `/controllers/{id}/command-acks` | свой controller/admin |

## CLI-испытания

```bash
npm run scenarios
npm run scenarios -- tank_leak_12h
npm run faults
npm run faults -- controller_outage_recovery
```

CLI возвращает код `1`, если хотя бы один критерий не выполнен.

## Граница ответственности

`GreenCoreEngine` создаёт безопасное намерение. `GreenCoreRuntime` маршрутизирует его владельцу устройства. Локальный контроллер повторно проверяет команду перед силовым переключением. Rate limiting, очередь и SSE защищают серверный контур, но не заменяют локальные interlock. Digital Twin и comparison reports демонстрируют причинно-следственную логику, но не являются подтверждённым прогнозом урожая или прибыли.
