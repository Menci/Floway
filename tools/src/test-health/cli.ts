import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { analyze, type CurrentTest, type TestHealth } from './analyze.ts';
import { collect } from './collect.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STATE_DIR = join(ROOT, '.tmp', 'test-health');

const usage = `Usage:
  pnpm --silent --filter @floway-dev/tools run test-health [--since <YYYY-MM-DD>]

Reads every finished Verify run since the given date (default: the first one),
maps per-test outcomes onto the tests in the current checkout, and writes
.tmp/test-health/report.json and report.md.
`;

// `vitest list` reports absolute file paths; the reporter prints them relative
// to the owning project's root, which is the directory of its config file.
const listCurrentTests = async (): Promise<CurrentTest[]> => {
  const output = join(STATE_DIR, 'tests.json');
  // The listing walks every project, which the repository's verification guard
  // reserves for CI; `list` is the one subcommand it permits locally.
  const result = spawnSync('pnpm', ['exec', 'vitest', 'list', '--json', output], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`vitest list exited with ${result.status}:\n${result.stderr}`);
  const listed = JSON.parse(await readFile(output, 'utf8')) as { name: string; file: string; projectName: string }[];
  return listed.map(test => {
    const marker = test.file.lastIndexOf('/__tests__/');
    return { project: test.projectName, file: relative(test.file.slice(0, marker), test.file), name: test.name };
  });
};

type Verdict = 'healthy' | 'flaky' | 'broken-then-fixed' | 'never-observed';

// A failure on a commit where the same test also passed is nondeterminism by
// definition. Failures confined to commits where the test never passed are
// real breakage on those trees; when the newest outcome passes, it was fixed.
const verdict = (health: TestHealth | undefined): Verdict => {
  if (health === undefined) return 'never-observed';
  if (health.failures === 0) return 'healthy';
  if (health.splitCommits.length > 0) return 'flaky';
  return 'broken-then-fixed';
};

const renderMarkdown = (rows: { key: string; verdict: Verdict; health: TestHealth | undefined }[]): string => {
  const counts = Map.groupBy(rows, row => row.verdict);
  const lines = ['# Test health', '', '| Verdict | Tests |', '|---|---|'];
  for (const name of ['healthy', 'flaky', 'broken-then-fixed', 'never-observed'] as const) lines.push(`| ${name} | ${counts.get(name)?.length ?? 0} |`);
  for (const name of ['flaky', 'broken-then-fixed'] as const) {
    lines.push('', `## ${name}`, '', '| Test | Runs | Failures | Split commits | Failing branches |', '|---|---|---|---|---|');
    for (const { key, health } of (counts.get(name) ?? []).toSorted((a, b) => b.health!.failures - a.health!.failures)) {
      lines.push(`| \`${key.replaceAll('|', ' › ')}\` | ${health!.runs} | ${health!.failures} | ${health!.splitCommits.length} | ${health!.failingBranches.join(', ')} |`);
    }
  }
  return `${lines.join('\n')}\n`;
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({ options: { since: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  await mkdir(STATE_DIR, { recursive: true });
  const tests = await listCurrentTests();
  const observations = await collect(join(STATE_DIR, 'attempts'), values.since ?? '2000-01-01', (done, total) => {
    if (done % 25 === 0 || done === total) process.stderr.write(`collected ${done}/${total} run attempts\n`);
  });
  const healthByKey = new Map(analyze(tests, observations).map(health => [health.key, health]));
  const rows = tests.map(test => {
    const key = `${test.project}|${test.file}|${test.name}`;
    const health = healthByKey.get(key);
    return { key, verdict: verdict(health), health };
  });
  await writeFile(join(STATE_DIR, 'report.json'), JSON.stringify(rows.filter(row => row.verdict === 'flaky' || row.verdict === 'broken-then-fixed'), null, 2));
  await writeFile(join(STATE_DIR, 'report.md'), renderMarkdown(rows));
  process.stdout.write(`${relative(ROOT, join(STATE_DIR, 'report.md'))}\n`);
};

await main();
