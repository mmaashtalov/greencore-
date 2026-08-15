import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDirectory = path.join(repositoryRoot, 'core');
const [major, minor] = process.versions.node.split('.').map(Number);
const pnpmInvocation = {
  command: process.platform === 'win32' ? 'corepack.cmd' : 'corepack',
  prefixArguments: ['pnpm'],
};

if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`GreenCore requires Node.js 22.13.0 or newer; found ${process.version}.`);
  process.exit(1);
}

const checks = [
  {
    label: 'Monorepo typecheck',
    command: pnpmInvocation.command,
    args: [...pnpmInvocation.prefixArguments, 'typecheck'],
    cwd: repositoryRoot,
  },
  {
    label: 'Production build',
    command: pnpmInvocation.command,
    args: [...pnpmInvocation.prefixArguments, 'build'],
    cwd: repositoryRoot,
  },
  { label: 'Core tests', command: 'npm', args: ['test'], cwd: coreDirectory },
  { label: 'Scenario runner', command: 'npm', args: ['run', 'scenarios'], cwd: coreDirectory },
  { label: 'Fault campaigns', command: 'npm', args: ['run', 'faults'], cwd: coreDirectory },
];

for (const check of checks) {
  console.log(`\n==> ${check.label}`);
  const result = spawnSync(check.command, check.args, {
    cwd: check.cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(`Could not start ${check.command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`${check.label} failed with exit code ${result.status ?? 'unknown'}.`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nGreenCore software acceptance: PASS');
