import { normalizeApiUrl } from './core-api';
const TOKEN_KEY = 'greencore-operator-token';
function errorMessage(payload, status) {
    if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
        return payload.message;
    }
    return `GreenCore API returned HTTP ${status}`;
}
function normalizeToken(value) {
    return value.trim();
}
export function initialOperatorToken() {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? '';
}
export function saveOperatorToken(value) {
    const token = normalizeToken(value);
    if (token)
        window.sessionStorage.setItem(TOKEN_KEY, token);
    else
        window.sessionStorage.removeItem(TOKEN_KEY);
    return token;
}
export function clearOperatorToken() {
    window.sessionStorage.removeItem(TOKEN_KEY);
}
async function operatorRequest(apiUrl, token, path, options = {}) {
    const normalizedApiUrl = normalizeApiUrl(apiUrl);
    const normalizedToken = normalizeToken(token);
    if (!normalizedApiUrl)
        throw new Error('Укажите адрес GreenCore API');
    if (!normalizedToken)
        throw new Error('Введите operator или admin token');
    const response = await fetch(`${normalizedApiUrl}${path}`, {
        method: options.method ?? 'GET',
        cache: 'no-store',
        headers: {
            authorization: `Bearer ${normalizedToken}`,
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok)
        throw new Error(errorMessage(payload, response.status));
    return payload;
}
export function fetchOperatorState(apiUrl, token) {
    return operatorRequest(apiUrl, token, '/state');
}
export async function setOperatorMode(apiUrl, token, mode) {
    return operatorRequest(apiUrl, token, '/mode', {
        method: 'POST',
        body: { mode },
    });
}
export async function setOperatorConnectivity(apiUrl, token, connected) {
    return operatorRequest(apiUrl, token, '/connectivity', {
        method: 'POST',
        body: { connected },
    });
}
export async function issueOperatorCommand(apiUrl, token, actuatorId, action, reason) {
    return operatorRequest(apiUrl, token, '/manual-commands', {
        method: 'POST',
        body: {
            actuator_id: actuatorId,
            action,
            reason: reason.trim() || 'owner console request',
        },
    });
}
export async function evaluateOperatorNow(apiUrl, token) {
    return operatorRequest(apiUrl, token, '/evaluate', {
        method: 'POST',
    });
}
