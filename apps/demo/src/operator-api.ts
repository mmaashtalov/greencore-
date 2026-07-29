import { normalizeApiUrl } from './core-api';

export type OperatorMode = 'AUTO' | 'MANUAL' | 'SAFE';
export type ActuatorId = 'pump_01' | 'fan_01' | 'vent_01';
export type ActuatorAction = 'ON' | 'OFF' | 'OPEN' | 'CLOSE';

export type PolicyEvidence = {
  fact: string;
  operator: string;
  observed?: unknown;
  expected?: unknown;
  matched: boolean;
};

export type PolicyDecision = {
  decision_id: string;
  evaluated_at: string;
  policy_version: string;
  effect: 'ALLOW' | 'DENY';
  policy_id?: string | null;
  summary: string;
  alert_type?: string | null;
  matched_policy_ids: string[];
  evidence: PolicyEvidence[];
  context: {
    command?: {
      actuator_id?: string;
      action?: string;
      source?: string;
      reason?: string;
    };
    telemetry?: Record<string, {
      state?: string;
      usable?: boolean;
      value?: number | null;
      quality?: string | null;
      age_seconds?: number | null;
    }>;
  };
};

export type OperatorRuntimeState = {
  configured_mode: string;
  effective_mode: string;
  connected: boolean;
  telemetry: Record<string, {
    device_id: string;
    metric: string;
    value: number;
    unit: string;
    quality: string;
    timestamp: string;
  }>;
  actuators: Record<string, {
    type: string;
    state: string;
    changedAt?: string | null;
  }>;
  controllers?: Record<string, unknown> | unknown[];
  pending_commands: Array<{
    command_id: string;
    actuator_id: string;
    action: string;
    delivery_status?: string;
    reason?: string;
  }>;
  alerts: Array<{
    type: string;
    timestamp?: string;
    details?: Record<string, unknown>;
  }>;
  policy_contract?: {
    version: string;
    status: string;
  };
  policy_decisions?: PolicyDecision[];
};

const TOKEN_KEY = 'greencore-operator-token';

function errorMessage(payload: unknown, status: number) {
  if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
    return payload.message;
  }
  return `GreenCore API returned HTTP ${status}`;
}

function normalizeToken(value: string) {
  return value.trim();
}

export function initialOperatorToken() {
  return window.sessionStorage.getItem(TOKEN_KEY) ?? '';
}

export function saveOperatorToken(value: string) {
  const token = normalizeToken(value);
  if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
  else window.sessionStorage.removeItem(TOKEN_KEY);
  return token;
}

export function clearOperatorToken() {
  window.sessionStorage.removeItem(TOKEN_KEY);
}

async function operatorRequest<T>(
  apiUrl: string,
  token: string,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const normalizedToken = normalizeToken(token);
  if (!normalizedApiUrl) throw new Error('Укажите адрес GreenCore API');
  if (!normalizedToken) throw new Error('Введите operator или admin token');

  const response = await fetch(`${normalizedApiUrl}${path}`, {
    method: options.method ?? 'GET',
    cache: 'no-store',
    headers: {
      authorization: `Bearer ${normalizedToken}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  return payload as T;
}

export function fetchOperatorState(apiUrl: string, token: string) {
  return operatorRequest<OperatorRuntimeState>(apiUrl, token, '/state');
}

export async function setOperatorMode(apiUrl: string, token: string, mode: OperatorMode) {
  return operatorRequest<{ configured_mode: string }>(apiUrl, token, '/mode', {
    method: 'POST',
    body: { mode },
  });
}

export async function setOperatorConnectivity(apiUrl: string, token: string, connected: boolean) {
  return operatorRequest<{ connected: boolean }>(apiUrl, token, '/connectivity', {
    method: 'POST',
    body: { connected },
  });
}

export async function issueOperatorCommand(
  apiUrl: string,
  token: string,
  actuatorId: ActuatorId,
  action: ActuatorAction,
  reason: string,
) {
  return operatorRequest<{ queued: boolean }>(apiUrl, token, '/manual-commands', {
    method: 'POST',
    body: {
      actuator_id: actuatorId,
      action,
      reason: reason.trim() || 'owner console request',
    },
  });
}

export async function evaluateOperatorNow(apiUrl: string, token: string) {
  return operatorRequest<{ commands: unknown[]; effective_state: OperatorRuntimeState }>(apiUrl, token, '/evaluate', {
    method: 'POST',
  });
}
