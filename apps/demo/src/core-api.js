const LIVE_EVENTS = [
    'snapshot',
    'telemetry',
    'controller.registered',
    'controller.heartbeat',
    'commands.delivered',
    'command.acknowledged',
    'manual-command.queued',
    'mode.changed',
    'connectivity.changed',
    'automation.evaluated',
    'simulation.completed',
    'automation.cycle',
];
const TERMINAL = new Set(['EXECUTED', 'REJECTED', 'EXPIRED', 'FAILED']);
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function errorMessage(payload, status) {
    const body = record(payload);
    return text(body.message, `GreenCore API returned HTTP ${status}`);
}
function telemetrySample(value, fallbackMetric = '') {
    const sample = record(value);
    const metric = text(sample.metric, fallbackMetric);
    const numeric = finite(sample.value);
    if (!metric || numeric === null)
        return null;
    return {
        device_id: text(sample.device_id, metric),
        metric,
        value: numeric,
        unit: text(sample.unit),
        quality: text(sample.quality, 'UNKNOWN'),
        timestamp: text(sample.timestamp),
        simulation_time: text(sample.simulation_time) || undefined,
    };
}
function telemetryMap(value) {
    const result = {};
    for (const [metric, raw] of Object.entries(record(value))) {
        const sample = telemetrySample(raw, metric);
        if (sample)
            result[sample.metric] = sample;
    }
    return result;
}
function actuatorMap(value) {
    const result = {};
    for (const [id, raw] of Object.entries(record(value))) {
        const actuator = record(raw);
        result[id] = {
            type: text(actuator.type, 'unknown'),
            state: text(actuator.state, 'UNKNOWN'),
            changedAt: text(actuator.changedAt) || null,
        };
    }
    return result;
}
function controllerList(value) {
    const values = Array.isArray(value) ? value : Object.values(record(value));
    return values.map(raw => {
        const controller = record(raw);
        return {
            controller_id: text(controller.controller_id, 'unknown'),
            name: text(controller.name) || undefined,
            status: text(controller.status, 'UNKNOWN'),
            firmware: text(controller.firmware) || undefined,
            last_heartbeat: text(controller.last_heartbeat) || null,
            registered_at: text(controller.registered_at) || undefined,
            devices: Array.isArray(controller.devices)
                ? controller.devices.filter((item) => typeof item === 'string')
                : undefined,
        };
    });
}
function commandList(value) {
    if (!Array.isArray(value))
        return [];
    return value.map(raw => {
        const command = record(raw);
        return {
            command_id: text(command.command_id, 'unknown'),
            controller_id: text(command.controller_id) || undefined,
            actuator_id: text(command.actuator_id, 'unknown'),
            actuator_type: text(command.actuator_type) || undefined,
            action: text(command.action, 'UNKNOWN'),
            reason: text(command.reason) || undefined,
            mode: text(command.mode) || undefined,
            delivery_status: text(command.delivery_status) || undefined,
            issued_at: text(command.issued_at) || undefined,
            expires_at: text(command.expires_at) || undefined,
        };
    });
}
function alertList(value) {
    if (!Array.isArray(value))
        return [];
    return value.map(raw => {
        const alert = record(raw);
        return {
            type: text(alert.type, 'UNKNOWN_ALERT'),
            timestamp: text(alert.timestamp) || undefined,
            details: record(alert.details),
        };
    });
}
function queueStatus(value) {
    const queue = record(value);
    return {
        active: finite(queue.active) ?? 0,
        queued: finite(queue.queued) ?? 0,
        max_concurrent: finite(queue.max_concurrent) ?? 0,
        max_queued: finite(queue.max_queued) ?? 0,
        completed: finite(queue.completed) ?? 0,
        rejected: finite(queue.rejected) ?? 0,
    };
}
function runtimeState(value) {
    const state = record(value);
    const commands = commandList(state.pending_commands);
    const inferredMode = commands.find(command => command.mode)?.mode ?? 'UNKNOWN';
    const configuredMode = text(state.configured_mode, text(state.mode, inferredMode));
    return {
        generated_at: text(state.generated_at, new Date().toISOString()),
        configured_mode: configuredMode,
        effective_mode: text(state.effective_mode, configuredMode),
        connected: state.connected !== false,
        telemetry: telemetryMap(state.telemetry),
        actuators: actuatorMap(state.actuators),
        controllers: controllerList(state.controllers),
        pending_commands: commands,
        alerts: alertList(state.alerts),
    };
}
export function normalizeLiveSnapshot(value) {
    const snapshot = record(value);
    return {
        state: runtimeState(snapshot.state),
        simulation_queue: queueStatus(snapshot.simulation_queue),
    };
}
function mergeController(controllers, patch) {
    const existing = controllers.find(item => item.controller_id === patch.controller_id);
    return existing
        ? controllers.map(item => item.controller_id === patch.controller_id ? { ...item, ...patch } : item)
        : [...controllers, patch];
}
function mergeCommands(existing, incoming) {
    const merged = new Map(existing.map(command => [command.command_id, command]));
    for (const command of incoming)
        merged.set(command.command_id, { ...merged.get(command.command_id), ...command });
    return [...merged.values()];
}
export function applyLiveEvent(current, event) {
    if (event.event === 'snapshot')
        return normalizeLiveSnapshot(event.data);
    if (!current)
        return null;
    const payload = record(event.data);
    if (event.event === 'automation.evaluated') {
        return { ...current, state: runtimeState(payload.state) };
    }
    if (event.event === 'telemetry') {
        const telemetry = { ...current.state.telemetry };
        if (Array.isArray(payload.samples)) {
            for (const raw of payload.samples) {
                const sample = telemetrySample(raw);
                if (sample)
                    telemetry[sample.metric] = sample;
            }
        }
        return { ...current, state: { ...current.state, telemetry, generated_at: event.received_at } };
    }
    if (event.event === 'controller.registered') {
        const controller = controllerList([payload.controller])[0];
        if (!controller)
            return current;
        return {
            ...current,
            state: {
                ...current.state,
                controllers: mergeController(current.state.controllers, controller),
                generated_at: event.received_at,
            },
        };
    }
    if (event.event === 'controller.heartbeat') {
        const patch = {
            controller_id: text(payload.controller_id, 'unknown'),
            status: text(payload.status, 'UNKNOWN'),
            last_heartbeat: text(payload.last_heartbeat) || null,
        };
        return {
            ...current,
            state: {
                ...current.state,
                controllers: mergeController(current.state.controllers, patch),
                generated_at: event.received_at,
            },
        };
    }
    if (event.event === 'commands.delivered') {
        return {
            ...current,
            state: {
                ...current.state,
                pending_commands: mergeCommands(current.state.pending_commands, commandList(payload.commands)),
                generated_at: event.received_at,
            },
        };
    }
    if (event.event === 'command.acknowledged') {
        const command = commandList([payload.command])[0];
        if (!command)
            return current;
        const status = command.delivery_status ?? '';
        const pendingCommands = TERMINAL.has(status)
            ? current.state.pending_commands.filter(item => item.command_id !== command.command_id)
            : mergeCommands(current.state.pending_commands, [command]);
        const actuators = { ...current.state.actuators };
        const existingActuator = actuators[command.actuator_id];
        if (status === 'EXECUTED' && existingActuator) {
            actuators[command.actuator_id] = {
                type: existingActuator.type,
                state: command.action === 'CLOSE' ? 'CLOSED' : command.action,
                changedAt: event.received_at,
            };
        }
        return {
            ...current,
            state: { ...current.state, pending_commands: pendingCommands, actuators, generated_at: event.received_at },
        };
    }
    if (event.event === 'mode.changed') {
        const mode = text(payload.configured_mode, current.state.configured_mode);
        return { ...current, state: { ...current.state, configured_mode: mode, effective_mode: mode, generated_at: event.received_at } };
    }
    if (event.event === 'connectivity.changed') {
        const connected = payload.connected !== false;
        return {
            ...current,
            state: {
                ...current.state,
                connected,
                effective_mode: connected ? current.state.configured_mode : 'OFFLINE',
                generated_at: event.received_at,
            },
        };
    }
    return current;
}
export function normalizeApiUrl(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return '';
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('API URL must use http or https');
    return parsed.toString().replace(/\/$/, '');
}
export function initialApiUrl() {
    const query = new URLSearchParams(window.location.search).get('api');
    const saved = window.localStorage.getItem('greencore-api-url');
    const configured = import.meta.env.VITE_GREENCORE_API_URL;
    for (const candidate of [query, saved, configured]) {
        if (!candidate)
            continue;
        try {
            return normalizeApiUrl(candidate);
        }
        catch {
            // Ignore invalid saved/configured values and keep the offline demo usable.
        }
    }
    return '';
}
export function saveApiUrl(value) {
    const normalized = normalizeApiUrl(value);
    if (normalized)
        window.localStorage.setItem('greencore-api-url', normalized);
    else
        window.localStorage.removeItem('greencore-api-url');
    return normalized;
}
export function shareUrl(apiUrl) {
    const url = new URL(window.location.href);
    url.search = '';
    if (apiUrl)
        url.searchParams.set('api', normalizeApiUrl(apiUrl));
    return url.toString();
}
export async function fetchCoreHealth(apiUrl) {
    const normalized = normalizeApiUrl(apiUrl);
    if (!normalized)
        throw new Error('Укажите адрес GreenCore API');
    const response = await fetch(`${normalized}/health`, { cache: 'no-store' });
    const payload = await response.json().catch(() => null);
    if (!response.ok)
        throw new Error(errorMessage(payload, response.status));
    return payload;
}
export function openCoreLiveStream(apiUrl, handlers) {
    const normalized = normalizeApiUrl(apiUrl);
    if (!normalized)
        throw new Error('Укажите адрес GreenCore API');
    handlers.onStatus?.('connecting');
    const source = new EventSource(`${normalized}/live`);
    source.onopen = () => handlers.onStatus?.('open');
    source.onerror = () => handlers.onStatus?.(source.readyState === EventSource.CLOSED ? 'closed' : 'retrying');
    const listeners = LIVE_EVENTS.map(eventName => {
        const listener = rawEvent => {
            const message = rawEvent;
            let data = null;
            try {
                data = JSON.parse(message.data);
            }
            catch {
                data = { malformed: true, raw: message.data };
            }
            const parsedId = Number(message.lastEventId);
            handlers.onEvent?.({
                id: Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null,
                event: eventName,
                data,
                received_at: new Date().toISOString(),
            });
        };
        source.addEventListener(eventName, listener);
        return { eventName, listener };
    });
    return () => {
        for (const { eventName, listener } of listeners)
            source.removeEventListener(eventName, listener);
        source.close();
        handlers.onStatus?.('closed');
    };
}
export async function runCoreComparison(apiUrl, name = 'baseline_24h') {
    const normalized = normalizeApiUrl(apiUrl);
    if (!normalized)
        throw new Error('Укажите адрес GreenCore API');
    const response = await fetch(`${normalized}/simulations/compare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, include_timeline: false }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok)
        throw new Error(errorMessage(payload, response.status));
    return payload;
}
