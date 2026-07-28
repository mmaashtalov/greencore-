# GreenCore Core v0.11

Аппаратно-независимое ядро управления умной теплицей с controller contract, автоматическим runtime loop, цифровым двойником, fault campaigns, simulation API, SQLite-историей, серверной аналитикой и разграничением доступа.

## Честный статус

- Физическое оборудование отсутствует и не считается протестированным.
- Пороговые значения в `rules/pilot-rules.json` тестовые, а не агрономически подтверждённые.
- Программный контур замкнут: `GreenCore → Controller Emulator → Digital Twin → telemetry → GreenCore`.
- Runtime snapshot остаётся в атомарном JSON как механизм быстрого аварийного восстановления.
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
- Simulation API;
- SQLite migrations, WAL, busy timeout и prepared statements;
- retention limits для долговременной истории;
- временные telemetry-агрегаты для графиков;
- success rate команд, сводки тревог и simulation PASS/FAIL;
- Bearer / `x-api-key` аутентификация;
- роли `admin`, `operator`, `controller`;
- изоляция каждого controller token по `controller_id`;
- отдельные настройки публичного чтения и публичных симуляций;
- тестирование на Node.js 22 и 24;
- production Docker image и container smoke-test.

## Требование

Node.js `22.13+`.

## Запуск

Локальный открытый режим:

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
npm start
```

Эмулятор:

```bash
CONTROLLER_API_KEY='controller-secret' npm run emulator:controller
```

## Переменные сервера

| Переменная | По умолчанию | Назначение |
|---|---:|---|
| `HOST` | `0.0.0.0` | адрес API |
| `PORT` | `3000` | порт API |
| `STATE_FILE` | `data/state.json` | аварийный runtime snapshot |
| `HISTORY_DATABASE` | `data/history.sqlite` | SQLite history database |
| `SIMULATION_STATE_FILE` | `data/simulations.json` | только источник legacy-миграции |
| `MAX_SIMULATION_REPORTS` | `50` | отчёты в памяти |
| `MAX_SIMULATION_HISTORY` | `1000` | отчёты в SQLite |
| `MAX_TELEMETRY_HISTORY` | `250000` | samples в SQLite |
| `MAX_EVENT_HISTORY` | `100000` | события в SQLite |
| `MAX_ALERT_HISTORY` | `50000` | тревоги в SQLite |
| `MAX_COMMAND_HISTORY` | `100000` | команды в SQLite |
| `CORS_ORIGIN` | `*` | разрешённый origin dashboard |
| `AUTH_MODE` | `disabled` | `disabled` или `required` |
| `ADMIN_API_KEY` | — | полный доступ; обязателен при `required` |
| `OPERATOR_API_KEY` | — | управление, raw history и runtime state |
| `CONTROLLER_API_KEYS` | `{}` | JSON-объект `controller_id → key` |
| `PUBLIC_READ_ONLY` | `false` | публичный доступ к analytics и сохранённым reports |
| `PUBLIC_SIMULATIONS` | `false` | публичный запуск simulation endpoints |
| `AUTOMATION_ENABLED` | `true` | автоматический цикл |
| `EVALUATION_INTERVAL_MS` | `5000` | интервал решений |

## API Security

Поддерживаются два заголовка:

```http
Authorization: Bearer <token>
```

или

```http
x-api-key: <token>
```

### Роли

| Роль | Доступ |
|---|---|
| `admin` | все защищённые маршруты и любой контроллер |
| `operator` | управление, `/state`, raw history, analytics и simulations |
| `controller` | только регистрация и маршруты своего `controller_id` |
| public | `/health`, `/simulations/catalog`; остальное зависит от public flags |

Controller token для `controller_primary` не может отправить heartbeat, telemetry или ACK от имени `controller_secondary`.

`/health` показывает только безопасный статус конфигурации:

```json
{
  "security": {
    "mode": "required",
    "public_read_only": true,
    "public_simulations": false,
    "admin_key_configured": true,
    "operator_key_configured": true,
    "controller_key_count": 1
  }
}
```

Сами ключи в ответ не попадают. Сравнение ключей выполняется constant-time функцией.

### Рекомендуемая публичная конфигурация

```bash
AUTH_MODE=required
ADMIN_API_KEY=<long-random-secret>
OPERATOR_API_KEY=<different-long-random-secret>
CONTROLLER_API_KEYS={"controller_primary":"different-controller-secret"}
PUBLIC_READ_ONLY=true
PUBLIC_SIMULATIONS=false
CORS_ORIGIN=https://mmaashtalov.github.io
```

Публичный запуск симуляций лучше включать только вместе с отдельным rate limiting слоем.

## SQLite History

База создаётся автоматически. Используются:

- `journal_mode=WAL`;
- `synchronous=NORMAL`;
- `busy_timeout=5000`;
- параметризованные запросы;
- schema migrations;
- уникальные ограничения для дедупликации;
- ограничение размера таблиц.

Таблицы:

```text
telemetry_history
event_history
alert_history
command_history
simulation_reports
schema_migrations
```

Ошибка записи аналитической истории не останавливает безопасный runtime: текущее состояние сначала сохраняется в recovery snapshot, а `/health` переводится в `degraded`. Ошибка сохранения simulation report возвращает `500` и откатывает добавление отчёта в память.

## History API

Все raw history routes требуют operator/admin token при `AUTH_MODE=required`.

| Метод | Путь | Основные фильтры |
|---|---|---|
| `GET` | `/history/stats` | — |
| `GET` | `/history/telemetry` | `metric`, `device_id`, `controller_id`, `quality`, `from`, `to`, `limit` |
| `GET` | `/history/events` | `type`, `from`, `to`, `limit` |
| `GET` | `/history/alerts` | `type`, `from`, `to`, `limit` |
| `GET` | `/history/commands` | `status`, `actuator_id`, `controller_id`, `action`, `from`, `to`, `limit` |

```http
GET /history/telemetry?metric=soil_moisture&from=2026-07-28T00:00:00Z&limit=500
Authorization: Bearer <operator-token>
```

`from` и `to` принимают ISO 8601. Максимальный `limit` — `5000`.

## Historical Analytics API

При `PUBLIC_READ_ONLY=true` эти маршруты доступны dashboard без токена. Иначе требуется operator/admin.

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/analytics/catalog` | доступные бакеты и маршруты |
| `GET` | `/analytics/overview` | единая сводка для dashboard |
| `GET` | `/analytics/telemetry` | временной ряд `min/max/avg/count` |
| `GET` | `/analytics/commands` | качество исполнения команд |
| `GET` | `/analytics/alerts` | частота и интервалы тревог |
| `GET` | `/analytics/simulations` | статистика simulation PASS/FAIL |

