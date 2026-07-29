# GreenCore — пакет передачи внешнему разработчику

## Назначение

Этот пакет нужен для передачи GreenCore разработчику заказчика без устных допущений. Он описывает программную поставку, способ её воспроизведения, внешние настройки и границу ответственности.

## Контрольная точка поставки

| Поле | Значение |
|---|---|
| Репозиторий | `https://github.com/mmaashtalov/greencore-.git` |
| Каноническая поставка | Draft PR [#20](https://github.com/mmaashtalov/greencore-/pull/20), ветка `agent/decision-journal-ui-v1` |
| База PR | `main@0bfa299725a9e9925a34cf6f9573f1f22065e72b` |
| Исходник для развёртывания сейчас | Текущий HEAD ветки PR; `main` не использовать, пока PR не проверен и не влит вручную |
| Актуальный стек | Node.js Core v0.12, React/Vite dashboard, SQLite |
| Исключено из поставки | `greencore_sprint9_v1.0.0-rc1` — legacy FastAPI/Python, не использовать как код или требования |

## Что передаётся

- `core/` — GreenCore Runtime, API, Policy Engine, SQLite persistence, controller contract, эмулятор и испытания;
- `apps/demo/` — публичный dashboard и защищённая Owner Console;
- `packages/domain-model/` — общая доменная модель;
- `packages/simulation-core/` — автономный Digital Twin для публичной демонстрации;
- `core/contracts/` — контракты устройства, контроллера и примеры API;
- `render.yaml`, `docker-compose.yml`, `.github/workflows/` — воспроизводимая поставка и инфраструктурные шаблоны;
- `docs/integration/hardware-handoff.md` — единственный вход для подключения настоящего контроллера;
- этот пакет и [приёмочный чек-лист](acceptance-checklist.md).

## Честный статус поставки

**Факт:** программная цепочка работает через один контракт:

```text
Digital Twin / Controller Emulator → telemetry → GreenCore Runtime → Policy Engine → command → ACK → SQLite + SSE/UI
```

**Факт:** PR #20 имеет успешные GitHub-проверки Core на Node.js 22/24, monorepo typecheck/build и Docker smoke-test. Ссылки на текущие результаты находятся в самом PR.

**Не проверено:** GreenCore не подключался к физическим датчикам, ESP32, реле, насосам, вентиляции или форточке. Тестовые пороги и KPI модели не являются агрономической рекомендацией. Публичные Pages и Render URL ещё не приняты фактическим deploy/verify.

## Быстрый старт разработчика

Требования:

- Node.js `>=22.13.0`;
- pnpm `9.15.0`;
- Git;
- Docker — только для container-приёмки или локального развёртывания.

```bash
git clone https://github.com/mmaashtalov/greencore-.git
cd greencore-
git checkout agent/decision-journal-ui-v1
corepack pnpm install --frozen-lockfile
corepack pnpm acceptance
```

`corepack pnpm acceptance` запускает:

1. `pnpm typecheck`;
2. `pnpm build`;
3. `core/npm test`;
4. `core/npm run scenarios`;
5. `core/npm run faults`.

Нулевой код возврата — необходимое условие приёмки программной поставки. Он не является подтверждением физической эксплуатации или внешнего deploy.

## Локальный запуск и демонстрация

Для минимального локального контура:

```bash
cd core
npm start
```

В отдельном процессе можно поднять внешний эмулятор контроллера:

```bash
cd core
npm run emulator:controller
```

Для Docker-контура:

```bash
docker compose up --build
```

Затем API доступен на `http://localhost:3000`, health-check — `/health`, SSE — `/live`. По умолчанию локальный режим предназначен для разработки; перед внешним размещением обязательно включить `AUTH_MODE=required`.

## Безопасная конфигурация публичного API

| Настройка | Требование для публичного API |
|---|---|
| `AUTH_MODE` | `required` |
| `ADMIN_API_KEY` | отдельный длинный секрет, вне Git |
| `OPERATOR_API_KEY` | отдельный длинный секрет, вне Git |
| `EMBEDDED_CONTROLLER_API_KEY` или `CONTROLLER_API_KEYS` | ключ/ключи контроллера, вне Git |
| `PUBLIC_READ_ONLY` | `true` только для read-only dashboard/SSE |
| `PUBLIC_SIMULATIONS` | включать только при осознанной публичной демонстрации |
| `CORS_ORIGIN` | точный origin dashboard, не `*` |
| `STATE_FILE`, `HISTORY_DATABASE`, `SIMULATION_STATE_FILE` | persistent volume, не эфемерное хранилище |

Секреты передаются заказчику через отдельный защищённый канал. Их нельзя добавлять в `.env` в Git, issue, PR, лог CI или dashboard.

## Контракты и точки расширения

| Задача | Источник истины |
|---|---|
| API контроллера | `core/contracts/controller-contract.json` |
| Телеметрия, устройства, ACK | `core/contracts/device-contracts.json` |
| Примеры payload | `core/contracts/api-examples.json` |
| Тестовые safety-пороги | `core/rules/pilot-rules.json` |
| Аппаратный handoff | `docs/integration/hardware-handoff.md` |
| Архитектурная граница | `docs/architecture/overview.md` |

Реальный контроллер обязан заменить только `Controller Emulator`: зарегистрироваться, слать heartbeat и телеметрию, poll-ить команды и возвращать идемпотентные ACK. Изменять Core, Policy Engine, Decision Journal и UI для первого аппаратного адаптера не нужно.

## Внешняя публикация: порядок приёмки

1. Внешний разработчик проверяет PR №20 и запускает `corepack pnpm acceptance` на текущем HEAD.
2. После отдельного решения владельца PR вручную вливается в `main`; автоматический merge не используется.
3. GitHub Pages workflow публикует dashboard из `main`. Принять публикацию можно только после проверки фактической страницы, её JavaScript asset и маркера `GREENCORE LIVE OPERATIONS`.
4. Render Blueprint разворачивается из `main` с persistent disk и сгенерированными секретами. Проверяются `/health`, read-only analytics, SSE, запрет анонимного `/state` и встроенный demo-controller.
5. Публичный URL записывается только как GitHub repository variable `PUBLIC_API_URL`; после этого вручную запускается `GreenCore Public API Smoke`.
6. Только после успешного фактического smoke-test можно называть внешний LIVE-контур развёрнутым.

Для проверки самого Blueprint требуется ручной workflow `Validate Render Blueprint` и заранее заданные `RENDER_API_KEY` (secret) и `RENDER_WORKSPACE_ID` (repository variable). Их отсутствие означает «не проверено», а не «deployment прошёл».

## Граница следующей фазы

Полевой пилот начинается после выбора железа. Он должен следовать [hardware handoff](../integration/hardware-handoff.md) и повторить сценарии эмулятора на реальном контроллере. До этого поставка считается программно готовой, но не физически принятой системой управления теплицей.
