# GreenCore Core v0.9

Аппаратно-независимое ядро управления умной теплицей с controller contract, автоматическим runtime loop, цифровым двойником, fault campaigns, публичным simulation API и долговременной SQLite-историей.

## Честный статус

- Физическое оборудование отсутствует и не считается протестированным.
- Пороговые значения в `rules/pilot-rules.json` тестовые, а не агрономически подтверждённые.
- Программный контур замкнут: `GreenCore → Controller Emulator → Digital Twin → telemetry → GreenCore`.
- Runtime snapshot остаётся в атомарном JSON как механизм быстрого аварийного восстановления.
- Телеметрия, события, тревоги, команды и simulation reports сохраняются в SQLite.
- Baseline сравнения — `MANUAL_WITHOUT_OPERATOR_INTERVENTIONS`, а не квалифицированный оператор.

## Реализовано

- строгая проверка телеметрии, времени, единиц, диапазонов и качества;
- режимы `AUTO`, `MANUAL`, `SAFE`, `OFFLINE`;
- safety interlock насоса, лимит непрерывной работы и TTL команд;
- регистрация контроллеров, ownership, heartbeat и offline timeout;
- идемпотентный терминальный ACK, включая повтор после рестарта;
- Controller Emulator с локальной защитой и fault injection;
- автоматический неперекрывающийся цикл принятия решений;
- детерминированный Digital Twin;
- Scenario Runner и Fault Campaign Runner с машинным PASS/FAIL;
- публичный Simulation API;
- SQLite schema migrations, WAL, busy timeout и prepared statements;
- retention limits для долговременной истории;
- автоматическая миграция старого `simulations.json` в SQLite;
- тестирование на Node.js 22 и 24;
- production Docker image и container smoke-test.

## Требование

Node.js `22.13+`.

## Запуск

```bash
cd core
npm test
npm start
```

В другом процессе:

```bash
cd core
npm run emulator:controller
```

## Переменные сервера

| Переменная | По умолчанию | Назначение |
|---|---:|---|
| `HOST` | `0.0.0.0` | адрес API |
| `PORT` | `3000` | порт API |
| `STATE_FILE` | `data/state.json` | аварийный runtime snapshot |
| `HISTORY_DATABASE` | `data/history.sqlite` | SQLite history database |
| `SIMULATION_STATE_FILE` | `data/simulations.json` | только источник одноразовой legacy-миграции |
| `MAX_SIMULATION_REPORTS` | `50` | отчёты, загружаемые в память |
| `MAX_SIMULATION_HISTORY` | `1000` | отчёты в SQLite |
| `MAX_TELEMETRY_HISTORY` | `250000` | samples в SQLite |
| `MAX_EVENT_HISTORY` | `100000` | события в SQLite |
| `MAX_ALERT_HISTORY` | `50000` | тревоги в SQLite |
| `MAX_COMMAND_HISTORY` | `100000` | команды в SQLite |
| `CORS_ORIGIN` | `*` | разрешённый origin dashboard |
| `AUTOMATION_ENABLED` | `true` | автоматический цикл |
| `EVALUATION_INTERVAL_MS` | `5000` | интервал решений |

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

| Метод | Путь | Основные фильтры |
|---|---|---|
| `GET` | `/history/stats` | — |
| `GET` | `/history/telemetry` | `metric`, `device_id`, `controller_id`, `quality`, `from`, `to`, `limit` |
| `GET` | `/history/events` | `type`, `from`, `to`, `limit` |
| `GET` | `/history/alerts` | `type`, `from`, `to`, `limit` |
| `GET` | `/history/commands` | `status`, `actuator_id`, `controller_id`, `action`, `from`, `to`, `limit` |

Пример:

```http
GET /history/telemetry?metric=soil_moisture&from=2026-07-28T00:00:00Z&limit=500
```

`from` и `to` принимают ISO 8601. Максимальный `limit` — `5000`.

## Public Simulation API

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/simulations/catalog` | каталог сценариев и кампаний |
| `GET` | `/simulations?limit=20` | последние отчёты |
| `GET` | `/simulations/{report_id}` | полный отчёт |
| `POST` | `/simulations` | запуск сценария или fault campaign |
| `POST` | `/simulations/compare` | AUTO против пассивного manual baseline |

Пример:

```http
POST /simulations/compare
Content-Type: application/json

{
  "name": "baseline_24h",
  "include_timeline": false
}
```

## Controller Emulator и Digital Twin

| Переменная | По умолчанию | Назначение |
|---|---:|---|
| `GREENCORE_URL` | `http://127.0.0.1:3000` | адрес GreenCore API |
| `CONTROLLER_ID` | `controller_primary` | ID контроллера |
| `CONTROLLER_FIRMWARE` | `emulator-2.0.0` | версия виртуального firmware |
| `DIGITAL_TWIN_PRESET` | `normal` | сценарий модели |
| `SIMULATION_SPEED` | `1` | ускорение модельного времени |

Presets: `normal`, `heatwave`, `drought`, `leak`, `weak_ventilation`.

```bash
DIGITAL_TWIN_PRESET=heatwave SIMULATION_SPEED=60 npm run emulator:controller
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

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health` | runtime и состояние SQLite history |
| `GET` | `/state` | полный runtime snapshot |
| `GET` | `/alerts` | текущий ограниченный буфер тревог |
| `GET` | `/events?limit=100` | текущий ограниченный буфер событий |
| `POST` | `/mode` | режим управления |
| `POST` | `/connectivity` | внешняя связь |
| `POST` | `/manual-commands` | ручной запрос с TTL |
| `POST` | `/evaluate` | диагностический цикл |

### Controller Contract v1

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/controllers` | список и здоровье контроллеров |
| `POST` | `/controllers/register` | регистрация или обновление |
| `POST` | `/controllers/{id}/heartbeat` | heartbeat и диагностика |
| `GET` | `/controllers/{id}/configuration` | интервалы и ownership |
| `GET` | `/controllers/{id}/commands` | незавершённые команды |
| `POST` | `/controllers/{id}/telemetry` | контроллерная телеметрия |
| `POST` | `/controllers/{id}/command-acks` | контроллерный ACK |

## Граница ответственности

`GreenCoreEngine` создаёт безопасное намерение. `GreenCoreRuntime` маршрутизирует его владельцу устройства. Локальный контроллер повторно проверяет команду перед силовым переключением. Digital Twin и comparison reports демонстрируют причинно-следственную логику, но не являются подтверждённым прогнозом урожая или прибыли.
