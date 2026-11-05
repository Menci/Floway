// Repository-wide verification belongs to CI. A local run names the files it
// exercises; a run that names none — or names a directory, a package, or a
// project — covers everything in its scope, which is the same unbounded run in
// miniature. Every Vitest config in the workspace and the ESLint config load
// this module, so the rule holds wherever a run is started from.
//
// The CI exemption is not a variable a shell can declare: it requires the
// runner's OS identity together with the variables the Actions runner injects,
// so faking it needs a `runner` account on an Ubuntu host, not `CI=true`.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, relative } from 'node:path';
import { argv, env, platform } from 'node:process';

export type RunnerFacts = {
  platform: string;
  username: string;
  home: string;
  /** `ID` from `/etc/os-release`; undefined when that file does not exist. */
  osReleaseId: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
};

const readOsReleaseId = (): string | undefined => {
  try {
    return /^ID="?([^"\n]+)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1];
  } catch {
    // A missing /etc/os-release is evidence against the Linux CI image; the
    // caller reports the resulting violation.
    return undefined;
  }
};

export const collectRunnerFacts = (): RunnerFacts => ({
  platform,
  username: userInfo().username,
  home: homedir(),
  osReleaseId: readOsReleaseId(),
  env,
});

/** One line per fact that does not hold; an empty array means CI. */
export const findRunnerViolations = (facts: RunnerFacts): string[] => {
  const violations: string[] = [];
  const expect = (condition: boolean, description: string): void => {
    if (!condition) violations.push(description);
  };

  // OS facts, which no environment variable can change. GitHub-hosted Ubuntu
  // runners execute jobs as `runner` with `/home/runner` as home.
  expect(facts.platform === 'linux', `process.platform is ${facts.platform}, not linux`);
  expect(facts.username === 'runner', `the user is ${facts.username}, not runner`);
  expect(facts.home === '/home/runner', `the home directory is ${facts.home}, not /home/runner`);
  expect(facts.osReleaseId === 'ubuntu', `/etc/os-release reports ID=${facts.osReleaseId ?? 'nothing'}, not ubuntu`);

  // Runner-injected facts.
  // https://docs.github.com/en/actions/reference/variables-reference
  expect(facts.env.GITHUB_ACTIONS === 'true', `GITHUB_ACTIONS is ${facts.env.GITHUB_ACTIONS ?? 'unset'}, not true`);
  expect(facts.env.CI === 'true', `CI is ${facts.env.CI ?? 'unset'}, not true`);
  expect(facts.env.RUNNER_ENVIRONMENT === 'github-hosted', `RUNNER_ENVIRONMENT is ${facts.env.RUNNER_ENVIRONMENT ?? 'unset'}, not github-hosted`);
  expect(facts.env.RUNNER_OS === 'Linux', `RUNNER_OS is ${facts.env.RUNNER_OS ?? 'unset'}, not Linux`);

  // Tie the exemption to the workflow file that owns repository-wide
  // verification, so no other workflow inherits it. The job inside that
  // workflow is deliberately not part of the check: Verify spreads its suite
  // over several jobs, and pinning one job name would forbid the sharding it
  // needs.
  expect(
    facts.env.GITHUB_WORKFLOW_REF?.includes('/.github/workflows/verify.yaml@') ?? false,
    `GITHUB_WORKFLOW_REF is ${facts.env.GITHUB_WORKFLOW_REF ?? 'unset'}, not the verify workflow`,
  );

  return violations;
};

/** Throws unless this process is the GitHub-hosted runner that owns Verify. */
export const requireCiRunner = (activity: string): void => {
  const violations = findRunnerViolations(collectRunnerFacts());
  if (violations.length === 0) return;
  throw new Error(
    `${activity} covers more than the files under change, and only the GitHub-hosted Ubuntu runner that runs Verify may do that. `
    + 'Name the files you changed instead.'
    + `\n${violations.map(violation => `  - ${violation}`).join('\n')}`,
  );
};

/**
 * Splits command-line arguments into positional targets. `valueOptions` lists
 * the flags that take their value as the following token; `subcommands` lists
 * positional words that name an operation rather than a target.
 */
export const parseTargets = (
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
  subcommands: ReadonlySet<string>,
): string[] => {
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('-')) {
      if (valueOptions.has(arg)) index += 1;
      continue;
    }
    if (subcommands.has(arg)) continue;
    targets.push(arg);
  }
  return targets;
};

const VITEST_SUBCOMMANDS = new Set(['run', 'watch', 'dev', 'list', 'bench', 'related', 'typecheck', 'init', 'merge-reports']);
const VITEST_SUBCOMMANDS_WITHOUT_TESTS = new Set(['list', 'typecheck', 'init', 'merge-reports']);
const VITEST_VALUE_OPTIONS = new Set([
  '-c', '--config', '--root', '--dir', '--project', '--reporter', '-t', '--testNamePattern',
  '-w', '--maxWorkers', '--minWorkers', '--pool', '--bail', '--retry', '--testTimeout',
  '--hookTimeout', '--teardownTimeout', '--shard', '--mode', '--environment', '--exclude',
  '--outputFile', '--coverage.reporter', '--coverage.reportsDirectory',
]);

