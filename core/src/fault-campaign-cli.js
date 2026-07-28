import { FaultCampaignRunner } from './fault-campaign-runner.js';
import { FAULT_CAMPAIGN_CATALOG, faultCampaignDefinition } from './fault-campaign-catalog.js';

const requested = process.argv[2] ?? process.env.FAULT_CAMPAIGN ?? 'all';
const names = requested === 'all' ? Object.keys(FAULT_CAMPAIGN_CATALOG) : [requested];
const reports = [];

for (const name of names) {
  const definition = faultCampaignDefinition(name);
  const result = new FaultCampaignRunner(definition.runner).run({
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
  campaigns: reports
};

console.log(JSON.stringify(campaign, null, 2));
if (!campaign.passed) process.exitCode = 1;
