# GreenCore Core v0.7

Аппаратно-независимое ядро управления умной теплицей с автоматическим runtime loop, контрактом локального контроллера, безопасным восстановлением, цифровым двойником и детерминированными испытаниями отказов.

## Честный статус

- Физическое оборудование отсутствует и не считается протестированным.
- Пороговые значения в `rules/pilot-rules.json` тестовые, а не агрономически подтверждённые.
- Программный контур замкнут: `GreenCore → Controller Emulator → Digital Twin → telemetry → GreenCore`.
- Состояние ядра сохраняется в атомарно обновляемый JSON-файл. Это пилотная персистентность, не промышленная БД.
- Программная безопасность проверяется обычными сценариями и fault campaigns с машинным PASS/FAIL.

## Реализовано

- строгая проверка телеметрии, времени, единиц, диапазонов и качества;
- режимы `AUTO`, `MANUAL`, `SAFE`, `OFFLINE`;
- safety interlock насоса, лимит непрерывной работы и TTL команд;
- атомарное сохранение, rollback, restore и quarantine повреждённого state;
- регистрация контроллеров, ownership устройств, heartbeat и offline timeout;
- контроллерные очереди и ACK только от владельца actuator;
- идемпотентный повтор терминального ACK, включая повтор после рестарта;
- Controller Emulator с локальной защитой и fault injection;
- автоматический неперекрывающийся цикл принятия решений;
- детерминированный цифровой двойник воздуха, почвы, воды и оборудования;
- Scenario Runner для длительных штатных сценариев;
- Fault Campaign Runner для обрывов связи, задержки доставки, рестартов и повторов ACK;
- 72 автоматических теста на Node.js 20 и 22;
- test-output artifacts сохраняются в GitHub Actions семь дней.

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
| `STATE_FILE` | `data/state.json` | файл состояния |
| `AUTOMATION_ENABLED` | `true` | автоматический цикл |
| `EVALUATION_INTERVAL_MS` | `5000` | интервал решений |

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

## Штатные сценарии

Весь каталог:

```bash
npm run scenarios
```

Один сценарий:

```bash
npm run scenarios -- tank_leak_12h
```

Каталог: `baseline_24h`, `heatwave_48h`, `tank_leak_12h`, `low_water_safety_2h`, `pump_failure_2h`, `weak_ventilation_24h`.

## Fault campaigns

Весь каталог отказов:

```bash
npm run faults
```

Одна кампания:

```bash
npm run faults -- controller_outage_recovery
```

Каталог:

- `command_delivery_blackout` — команды истекают без доставки и исполняются после восстановления polling;
- `controller_outage_recovery` — heartbeat и telemetry пропадают, данные устаревают, управление переходит в safe state и восстанавливается;
- `runtime_restart_and_ack_replay` — runtime восстанавливается из snapshot, повтор терминального ACK остаётся идемпотентным;
- `cloud_connectivity_recovery` — движок продолжает локальную автоматику в режиме `OFFLINE`.

Отчёт содержит extrema параметров, actuator runtime, команды, тревоги, safety violations, число рестартов, повторов ACK, применённых отказов и незавершённых команд. CLI возвращает код `1`, если хотя бы один критерий не выполнен.

## HTTP API

### Система

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health` | доступность процесса |
| `GET` | `/state` | полный снимок runtime |
| `GET` | `/alerts` | тревоги |
| `GET` | `/events?limit=100` | события |
| `POST` | `/mode` | режим управления |
| `POST` | `/connectivity` | состояние внешней связи |
| `POST` | `/manual-commands` | ручной запрос с TTL |
| `POST` | `/evaluate` | диагностический цикл |

### Контроллер v1

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

`GreenCoreEngine` создаёт безопасное намерение. `GreenCoreRuntime` маршрутизирует его владельцу устройства. Локальный контроллер повторно проверяет команду перед силовым переключением. После появления ESP32 цифровой двойник заменяется физическими входами и выходами без изменения центральной архитектуры.

## Следующий этап

Публичный simulation API и live-dashboard: запуск сценариев через HTTP, хранение отчётов и визуальное сравнение ручного и автоматического управления по микроклимату, ресурсам, модельному здоровью и экономическим показателям.
