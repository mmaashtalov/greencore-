import { useEffect, useMemo, useState } from 'react';
import {
  calculateEconomy,
  createInitialState,
  defaultConfig,
  stepSimulation,
  type ControlMode,
} from '@greencore/simulation-core';
import type { GreenhouseState } from '@greencore/domain-model';

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

  return (
    <section className="scenario-card">
      <div className="scenario-header">
        <div>
          <p className="eyebrow">{scenario.mode === 'automatic' ? 'GREENCORE AI' : 'БАЗОВЫЙ СЦЕНАРИЙ'}</p>
          <h2>{title}</h2>
        </div>
        <div className={`status ${scenario.mode}`}>
          <span />{scenario.mode === 'automatic' ? 'Автоматически' : 'Вручную'}
        </div>
      </div>

      <div className="equipment-row">
        <div className={`equipment ${s.pumpOn ? 'on' : ''}`}><span>Насос</span><b>{s.pumpOn ? 'ON' : 'OFF'}</b></div>
        <div className={`equipment ${s.fanOn ? 'on' : ''}`}><span>Вентиляция</span><b>{s.fanOn ? 'ON' : 'OFF'}</b></div>
      </div>

      <div className="metrics-grid">
        {metric('Температура', `${s.insideTemperatureC.toFixed(1)} °C`, s.insideTemperatureC > 30)}
        {metric('Влажность почвы', `${s.soilMoisturePct.toFixed(1)} %`, s.soilMoisturePct < 38)}
        {metric('Здоровье растений', `${s.plantHealthPct.toFixed(1)} %`, s.plantHealthPct < 80)}
        {metric('Прогноз урожая', `${s.predictedYieldKg.toFixed(1)} кг`)}
        {metric('Потеря урожая', `${s.irreversibleYieldLossKg.toFixed(2)} кг`, s.irreversibleYieldLossKg > 0.1)}
        {metric('Накопленный стресс', s.accumulatedStress.toFixed(1), s.accumulatedStress > 12)}
      </div>

      <div className="resource-strip">
        <span>Вода <b>{s.waterUsedLiters.toFixed(0)} л</b></span>
        <span>Энергия <b>{s.electricityUsedKwh.toFixed(1)} кВт·ч</b></span>
        <span>Затраты <b>{money(economy.operatingCostRub)}</b></span>
      </div>

      <div className="profit">
        <span>Прогнозная прибыль</span>
        <strong>{money(economy.projectedProfitRub)}</strong>
      </div>
    </section>
  );
}

export function App() {
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState<(typeof speeds)[number]>(300);
  const [automatic, setAutomatic] = useState<Scenario>({ mode: 'automatic', state: createInitialState() });
  const [manual, setManual] = useState<Scenario>({ mode: 'manual', state: createInitialState() });

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

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">DIGITAL TWIN PLATFORM</p>
          <h1>GreenCore</h1>
          <p className="subtitle">Наглядное сравнение ручного и автоматического управления теплицей</p>
        </div>
        <div className="clock">
          <span>Виртуальное время</span>
          <strong>{formatTime(automatic.state.simulatedMinutes)}</strong>
        </div>
      </header>

      <nav className="controls">
        <button className="primary" onClick={() => setRunning(value => !value)}>{running ? 'Пауза' : 'Продолжить'}</button>
        {speeds.map(item => <button key={item} className={speed === item ? 'active' : ''} onClick={() => setSpeed(item)}>×{item}</button>)}
        <button onClick={reset}>Сбросить</button>
      </nav>

      <section className="comparison-banner">
        <div><span>Дополнительный урожай</span><strong>+{comparison.yield.toFixed(2)} кг</strong></div>
        <div><span>Предотвращённые потери</span><strong>{comparison.lossPrevented.toFixed(2)} кг</strong></div>
        <div><span>Эффект на прибыль</span><strong>{comparison.profit >= 0 ? '+' : ''}{money(comparison.profit)}</strong></div>
      </section>

      <div className="scenarios">
        <ScenarioCard title="Управление GreenCore" scenario={automatic} />
        <ScenarioCard title="Ручное управление" scenario={manual} />
      </div>

      <section className="explanation">
        <p className="eyebrow">ПОЧЕМУ МЕНЯЕТСЯ РЕЗУЛЬТАТ</p>
        <h3>Автоматика реагирует до того, как стресс превращается в необратимую потерю урожая.</h3>
        <p>Оба сценария получают одинаковую погоду и стартовые условия. Разница создаётся только логикой управления насосом и вентиляцией.</p>
      </section>
    </main>
  );
}