import tls from 'node:tls';

import { expect, test, vi } from 'vitest';

test('nodeRuntimeRootCAs snapshots Node\'s complete default trust set', async () => {
  const original = tls.getCACertificates('default');
  const singleRoot = tls.rootCertificates[0];
  if (singleRoot === undefined) throw new Error('Node exposes no bundled root certificates');
  try {
    tls.setDefaultCACertificates([singleRoot]);
    vi.resetModules();

    const { nodeRuntimeRootCAs } = await import('../src/runtime-root-cas.ts');

    expect(nodeRuntimeRootCAs).toEqual(tls.getCACertificates('default'));
    expect(nodeRuntimeRootCAs).toEqual([singleRoot]);
  } finally {
    tls.setDefaultCACertificates(original);
    vi.resetModules();
  }
});
