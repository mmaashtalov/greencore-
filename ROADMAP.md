# GreenCore Roadmap

## Sprint 1 — Foundation
- monorepo and workspace
- universal domain contracts
- deterministic greenhouse simulation core
- minimal public demo shell
- CI typecheck and build

## Sprint 2 — Fair comparison
- manual and automatic scenarios from identical initial conditions
- shared weather timeline
- scenario reset, pause and speed control
- KPI comparison

## Sprint 3 — Explainability
- event stream
- reasons for commands
- warnings about stress and irreversible loss
- economic impact attribution

## Sprint 4 — Visual demo
- realtime charts
- weather and equipment animation
- mobile-first SCADA layout
- public deployment

## Sprint 5 — Experiment mode
- heat wave
- drought
- irrigation failure
- pump failure
- sensor failure

## Later
- crop profiles
- ROI and payback
- MQTT/ESP32 integration
- plugin SDK
- additional asset types

## GreenCore software-complete target

До покупки физических датчиков проект развивается как полностью исполняемая программная система. Физическое оборудование не выдаётся за подключённое: его роль выполняют `Digital Twin Controller Emulator` и `Embedded Demo Controller` через тот же controller contract, который позднее будет использовать реальный контроллер.

### Уже закрыто в актуальной Node.js-базе

- runtime: telemetry → state → automation → command → controller ACK
- режимы `AUTO`, `MANUAL`, `SAFE`, `OFFLINE`
- safety interlocks и Policy Engine v1 с `ALLOW/DENY`, `decision_id`, evidence и специализированными тревогами
- JSON recovery snapshot и SQLite history
- controller ownership, heartbeat, TTL, идемпотентные ACK и восстановление после рестарта
- Digital Twin, встроенный эмулятор, сценарии и fault campaigns
- защищённый API, SSE live stream и мобильный Owner Console
- Decision Journal API и read-only Policy Journal в публичном LIVE-контуре
- hardware-ready integration contract для будущего контроллера

### Критерии готовности программного контура

Система считается software-complete, когда все пункты подтверждены фактическим прогоном:

1. эмулятор передаёт телеметрию через controller contract
2. Core принимает, проверяет и сохраняет телеметрию
3. каждое фактическое решение получает `decision_id`, правило/причину и показатели
4. запрещённая команда не доходит до исполнительного устройства и создаёт тревогу
5. разрешённая команда проходит путь до ACK и меняет состояние эмулятора
6. после рестарта восстанавливаются state, pending commands, policy decisions и ACK replay
7. проходят baseline, heatwave, low-water, stale/missing telemetry, controller outage, delivery blackout, actuator failure и offline campaigns
8. владелец с телефона видит live state, decisions, alerts и может безопасно отправить операторскую команду
9. CI, Docker и публичная публикация проверены отдельно и не считаются успешными по одному HTTP 200
10. остаётся отдельный hardware handoff: подключить реальные датчики/реле к существующему контракту без изменения policy/runtime

### Следующий порядок работ

1. завершить и проверить Decision Journal/Policy UI
2. сделать единый acceptance smoke-test для embedded emulator и API
3. зафиксировать зависимости и CI на воспроизводимой установке
4. восстановить и подтвердить публикацию Pages + Render по фактическим URL
5. после появления оборудования провести отдельный полевой pilot по hardware-ready handoff
