import { ScenarioRunner } from './scenario-runner.js';
import { SCENARIO_CATALOG, scenarioDefinition } from './scenario-catalog.js';

const requested = process.argv[2] ?? process.env.SCENARIO ?? 'all';
const names = requested === 'all' ? Object.keys(SCENARIO_CATALOG) : [requested];
const reports = [];

for (const name of names) {
  const definition = scenarioDefinition(name);
  const runner = new ScenarioRunner(definition.runner);
  const result = runner.run({
    durationSeconds: definition.durationSeconds,
    expectations: definition.expectations
  });
  reports.push({
    name,
    description: definition.description,
    passed: result.passed,
    checks: result.checks,
    summary: result.summary
  });
}

const campaign = {
  passed: reports.every(report => report.passed),
  generated_at: new Date().toISOString(),
  scenarios: reports
};

console.log(JSON.stringify(campaign, null, 2));
if (!campaign.passed) process.exitCode = 1;
