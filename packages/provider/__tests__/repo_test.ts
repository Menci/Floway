import { expect, expectTypeOf, test } from 'vitest';

import type { UpstreamRecord } from '../src/model.ts';
import type { UpstreamsRepoSlim, UpstreamStateWriteGuard } from '../src/repo.ts';
import { assertUpstreamStateWriteGuard } from '@floway-dev/test-utils';

test('saveState requires a provider-kind write guard', () => {
  expectTypeOf<Parameters<UpstreamsRepoSlim['saveState']>>().toEqualTypeOf<[
    id: string,
    mutate: (current: unknown) => unknown,
    guard: UpstreamStateWriteGuard,
  ]>();
});

test('state-repository doubles enforce provider and structural config generations', () => {
  const record = {
    id: 'up_test',
    kind: 'copilot',
    config: { githubHost: 'github.com', nested: { first: 1, second: 2 } },
  } as UpstreamRecord;

  expect(() => assertUpstreamStateWriteGuard(record, {
    kind: 'copilot',
    config: { nested: { second: 2, first: 1 }, githubHost: 'github.com' },
  })).not.toThrow();
  expect(() => assertUpstreamStateWriteGuard(record, { kind: 'custom' })).toThrow(/changed from custom to copilot/);
  expect(() => assertUpstreamStateWriteGuard(record, {
    kind: 'copilot',
    config: { githubHost: 'octocorp.ghe.com', nested: { first: 1, second: 2 } },
  })).toThrow(/credentials changed/);
});
