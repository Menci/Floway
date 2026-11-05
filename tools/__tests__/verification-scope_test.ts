import { describe, expect, it } from 'vitest';

import { findRunnerViolations, isExpandedTrapList, parseTargets, TRAP_TEST_FILENAME, type RunnerFacts } from '../src/verification-scope.ts';

const runnerEnv = {
  GITHUB_ACTIONS: 'true',
  CI: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'Linux',
  GITHUB_JOB: 'verify',
  GITHUB_WORKFLOW_REF: 'Menci/Floway/.github/workflows/verify.yaml@refs/heads/main',
};

const runner: RunnerFacts = {
  platform: 'linux',
  username: 'runner',
  home: '/home/runner',
  osReleaseId: 'ubuntu',
  env: runnerEnv,
};

describe('findRunnerViolations', () => {
  it('accepts the GitHub-hosted Ubuntu runner that runs Verify', () => {
    expect(findRunnerViolations(runner)).toEqual([]);
  });

  it('rejects a developer machine even when every runner variable is declared', () => {
    expect(findRunnerViolations({
      ...runner,
      platform: 'darwin',
      username: 'menci',
      home: '/Users/menci',
      osReleaseId: undefined,
    })).toEqual([
      'process.platform is darwin, not linux',
      'the user is menci, not runner',
      'the home directory is /Users/menci, not /home/runner',
      '/etc/os-release reports ID=nothing, not ubuntu',
    ]);
  });

  it('rejects a self-hosted runner', () => {
    expect(findRunnerViolations({
      ...runner,
      env: { ...runnerEnv, RUNNER_ENVIRONMENT: 'self-hosted' },
    })).toEqual(['RUNNER_ENVIRONMENT is self-hosted, not github-hosted']);
  });

  it('rejects another workflow on a GitHub-hosted runner', () => {
    expect(findRunnerViolations({
      ...runner,
      env: { ...runnerEnv, GITHUB_WORKFLOW_REF: 'Menci/Floway/.github/workflows/build.yaml@refs/heads/main' },
    })).toEqual(['GITHUB_WORKFLOW_REF is Menci/Floway/.github/workflows/build.yaml@refs/heads/main, not the verify workflow']);
  });

  it('accepts any job inside Verify, which spreads its suite across jobs', () => {
    for (const job of ['verify', 'test', 'test-installers']) {
      expect(findRunnerViolations({ ...runner, env: { ...runnerEnv, GITHUB_JOB: job } })).toEqual([]);
    }
  });

  it('rejects a non-Ubuntu Linux host', () => {
    expect(findRunnerViolations({ ...runner, osReleaseId: 'debian' }))
      .toEqual(['/etc/os-release reports ID=debian, not ubuntu']);
  });
});

describe('parseTargets', () => {
  const valueOptions = new Set(['--project', '--reporter']);
  const subcommands = new Set(['run']);

  it('keeps only positional targets', () => {
    expect(parseTargets(['run', 'a_test.ts', '--project', 'x', 'b_test.ts'], valueOptions, subcommands))
      .toEqual(['a_test.ts', 'b_test.ts']);
  });

  it('drops the subcommand and standalone flags', () => {
    expect(parseTargets(['run', '--changed', 'a_test.ts'], valueOptions, subcommands))
      .toEqual(['a_test.ts']);
  });
});

describe('the trap that detects an expanded glob', () => {
  const trap = `packages/http/__tests__/${TRAP_TEST_FILENAME}`;
  const real = 'packages/http/__tests__/parser_test.ts';

  it('names a file every package carries', async () => {
    const { execFileSync } = await import('node:child_process');
    const found = execFileSync(
      'find',
      ['packages', 'apps', 'tools', '-name', TRAP_TEST_FILENAME, '-not', '-path', '*/node_modules/*'],
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean);

    expect(TRAP_TEST_FILENAME).toBe('disallow-full-tests_test.ts');
    expect(found.length).toBeGreaterThanOrEqual(19);
    expect(found).toContain('packages/http/__tests__/disallow-full-tests_test.ts');
    expect(found).toContain('packages/gateway/__tests__/repo/disallow-full-tests_test.ts');
  });

  it('recognizes a glob that expanded to traps and real files together', () => {
    expect(isExpandedTrapList([real, trap])).toBe(true);
  });

  it('recognizes a sweep of traps alone', () => {
    expect(isExpandedTrapList([trap, `packages/proxy/__tests__/${TRAP_TEST_FILENAME}`])).toBe(true);
  });

  it('allows naming one trap directly, so the trap body stays verifiable', () => {
    expect(isExpandedTrapList([trap])).toBe(false);
  });

  it('allows an ordinary list of test files', () => {
    expect(isExpandedTrapList([real])).toBe(false);
  });
});
