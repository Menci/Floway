import { describe, expect, it, vi } from 'vitest';

import type { ApiKey } from '../../../src/api/types';
import { refreshRequestKeys } from '../../../src/components/requests/key-refresh';

const key = (id: string): ApiKey => ({
  id,
  name: id,
  key: id,
  created_at: '',
  last_used_at: null,
  upstream_ids: null,
  dump_retention_seconds: 3600,
  responses_retention_seconds: 0,
});

describe('request key refresh', () => {
  it('cannot redirect after its loader generation is aborted', async () => {
    const controller = new AbortController();
    let resolve!: (value: { data: ApiKey[] }) => void;
    const response = new Promise<{ data: ApiKey[] }>(done => { resolve = done; });
    const onNavigate = vi.fn();
    const onUpdate = vi.fn();
    const refresh = refreshRequestKeys({
      currentKeys: [key('key-a')],
      load: () => response,
      onNavigate,
      onUpdate,
      selectedKeyId: 'key-a',
      signal: controller.signal,
    });

    controller.abort();
    resolve({ data: [key('key-b')] });
    await refresh;

    expect(onNavigate).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