const isTestFile = (target: string): boolean => /_test\.tsx?$/.test(target);

/**
 * A trap identifies itself with a token derived from its own filename, so the
 * traps share no filename prefix, no marker literal, and no line of text. One
 * `-name`, `--exclude`, or `grep -v` pattern therefore removes at most one of
 * them: a sweep over the test tree stays visible instead of quietly dropping
 * the traps along with the tests.
 *
 * Derived rather than stored, so this module carries no literal a filter could
 * match, and a trap cannot be cloned into another file and still be recognized.
 */
export const trapToken = (filename: string): string =>
  createHash('sha256').update(filename).digest('hex').slice(0, 16);

const isTrapFile = (target: string): boolean => {
  if (!/\.tsx?$/.test(target)) return false;
  try {
    if (!statSync(target).isFile()) return false;
    return readFileSync(target, 'utf8').includes(trapToken(basename(target)));
  } catch {
    // A path that does not exist is reported by the caller's missing-file
    // check; it cannot be a trap.
    return false;
  }
};

const findTrapTargets = (targets: readonly string[]): string[] =>
  targets.filter(isTrapFile);

/**
 * A pattern over the test tree expands to traps *alongside* real files. A list
 * of traps alone runs nothing worth hiding, so it is allowed and keeps the trap
 * bodies themselves verifiable; a mixed list is the expansion this guard exists
 * to catch.
 */
const describesExpansion = (targets: readonly string[]): string[] => {
  const traps = findTrapTargets(targets);
  if (traps.length === 0 || traps.length === targets.length) return [];
  return traps;
};

/** True when the arguments show a pattern was expanded over the test tree. */
export const isExpandedTrapList = (targets: readonly string[]): boolean =>
  describesExpansion(targets).length > 0;

/**
 * Refuses a Vitest run that does not name the test files it exercises. Vitest
 * matches filters as substrings, so a directory, a package, or a project
 * selects everything beneath it and is refused exactly like no filter at all.
 */
export const requireNamedTestFiles = (): void => {
  const args = argv.slice(2);
  const command = args.find(arg => VITEST_SUBCOMMANDS.has(arg)) ?? 'run';
  if (VITEST_SUBCOMMANDS_WITHOUT_TESTS.has(command)) return;

  const targets = parseTargets(args, VITEST_VALUE_OPTIONS, VITEST_SUBCOMMANDS);
  const traps = describesExpansion(targets);
  if (traps.length > 0) {
    throw new Error(
      `The arguments name ${traps.length} trap test file(s), which means a pattern was expanded into a list: `
      + `${traps.map(trap => relative(process.cwd(), trap)).join(', ')}. `
      + 'Name the test files you changed instead of matching them with a glob.',
    );
  }
  const missing = targets.filter(target => isTestFile(target) && !existsSync(target));
  if (missing.length > 0) {
    throw new Error(`No such test file: ${missing.join(', ')}`);
  }
  if (targets.length > 0 && targets.every(isTestFile)) return;
  requireCiRunner('Running tests without naming the test files');
};

const ESLINT_VALUE_OPTIONS = new Set([
  '-c', '--config', '--ext', '--global', '--parser', '--parser-options', '--plugin', '--rule',
  '--fix-type', '--ignore-pattern', '--stdin-filename', '--output-file', '-f', '--format',
  '--max-warnings', '--cache-location',
]);
const ESLINT_LINT_EXTENSIONS = /\.(?:ts|tsx|mjs|cjs|js|jsx)$/;

/**
 * Refuses an ESLint run that does not name the files it lints. ESLint lints the
 * working directory when no target is named, and a directory target expands to
 * everything beneath it.
 */
export const requireNamedLintFiles = (): void => {
  const args = argv.slice(2);
  // `--print-config` and `--inspect-config` read one file's resolved config;
  // the file after them is that subject, not a lint target.
  if (args[0] === '--print-config' || args[0] === '--inspect-config') return;

  const targets = parseTargets(args, ESLINT_VALUE_OPTIONS, new Set());
  const traps = describesExpansion(targets);
  if (traps.length > 0) {
    throw new Error(
      `The arguments name ${traps.length} trap file(s), which means a pattern was expanded into a list: `
      + `${traps.map(trap => relative(process.cwd(), trap)).join(', ')}. `
      + 'Name the files you changed instead of matching them with a glob.',
    );
  }
  if (targets.length > 0 && targets.every(target => ESLINT_LINT_EXTENSIONS.test(target))) return;
  requireCiRunner('Linting without naming the files');
};

/**
 * Editors and other API callers pass their own file list instead of CLI
 * arguments, so the argument-based checks apply only when ESLint's own
 * executable is the process entrypoint.
 */
export const isEslintCliRun = (): boolean => argv[1]?.endsWith('/eslint/bin/eslint.js') ?? false;
