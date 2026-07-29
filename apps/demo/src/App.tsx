import { useEffect, useMemo, useState } from 'react';
import {
  calculateEconomy,
  createInitialState,
  defaultConfig,
  stepSimulation,
  type ControlMode,
} from '@greencore/simulation-core';
import type { GreenhouseState } from '@greencore/domain-model';
import {
  applyLiveEvent,
  fetchCoreHealth,
  initialApiUrl,
  openCoreLiveStream,
  runCoreComparison,
  saveApiUrl,
  shareUrl,
  type CoreComparisonReport,
  type CoreHealth,
  type CoreMetrics,
  type LiveConnectionStatus,
  type LiveEventRecord,
  type LivePolicyDecision,
  type LiveSnapshot,
  type LiveTelemetrySample,
} from './core-api';

type Scenario = {
  mode: ControlMode;
  state: GreenhouseState;
};

const speeds = [60, 300, 1200] as const;

function formatTime(minutes: number) {
  const day = Math.floor(minutes / 1440) + 1;
  const minuteOfDay = minutes % 1440;
  const hours = Math.floor(minuteOfDay / 60).toString().padStart(2, '0');
  const mins = Math.floor(minuteOfDay % 60).toString().padStart(2, '0');
  return `День ${day}, ${hours}:${mins}`;
}

