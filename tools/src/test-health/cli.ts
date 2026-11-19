import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { analyze, type CurrentTest, type Outcome, type TestHealth, type TreeOf } from './analyze.ts';
import { collect } from './collect.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STATE_DIR = join(ROOT, '.tmp', 'test-health');

const usage = `Usage:
  pnpm --silent --filter @floway-dev/tools run test-health [--since <YYYY-MM-DD>]

Reads every finished Verify run attempt since the given date (default: the
first one), maps its outcomes onto the tests in the current checkout by exact
project, file, and name, and writes .tmp/test-health/report.json and
report.md. Downloads are cached under .tmp/test-health/attempts.
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

// Two checkouts carry the same source exactly when their commits share a
// tree. Pull request runs check out a synthetic merge commit that GitHub
// replaces on every push, so most of those are absent locally and only match
// reruns of themselves. Lazy fetching is off because this is a partial clone,
// where every miss would otherwise become a network round trip.
const gitTrees = (commits: Iterable<string>): TreeOf => {
  const unique = [...new Set(commits)];
  const result = spawnSync('git', ['cat-file', '--batch-check=%(objectname) %(rest)'], {
    cwd: ROOT, input: unique.map(commit => `${commit}^{tree} ${commit}`).join('\n'), encoding: 'utf8', maxBuffer: 1 << 28,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
  });
  if (result.status !== 0) throw new Error(`git cat-file exited with ${result.status}:\n${result.stderr}`);
  const trees = new Map(result.stdout.trim().split('\n')
    .filter(line => !line.endsWith(' missing'))
    .map(line => line.split(' ').toReversed() as [string, string]));
  return commit => trees.get(commit);
};

type Verdict =
  /** Clean-file passes and no failures. */
  | 'healthy'
  /** Failed and passed on the same source tree. */
  | 'flaky'
  /** Failed, but never beside a pass on the same tree: either a broken revision or an unproven flake. */
  | 'needs-audit'
  /** No run recorded a failure or a clean pass of its file. */
  | 'unobserved';

const verdict = (health: TestHealth | undefined): Verdict => {
  if (health === undefined) return 'unobserved';
  if (health.splitTrees.length > 0) return 'flaky';
  if (health.outcomes.some(outcome => outcome.evidence !== 'file-passed')) return 'needs-audit';
  return 'healthy';
};

const failuresOf = (health: TestHealth): Outcome[] => health.outcomes.filter(outcome => outcome.evidence !== 'file-passed');

const renderMarkdown = (rows: { key: string; verdict: Verdict; health: TestHealth | undefined }[], duplicates: string[]): string => {
  const counts = Map.groupBy(rows, row => row.verdict);
  const lines = [
    '# Test health',
    '',
    'Passes are inferred from a test file finishing with no failed or skipped test; failures are named by the reporter or by check annotations.',
    '',
    '| Verdict | Tests |',
    '|---|---|',
    ...(['healthy', 'flaky', 'needs-audit', 'unobserved'] as const).map(name => `| ${name} | ${counts.get(name)?.length ?? 0} |`),
  ];
  for (const name of ['flaky', 'needs-audit'] as const) {
    lines.push('', `## ${name}`, '');
    for (const { key, health } of (counts.get(name) ?? []).toSorted((a, b) => failuresOf(b.health!).length - failuresOf(a.health!).length)) {
      const failures = failuresOf(health!);
      const passes = health!.outcomes.length - failures.length;
      lines.push(`### \`${key.replaceAll('|', ' › ')}\``, '', `${failures.length} failed, ${passes} passed${health!.splitTrees.length > 0 ? `, split trees ${health!.splitTrees.join(', ')}` : ''}`, '');
      for (const failure of failures) {
        lines.push(`- [${failure.runId}/${failure.attempt}](https://github.com/Menci/Floway/actions/runs/${failure.runId}/attempts/${failure.attempt}) ${failure.createdAt.slice(0, 10)} \`${failure.branch}\` ${failure.commit.slice(0, 10)} ${failure.evidence}: ${failure.error ?? ''}`);
      }
      lines.push('');
    }
  }
  if (duplicates.length > 0) lines.push('## Ambiguous names', '', ...duplicates.map(key => `- \`${key.replaceAll('|', ' › ')}\``));
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
    if (done % 100 === 0 || done === total) process.stderr.write(`collected ${done}/${total} run attempts\n`);
  });
  const treeOf = gitTrees(observations.map(observation => observation.testedCommit ?? observation.headSha));
  const healthByKey = new Map(analyze(tests, observations, treeOf).map(health => [health.key, health]));
  const keys = tests.map(test => `${test.project}|${test.file}|${test.name}`);
  // Tests sharing a full name are indistinguishable in reports, so their
  // outcomes are pooled under that name.
  const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
  const rows = [...new Set(keys)].map(key => {
    const health = healthByKey.get(key);
    return { key, verdict: verdict(health), health };
  });
  await writeFile(join(STATE_DIR, 'report.json'), JSON.stringify({
    attempts: new Set(observations.map(observation => `${observation.runId}/${observation.attempt}`)).size,
    tests: rows.map(({ key, verdict, health }) => ({
      key,
      verdict,
      passes: health?.outcomes.filter(outcome => outcome.evidence === 'file-passed').length ?? 0,
      failures: health === undefined ? [] : failuresOf(health),
      splitTrees: health?.splitTrees ?? [],
    })),
    duplicates,
  }, null, 2));
  await writeFile(join(STATE_DIR, 'report.md'), renderMarkdown(rows, duplicates));
  process.stdout.write(`${relative(ROOT, join(STATE_DIR, 'report.md'))}\n`);
};

await main();
