import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { initialApiUrl, saveApiUrl } from './core-api';
import { clearOperatorToken, evaluateOperatorNow, fetchOperatorState, initialOperatorToken, issueOperatorCommand, saveOperatorToken, setOperatorConnectivity, setOperatorMode, } from './operator-api';
import './owner-console.css';
const DEVICES = [
    { id: 'pump_01', label: 'Насос', actions: [{ action: 'ON', label: 'Включить', active: true }, { action: 'OFF', label: 'Выключить' }] },
    { id: 'fan_01', label: 'Вентиляция', actions: [{ action: 'ON', label: 'Включить', active: true }, { action: 'OFF', label: 'Выключить' }] },
    { id: 'vent_01', label: 'Форточка', actions: [{ action: 'OPEN', label: 'Открыть', active: true }, { action: 'CLOSE', label: 'Закрыть' }] },
];
function localDate(value) {
    if (!value)
        return 'нет данных';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'нет данных' : date.toLocaleString('ru-RU');
}
function telemetryValue(state, metric) {
    const sample = state?.telemetry?.[metric];
    if (!sample)
        return '—';
    return `${sample.value.toFixed(1)} ${sample.unit}`;
}
function errorText(error) {
    return error instanceof Error ? error.message : 'Неизвестная ошибка';
}
export function OwnerConsole() {
    const initialApi = useMemo(() => initialApiUrl(), []);
    const initialToken = useMemo(() => initialOperatorToken(), []);
    const [apiDraft, setApiDraft] = useState(initialApi);
    const [apiUrl, setApiUrl] = useState(initialApi);
    const [tokenDraft, setTokenDraft] = useState(initialToken);
    const [token, setToken] = useState(initialToken);
    const [runtime, setRuntime] = useState(null);
    const [reason, setReason] = useState('owner console request');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const authenticated = Boolean(apiUrl && token && runtime);
    const refresh = useCallback(async (nextApiUrl = apiUrl, nextToken = token) => {
        if (!nextApiUrl || !nextToken)
            return null;
        const nextState = await fetchOperatorState(nextApiUrl, nextToken);
        setRuntime(nextState);
        return nextState;
    }, [apiUrl, token]);
    const connect = useCallback(async () => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
            const nextApiUrl = saveApiUrl(apiDraft);
            const nextToken = saveOperatorToken(tokenDraft);
            if (!nextApiUrl)
                throw new Error('Укажите адрес GreenCore API');
            if (!nextToken)
                throw new Error('Введите operator или admin token');
            const nextState = await fetchOperatorState(nextApiUrl, nextToken);
            setApiUrl(nextApiUrl);
            setToken(nextToken);
            setRuntime(nextState);
            setNotice('Защищённая панель подключена');
        }
        catch (connectError) {
            setRuntime(null);
            setError(errorText(connectError));
        }
        finally {
            setBusy(false);
        }
    }, [apiDraft, tokenDraft]);
    useEffect(() => {
        if (!apiUrl || !token)
            return;
        let active = true;
        const update = async () => {
            try {
                const nextState = await fetchOperatorState(apiUrl, token);
                if (active)
                    setRuntime(nextState);
            }
            catch (refreshError) {
                if (active)
                    setError(errorText(refreshError));
            }
        };
        void update();
        const timer = window.setInterval(() => void update(), 10000);
        return () => {
            active = false;
            window.clearInterval(timer);
        };
    }, [apiUrl, token]);
    const disconnect = () => {
        clearOperatorToken();
        setToken('');
        setTokenDraft('');
        setRuntime(null);
        setError('');
        setNotice('Токен удалён из этой сессии браузера');
    };
    const execute = async (label, action) => {
        if (!apiUrl || !token) {
            setError('Сначала подключите защищённую панель');
            return;
        }
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await action();
            await refresh();
            setNotice(label);
        }
        catch (actionError) {
            setError(errorText(actionError));
        }
        finally {
            setBusy(false);
        }
    };
    const changeMode = (mode) => void execute(`Режим переключён: ${mode}`, () => setOperatorMode(apiUrl, token, mode));
    const forceSafe = () => void execute('SAFE применён и выполнена немедленная оценка', async () => {
        await setOperatorMode(apiUrl, token, 'SAFE');
        await evaluateOperatorNow(apiUrl, token);
    });
    const sendCommand = (actuatorId, action, active = false) => {
        if (active && !window.confirm(`Отправить команду ${actuatorId} → ${action}? Safety-проверки останутся активны.`))
            return;
        void execute(`Команда поставлена в очередь: ${actuatorId} → ${action}`, () => issueOperatorCommand(apiUrl, token, actuatorId, action, reason));
    };
    return (_jsxs("section", { className: "owner-console", "aria-label": "\u041F\u0430\u043D\u0435\u043B\u044C \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430 GreenCore", children: [_jsxs("div", { className: "owner-console__heading", children: [_jsxs("div", { children: [_jsx("p", { className: "owner-console__eyebrow", children: "OWNER CONSOLE v1" }), _jsx("h2", { children: "\u0417\u0430\u0449\u0438\u0449\u0451\u043D\u043D\u0430\u044F \u043C\u043E\u0431\u0438\u043B\u044C\u043D\u0430\u044F \u043F\u0430\u043D\u0435\u043B\u044C \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430" }), _jsx("p", { children: "\u041F\u0443\u0431\u043B\u0438\u0447\u043D\u044B\u0439 dashboard \u043E\u0441\u0442\u0430\u0451\u0442\u0441\u044F read-only. \u0423\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u043F\u043E\u044F\u0432\u043B\u044F\u0435\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u043E\u0441\u043B\u0435 \u0432\u0432\u043E\u0434\u0430 operator \u0438\u043B\u0438 admin token." })] }), _jsx("span", { className: `owner-console__status ${authenticated ? 'connected' : ''}`, children: authenticated ? 'OPERATOR CONNECTED' : 'LOCKED' })] }), _jsxs("div", { className: "owner-console__auth", children: [_jsxs("label", { children: [_jsx("span", { children: "GreenCore API" }), _jsx("input", { value: apiDraft, onChange: event => setApiDraft(event.target.value), placeholder: "https://api.example.com", inputMode: "url" })] }), _jsxs("label", { children: [_jsx("span", { children: "Operator / Admin token" }), _jsx("input", { value: tokenDraft, onChange: event => setTokenDraft(event.target.value), placeholder: "\u0422\u043E\u043A\u0435\u043D \u043D\u0435 \u043F\u043E\u043F\u0430\u0434\u0451\u0442 \u0432 \u043F\u0443\u0431\u043B\u0438\u0447\u043D\u0443\u044E \u0441\u0441\u044B\u043B\u043A\u0443", type: "password", autoComplete: "current-password" })] }), _jsx("button", { className: "owner-console__primary", onClick: () => void connect(), disabled: busy, children: busy ? 'Выполняю…' : 'Подключить' }), _jsx("button", { onClick: disconnect, disabled: !tokenDraft && !token, children: "\u0417\u0430\u0431\u044B\u0442\u044C \u0442\u043E\u043A\u0435\u043D" })] }), _jsx("p", { className: "owner-console__security", children: "\u0422\u043E\u043A\u0435\u043D \u0445\u0440\u0430\u043D\u0438\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u0432 sessionStorage \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u0432\u043A\u043B\u0430\u0434\u043A\u0438 \u0438 \u0443\u0434\u0430\u043B\u044F\u0435\u0442\u0441\u044F \u043F\u0440\u0438 \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u0438 \u0441\u0435\u0441\u0441\u0438\u0438 \u0438\u043B\u0438 \u043F\u043E \u043A\u043D\u043E\u043F\u043A\u0435 \u00AB\u0417\u0430\u0431\u044B\u0442\u044C \u0442\u043E\u043A\u0435\u043D\u00BB." }), error && _jsx("p", { className: "owner-console__message error", children: error }), notice && _jsx("p", { className: "owner-console__message success", children: notice }), !authenticated && (_jsxs("div", { className: "owner-console__locked", children: [_jsx("strong", { children: "\u041F\u0430\u043D\u0435\u043B\u044C \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043B\u0435\u043D\u0430, \u043D\u043E \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u043E" }), _jsx("p", { children: "Backend \u043C\u043E\u0436\u043D\u043E \u0440\u0430\u0437\u0432\u0435\u0440\u043D\u0443\u0442\u044C \u043F\u043E\u0437\u0436\u0435 \u0441 \u041F\u041A. \u0414\u043E \u044D\u0442\u043E\u0433\u043E \u043D\u0438\u043A\u0430\u043A\u0438\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F \u043E\u0442 \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430 \u043D\u0435 \u0442\u0440\u0435\u0431\u0443\u044E\u0442\u0441\u044F." })] })), authenticated && runtime && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "owner-console__summary", children: [_jsxs("div", { children: [_jsx("span", { children: "\u0420\u0435\u0436\u0438\u043C" }), _jsx("strong", { children: runtime.effective_mode })] }), _jsxs("div", { children: [_jsx("span", { children: "\u0421\u0432\u044F\u0437\u044C" }), _jsx("strong", { children: runtime.connected ? 'ONLINE' : 'OFFLINE' })] }), _jsxs("div", { children: [_jsx("span", { children: "\u041A\u043E\u043C\u0430\u043D\u0434\u044B" }), _jsx("strong", { children: runtime.pending_commands.length })] }), _jsxs("div", { children: [_jsx("span", { children: "\u0422\u0440\u0435\u0432\u043E\u0433\u0438" }), _jsx("strong", { children: runtime.alerts.length })] })] }), _jsxs("div", { className: "owner-console__telemetry", children: [_jsxs("div", { children: [_jsx("span", { children: "\u041F\u043E\u0447\u0432\u0430" }), _jsx("strong", { children: telemetryValue(runtime, 'soil_moisture') })] }), _jsxs("div", { children: [_jsx("span", { children: "\u0422\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430" }), _jsx("strong", { children: telemetryValue(runtime, 'air_temperature') })] }), _jsxs("div", { children: [_jsx("span", { children: "\u0412\u043B\u0430\u0436\u043D\u043E\u0441\u0442\u044C \u0432\u043E\u0437\u0434\u0443\u0445\u0430" }), _jsx("strong", { children: telemetryValue(runtime, 'air_humidity') })] }), _jsxs("div", { children: [_jsx("span", { children: "\u0412\u043E\u0434\u0430" }), _jsx("strong", { children: telemetryValue(runtime, 'water_level') })] })] }), _jsxs("div", { className: "owner-console__grid", children: [_jsxs("article", { className: "owner-console__card", children: [_jsxs("div", { className: "owner-console__card-heading", children: [_jsx("h3", { children: "\u0420\u0435\u0436\u0438\u043C \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F" }), _jsx("button", { className: "owner-console__danger", onClick: forceSafe, disabled: busy, children: "SAFE \u0441\u0435\u0439\u0447\u0430\u0441" })] }), _jsx("div", { className: "owner-console__button-row", children: ['AUTO', 'MANUAL', 'SAFE'].map(mode => (_jsx("button", { className: runtime.configured_mode === mode ? 'active' : '', onClick: () => changeMode(mode), disabled: busy, children: mode }, mode))) }), _jsxs("div", { className: "owner-console__button-row", children: [_jsx("button", { className: runtime.connected ? 'active' : '', onClick: () => void execute('Связь ядра: ONLINE', () => setOperatorConnectivity(apiUrl, token, true)), disabled: busy, children: "\u0421\u0432\u044F\u0437\u044C ONLINE" }), _jsx("button", { className: !runtime.connected ? 'active warning' : '', onClick: () => void execute('Связь ядра: OFFLINE', () => setOperatorConnectivity(apiUrl, token, false)), disabled: busy, children: "\u0421\u0432\u044F\u0437\u044C OFFLINE" }), _jsx("button", { onClick: () => void execute('Немедленная оценка завершена', () => evaluateOperatorNow(apiUrl, token)), disabled: busy, children: "\u041E\u0446\u0435\u043D\u0438\u0442\u044C \u0441\u0435\u0439\u0447\u0430\u0441" })] })] }), _jsxs("article", { className: "owner-console__card", children: [_jsx("h3", { children: "\u0420\u0443\u0447\u043D\u044B\u0435 \u043A\u043E\u043C\u0430\u043D\u0434\u044B" }), _jsxs("label", { className: "owner-console__reason", children: [_jsx("span", { children: "\u041F\u0440\u0438\u0447\u0438\u043D\u0430 \u043A\u043E\u043C\u0430\u043D\u0434\u044B" }), _jsx("input", { value: reason, onChange: event => setReason(event.target.value), maxLength: 160 })] }), _jsx("div", { className: "owner-console__devices", children: DEVICES.map(device => (_jsxs("div", { children: [_jsxs("div", { children: [_jsx("strong", { children: device.label }), _jsxs("small", { children: [device.id, " \u00B7 \u0441\u0435\u0439\u0447\u0430\u0441 ", runtime.actuators[device.id]?.state ?? 'UNKNOWN'] })] }), _jsx("div", { children: device.actions.map(item => (_jsx("button", { onClick: () => sendCommand(device.id, item.action, item.active), disabled: busy, children: item.label }, item.action))) })] }, device.id))) }), _jsx("p", { className: "owner-console__hint", children: "\u041A\u043E\u043C\u0430\u043D\u0434\u0430 \u0441\u043D\u0430\u0447\u0430\u043B\u0430 \u043F\u043E\u043F\u0430\u0434\u0430\u0435\u0442 \u0432 \u043E\u0447\u0435\u0440\u0435\u0434\u044C. \u0421\u0435\u0440\u0432\u0435\u0440\u043D\u044B\u0435 \u0438 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0435 safety-\u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043C\u043E\u0433\u0443\u0442 \u0435\u0451 \u043E\u0442\u043A\u043B\u043E\u043D\u0438\u0442\u044C." })] })] }), _jsxs("article", { className: "owner-console__card owner-console__alerts", children: [_jsxs("div", { className: "owner-console__card-heading", children: [_jsx("h3", { children: "\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 \u0442\u0440\u0435\u0432\u043E\u0433\u0438" }), _jsx("button", { onClick: () => void refresh(), disabled: busy, children: "\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C" })] }), runtime.alerts.length === 0 && _jsx("p", { className: "owner-console__muted", children: "\u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0445 \u0437\u0430\u043F\u0438\u0441\u0435\u0439 \u0442\u0440\u0435\u0432\u043E\u0433 \u043D\u0435\u0442." }), [...runtime.alerts].slice(-6).reverse().map((alert, index) => (_jsxs("div", { children: [_jsx("strong", { children: alert.type }), _jsx("span", { children: localDate(alert.timestamp) })] }, `${alert.type}-${alert.timestamp ?? index}`)))] })] }))] }));
}
