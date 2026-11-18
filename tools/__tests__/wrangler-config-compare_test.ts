import { expect, test } from 'vitest';

import { findWranglerConfigMismatches } from '../src/wrangler-config-compare.ts';

const example = {
  name: '<YOUR_WORKER_NAME>',
  observability: { enabled: false },
  triggers: { crons: ['* * * * *'] },
};

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
