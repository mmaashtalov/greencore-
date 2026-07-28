# GreenCore

GreenCore — аппаратно-независимая платформа управления умной теплицей с цифровым двойником, эмулятором контроллера и воспроизводимыми испытаниями.

## Публичная демонстрация

GitHub Pages: https://mmaashtalov.github.io/greencore-/

Dashboard работает автономно в браузере. При подключении опубликованного GreenCore API он может запускать серверно проверяемые сценарии и сравнения.

## Реализовано

- GreenCore Engine и HTTP API;
- регистрация контроллеров, ownership устройств и heartbeat;
- Controller Emulator с локальными safety-проверками;
- автоматический runtime loop;
- детерминированный цифровой двойник теплицы;
- Scenario Runner и Fault Campaign Runner;
- восстановление состояния после рестарта;
- TTL, повторная доставка и идемпотентные ACK;
- Simulation API и хранение отчётов;
- production Docker-контейнер и GHCR workflow;
- публичный React dashboard;
- 72 автоматических теста на Node.js 20 и 22.

## Честные ограничения

- Физические датчики, ESP32, реле, насосы и вентиляторы ещё не подключались и не считаются протестированными.
- Пороговые значения и модель роста тестовые, а не агрономически подтверждённые.
- Показатели урожайности и прибыли в демонстрации являются модельными.

## Структура

```text
apps/demo/                 # публичный React dashboard
core/                      # сервер, runtime, API, digital twin и тесты
packages/domain-model/     # общие типы
packages/simulation-core/  # автономная браузерная модель
.github/workflows/         # CI, Pages и container release
```

## Запуск ядра

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

Сценарии и кампании отказов:

```bash
cd core
npm run scenarios
npm run faults
```

## Docker

```bash
docker compose up --build
```

После запуска:

- API: `http://localhost:3000`
- health: `http://localhost:3000/health`
- каталог симуляций: `http://localhost:3000/simulations/catalog`

Подробная документация ядра: [core/README.md](core/README.md)
