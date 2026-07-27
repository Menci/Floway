import { describe, expect, it } from 'vitest';

import { nodeRuntimeRootCAs } from '../src/runtime-root-cas.ts';

describe('nodeRuntimeRootCAs', () => {
  it('exposes Node\'s bundled root certificate PEMs', () => {
    expect(Array.isArray(nodeRuntimeRootCAs)).toBe(true);
    expect(nodeRuntimeRootCAs.length).toBeGreaterThan(50);
    expect(nodeRuntimeRootCAs[0]).toContain('-----BEGIN CERTIFICATE-----');
    expect(nodeRuntimeRootCAs[0]).toContain('-----END CERTIFICATE-----');
  });
});
