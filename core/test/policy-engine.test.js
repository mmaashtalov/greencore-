import test from 'node:test';
import assert from 'node:assert/strict';
import contracts from '../contracts/device-contracts.json' with { type: 'json' };
import rules from '../rules/pilot-rules.json' with { type: 'json' };
import { GreenCoreEngine } from '../src/engine.js';
import { PolicyEngine } from '../src/policy-engine.js';

function createClock(iso = '2026-07-29T10:00:00.000Z') {
  let value = new Date(iso);
  return {
    now: () => new Date(value),
    advance(seconds) { value = new Date(value.getTime() + seconds * 1000); }
  };
}

function sample(clock, metric, value, quality = 'GOOD') {
  const units = {
    air_temperature: '°C',
    soil_moisture: '%',
    water_level: '%'
  };
  return {
    device_id: `${metric}_sensor`,
    metric,
    value,
    unit: units[metric],
    timestamp: clock.now().toISOString(),
    quality
  };
}

function fixture({ water = 80, soil = 50, air = 24 } = {}) {
  const clock = createClock();
  const engine = new GreenCoreEngine({ contracts, rules, now: clock.now });
  engine.ingest(sample(clock, 'air_temperature', air));
  engine.ingest(sample(clock, 'soil_moisture', soil));
  engine.ingest(sample(clock, 'water_level', water));
  return { clock, engine };
}

test('policy engine resolves referenced thresholds and selects highest priority match', () => {
  const policy = new PolicyEngine({
    now: () => new Date('2026-07-29T10:00:00.000Z'),
    idFactory: () => 'fixed',
    config: {
      version: 'test',
      default_effect: 'ALLOW',
      policies: [
        {
          id: 'lower-priority',
          priority: 10,
          effect: 'DENY',
          when: { fact: 'telemetry.water.value', operator: 'lt', value: 30 }
        },
        {
          id: 'higher-priority',
          priority: 20,
          effect: 'DENY',
          when: { fact: 'telemetry.water.value', operator: 'lt', value: { ref: 'rules.minimum' } }
        }
      ]
    }
  });

  const decision = policy.evaluate({
    command: { actuator_id: 'pump_01', actuator_type: 'pump', action: 'ON', source: 'MANUAL' },
    mode: { configured: 'MANUAL', effective: 'MANUAL' },
    connectivity: { connected: true },
    actuator: { state: 'OFF' },
    required_telemetry_usable: true,
    telemetry: { water: { value: 20 } },
    rules: { minimum: 25 }
  });

  assert.equal(decision.effect, 'DENY');
  assert.equal(decision.policy_id, 'higher-priority');
  assert.equal(decision.decision_id, 'pdec_fixed');
  assert.equal(decision.evidence[0].expected, 25);
});

test('manual pump activation is denied when water is below safety minimum', () => {
  const { engine } = fixture({ water: 10, soil: 25 });
  engine.setMode('MANUAL');
  engine.requestManual('pump_01', 'ON', 'operator irrigation request');

  const commands = engine.evaluate();
  const decision = engine.policyDecisionHistory(1)[0];

  assert.equal(commands.some(command => command.actuator_id === 'pump_01' && command.action === 'ON'), false);
  assert.equal(decision.effect, 'DENY');
  assert.equal(decision.policy_id, 'deny-pump-on-low-water');
  assert.ok(engine.alerts.some(alert => alert.type === 'POLICY_DENIED_PUMP_LOW_WATER'));
  assert.ok(engine.alerts.some(alert => alert.type === 'MANUAL_COMMAND_REJECTED_LOW_WATER'));
});

test('automatic pump activation is denied during configured cooldown', () => {
  const { clock, engine } = fixture({ water: 80, soil: 20, air: 24 });
  engine.setMode('AUTO');
  const pump = engine.actuators.get('pump_01');
  pump.state = 'OFF';
  pump.changedAt = new Date(clock.now().getTime() - 30_000).toISOString();

  const commands = engine.evaluate();
  const decision = engine.policyDecisionHistory(1)[0];

  assert.equal(commands.some(command => command.actuator_id === 'pump_01' && command.action === 'ON'), false);
  assert.equal(decision.effect, 'DENY');
  assert.equal(decision.policy_id, 'deny-pump-on-during-cooldown');
});

test('manual fan shutdown is denied while temperature remains high', () => {
  const { clock, engine } = fixture({ water: 80, soil: 50, air: 33 });
  engine.setMode('MANUAL');
  const fan = engine.actuators.get('fan_01');
  fan.state = 'ON';
  fan.changedAt = new Date(clock.now().getTime() - 120_000).toISOString();
  engine.requestManual('fan_01', 'OFF', 'operator wants quiet mode');

  const commands = engine.evaluate();
  const decision = engine.policyDecisionHistory(1)[0];

  assert.equal(commands.some(command => command.actuator_id === 'fan_01' && command.action === 'OFF'), false);
  assert.equal(fan.state, 'ON');
  assert.equal(decision.policy_id, 'deny-fan-off-at-high-temperature');
  assert.ok(engine.alerts.some(alert => alert.type === 'POLICY_DENIED_FAN_OFF_HIGH_TEMPERATURE'));
});

test('allowed command includes policy explanation and decisions survive restore', () => {
  const { clock, engine } = fixture({ water: 80, soil: 20, air: 24 });
  engine.setMode('AUTO');

  const commands = engine.evaluate();
  const pumpCommand = commands.find(command => command.actuator_id === 'pump_01' && command.action === 'ON');

  assert.ok(pumpCommand);
  assert.equal(pumpCommand.policy_decision.effect, 'ALLOW');
  assert.match(pumpCommand.policy_decision.decision_id, /^pdec_/);
  assert.equal(typeof pumpCommand.policy_decision.summary, 'string');

  const snapshot = engine.snapshot();
  const restored = new GreenCoreEngine({ contracts, rules, now: clock.now });
  restored.restore(snapshot, { logEvent: false });

  assert.equal(restored.policyDecisionHistory(10).length, engine.policyDecisionHistory(10).length);
  assert.equal(restored.policyDecisionHistory(1)[0].decision_id, pumpCommand.policy_decision.decision_id);
  assert.equal(restored.snapshot().policy_contract.version, rules.policy_set.version);
});

test('policy preview explains a decision without mutating decision history', () => {
  const { engine } = fixture({ water: 5, soil: 20, air: 24 });
  engine.setMode('MANUAL');

  const before = engine.policyDecisionHistory(100).length;
  const decision = engine.previewPolicy({
    actuator_id: 'pump_01',
    action: 'ON',
    source: 'MANUAL',
    reason: 'preview only'
  });

  assert.equal(decision.effect, 'DENY');
  assert.equal(decision.policy_id, 'deny-pump-on-low-water');
  assert.equal(engine.policyDecisionHistory(100).length, before);
});
