import { expect, test } from 'vitest';

import { findWranglerConfigMismatches } from '../src/wrangler-config-compare.ts';

const example = {
  name: '<YOUR_WORKER_NAME>',
  observability: { enabled: false },
  triggers: { crons: ['* * * * *'] },
};

test('a real Wrangler config may omit deployment-specific observability', () => {
  expect(findWranglerConfigMismatches(example, {
    name: 'floway',
    triggers: { crons: ['* * * * *'] },
  })).toEqual([]);
});

test('a real Wrangler config may replace deployment-specific observability completely', () => {
  expect(findWranglerConfigMismatches(example, {
    name: 'floway',
    observability: {
      logs: { enabled: true, head_sampling_rate: 0.25 },
      traces: { enabled: false },
    },
    triggers: { crons: ['* * * * *'] },
  })).toEqual([]);
});

test('shared Wrangler topology still rejects unrelated drift', () => {
  expect(findWranglerConfigMismatches(example, {
    name: 'floway',
    triggers: { crons: ['0 * * * *'] },
  })).toEqual([{
    path: 'triggers.crons[0]',
    reason: 'expected "* * * * *", got "0 * * * *"',
  }]);
});

test('placeholder replacement and account selection remain deployment-local', () => {
  expect(findWranglerConfigMismatches(example, {
    name: 'floway',
    account_id: 'account-id',
    triggers: { crons: ['* * * * *'] },
  })).toEqual([]);
  expect(findWranglerConfigMismatches(example, {
    name: '<YOUR_WORKER_NAME>',
    triggers: { crons: ['* * * * *'] },
  })).toEqual([{
    path: 'name',
    reason: 'placeholder <YOUR_WORKER_NAME> must be replaced with a concrete value, got "<YOUR_WORKER_NAME>"',
  }]);
});

test('binding identity and Worker-first route order retain their specialized comparisons', () => {
  const topology = {
    d1_databases: [
      { binding: 'FIRST', database_id: '<YOUR_FIRST_ID>' },
      { binding: 'SECOND', database_id: '<YOUR_SECOND_ID>' },
    ],
    assets: { run_worker_first: ['/api/*', '/v1/*'] },
  };
  expect(findWranglerConfigMismatches(topology, {
    d1_databases: [
      { binding: 'SECOND', database_id: 'second-id' },
      { binding: 'FIRST', database_id: 'first-id' },
    ],
    assets: { run_worker_first: ['/v1/*', '/api/*'] },
  })).toEqual([]);
});
