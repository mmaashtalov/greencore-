import { useCallback, useEffect, useMemo, useState } from 'react';
import { initialApiUrl, saveApiUrl } from './core-api';
import {
  clearOperatorToken,
  evaluateOperatorNow,
  fetchOperatorState,
  initialOperatorToken,
  issueOperatorCommand,
  saveOperatorToken,
  setOperatorConnectivity,
  setOperatorMode,
  type ActuatorAction,
  type ActuatorId,
  type OperatorMode,
  type OperatorRuntimeState,
} from './operator-api';
import './owner-console.css';

const DEVICES: Array<{
  id: ActuatorId;
  label: string;
  actions: Array<{ action: ActuatorAction; label: string; active?: boolean }>;
}> = [
  { id: 'pump_01', label: 'Насос', actions: [{ action: 'ON', label: 'Включить', active: true }, { action: 'OFF', label: 'Выключить' }] },
  { id: 'fan_01', label: 'Вентиляция', actions: [{ action: 'ON', label: 'Включить', active: true }, { action: 'OFF', label: 'Выключить' }] },
  { id: 'vent_01', label: 'Форточка', actions: [{ action: 'OPEN', label: 'Открыть', active: true }, { action: 'CLOSE', label: 'Закрыть' }] },
];

function localDate(value?: string | null) {
  if (!value) return 'нет данных';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'нет данных' : date.toLocaleString('ru-RU');
}

function telemetryValue(state: OperatorRuntimeState | null, metric: string) {
  const sample = state?.telemetry?.[metric];
  if (!sample) return '—';
  return `${sample.value.toFixed(1)} ${sample.unit}`;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Неизвестная ошибка';
}

