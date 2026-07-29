import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ControlPlaneModel, UpstreamRecord } from '../../src/api/types';
import { setSessionToken } from '../../src/auth/session';
import { clientLoader, eligibleSearchUpstreams } from '../../src/routes/dashboard-providers-search';
import { useAuthStore } from '../../src/stores/auth-store';

afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

describe('OpenAI search passthrough eligibility', () => {
  it('keeps only enabled Codex or Custom upstreams with chat models', () => {
    const upstreams = [
      { id: 'codex', kind: 'codex', enabled: true },
      { id: 'custom', kind: 'custom', enabled: false },
      { id: 'ollama', kind: 'ollama', enabled: true },
    ] as UpstreamRecord[];
    const models = [{
      id: 'gpt-5', kind: 'chat', upstreams: [{ id: 'codex', kind: 'codex', name: 'Codex', color: null }],
    }] as ControlPlaneModel[];
    expect(eligibleSearchUpstreams(upstreams, models).map(upstream => upstream.id)).toEqual(['codex']);
  });

  it('does not call admin endpoints for an operator', async () => {
    const user = { id: 2, username: 'operator', isAdmin: false, upstreamIds: null };
    setSessionToken('operator-session');
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(await clientLoader()).toEqual({ admin: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
