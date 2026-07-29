# GreenCore

GreenCore — аппаратно-независимая платформа управления умной теплицей с цифровым двойником, эмулятором контроллера, защищённым API и воспроизводимыми испытаниями.

Правила работы с канонической базой, граница legacy, обязательная проверка Git и критерии фактической валидации зафиксированы в [AGENTS.md](AGENTS.md).

## Публичная демонстрация

Dashboard: https://mmaashtalov.github.io/greencore-/

Dashboard работает автономно в браузере. После подключения публичного GreenCore API он дополнительно показывает живой серверный контур:

```text
Controller → telemetry → automation → command → ACK
```

## Развернуть публичный backend с телефона

> Blueprint использует минимальный платный Render web service, потому что постоянный SQLite-диск недоступен бесплатному сервису.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fmmaashtalov%2Fgreencore-)

После нажатия:

1. Войти в Render через GitHub.
2. Проверить Blueprint `greencore-live-api`.
3. Подтвердить создание сервиса и диска.
4. Дождаться успешного health check `/health`.
5. Скопировать публичный URL вида `https://<service>.onrender.com`.
6. Открыть dashboard и вставить URL в поле **Адрес GreenCore API**.

Render автоматически создаёт отдельные случайные секреты для:

- администратора;
- оператора;
- встроенного demo-controller.

Секреты не записываются в GitHub. Публично разрешены только read-only данные, SSE и ограниченный Simulation API. Управляющие маршруты требуют токен.

### Автоматическая внешняя проверка

После развёртывания добавить URL в GitHub:

```text
Repository → Settings → Secrets and variables → Actions
→ Variables → New repository variable

Name: PUBLIC_API_URL
Value: https://<service>.onrender.com
```

Workflow `GreenCore Public API Smoke` ежедневно проверяет:

- `/health`;
- публичную аналитику;
- SSE snapshot;
- встроенный контроллер и телеметрию;
- серверное сравнение AUTO с baseline;
- запрет анонимного доступа к `/state`.

## Что реализовано

- GreenCore Engine и автоматический runtime loop;
- режимы `AUTO`, `MANUAL`, `SAFE`, `OFFLINE`;
- controller contract, ownership и heartbeat;
- Controller Emulator с локальными safety-проверками;
- встроенный публичный demo-controller;
- детерминированный Digital Twin;
- Scenario Runner и Fault Campaign Runner;
- TTL, повторная доставка и идемпотентные ACK;
- SQLite history и серверная аналитика;
- Policy Engine v1 и Decision Journal с объяснением `ALLOW/DENY`;
- Bearer/API-key авторизация и роли;
- rate limiting и ограниченная очередь симуляций;
- SSE live stream с replay и heartbeat;
- production Docker image и persistent volume;
- GitHub Pages dashboard;
- CI на Node.js 22/24 и container smoke-tests;
- воспроизводимая frontend-установка через pinned dependencies и `pnpm-lock.yaml`.

## Честные ограничения

- Физические датчики, ESP32, реле, насосы и вентиляторы ещё не подключались и не считаются протестированными.
- Пороговые значения и модель роста тестовые, а не агрономически подтверждённые.
- Показатели урожайности и прибыли в демонстрации являются модельными.
- Встроенный demo-controller предназначен для публичной демонстрации, а не для управления физическим оборудованием.

Публикация внешних Pages/Render URL считается готовой только после отдельной проверки фактического URL и загруженного asset; локальная сборка сама по себе это не подтверждает.

## Структура

```text
apps/demo/                 # публичный React dashboard
core/                      # server, API, runtime, digital twin, tests
packages/domain-model/     # общая модель предметной области
packages/simulation-core/  # автономная браузерная модель
render.yaml                # one-click публичный backend
.github/workflows/         # CI, Pages, container и external smoke
```

Контракт будущего подключения физических устройств: [docs/integration/hardware-handoff.md](docs/integration/hardware-handoff.md).

## Локальный запуск

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

## Docker

```bash
docker compose up --build
```

После запуска:

- API: `http://localhost:3000`
- health: `http://localhost:3000/health`
- live stream: `http://localhost:3000/live`
- каталог симуляций: `http://localhost:3000/simulations/catalog`

Подробная документация ядра: [core/README.md](core/README.md)
