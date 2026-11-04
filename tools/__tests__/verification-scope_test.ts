import { describe, expect, it } from 'vitest';

import { findRunnerViolations, parseTargets, type RunnerFacts } from '../src/verification-scope.ts';

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
      env: { ...runnerEnv, GITHUB_JOB: 'build' },
    })).toEqual(['GITHUB_JOB is build, not verify']);
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
