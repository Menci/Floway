import { expectTypeOf, test } from 'vitest';

import type { UpstreamsRepoSlim, UpstreamStateWriteGuard } from '../src/repo.ts';

test('saveState requires a provider-kind write guard', () => {
  expectTypeOf<Parameters<UpstreamsRepoSlim['saveState']>>().toEqualTypeOf<[
    id: string,
    mutate: (current: unknown) => unknown,
    guard: UpstreamStateWriteGuard,
  ]>();
});
