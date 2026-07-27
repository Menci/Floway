import { describe, expect, it } from 'vitest';

import { cloudflareRuntimeRootCAs } from '../src/runtime-root-cas.ts';

describe('cloudflareRuntimeRootCAs', () => {
  it('is empty because workerd exposes no runtime trust store', () => {
    expect(cloudflareRuntimeRootCAs).toEqual([]);
  });
});
