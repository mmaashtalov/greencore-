# GreenCore — чек-лист приёмки

Отмечать пункт выполненным только по фактическому результату команды, workflow или испытания. «Собралось локально», HTTP `200` старой страницы, `skipped` или `No jobs were run` не являются приёмкой.

## A. Программная поставка

- [ ] Получен именно репозиторий `mmaashtalov/greencore-` и текущий HEAD PR №20, а не legacy `greencore_sprint9_v1.0.0-rc1`.
- [ ] Проверены `git remote -v`, ветка, SHA, `git status --short --branch` и состав diff PR.
- [ ] Установлены Node.js `>=22.13.0` и pnpm `9.15.0`.
- [ ] `corepack pnpm install --frozen-lockfile` завершён без изменения lockfile.
- [ ] `corepack pnpm acceptance` завершился с кодом `0`.
- [ ] Отдельно проверен Docker smoke-test, если production будет container-based.

## B. Безопасный runtime

- [ ] Публичный API запускается с `AUTH_MODE=required`.
- [ ] Административный, операторский и controller-секреты не совпадают, не лежат в Git и переданы защищённо.
- [ ] Анонимный `GET /state` возвращает `401`.
- [ ] Публичные read-only маршруты и `/live` доступны только в согласованном режиме.
- [ ] `CORS_ORIGIN` содержит точный публичный origin dashboard.
- [ ] SQLite и recovery snapshot записываются на persistent volume; проверен рестарт с восстановлением state/history.

## C. Внешний LIVE-контур

- [ ] PR вручную влит в `main` после ревью владельца.
- [ ] GitHub Pages deploy завершился, и фактический asset содержит маркер `GREENCORE LIVE OPERATIONS`.
- [ ] Render Blueprint создан с persistent disk, `AUTH_MODE=required` и отдельными секретами.
- [ ] `/health` показывает рабочий безопасный режим, а не только HTTP-статус.
- [ ] Пройдены read-only analytics, SSE snapshot, embedded controller telemetry и запрет анонимного `/state`.
- [ ] В GitHub задан `PUBLIC_API_URL`; `GreenCore Public API Smoke` завершился success.
- [ ] `Validate Render Blueprint` имеет заданные `RENDER_API_KEY` и `RENDER_WORKSPACE_ID` и завершился success.

## D. Аппаратный пилот — отдельная приёмка

- [ ] Выбранный контроллер реализует `controller-contract.json` без обхода Policy Engine.
- [ ] Локальные interlock не позволяют включить насос при низком/недостоверном уровне воды и не исполняют истёкшие команды.
- [ ] Повторная доставка одной команды не вызывает повторное силовое переключение.
- [ ] Проверены AUTO, сухая почва, высокая температура, низкая вода, stale/missing telemetry, controller outage, delivery blackout, actuator failure и рестарт.
- [ ] Для каждой проверенной команды есть `decision_id`, правило/evidence и терминальный ACK.
- [ ] Электробезопасность, влагозащита, монтаж, сеть и агрономические пороги приняты ответственными специалистами.

## Решение о приёмке

| Стадия | Условие |
|---|---|
| Software-ready | Разделы A и B выполнены; C/D явно могут быть незакрыты |
| Public LIVE-ready | Разделы A, B и C выполнены |
| Field-ready | Разделы A–D выполнены, результаты полевого пилота зафиксированы |