export function OwnerConsole() {
  const initialApi = useMemo(() => initialApiUrl(), []);
  const initialToken = useMemo(() => initialOperatorToken(), []);
  const [apiDraft, setApiDraft] = useState(initialApi);
  const [apiUrl, setApiUrl] = useState(initialApi);
  const [tokenDraft, setTokenDraft] = useState(initialToken);
  const [token, setToken] = useState(initialToken);
  const [runtime, setRuntime] = useState<OperatorRuntimeState | null>(null);
  const [reason, setReason] = useState('owner console request');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const authenticated = Boolean(apiUrl && token && runtime);

  const refresh = useCallback(async (nextApiUrl = apiUrl, nextToken = token) => {
    if (!nextApiUrl || !nextToken) return null;
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
      if (!nextApiUrl) throw new Error('Укажите адрес GreenCore API');
      if (!nextToken) throw new Error('Введите operator или admin token');
      const nextState = await fetchOperatorState(nextApiUrl, nextToken);
      setApiUrl(nextApiUrl);
      setToken(nextToken);
      setRuntime(nextState);
      setNotice('Защищённая панель подключена');
    } catch (connectError) {
      setRuntime(null);
      setError(errorText(connectError));
    } finally {
      setBusy(false);
    }
  }, [apiDraft, tokenDraft]);

  useEffect(() => {
    if (!apiUrl || !token) return;
    let active = true;
    const update = async () => {
      try {
        const nextState = await fetchOperatorState(apiUrl, token);
        if (active) setRuntime(nextState);
      } catch (refreshError) {
        if (active) setError(errorText(refreshError));
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

  const execute = async (label: string, action: () => Promise<unknown>) => {
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
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setBusy(false);
    }
  };

  const changeMode = (mode: OperatorMode) => void execute(`Режим переключён: ${mode}`, () => setOperatorMode(apiUrl, token, mode));

  const forceSafe = () => void execute('SAFE применён и выполнена немедленная оценка', async () => {
    await setOperatorMode(apiUrl, token, 'SAFE');
    await evaluateOperatorNow(apiUrl, token);
  });

  const sendCommand = (actuatorId: ActuatorId, action: ActuatorAction, active = false) => {
    if (active && !window.confirm(`Отправить команду ${actuatorId} → ${action}? Safety-проверки останутся активны.`)) return;
    void execute(`Команда поставлена в очередь: ${actuatorId} → ${action}`, () => issueOperatorCommand(apiUrl, token, actuatorId, action, reason));
  };

  return (
    <section className="owner-console" aria-label="Панель владельца GreenCore">
      <div className="owner-console__heading">
        <div>
          <p className="owner-console__eyebrow">OWNER CONSOLE v1</p>
          <h2>Защищённая мобильная панель владельца</h2>
          <p>Публичный dashboard остаётся read-only. Управление появляется только после ввода operator или admin token.</p>
        </div>
        <span className={`owner-console__status ${authenticated ? 'connected' : ''}`}>{authenticated ? 'OPERATOR CONNECTED' : 'LOCKED'}</span>
      </div>

      <div className="owner-console__auth">
        <label>
          <span>GreenCore API</span>
          <input value={apiDraft} onChange={event => setApiDraft(event.target.value)} placeholder="https://api.example.com" inputMode="url" />
        </label>
        <label>
          <span>Operator / Admin token</span>
          <input value={tokenDraft} onChange={event => setTokenDraft(event.target.value)} placeholder="Токен не попадёт в публичную ссылку" type="password" autoComplete="current-password" />
        </label>
        <button className="owner-console__primary" onClick={() => void connect()} disabled={busy}>{busy ? 'Выполняю…' : 'Подключить'}</button>
        <button onClick={disconnect} disabled={!tokenDraft && !token}>Забыть токен</button>
      </div>

      <p className="owner-console__security">Токен хранится только в sessionStorage текущей вкладки и удаляется при закрытии сессии или по кнопке «Забыть токен».</p>
      {error && <p className="owner-console__message error">{error}</p>}
      {notice && <p className="owner-console__message success">{notice}</p>}

      {!authenticated && (
        <div className="owner-console__locked">
          <strong>Панель подготовлена, но управление заблокировано</strong>
          <p>Backend можно развернуть позже с ПК. До этого никакие действия от владельца не требуются.</p>
        </div>
      )}

      {authenticated && runtime && (
        <>
          <div className="owner-console__summary">
            <div><span>Режим</span><strong>{runtime.effective_mode}</strong></div>
            <div><span>Связь</span><strong>{runtime.connected ? 'ONLINE' : 'OFFLINE'}</strong></div>
            <div><span>Команды</span><strong>{runtime.pending_commands.length}</strong></div>
            <div><span>Тревоги</span><strong>{runtime.alerts.length}</strong></div>
          </div>

          <div className="owner-console__telemetry">
            <div><span>Почва</span><strong>{telemetryValue(runtime, 'soil_moisture')}</strong></div>
            <div><span>Температура</span><strong>{telemetryValue(runtime, 'air_temperature')}</strong></div>
            <div><span>Влажность воздуха</span><strong>{telemetryValue(runtime, 'air_humidity')}</strong></div>
            <div><span>Вода</span><strong>{telemetryValue(runtime, 'water_level')}</strong></div>
          </div>

          <div className="owner-console__grid">
            <article className="owner-console__card">
              <div className="owner-console__card-heading"><h3>Режим управления</h3><button className="owner-console__danger" onClick={forceSafe} disabled={busy}>SAFE сейчас</button></div>
              <div className="owner-console__button-row">
                {(['AUTO', 'MANUAL', 'SAFE'] as OperatorMode[]).map(mode => (
                  <button key={mode} className={runtime.configured_mode === mode ? 'active' : ''} onClick={() => changeMode(mode)} disabled={busy}>{mode}</button>
                ))}
              </div>
              <div className="owner-console__button-row">
                <button className={runtime.connected ? 'active' : ''} onClick={() => void execute('Связь ядра: ONLINE', () => setOperatorConnectivity(apiUrl, token, true))} disabled={busy}>Связь ONLINE</button>
                <button className={!runtime.connected ? 'active warning' : ''} onClick={() => void execute('Связь ядра: OFFLINE', () => setOperatorConnectivity(apiUrl, token, false))} disabled={busy}>Связь OFFLINE</button>
                <button onClick={() => void execute('Немедленная оценка завершена', () => evaluateOperatorNow(apiUrl, token))} disabled={busy}>Оценить сейчас</button>
              </div>
            </article>

            <article className="owner-console__card">
              <h3>Ручные команды</h3>
              <label className="owner-console__reason">
                <span>Причина команды</span>
                <input value={reason} onChange={event => setReason(event.target.value)} maxLength={160} />
              </label>
              <div className="owner-console__devices">
                {DEVICES.map(device => (
                  <div key={device.id}>
                    <div><strong>{device.label}</strong><small>{device.id} · сейчас {runtime.actuators[device.id]?.state ?? 'UNKNOWN'}</small></div>
                    <div>
                      {device.actions.map(item => (
                        <button key={item.action} onClick={() => sendCommand(device.id, item.action, item.active)} disabled={busy}>{item.label}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <p className="owner-console__hint">Команда сначала попадает в очередь. Серверные и локальные safety-проверки могут её отклонить.</p>
            </article>
          </div>

          <article className="owner-console__card owner-console__alerts">
            <div className="owner-console__card-heading"><h3>Последние тревоги</h3><button onClick={() => void refresh()} disabled={busy}>Обновить</button></div>
            {runtime.alerts.length === 0 && <p className="owner-console__muted">Активных записей тревог нет.</p>}
            {[...runtime.alerts].slice(-6).reverse().map((alert, index) => (
              <div key={`${alert.type}-${alert.timestamp ?? index}`}>
                <strong>{alert.type}</strong>
                <span>{localDate(alert.timestamp)}</span>
              </div>
            ))}
          </article>
        </>
      )}
    </section>
  );
}