function duration(seconds: number) {
  if (seconds < 60) return `${seconds.toFixed(0)} сек`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(0)} мин`;
  return `${(minutes / 60).toFixed(1)} ч`;
}

function signed(value: number, digits = 1) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function money(value: number) {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(value);
}

function localDate(value?: string | null) {
  if (!value) return 'нет данных';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'нет данных' : date.toLocaleString('ru-RU');
}

function metric(label: string, value: string, danger = false) {
  return (
    <div className={`metric ${danger ? 'danger' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ScenarioCard({ title, scenario }: { title: string; scenario: Scenario }) {
  const economy = calculateEconomy(scenario.state, {
    ...defaultConfig,
    controlMode: scenario.mode,
  });
  const s = scenario.state;
  const automatic = scenario.mode === 'automatic';

  return (
    <section className="scenario-card">
      <div className="scenario-header">
        <div>
          <p className="eyebrow">{automatic ? 'GREENCORE AUTO' : 'ПАССИВНЫЙ BASELINE'}</p>
          <h2>{title}</h2>
        </div>
        <div className={`status ${scenario.mode}`}>
          <span />{automatic ? 'Автоматика' : 'Без вмешательств'}
        </div>
      </div>

      <div className="equipment-row">
        <div className={`equipment ${s.pumpOn ? 'on' : ''}`}><span>Насос</span><b>{s.pumpOn ? 'ON' : 'OFF'}</b></div>
        <div className={`equipment ${s.fanOn ? 'on' : ''}`}><span>Вентиляция</span><b>{s.fanOn ? 'ON' : 'OFF'}</b></div>
      </div>

      <div className="metrics-grid">
        {metric('Температура', `${s.insideTemperatureC.toFixed(1)} °C`, s.insideTemperatureC > 30)}
        {metric('Влажность почвы', `${s.soilMoisturePct.toFixed(1)} %`, s.soilMoisturePct < 38)}
        {metric('Здоровье модели', `${s.plantHealthPct.toFixed(1)} %`, s.plantHealthPct < 80)}
        {metric('Модельный урожай', `${s.predictedYieldKg.toFixed(1)} кг`)}
        {metric('Модельная потеря', `${s.irreversibleYieldLossKg.toFixed(2)} кг`, s.irreversibleYieldLossKg > 0.1)}
        {metric('Накопленный стресс', s.accumulatedStress.toFixed(1), s.accumulatedStress > 12)}
      </div>

      <div className="resource-strip">
        <span>Вода <b>{s.waterUsedLiters.toFixed(0)} л</b></span>
        <span>Энергия <b>{s.electricityUsedKwh.toFixed(1)} кВт·ч</b></span>
        <span>Модельные затраты <b>{money(economy.operatingCostRub)}</b></span>
      </div>

      <div className="profit">
        <span>Модельная прибыль</span>
        <strong>{money(economy.projectedProfitRub)}</strong>
      </div>
    </section>
  );
}

function CoreMetricCard({ label, metrics }: { label: string; metrics: CoreMetrics }) {
  return (
    <article className="core-metric-card">
      <p className="eyebrow">{label}</p>
      <div className="core-metrics">
        <div><span>Финальное здоровье</span><strong>{metrics.final_plant_health_percent.toFixed(1)}%</strong></div>
        <div><span>Минимум почвы</span><strong>{metrics.min_soil_moisture_percent.toFixed(1)}%</strong></div>
        <div><span>Пик температуры</span><strong>{metrics.max_air_temperature_c.toFixed(1)}°C</strong></div>
        <div><span>Расход воды</span><strong>{metrics.cumulative_water_used_percent.toFixed(1)}% бака</strong></div>
        <div><span>Работа насоса</span><strong>{duration(metrics.pump_runtime_seconds)}</strong></div>
        <div><span>Команды / тревоги</span><strong>{metrics.command_count} / {metrics.alert_count}</strong></div>
      </div>
    </article>
  );
}

function connectionLabel(status: LiveConnectionStatus) {
  if (status === 'open') return 'LIVE подключён';
  if (status === 'connecting') return 'Подключение…';
  if (status === 'retrying') return 'Переподключение…';
  if (status === 'closed') return 'Поток закрыт';
  return 'API не подключён';
}

function telemetryLabel(metricName: string) {
  const labels: Record<string, string> = {
    soil_moisture: 'Влажность почвы',
    air_temperature: 'Температура воздуха',
    air_humidity: 'Влажность воздуха',
    water_level: 'Уровень воды',
  };
  return labels[metricName] ?? metricName;
}

function telemetryValue(sample?: LiveTelemetrySample) {
  if (!sample) return '—';
  return `${sample.value.toFixed(1)} ${sample.unit}`;
}

function policyCommand(decision: LivePolicyDecision) {
  const command = decision.context.command;
  return `${command.actuator_id ?? 'устройство'} → ${command.action ?? 'действие'} · ${command.source ?? 'источник не указан'}`;
}

function eventSummary(record: LiveEventRecord) {
  const payload = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
  if (record.event === 'telemetry') return `Принято измерений: ${String(payload.accepted_count ?? '—')}`;
  if (record.event === 'controller.heartbeat') return `${String(payload.controller_id ?? 'контроллер')} → ${String(payload.status ?? 'UNKNOWN')}`;
  if (record.event === 'commands.delivered') return `Команды доставлены: ${Array.isArray(payload.commands) ? payload.commands.length : 0}`;
  if (record.event === 'command.acknowledged') {
    const command = payload.command && typeof payload.command === 'object' ? payload.command as Record<string, unknown> : {};
    return `${String(command.actuator_id ?? 'устройство')} ${String(command.action ?? '')} → ${String(command.delivery_status ?? 'ACK')}`;
  }
  if (record.event === 'mode.changed') return `Режим: ${String(payload.configured_mode ?? 'UNKNOWN')}`;
  if (record.event === 'connectivity.changed') return `Связь: ${payload.connected === false ? 'OFFLINE' : 'ONLINE'}`;
  if (record.event === 'simulation.completed') return `Сценарий завершён: ${String(payload.name ?? payload.report_id ?? 'simulation')}`;
  if (record.event === 'automation.evaluated') return 'Автоматический цикл принятия решений';
  if (record.event === 'snapshot') return 'Получено актуальное состояние GreenCore';
  return record.event;
}

function LiveOperationsPanel({
  apiUrl,
  status,
  health,
  snapshot,
  events,
  lastEventAt,
}: {
  apiUrl: string;
  status: LiveConnectionStatus;
  health: CoreHealth | null;
  snapshot: LiveSnapshot | null;
  events: LiveEventRecord[];
  lastEventAt: string | null;
}) {
  const state = snapshot?.state;
  const telemetry = state?.telemetry ?? {};
  const controllers = state?.controllers ?? [];
  const actuators = state?.actuators ?? {};
  const pendingCommands = state?.pending_commands ?? [];
  const policyDecisions = state?.policy_decisions ?? [];
  const queue = snapshot?.simulation_queue ?? health?.simulation_queue;

  return (
    <section className="live-operations">
      <div className="live-heading">
        <div>
          <p className="eyebrow">GREENCORE LIVE OPERATIONS</p>
          <h3>Живой контур: контроллер → телеметрия → решение → команда → ACK</h3>
          <p>{apiUrl ? apiUrl : 'Укажите публичный адрес GreenCore API, чтобы открыть живой поток.'}</p>
        </div>
        <div className={`live-status ${status}`}><span />{connectionLabel(status)}</div>
      </div>

      {!snapshot && (
        <div className="live-empty">
          <strong>{status === 'retrying' ? 'API пока недоступен' : 'Живые данные ещё не получены'}</strong>
          <p>Автономная браузерная модель продолжает работать. SSE подключится автоматически после доступности API.</p>
        </div>
      )}

      {snapshot && state && (
        <>
          <div className="live-summary">
            <div><span>Core</span><strong>v{health?.version ?? '0.12.0'}</strong></div>
            <div><span>Режим</span><strong>{state.effective_mode}</strong></div>
            <div><span>Внешняя связь</span><strong>{state.connected ? 'ONLINE' : 'OFFLINE'}</strong></div>
            <div><span>Последнее событие</span><strong>{localDate(lastEventAt ?? state.generated_at)}</strong></div>
          </div>

          <div className="live-grid">
            <article className="live-card">
              <div className="live-card-heading"><span>Телеметрия</span><b>{Object.keys(telemetry).length}</b></div>
              <div className="telemetry-list">
                {['soil_moisture', 'air_temperature', 'air_humidity', 'water_level'].map(metricName => {
                  const sample = telemetry[metricName];
                  return (
                    <div key={metricName} className={!sample || sample.quality !== 'GOOD' ? 'warning' : ''}>
                      <span>{telemetryLabel(metricName)}</span>
                      <strong>{telemetryValue(sample)}</strong>
                      <small>{sample ? `${sample.quality} · ${localDate(sample.timestamp)}` : 'нет данных'}</small>
                    </div>
                  );
                })}
              </div>
            </article>

            <article className="live-card">
              <div className="live-card-heading"><span>Контроллеры</span><b>{controllers.length}</b></div>
              <div className="controller-list">
                {controllers.length === 0 && <p className="muted">Контроллеры не зарегистрированы.</p>}
                {controllers.map(controller => (
                  <div key={controller.controller_id}>
                    <div>
                      <strong>{controller.name ?? controller.controller_id}</strong>
                      <small>{controller.controller_id} · {controller.firmware ?? 'firmware unknown'}</small>
                    </div>
                    <span className={`controller-state ${(controller.status ?? 'UNKNOWN').toLowerCase()}`}>{controller.status ?? 'UNKNOWN'}</span>
                    <small>Heartbeat: {localDate(controller.last_heartbeat)}</small>
                  </div>
                ))}
              </div>
            </article>

            <article className="live-card">
              <div className="live-card-heading"><span>Исполнительные устройства</span><b>{Object.keys(actuators).length}</b></div>
              <div className="actuator-list">
                {Object.entries(actuators).map(([id, actuator]) => (
                  <div key={id} className={['ON', 'OPEN'].includes(actuator.state) ? 'active' : ''}>
                    <span>{id}<small>{actuator.type}</small></span>
                    <strong>{actuator.state}</strong>
                  </div>
                ))}
              </div>
              <div className="queue-strip">
                <span>Simulation queue</span>
                <strong>{queue?.active ?? 0} active / {queue?.queued ?? 0} queued</strong>
              </div>
            </article>

            <article className="live-card">
              <div className="live-card-heading"><span>Команды и ACK</span><b>{pendingCommands.length}</b></div>
              <div className="command-list">
                {pendingCommands.length === 0 && <p className="muted">Незавершённых команд нет.</p>}
                {pendingCommands.slice(0, 6).map(command => (
                  <div key={command.command_id}>
                    <strong>{command.actuator_id} · {command.action}</strong>
                    <span>{command.delivery_status ?? 'QUEUED'}</span>
                    <small>{command.reason ?? command.command_id}</small>
                  </div>
                ))}
              </div>
            </article>

            <article className="live-card">
              <div className="live-card-heading"><span>Policy Journal</span><b>{policyDecisions.length}</b></div>
              <div className="policy-list">
                {policyDecisions.length === 0 && <p className="muted">Ожидание первого решения.</p>}
                {[...policyDecisions].slice(-6).reverse().map(decision => (
                  <div key={decision.decision_id} className="policy-item">
                    <div>
                      <strong className={decision.effect === 'DENY' ? 'deny' : 'allow'}>{decision.effect}</strong>
                      <small>{localDate(decision.evaluated_at)}</small>
                    </div>
                    <span>{policyCommand(decision)}</span>
                    <p>{decision.summary}</p>
                    <small>Правило: {decision.policy_id ?? 'default'} · {decision.decision_id}</small>
                  </div>
                ))}
              </div>
            </article>
          </div>

          <article className="event-stream-card">
            <div className="live-card-heading"><span>Последние live-события</span><b>{events.length}</b></div>
            <div className="event-list">
              {events.length === 0 && <p className="muted">Ожидание событий…</p>}
              {events.map((event, index) => (
                <div key={`${event.id ?? 'direct'}-${event.received_at}-${index}`}>
                  <span>{event.event}</span>
                  <strong>{eventSummary(event)}</strong>
                  <small>{localDate(event.received_at)}{event.id ? ` · #${event.id}` : ''}</small>
                </div>
              ))}
            </div>
          </article>
        </>
      )}
    </section>
  );
}

function CoreVerification({
  apiDraft,
  apiUrl,
  loading,
  error,
  report,
  copied,
  liveStatus,
  health,
  liveSnapshot,
  liveEvents,
  lastEventAt,
  onDraftChange,
  onConnect,
  onRun,
  onCopy,
}: {
  apiDraft: string;
  apiUrl: string;
  loading: boolean;
  error: string;
  report: CoreComparisonReport | null;
  copied: boolean;
  liveStatus: LiveConnectionStatus;
  health: CoreHealth | null;
  liveSnapshot: LiveSnapshot | null;
  liveEvents: LiveEventRecord[];
  lastEventAt: string | null;
  onDraftChange: (value: string) => void;
  onConnect: () => void;
  onRun: () => void;
  onCopy: () => void;
}) {
  const auto = report?.strategies.automatic.metrics;
  const manual = report?.strategies.manual_baseline.metrics;

  return (
    <section className="core-verification">
      <div className="verification-heading">
        <div>
          <p className="eyebrow">GREENCORE CORE v{health?.version ?? '0.12.0'}</p>
          <h3>Публичная серверная демонстрация и воспроизводимая проверка</h3>
          <p>Live-поток показывает фактическое состояние Core. Сравнение 24 часов отдельно запускает одинаковые условия для AUTO и baseline без операторских действий.</p>
        </div>
        <span className={`api-status ${liveStatus === 'open' ? 'connected' : liveStatus === 'retrying' ? 'warning' : ''}`}>{connectionLabel(liveStatus)}</span>
      </div>

      <div className="api-controls">
        <label>
          <span>Адрес GreenCore API</span>
          <input
            value={apiDraft}
            onChange={event => onDraftChange(event.target.value)}
            placeholder="https://api.example.com"
            inputMode="url"
          />
        </label>
        <button className="primary" onClick={onConnect}>Подключить LIVE</button>
        <button onClick={onRun} disabled={loading}>{loading ? 'Считаю…' : 'Проверка 24 ч'}</button>
        <button onClick={onCopy} disabled={!apiUrl}>{copied ? 'Ссылка скопирована' : 'Скопировать публичную ссылку'}</button>
      </div>

      {error && <p className="api-error">{error}</p>}
      {!apiUrl && !report && <p className="api-note">Интерактивная браузерная модель работает автономно. Для серверной демонстрации нужен опубликованный GreenCore API с публичным read-only SSE.</p>}

      <LiveOperationsPanel
        apiUrl={apiUrl}
        status={liveStatus}
        health={health}
        snapshot={liveSnapshot}
        events={liveEvents}
        lastEventAt={lastEventAt}
      />

      {report && auto && manual && (
        <section className="comparison-report">
          <div className="server-deltas">
            <div><span>Здоровье AUTO − baseline</span><strong>{signed(report.automatic_minus_manual.final_plant_health_percent)} п.п.</strong></div>
            <div><span>Снижение температурного пика</span><strong>{signed(manual.max_air_temperature_c - auto.max_air_temperature_c)} °C</strong></div>
            <div><span>Изменение расхода воды</span><strong>{signed(report.automatic_minus_manual.cumulative_water_used_percent)}% бака</strong></div>
            <div><span>Нарушения safety</span><strong>{auto.safety_violation_count} / {manual.safety_violation_count}</strong></div>
          </div>
          <div className="core-comparison-grid">
            <CoreMetricCard label="AUTO" metrics={auto} />
            <CoreMetricCard label="MANUAL БЕЗ ВМЕШАТЕЛЬСТВ" metrics={manual} />
          </div>
          <div className="report-meta">
            <span>Report ID: <b>{report.report_id}</b></span>
            <span>{new Date(report.created_at).toLocaleString('ru-RU')}</span>
          </div>
          <p className="model-notice">{report.model_notice} {report.interpretation.note}</p>
        </section>
      )}
    </section>
  );
}

export function App() {
  const configuredApi = useMemo(() => initialApiUrl(), []);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState<(typeof speeds)[number]>(300);
  const [automatic, setAutomatic] = useState<Scenario>({ mode: 'automatic', state: createInitialState() });
  const [manual, setManual] = useState<Scenario>({ mode: 'manual', state: createInitialState() });
  const [apiUrl, setApiUrl] = useState(configuredApi);
  const [apiDraft, setApiDraft] = useState(configuredApi);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState('');
  const [report, setReport] = useState<CoreComparisonReport | null>(null);
  const [copied, setCopied] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveConnectionStatus>(configuredApi ? 'connecting' : 'idle');
  const [health, setHealth] = useState<CoreHealth | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<LiveSnapshot | null>(null);
  const [liveEvents, setLiveEvents] = useState<LiveEventRecord[]>([]);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  useEffect(() => {
    if (!running) return;
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
      .then(result => { if (active) setHealth(result); })
      .catch(error => { if (active) setApiError(error instanceof Error ? error.message : 'Не удалось проверить GreenCore API'); });

    let closeStream = () => {};
    try {
      closeStream = openCoreLiveStream(apiUrl, {
        onStatus: status => { if (active) setLiveStatus(status); },
        onEvent: event => {
          if (!active) return;
          setLastEventAt(event.received_at);
          setLiveEvents(current => [event, ...current].slice(0, 12));
          setLiveSnapshot(current => applyLiveEvent(current, event));
        },
      });
    } catch (error) {
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
    if (!normalized) throw new Error('Укажите адрес GreenCore API');
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
    } catch (error) {
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
    } catch (error) {
      setApiError(error instanceof Error ? error.message : 'Не удалось выполнить проверку');
    } finally {
      setLoading(false);
    }
  };

  const copyPublicLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl(apiUrl));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setApiError('Браузер не разрешил копирование. Скопируйте адрес из строки браузера.');
    }
  };

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">DIGITAL TWIN PLATFORM</p>
          <h1>GreenCore</h1>
          <p className="subtitle">Живое сравнение автоматики с baseline без операторских действий</p>
        </div>
        <div className="clock">
          <span>Виртуальное время браузерной модели</span>
          <strong>{formatTime(automatic.state.simulatedMinutes)}</strong>
        </div>
      </header>

      <nav className="controls">
        <button className="primary" onClick={() => setRunning(value => !value)}>{running ? 'Пауза' : 'Продолжить'}</button>
        {speeds.map(item => <button key={item} className={speed === item ? 'active' : ''} onClick={() => setSpeed(item)}>×{item}</button>)}
        <button onClick={reset}>Сбросить</button>
      </nav>

      <section className="comparison-banner">
        <div><span>Модельный дополнительный урожай</span><strong>+{comparison.yield.toFixed(2)} кг</strong></div>
        <div><span>Модельные предотвращённые потери</span><strong>{comparison.lossPrevented.toFixed(2)} кг</strong></div>
        <div><span>Модельный эффект на прибыль</span><strong>{comparison.profit >= 0 ? '+' : ''}{money(comparison.profit)}</strong></div>
      </section>

      <div className="scenarios">
        <ScenarioCard title="Управление GreenCore" scenario={automatic} />
        <ScenarioCard title="Без операторских действий" scenario={manual} />
      </div>

      <section className="model-warning">
        <strong>Что именно показано</strong>
        <p>Оба сценария получают одинаковую погоду и стартовые условия. Разница создаётся логикой насоса и вентиляции. Урожай и прибыль — демонстрационные показатели браузерной модели, не агрономический или инвестиционный прогноз.</p>
      </section>

      <CoreVerification
        apiDraft={apiDraft}
        apiUrl={apiUrl}
        loading={loading}
        error={apiError}
        report={report}
        copied={copied}
        liveStatus={liveStatus}
        health={health}
        liveSnapshot={liveSnapshot}
        liveEvents={liveEvents}
        lastEventAt={lastEventAt}
        onDraftChange={setApiDraft}
        onConnect={connectToCore}
        onRun={() => void verifyWithCore()}
        onCopy={() => void copyPublicLink()}
      />

      <section className="explanation">
        <p className="eyebrow">ПОЧЕМУ МЕНЯЕТСЯ РЕЗУЛЬТАТ</p>
        <h3>Автоматика реагирует до того, как длительный выход параметров из диапазона накапливает модельный стресс.</h3>
        <p>Dashboard разделяет три вещи: быстрый digital twin в браузере, живой серверный контур GreenCore и воспроизводимый сравнительный отчёт.</p>
      </section>
    </main>
  );
}
