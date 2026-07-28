export type CoreMetrics = {
  final_plant_health_percent: number;
  min_plant_health_percent: number;
  min_soil_moisture_percent: number;
  max_air_temperature_c: number;
  min_water_level_percent: number;
  cumulative_water_used_percent: number;
  pump_runtime_seconds: number;
  fan_runtime_seconds: number;
  command_count: number;
  alert_count: number;
  safety_violation_count: number;
};

export type CoreComparisonReport = {
  report_id: string;
  created_at: string;
  type: 'comparison';
  name: string;
  description: string;
  strategies: {
    automatic: { label: 'AUTO'; metrics: CoreMetrics };
    manual_baseline: { label: 'MANUAL_WITHOUT_OPERATOR_INTERVENTIONS'; metrics: CoreMetrics };
  };
  automatic_minus_manual: CoreMetrics;
  interpretation: {
    health_delta_percent_points: number;
    water_use_delta_percent_of_tank: number;
    note: string;
  };
  model_notice: string;
};

function errorMessage(payload: unknown, status: number) {
  if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
    return payload.message;
  }
  return `GreenCore API returned HTTP ${status}`;
}

export function normalizeApiUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('API URL must use http or https');
  return parsed.toString().replace(/\/$/, '');
}

export function initialApiUrl() {
  const query = new URLSearchParams(window.location.search).get('api');
  const saved = window.localStorage.getItem('greencore-api-url');
  const configured = import.meta.env.VITE_GREENCORE_API_URL as string | undefined;
  for (const candidate of [query, saved, configured]) {
    if (!candidate) continue;
    try {
      return normalizeApiUrl(candidate);
    } catch {
      // Ignore invalid saved/configured values and keep the offline demo usable.
    }
  }
  return '';
}

export function saveApiUrl(value: string) {
  const normalized = normalizeApiUrl(value);
  if (normalized) window.localStorage.setItem('greencore-api-url', normalized);
  else window.localStorage.removeItem('greencore-api-url');
  return normalized;
}

export function shareUrl(apiUrl: string) {
  const url = new URL(window.location.href);
  url.search = '';
  if (apiUrl) url.searchParams.set('api', normalizeApiUrl(apiUrl));
  return url.toString();
}

export async function runCoreComparison(
  apiUrl: string,
  name = 'baseline_24h',
): Promise<CoreComparisonReport> {
  const normalized = normalizeApiUrl(apiUrl);
  if (!normalized) throw new Error('Укажите адрес GreenCore API');
  const response = await fetch(`${normalized}/simulations/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, include_timeline: false }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  return payload as CoreComparisonReport;
}
