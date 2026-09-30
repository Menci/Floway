import { test } from 'vitest';

import { materializeOpaqueBlobCompatibilityIdentity } from '../../src/common/models.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('materializes opaque blob compatibility scopes with an upstream-model default key', () => {
  assertEquals(
    materializeOpaqueBlobCompatibilityIdentity({ bindToUpstream: true }, 'upstream-1', 'gpt-5'),
    { upstreamId: 'upstream-1', key: 'gpt-5' },
  );
  assertEquals(
    materializeOpaqueBlobCompatibilityIdentity({ bindToUpstream: false, key: 'shared' }, 'upstream-1', 'gpt-5'),
    { key: 'shared' },
  );
});
