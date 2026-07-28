# GreenCore Core v0.8

Аппаратно-независимое ядро управления умной теплицей с автоматическим runtime loop, локальным controller contract, безопасным восстановлением, цифровым двойником, fault campaigns и публичным simulation API.

## Честный статус

- Физическое оборудование отсутствует и не считается протестированным.
- Пороговые значения в `rules/pilot-rules.json` тестовые, а не агрономически подтверждённые.
- Программный контур замкнут: `GreenCore → Controller Emulator → Digital Twin → telemetry → GreenCore`.
- Состояние runtime и simulation reports сохраняется в атомарно обновляемые JSON-файлы. Это пилотная персистентность, не промышленная БД.
- Сравнение manual/auto не выдаётся за сравнение со skilled operator: текущий baseline — `MANUAL_WITHOUT_OPERATOR_INTERVENTIONS`.

## Реализовано

- строгая проверка телеметрии, времени, единиц, диапазонов и качества;
- режимы `AUTO`, `MANUAL`, `SAFE`, `OFFLINE`;
- safety interlock насоса, лимит непрерывной работы и TTL команд;
- атомарное сохранение, rollback, restore и quarantine повреждённого state;
- регистрация контроллеров, ownership устройств, heartbeat и offline timeout;
- идемпотентный терминальный ACK, включая повтор после рестарта;
- Controller Emulator с локальной защитой и fault injection;
- автоматический неперекрывающийся цикл принятия решений;
- детерминированный цифровой двойник воздуха, почвы, воды и оборудования;
- Scenario Runner и Fault Campaign Runner с машинным PASS/FAIL;
- persistent SimulationService с ограниченным хранилищем отчётов;
- CORS-ready HTTP API для публичного dashboard;
- автоматическая test suite на Node.js 20 и 22;
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
| `STATE_FILE` | `data/state.json` | runtime state |
| `SIMULATION_STATE_FILE` | `data/simulations.json` | simulation reports |
| `MAX_SIMULATION_REPORTS` | `50` | максимальное число сохранённых отчётов |
| `CORS_ORIGIN` | `*` | разрешённый origin публичного dashboard |
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

## CLI-испытания

Штатные сценарии:

```bash
npm run scenarios
npm run scenarios -- tank_leak_12h
```

Fault campaigns:

```bash
npm run faults
npm run faults -- controller_outage_recovery
```

CLI возвращает код `1`, если хотя бы один критерий не выполнен.

## Public Simulation API

### Каталог

```http
GET /simulations/catalog
```

Возвращает доступные штатные сценарии, fault campaigns и обязательное предупреждение о границах модели.

### Запуск сценария

```http
POST /simulations
Content-Type: application/json

{
  "kind": "scenario",
  "name": "heatwave_48h",
  "include_timeline": false
}
```

Для fault campaign используется `"kind": "fault"`.

### Сравнение AUTO и manual baseline

```http
POST /simulations/compare
Content-Type: application/json

{
  "name": "baseline_24h",
  "include_timeline": false
}
```

Отчёт содержит обе стратегии, одинаковые исходные условия, метрики и `automatic_minus_manual`. Manual baseline означает отсутствие операторских вмешательств и не моделирует квалифицированного агронома.

### Хранилище отчётов

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/simulations?limit=20` | последние отчёты |
| `GET` | `/simulations/{report_id}` | полный отчёт |

При ошибке записи новый отчёт откатывается. После рестарта отчёты восстанавливаются из `SIMULATION_STATE_FILE`.

## Основной HTTP API

### Система

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/health` | доступность и статус simulation service |
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

`GreenCoreEngine` создаёт безопасное намерение. `GreenCoreRuntime` маршрутизирует его владельцу устройства. Локальный контроллер повторно проверяет команду перед силовым переключением. Digital Twin и comparison reports демонстрируют причинно-следственную логику, но не являются подтверждённым прогнозом урожая или прибыли.

## Следующий этап

Live Dashboard v1: публичная страница, которая запускает comparison report, показывает два таймлайна и наглядно объясняет, где автоматика изменила микроклимат, расход ресурсов и модельное состояние растений.
