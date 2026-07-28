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
  initialApiUrl,
  runCoreComparison,
  saveApiUrl,
  shareUrl,
  type CoreComparisonReport,
  type CoreMetrics,
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

function CoreVerification({
  apiDraft,
  apiUrl,
  loading,
  error,
  report,
  copied,
  onDraftChange,
  onRun,
  onCopy,
}: {
  apiDraft: string;
  apiUrl: string;
  loading: boolean;
  error: string;
  report: CoreComparisonReport | null;
  copied: boolean;
  onDraftChange: (value: string) => void;
  onRun: () => void;
  onCopy: () => void;
}) {
  const auto = report?.strategies.automatic.metrics;
  const manual = report?.strategies.manual_baseline.metrics;

  return (
    <section className="core-verification">
      <div className="verification-heading">
        <div>
          <p className="eyebrow">GREENCORE CORE v0.8</p>
          <h3>Проверка тем же ядром, которое управляет controller contract</h3>
          <p>Сервер запускает идентичные 24 часа для AUTO и baseline без операторских действий, сохраняет отчёт и возвращает измеримые различия.</p>
        </div>
        <span className={`api-status ${report ? 'connected' : ''}`}>{report ? 'Отчёт получен' : apiUrl ? 'API настроен' : 'API не подключён'}</span>
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
        <button className="primary" onClick={onRun} disabled={loading}>{loading ? 'Считаю…' : 'Запустить проверку 24 ч'}</button>
        <button onClick={onCopy} disabled={!apiUrl}>{copied ? 'Ссылка скопирована' : 'Скопировать публичную ссылку'}</button>
      </div>

      {error && <p className="api-error">{error}</p>}
      {!apiUrl && !report && <p className="api-note">Интерактивная браузерная модель выше работает автономно. Для серверной верификации нужен опубликованный GreenCore API.</p>}

      {report && auto && manual && (
        <>
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
        </>
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

  const verifyWithCore = async () => {
    setLoading(true);
    setApiError('');
    setCopied(false);
    try {
      const normalized = saveApiUrl(apiDraft);
      setApiUrl(normalized);
      const nextReport = await runCoreComparison(normalized);
      setReport(nextReport);
      const url = new URL(window.location.href);
      url.searchParams.set('api', normalized);
      window.history.replaceState({}, '', url);
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
        onDraftChange={setApiDraft}
        onRun={() => void verifyWithCore()}
        onCopy={() => void copyPublicLink()}
      />

      <section className="explanation">
        <p className="eyebrow">ПОЧЕМУ МЕНЯЕТСЯ РЕЗУЛЬТАТ</p>
        <h3>Автоматика реагирует до того, как длительный выход параметров из диапазона накапливает модельный стресс.</h3>
        <p>Dashboard разделяет две вещи: быстрый интерактивный digital twin в браузере и воспроизводимый отчёт серверного GreenCore Core.</p>
      </section>
    </main>
  );
}