Бакеты: `1m`, `5m`, `15m`, `1h`, `6h`, `1d`.

```http
GET /analytics/telemetry?metric=soil_moisture&bucket=15m&from=2026-07-28T00:00:00Z
```

`/analytics/commands` рассчитывает `success_rate_percent` только по терминальным статусам: `EXECUTED`, `REJECTED`, `FAILED`, `EXPIRED`.

## Simulation API

`GET /simulations/catalog` всегда публичен. Чтение reports регулируется `PUBLIC_READ_ONLY`; запуск — `PUBLIC_SIMULATIONS`.

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/simulations/catalog` | каталог сценариев и кампаний |
| `GET` | `/simulations?limit=20` | последние отчёты |
| `GET` | `/simulations/{report_id}` | полный отчёт |
| `POST` | `/simulations` | запуск сценария или fault campaign |
| `POST` | `/simulations/compare` | AUTO против пассивного manual baseline |

## Controller Emulator и Digital Twin

| Переменная | По умолчанию | Назначение |
|---|---:|---|
| `GREENCORE_URL` | `http://127.0.0.1:3000` | адрес GreenCore API |
| `CONTROLLER_ID` | `controller_primary` | ID контроллера |
| `CONTROLLER_API_KEY` | — | Bearer key своего контроллера |
| `CONTROLLER_FIRMWARE` | `emulator-2.0.0` | версия firmware |
| `DIGITAL_TWIN_PRESET` | `normal` | сценарий модели |
| `SIMULATION_SPEED` | `1` | ускорение модельного времени |

Presets: `normal`, `heatwave`, `drought`, `leak`, `weak_ventilation`.

```bash
CONTROLLER_API_KEY='controller-secret' \
DIGITAL_TWIN_PRESET=heatwave \
SIMULATION_SPEED=60 \
npm run emulator:controller
```

## CLI-испытания

```bash
npm run scenarios
npm run scenarios -- tank_leak_12h
npm run faults
npm run faults -- controller_outage_recovery
```

CLI возвращает код `1`, если хотя бы один критерий не выполнен.

## Основной HTTP API

| Метод | Путь | Доступ |
|---|---|---|
| `GET` | `/health` | public |
| `GET` | `/state` | operator/admin |
| `GET` | `/alerts` | operator/admin |
| `GET` | `/events?limit=100` | operator/admin |
| `POST` | `/mode` | operator/admin |
| `POST` | `/connectivity` | operator/admin |
| `POST` | `/manual-commands` | operator/admin |
| `POST` | `/evaluate` | operator/admin |

### Controller Contract v1

| Метод | Путь | Доступ |
|---|---|---|
| `GET` | `/controllers` | operator/admin |
| `POST` | `/controllers/register` | свой controller token/admin |
| `POST` | `/controllers/{id}/heartbeat` | свой controller token/admin |
| `GET` | `/controllers/{id}/configuration` | свой controller token/admin |
| `GET` | `/controllers/{id}/commands` | свой controller token/admin |
| `POST` | `/controllers/{id}/telemetry` | свой controller token/admin |
| `POST` | `/controllers/{id}/command-acks` | свой controller token/admin |

## Граница ответственности

`GreenCoreEngine` создаёт безопасное намерение. `GreenCoreRuntime` маршрутизирует его владельцу устройства. Локальный контроллер повторно проверяет команду перед силовым переключением. Digital Twin и comparison reports демонстрируют причинно-следственную логику, но не являются подтверждённым прогнозом урожая или прибыли.
