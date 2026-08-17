import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from 'react';
import { calculateEconomy, createInitialState, defaultConfig, stepSimulation, } from '@greencore/simulation-core';
import { applyLiveEvent, fetchCoreHealth, initialApiUrl, openCoreLiveStream, runCoreComparison, saveApiUrl, shareUrl, } from './core-api';
const speeds = [60, 300, 1200];
function formatTime(minutes) {
    const day = Math.floor(minutes / 1440) + 1;
    const minuteOfDay = minutes % 1440;
    const hours = Math.floor(minuteOfDay / 60).toString().padStart(2, '0');
    const mins = Math.floor(minuteOfDay % 60).toString().padStart(2, '0');
    return `День ${day}, ${hours}:${mins}`;
}
function duration(seconds) {
    if (seconds < 60)
        return `${seconds.toFixed(0)} сек`;
    const minutes = seconds / 60;
    if (minutes < 60)
        return `${minutes.toFixed(0)} мин`;
    return `${(minutes / 60).toFixed(1)} ч`;
}
function signed(value, digits = 1) {
    return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}
function money(value) {
    return new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency: 'RUB',
        maximumFractionDigits: 0,
    }).format(value);
}
function localDate(value) {
    if (!value)
        return 'нет данных';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'нет данных' : date.toLocaleString('ru-RU');
}
function metric(label, value, danger = false) {
    return (_jsxs("div", { className: `metric ${danger ? 'danger' : ''}`, children: [_jsx("span", { children: label }), _jsx("strong", { children: value })] }));
}
function ScenarioCard({ title, scenario }) {
    const economy = calculateEconomy(scenario.state, {
        ...defaultConfig,
        controlMode: scenario.mode,
    });
    const s = scenario.state;
    const automatic = scenario.mode === 'automatic';
    return (_jsxs("section", { className: "scenario-card", children: [_jsxs("div", { className: "scenario-header", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: automatic ? 'GREENCORE AUTO' : 'ПАССИВНЫЙ BASELINE' }), _jsx("h2", { children: title })] }), _jsxs("div", { className: `status ${scenario.mode}`, children: [_jsx("span", {}), automatic ? 'Автоматика' : 'Без вмешательств'] })] }), _jsxs("div", { className: "equipment-row", children: [_jsxs("div", { className: `equipment ${s.pumpOn ? 'on' : ''}`, children: [_jsx("span", { children: "\u041D\u0430\u0441\u043E\u0441" }), _jsx("b", { children: s.pumpOn ? 'ON' : 'OFF' })] }), _jsxs("div", { className: `equipment ${s.fanOn ? 'on' : ''}`, children: [_jsx("span", { children: "\u0412\u0435\u043D\u0442\u0438\u043B\u044F\u0446\u0438\u044F" }), _jsx("b", { children: s.fanOn ? 'ON' : 'OFF' })] })] }), _jsxs("div", { className: "metrics-grid", children: [metric('Температура', `${s.insideTemperatureC.toFixed(1)} °C`, s.insideTemperatureC > 30), metric('Влажность почвы', `${s.soilMoisturePct.toFixed(1)} %`, s.soilMoisturePct < 38), metric('Здоровье модели', `${s.plantHealthPct.toFixed(1)} %`, s.plantHealthPct < 80), metric('Модельный урожай', `${s.predictedYieldKg.toFixed(1)} кг`), metric('Модельная потеря', `${s.irreversibleYieldLossKg.toFixed(2)} кг`, s.irreversibleYieldLossKg > 0.1), metric('Накопленный стресс', s.accumulatedStress.toFixed(1), s.accumulatedStress > 12)] }), _jsxs("div", { className: "resource-strip", children: [_jsxs("span", { children: ["\u0412\u043E\u0434\u0430 ", _jsxs("b", { children: [s.waterUsedLiters.toFixed(0), " \u043B"] })] }), _jsxs("span", { children: ["\u042D\u043D\u0435\u0440\u0433\u0438\u044F ", _jsxs("b", { children: [s.electricityUsedKwh.toFixed(1), " \u043A\u0412\u0442\u00B7\u0447"] })] }), _jsxs("span", { children: ["\u041C\u043E\u0434\u0435\u043B\u044C\u043D\u044B\u0435 \u0437\u0430\u0442\u0440\u0430\u0442\u044B ", _jsx("b", { children: money(economy.operatingCostRub) })] })] }), _jsxs("div", { className: "profit", children: [_jsx("span", { children: "\u041C\u043E\u0434\u0435\u043B\u044C\u043D\u0430\u044F \u043F\u0440\u0438\u0431\u044B\u043B\u044C" }), _jsx("strong", { children: money(economy.projectedProfitRub) })] })] }));
}
function CoreMetricCard({ label, metrics }) {
    return (_jsxs("article", { className: "core-metric-card", children: [_jsx("p", { className: "eyebrow", children: label }), _jsxs("div", { className: "core-metrics", children: [_jsxs("div", { children: [_jsx("span", { children: "\u0424\u0438\u043D\u0430\u043B\u044C\u043D\u043E\u0435 \u0437\u0434\u043E\u0440\u043E\u0432\u044C\u0435" }), _jsxs("strong", { children: [metrics.final_plant_health_percent.toFixed(1), "%"] })] }), _jsxs("div", { children: [_jsx("span", { children: "\u041C\u0438\u043D\u0438\u043C\u0443\u043C \u043F\u043E\u0447\u0432\u044B" }), _jsxs("strong", { children: [metrics.min_soil_moisture_percent.toFixed(1), "%"] })] }), _jsxs("div", { children: [_jsx("span", { children: "\u041F\u0438\u043A \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u044B" }), _jsxs("strong", { children: [metrics.max_air_temperature_c.toFixed(1), "\u00B0C"] })] }), _jsxs("div", { children: [_jsx("span", { children: "\u0420\u0430\u0441\u0445\u043E\u0434 \u0432\u043E\u0434\u044B" }), _jsxs("strong", { children: [metrics.cumulative_water_used_percent.toFixed(1), "% \u0431\u0430\u043A\u0430"] })] }), _jsxs("div", { children: [_jsx("span", { children: "\u0420\u0430\u0431\u043E\u0442\u0430 \u043D\u0430\u0441\u043E\u0441\u0430" }), _jsx("strong", { children: duration(metrics.pump_runtime_seconds) })] }), _jsxs("div", { children: [_jsx("span", { children: "\u041A\u043E\u043C\u0430\u043D\u0434\u044B / \u0442\u0440\u0435\u0432\u043E\u0433\u0438" }), _jsxs("strong", { children: [metrics.command_count, " / ", metrics.alert_count] })] })] })] }));
}
function connectionLabel(status) {
    if (status === 'open')
        return 'LIVE подключён';
    if (status === 'connecting')
        return 'Подключение…';
    if (status === 'retrying')
        return 'Переподключение…';
    if (status === 'closed')
        return 'Поток закрыт';
    return 'API не подключён';
}
function telemetryLabel(metricName) {
    const labels = {
        soil_moisture: 'Влажность почвы',
        air_temperature: 'Температура воздуха',
        air_humidity: 'Влажность воздуха',
        water_level: 'Уровень воды',
    };
    return labels[metricName] ?? metricName;
}
function telemetryValue(sample) {
    if (!sample)
        return '—';
    return `${sample.value.toFixed(1)} ${sample.unit}`;
}
function eventSummary(record) {
    const payload = record.data && typeof record.data === 'object' ? record.data : {};
    if (record.event === 'telemetry')
        return `Принято измерений: ${String(payload.accepted_count ?? '—')}`;
    if (record.event === 'controller.heartbeat')
        return `${String(payload.controller_id ?? 'контроллер')} → ${String(payload.status ?? 'UNKNOWN')}`;
    if (record.event === 'commands.delivered')
        return `Команды доставлены: ${Array.isArray(payload.commands) ? payload.commands.length : 0}`;
    if (record.event === 'command.acknowledged') {
        const command = payload.command && typeof payload.command === 'object' ? payload.command : {};
        return `${String(command.actuator_id ?? 'устройство')} ${String(command.action ?? '')} → ${String(command.delivery_status ?? 'ACK')}`;
    }
    if (record.event === 'mode.changed')
        return `Режим: ${String(payload.configured_mode ?? 'UNKNOWN')}`;
    if (record.event === 'connectivity.changed')
        return `Связь: ${payload.connected === false ? 'OFFLINE' : 'ONLINE'}`;
    if (record.event === 'simulation.completed')
        return `Сценарий завершён: ${String(payload.name ?? payload.report_id ?? 'simulation')}`;
    if (record.event === 'automation.evaluated')
        return 'Автоматический цикл принятия решений';
    if (record.event === 'snapshot')
        return 'Получено актуальное состояние GreenCore';
    return record.event;
}
function LiveOperationsPanel({ apiUrl, status, health, snapshot, events, lastEventAt, }) {
    const state = snapshot?.state;
    const telemetry = state?.telemetry ?? {};
    const controllers = state?.controllers ?? [];
    const actuators = state?.actuators ?? {};
    const pendingCommands = state?.pending_commands ?? [];
    const queue = snapshot?.simulation_queue ?? health?.simulation_queue;
    return (_jsxs("section", { className: "live-operations", children: [_jsxs("div", { className: "live-heading", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "GREENCORE LIVE OPERATIONS" }), _jsx("h3", { children: "\u0416\u0438\u0432\u043E\u0439 \u043A\u043E\u043D\u0442\u0443\u0440: \u043A\u043E\u043D\u0442\u0440\u043E\u043B\u043B\u0435\u0440 \u2192 \u0442\u0435\u043B\u0435\u043C\u0435\u0442\u0440\u0438\u044F \u2192 \u0440\u0435\u0448\u0435\u043D\u0438\u0435 \u2192 \u043A\u043E\u043C\u0430\u043D\u0434\u0430 \u2192 ACK" }), _jsx("p", { children: apiUrl ? apiUrl : 'Укажите публичный адрес GreenCore API, чтобы открыть живой поток.' })] }), _jsxs("div", { className: `live-status ${status}`, children: [_jsx("span", {}), connectionLabel(status)] })] }), !snapshot && (_jsxs("div", { className: "live-empty", children: [_jsx("strong", { children: status === 'retrying' ? 'API пока недоступен' : 'Живые данные ещё не получены' }), _jsx("p", { children: "\u0410\u0432\u0442\u043E\u043D\u043E\u043C\u043D\u0430\u044F \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u043D\u0430\u044F \u043C\u043E\u0434\u0435\u043B\u044C \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0435\u0442 \u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C. SSE \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u043F\u043E\u0441\u043B\u0435 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E\u0441\u0442\u0438 API." })] })), snapshot && state && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "live-summary", children: [_jsxs("div", { children: [_jsx("span", { children: "Core" }), _jsxs("strong", { children: ["v", health?.version ?? '0.12.0'] })] }), _jsxs("div", { children: [_jsx("span", { children: "\u0420\u0435\u0436\u0438\u043C" }), _jsx("strong", { children: state.effective_mode })] }), _jsxs("div", { children: [_jsx("span", { children: "\u0412\u043D\u0435\u0448\u043D\u044F\u044F \u0441\u0432\u044F\u0437\u044C" }), _jsx("strong", { children: state.connected ? 'ONLINE' : 'OFFLINE' })] }), _jsxs("div", { children: [_jsx("span", { children: "\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0435 \u0441\u043E\u0431\u044B\u0442\u0438\u0435" }), _jsx("strong", { children: localDate(lastEventAt ?? state.generated_at) })] })] }), _jsxs("div", { className: "live-grid", children: [_jsxs("article", { className: "live-card", children: [_jsxs("div", { className: "live-card-heading", children: [_jsx("span", { children: "\u0422\u0435\u043B\u0435\u043C\u0435\u0442\u0440\u0438\u044F" }), _jsx("b", { children: Object.keys(telemetry).length })] }), _jsx("div", { className: "telemetry-list", children: ['soil_moisture', 'air_temperature', 'air_humidity', 'water_level'].map(metricName => {
                                            const sample = telemetry[metricName];
                                            return (_jsxs("div", { className: !sample || sample.quality !== 'GOOD' ? 'warning' : '', children: [_jsx("span", { children: telemetryLabel(metricName) }), _jsx("strong", { children: telemetryValue(sample) }), _jsx("small", { children: sample ? `${sample.quality} · ${localDate(sample.timestamp)}` : 'нет данных' })] }, metricName));
                                        }) })] }), _jsxs("article", { className: "live-card", children: [_jsxs("div", { className: "live-card-heading", children: [_jsx("span", { children: "\u041A\u043E\u043D\u0442\u0440\u043E\u043B\u043B\u0435\u0440\u044B" }), _jsx("b", { children: controllers.length })] }), _jsxs("div", { className: "controller-list", children: [controllers.length === 0 && _jsx("p", { className: "muted", children: "\u041A\u043E\u043D\u0442\u0440\u043E\u043B\u043B\u0435\u0440\u044B \u043D\u0435 \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u044B." }), controllers.map(controller => (_jsxs("div", { children: [_jsxs("div", { children: [_jsx("strong", { children: controller.name ?? controller.controller_id }), _jsxs("small", { children: [controller.controller_id, " \u00B7 ", controller.firmware ?? 'firmware unknown'] })] }), _jsx("span", { className: `controller-state ${(controller.status ?? 'UNKNOWN').toLowerCase()}`, children: controller.status ?? 'UNKNOWN' }), _jsxs("small", { children: ["Heartbeat: ", localDate(controller.last_heartbeat)] })] }, controller.controller_id)))] })] }), _jsxs("article", { className: "live-card", children: [_jsxs("div", { className: "live-card-heading", children: [_jsx("span", { children: "\u0418\u0441\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430" }), _jsx("b", { children: Object.keys(actuators).length })] }), _jsx("div", { className: "actuator-list", children: Object.entries(actuators).map(([id, actuator]) => (_jsxs("div", { className: ['ON', 'OPEN'].includes(actuator.state) ? 'active' : '', children: [_jsxs("span", { children: [id, _jsx("small", { children: actuator.type })] }), _jsx("strong", { children: actuator.state })] }, id))) }), _jsxs("div", { className: "queue-strip", children: [_jsx("span", { children: "Simulation queue" }), _jsxs("strong", { children: [queue?.active ?? 0, " active / ", queue?.queued ?? 0, " queued"] })] })] }), _jsxs("article", { className: "live-card", children: [_jsxs("div", { className: "live-card-heading", children: [_jsx("span", { children: "\u041A\u043E\u043C\u0430\u043D\u0434\u044B \u0438 ACK" }), _jsx("b", { children: pendingCommands.length })] }), _jsxs("div", { className: "command-list", children: [pendingCommands.length === 0 && _jsx("p", { className: "muted", children: "\u041D\u0435\u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D\u043D\u044B\u0445 \u043A\u043E\u043C\u0430\u043D\u0434 \u043D\u0435\u0442." }), pendingCommands.slice(0, 6).map(command => (_jsxs("div", { children: [_jsxs("strong", { children: [command.actuator_id, " \u00B7 ", command.action] }), _jsx("span", { children: command.delivery_status ?? 'QUEUED' }), _jsx("small", { children: command.reason ?? command.command_id })] }, command.command_id)))] })] })] }), _jsxs("article", { className: "event-stream-card", children: [_jsxs("div", { className: "live-card-heading", children: [_jsx("span", { children: "\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 live-\u0441\u043E\u0431\u044B\u0442\u0438\u044F" }), _jsx("b", { children: events.length })] }), _jsxs("div", { className: "event-list", children: [events.length === 0 && _jsx("p", { className: "muted", children: "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0441\u043E\u0431\u044B\u0442\u0438\u0439\u2026" }), events.map((event, index) => (_jsxs("div", { children: [_jsx("span", { children: event.event }), _jsx("strong", { children: eventSummary(event) }), _jsxs("small", { children: [localDate(event.received_at), event.id ? ` · #${event.id}` : ''] })] }, `${event.id ?? 'direct'}-${event.received_at}-${index}`)))] })] })] }))] }));
}
function CoreVerification({ apiDraft, apiUrl, loading, error, report, copied, liveStatus, health, liveSnapshot, liveEvents, lastEventAt, onDraftChange, onConnect, onRun, onCopy, }) {
    const auto = report?.strategies.automatic.metrics;
    const manual = report?.strategies.manual_baseline.metrics;
    return (_jsxs("section", { className: "core-verification", children: [_jsxs("div", { className: "verification-heading", children: [_jsxs("div", { children: [_jsxs("p", { className: "eyebrow", children: ["GREENCORE CORE v", health?.version ?? '0.12.0'] }), _jsx("h3", { children: "\u041F\u0443\u0431\u043B\u0438\u0447\u043D\u0430\u044F \u0441\u0435\u0440\u0432\u0435\u0440\u043D\u0430\u044F \u0434\u0435\u043C\u043E\u043D\u0441\u0442\u0440\u0430\u0446\u0438\u044F \u0438 \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u043E\u0434\u0438\u043C\u0430\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0430" }), _jsx("p", { children: "Live-\u043F\u043E\u0442\u043E\u043A \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u0444\u0430\u043A\u0442\u0438\u0447\u0435\u0441\u043A\u043E\u0435 \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 Core. \u0421\u0440\u0430\u0432\u043D\u0435\u043D\u0438\u0435 24 \u0447\u0430\u0441\u043E\u0432 \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u043E \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0435\u0442 \u043E\u0434\u0438\u043D\u0430\u043A\u043E\u0432\u044B\u0435 \u0443\u0441\u043B\u043E\u0432\u0438\u044F \u0434\u043B\u044F AUTO \u0438 baseline \u0431\u0435\u0437 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0441\u043A\u0438\u0445 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0439." })] }), _jsx("span", { className: `api-status ${liveStatus === 'open' ? 'connected' : liveStatus === 'retrying' ? 'warning' : ''}`, children: connectionLabel(liveStatus) })] }), _jsxs("div", { className: "api-controls", children: [_jsxs("label", { children: [_jsx("span", { children: "\u0410\u0434\u0440\u0435\u0441 GreenCore API" }), _jsx("input", { value: apiDraft, onChange: event => onDraftChange(event.target.value), placeholder: "https://api.example.com", inputMode: "url" })] }), _jsx("button", { className: "primary", onClick: onConnect, children: "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C LIVE" }), _jsx("button", { onClick: onRun, disabled: loading, children: loading ? 'Считаю…' : 'Проверка 24 ч' }), _jsx("button", { onClick: onCopy, disabled: !apiUrl, children: copied ? 'Ссылка скопирована' : 'Скопировать публичную ссылку' })] }), error && _jsx("p", { className: "api-error", children: error }), !apiUrl && !report && _jsx("p", { className: "api-note", children: "\u0418\u043D\u0442\u0435\u0440\u0430\u043A\u0442\u0438\u0432\u043D\u0430\u044F \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u043D\u0430\u044F \u043C\u043E\u0434\u0435\u043B\u044C \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0430\u0432\u0442\u043E\u043D\u043E\u043C\u043D\u043E. \u0414\u043B\u044F \u0441\u0435\u0440\u0432\u0435\u0440\u043D\u043E\u0439 \u0434\u0435\u043C\u043E\u043D\u0441\u0442\u0440\u0430\u0446\u0438\u0438 \u043D\u0443\u0436\u0435\u043D \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D\u043D\u044B\u0439 GreenCore API \u0441 \u043F\u0443\u0431\u043B\u0438\u0447\u043D\u044B\u043C read-only SSE." }), _jsx(LiveOperationsPanel, { apiUrl: apiUrl, status: liveStatus, health: health, snapshot: liveSnapshot, events: liveEvents, lastEventAt: lastEventAt }), report && auto && manual && (_jsxs("section", { className: "comparison-report", children: [_jsxs("div", { className: "server-deltas", children: [_jsxs("div", { children: [_jsx("span", { children: "\u0417\u0434\u043E\u0440\u043E\u0432\u044C\u0435 AUTO \u2212 baseline" }), _jsxs("strong", { children: [signed(report.automatic_minus_manual.final_plant_health_percent), " \u043F.\u043F."] })] }), _jsxs("div", { children: [_jsx("span", { children: "\u0421\u043D\u0438\u0436\u0435\u043D\u0438\u0435 \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u043D\u043E\u0433\u043E \u043F\u0438\u043A\u0430" }), _jsxs("strong", { children: [signed(manual.max_air_temperature_c - auto.max_air_temperature_c), " \u00B0C"] })] }), _jsxs("div", { children: [_jsx("span", { children: "\u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0435 \u0440\u0430\u0441\u0445\u043E\u0434\u0430 \u0432\u043E\u0434\u044B" }), _jsxs("strong", { children: [signed(report.automatic_minus_manual.cumulative_water_used_percent), "% \u0431\u0430\u043A\u0430"] })] }), _jsxs("div", { children: [_jsx("span", { children: "\u041D\u0430\u0440\u0443\u0448\u0435\u043D\u0438\u044F safety" }), _jsxs("strong", { children: [auto.safety_violation_count, " / ", manual.safety_violation_count] })] })] }), _jsxs("div", { className: "core-comparison-grid", children: [_jsx(CoreMetricCard, { label: "AUTO", metrics: auto }), _jsx(CoreMetricCard, { label: "MANUAL \u0411\u0415\u0417 \u0412\u041C\u0415\u0428\u0410\u0422\u0415\u041B\u042C\u0421\u0422\u0412", metrics: manual })] }), _jsxs("div", { className: "report-meta", children: [_jsxs("span", { children: ["Report ID: ", _jsx("b", { children: report.report_id })] }), _jsx("span", { children: new Date(report.created_at).toLocaleString('ru-RU') })] }), _jsxs("p", { className: "model-notice", children: [report.model_notice, " ", report.interpretation.note] })] }))] }));
}
export function App() {
    const configuredApi = useMemo(() => initialApiUrl(), []);
    const [running, setRunning] = useState(true);
    const [speed, setSpeed] = useState(300);
    const [automatic, setAutomatic] = useState({ mode: 'automatic', state: createInitialState() });
    const [manual, setManual] = useState({ mode: 'manual', state: createInitialState() });
    const [apiUrl, setApiUrl] = useState(configuredApi);
    const [apiDraft, setApiDraft] = useState(configuredApi);
    const [loading, setLoading] = useState(false);
    const [apiError, setApiError] = useState('');
    const [report, setReport] = useState(null);
    const [copied, setCopied] = useState(false);
    const [liveStatus, setLiveStatus] = useState(configuredApi ? 'connecting' : 'idle');
    const [health, setHealth] = useState(null);
    const [liveSnapshot, setLiveSnapshot] = useState(null);
    const [liveEvents, setLiveEvents] = useState([]);
    const [lastEventAt, setLastEventAt] = useState(null);
    useEffect(() => {
        if (!running)
            return;
        const timer = window.setInterval(() => {
            const stepMinutes = speed / 60;
            setAutomatic(current => ({
                ...current,
                state: stepSimulation(current.state, { ...defaultConfig, controlMode: 'automatic' }, stepMinutes),
            }));
            setManual(current => ({
                ...current,
                state: stepSimulation(current.state, { ...defaultConfig, controlMode: 'manual' }, stepMinutes),
            }));
        }, 1000);
        return () => window.clearInterval(timer);
    }, [running, speed]);
    useEffect(() => {
        if (!apiUrl) {
            setLiveStatus('idle');
            setHealth(null);
            setLiveSnapshot(null);
            setLiveEvents([]);
            setLastEventAt(null);
            return;
        }
        let active = true;
        setLiveEvents([]);
        setLiveSnapshot(null);
        setLastEventAt(null);
        void fetchCoreHealth(apiUrl)
            .then(result => { if (active)
            setHealth(result); })
            .catch(error => { if (active)
            setApiError(error instanceof Error ? error.message : 'Не удалось проверить GreenCore API'); });
        let closeStream = () => { };
        try {
            closeStream = openCoreLiveStream(apiUrl, {
                onStatus: status => { if (active)
                    setLiveStatus(status); },
                onEvent: event => {
                    if (!active)
                        return;
                    setLastEventAt(event.received_at);
                    setLiveEvents(current => [event, ...current].slice(0, 12));
                    setLiveSnapshot(current => applyLiveEvent(current, event));
                },
            });
        }
        catch (error) {
            setLiveStatus('closed');
            setApiError(error instanceof Error ? error.message : 'Не удалось открыть live-поток');
        }
        return () => {
            active = false;
            closeStream();
        };
    }, [apiUrl]);
    const comparison = useMemo(() => {
        const autoEconomy = calculateEconomy(automatic.state, { ...defaultConfig, controlMode: 'automatic' });
        const manualEconomy = calculateEconomy(manual.state, { ...defaultConfig, controlMode: 'manual' });
        return {
            yield: automatic.state.predictedYieldKg - manual.state.predictedYieldKg,
            profit: autoEconomy.projectedProfitRub - manualEconomy.projectedProfitRub,
            lossPrevented: manual.state.irreversibleYieldLossKg - automatic.state.irreversibleYieldLossKg,
        };
    }, [automatic, manual]);
    const reset = () => {
        setAutomatic({ mode: 'automatic', state: createInitialState() });
        setManual({ mode: 'manual', state: createInitialState() });
        setRunning(true);
    };
    const applyApiUrl = () => {
        const normalized = saveApiUrl(apiDraft);
        if (!normalized)
            throw new Error('Укажите адрес GreenCore API');
        setApiUrl(normalized);
        setApiError('');
        const url = new URL(window.location.href);
        url.searchParams.set('api', normalized);
        window.history.replaceState({}, '', url);
        return normalized;
    };
    const connectToCore = () => {
        try {
            applyApiUrl();
        }
        catch (error) {
            setApiError(error instanceof Error ? error.message : 'Некорректный адрес GreenCore API');
        }
    };
    const verifyWithCore = async () => {
        setLoading(true);
        setApiError('');
        setCopied(false);
        try {
            const normalized = applyApiUrl();
            const nextReport = await runCoreComparison(normalized);
            setReport(nextReport);
        }
        catch (error) {
            setApiError(error instanceof Error ? error.message : 'Не удалось выполнить проверку');
        }
        finally {
            setLoading(false);
        }
    };
    const copyPublicLink = async () => {
        try {
            await navigator.clipboard.writeText(shareUrl(apiUrl));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2500);
        }
        catch {
            setApiError('Браузер не разрешил копирование. Скопируйте адрес из строки браузера.');
        }
    };
    return (_jsxs("main", { children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "DIGITAL TWIN PLATFORM" }), _jsx("h1", { children: "GreenCore" }), _jsx("p", { className: "subtitle", children: "\u0416\u0438\u0432\u043E\u0435 \u0441\u0440\u0430\u0432\u043D\u0435\u043D\u0438\u0435 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u043A\u0438 \u0441 baseline \u0431\u0435\u0437 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0441\u043A\u0438\u0445 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0439" })] }), _jsxs("div", { className: "clock", children: [_jsx("span", { children: "\u0412\u0438\u0440\u0442\u0443\u0430\u043B\u044C\u043D\u043E\u0435 \u0432\u0440\u0435\u043C\u044F \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u043D\u043E\u0439 \u043C\u043E\u0434\u0435\u043B\u0438" }), _jsx("strong", { children: formatTime(automatic.state.simulatedMinutes) })] })] }), _jsxs("nav", { className: "controls", children: [_jsx("button", { className: "primary", onClick: () => setRunning(value => !value), children: running ? 'Пауза' : 'Продолжить' }), speeds.map(item => _jsxs("button", { className: speed === item ? 'active' : '', onClick: () => setSpeed(item), children: ["\u00D7", item] }, item)), _jsx("button", { onClick: reset, children: "\u0421\u0431\u0440\u043E\u0441\u0438\u0442\u044C" })] }), _jsxs("section", { className: "comparison-banner", children: [_jsxs("div", { children: [_jsx("span", { children: "\u041C\u043E\u0434\u0435\u043B\u044C\u043D\u044B\u0439 \u0434\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0439 \u0443\u0440\u043E\u0436\u0430\u0439" }), _jsxs("strong", { children: ["+", comparison.yield.toFixed(2), " \u043A\u0433"] })] }), _jsxs("div", { children: [_jsx("span", { children: "\u041C\u043E\u0434\u0435\u043B\u044C\u043D\u044B\u0435 \u043F\u0440\u0435\u0434\u043E\u0442\u0432\u0440\u0430\u0449\u0451\u043D\u043D\u044B\u0435 \u043F\u043E\u0442\u0435\u0440\u0438" }), _jsxs("strong", { children: [comparison.lossPrevented.toFixed(2), " \u043A\u0433"] })] }), _jsxs("div", { children: [_jsx("span", { children: "\u041C\u043E\u0434\u0435\u043B\u044C\u043D\u044B\u0439 \u044D\u0444\u0444\u0435\u043A\u0442 \u043D\u0430 \u043F\u0440\u0438\u0431\u044B\u043B\u044C" }), _jsxs("strong", { children: [comparison.profit >= 0 ? '+' : '', money(comparison.profit)] })] })] }), _jsxs("div", { className: "scenarios", children: [_jsx(ScenarioCard, { title: "\u0423\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435 GreenCore", scenario: automatic }), _jsx(ScenarioCard, { title: "\u0411\u0435\u0437 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0441\u043A\u0438\u0445 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0439", scenario: manual })] }), _jsxs("section", { className: "model-warning", children: [_jsx("strong", { children: "\u0427\u0442\u043E \u0438\u043C\u0435\u043D\u043D\u043E \u043F\u043E\u043A\u0430\u0437\u0430\u043D\u043E" }), _jsx("p", { children: "\u041E\u0431\u0430 \u0441\u0446\u0435\u043D\u0430\u0440\u0438\u044F \u043F\u043E\u043B\u0443\u0447\u0430\u044E\u0442 \u043E\u0434\u0438\u043D\u0430\u043A\u043E\u0432\u0443\u044E \u043F\u043E\u0433\u043E\u0434\u0443 \u0438 \u0441\u0442\u0430\u0440\u0442\u043E\u0432\u044B\u0435 \u0443\u0441\u043B\u043E\u0432\u0438\u044F. \u0420\u0430\u0437\u043D\u0438\u0446\u0430 \u0441\u043E\u0437\u0434\u0430\u0451\u0442\u0441\u044F \u043B\u043E\u0433\u0438\u043A\u043E\u0439 \u043D\u0430\u0441\u043E\u0441\u0430 \u0438 \u0432\u0435\u043D\u0442\u0438\u043B\u044F\u0446\u0438\u0438. \u0423\u0440\u043E\u0436\u0430\u0439 \u0438 \u043F\u0440\u0438\u0431\u044B\u043B\u044C \u2014 \u0434\u0435\u043C\u043E\u043D\u0441\u0442\u0440\u0430\u0446\u0438\u043E\u043D\u043D\u044B\u0435 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u0435\u043B\u0438 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u043D\u043E\u0439 \u043C\u043E\u0434\u0435\u043B\u0438, \u043D\u0435 \u0430\u0433\u0440\u043E\u043D\u043E\u043C\u0438\u0447\u0435\u0441\u043A\u0438\u0439 \u0438\u043B\u0438 \u0438\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u043E\u043D\u043D\u044B\u0439 \u043F\u0440\u043E\u0433\u043D\u043E\u0437." })] }), _jsx(CoreVerification, { apiDraft: apiDraft, apiUrl: apiUrl, loading: loading, error: apiError, report: report, copied: copied, liveStatus: liveStatus, health: health, liveSnapshot: liveSnapshot, liveEvents: liveEvents, lastEventAt: lastEventAt, onDraftChange: setApiDraft, onConnect: connectToCore, onRun: () => void verifyWithCore(), onCopy: () => void copyPublicLink() }), _jsxs("section", { className: "explanation", children: [_jsx("p", { className: "eyebrow", children: "\u041F\u041E\u0427\u0415\u041C\u0423 \u041C\u0415\u041D\u042F\u0415\u0422\u0421\u042F \u0420\u0415\u0417\u0423\u041B\u042C\u0422\u0410\u0422" }), _jsx("h3", { children: "\u0410\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u043A\u0430 \u0440\u0435\u0430\u0433\u0438\u0440\u0443\u0435\u0442 \u0434\u043E \u0442\u043E\u0433\u043E, \u043A\u0430\u043A \u0434\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0439 \u0432\u044B\u0445\u043E\u0434 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u043E\u0432 \u0438\u0437 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430 \u043D\u0430\u043A\u0430\u043F\u043B\u0438\u0432\u0430\u0435\u0442 \u043C\u043E\u0434\u0435\u043B\u044C\u043D\u044B\u0439 \u0441\u0442\u0440\u0435\u0441\u0441." }), _jsx("p", { children: "Dashboard \u0440\u0430\u0437\u0434\u0435\u043B\u044F\u0435\u0442 \u0442\u0440\u0438 \u0432\u0435\u0449\u0438: \u0431\u044B\u0441\u0442\u0440\u044B\u0439 digital twin \u0432 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435, \u0436\u0438\u0432\u043E\u0439 \u0441\u0435\u0440\u0432\u0435\u0440\u043D\u044B\u0439 \u043A\u043E\u043D\u0442\u0443\u0440 GreenCore \u0438 \u0432\u043E\u0441\u043F\u0440\u043E\u0438\u0437\u0432\u043E\u0434\u0438\u043C\u044B\u0439 \u0441\u0440\u0430\u0432\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0439 \u043E\u0442\u0447\u0451\u0442." })] })] }));
}
