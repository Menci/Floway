import { act, renderHook, type RenderHookResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flowayTokenStorageKey } from '../../../src/auth/session';
import { blankAgentSetupDraft } from '../../../src/components/api-keys/agent-setup';
import { useAgentSetup } from '../../../src/components/api-keys/use-agent-setup';
import { stubLocalStorage } from '../../local-storage-stub';
import { advance, settle } from '../../settle';

type SetupState = ReturnType<typeof useAgentSetup>;

const lease = (expiresAt = Date.now() + 120_000) => ({
  status: 'ok',
  token: 'lease-token',
  configuration: { ...blankAgentSetupDraft(), apiKeyId: 'key-1' },
  configurationRevision: 1,
  expiresAt,
  scripts: {
    claude: { sh: '/claude.sh', ps1: '/claude.ps1' },
    codex: { sh: '/codex.sh', ps1: '/codex.ps1' },
  },
});

describe('Agent Setup lease lifecycle', () => {
  const storage = stubLocalStorage();
  let view: RenderHookResult<SetupState, { apiKeyId: string | null }>;

  const mount = (apiKeyId: string | null) => {
    view = renderHook(({ apiKeyId: key }: { apiKeyId: string | null }) => useAgentSetup(key), {
      initialProps: { apiKeyId },
    });
  };

  const current = () => view.result.current;

  beforeEach(() => {
    vi.useFakeTimers();
    storage.set(flowayTokenStorageKey, 'session-token');
  });

  afterEach(() => {
    view.unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('expires copy permission at the exact server timestamp', async () => {
    const expiresAt = Date.now() + 500;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(lease(expiresAt))));
    mount('key-1');
    await settle();
    expect(current().canCopy).toBe(true);
    await advance(500);
    expect(current().canCopy).toBe(false);
  });

  it('retries a failed heartbeat after the retry delay', async () => {
    let heartbeatCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/heartbeat')) {
        heartbeatCalls += 1;
        return heartbeatCalls === 1 ? Response.json({ error: 'temporary' }, { status: 503 }) : Response.json(lease());
      }
      return Response.json(lease());
    }));
    mount('key-1');
    await settle();
    await advance(60_000);
    await settle();
    expect(heartbeatCalls).toBe(1);
    await advance(15_000);
    await settle();
    expect(heartbeatCalls).toBe(2);
  });

  it('does not let a successful heartbeat erase a save error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return Response.json({ error: 'save rejected' }, { status: 400 });
      return Response.json(lease());
    }));
    mount('key-1');
    await settle();
    await act(async () => current().updateDraft(configuration => ({
      ...configuration,
      codex: { ...configuration.codex, model: 'gpt-test' },
    })));
    await advance(400);
    await settle();
    expect(current().error).toBe('save rejected');
    await advance(60_000);
    await settle();
    expect(current().error).toBe('save rejected');
  });

  it('carries an edit made before a key was selected into the configuration it saves', async () => {
    const saves: { configuration: { codex: { model: string | null } } }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') saves.push(JSON.parse(String(init.body)) as (typeof saves)[number]);
      return Response.json(lease());
    }));
    mount(null);
    await settle();
    await act(async () => current().updateDraft(configuration => ({
      ...configuration,
      codex: { ...configuration.codex, model: 'gpt-early' },
    })));
    view.rerender({ apiKeyId: 'key-1' });
    await settle();
    expect(current().draft.codex.model).toBe('gpt-early');
    await advance(400);
    await settle();
    expect(saves.map(save => save.configuration.codex.model)).toEqual(['gpt-early']);
  });

  it('cancels a stale save retry after a newer edit succeeds', async () => {
    let putCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        putCalls += 1;
        return putCalls === 1 ? Response.json({ error: 'temporary' }, { status: 503 }) : Response.json(lease());
      }
      return Response.json(lease());
    }));
    mount('key-1');
    await settle();
    await act(async () => current().updateDraft(configuration => ({
      ...configuration,
      codex: { ...configuration.codex, model: 'first' },
    })));
    await advance(400);
    await settle();
    await act(async () => current().updateDraft(configuration => ({
      ...configuration,
      codex: { ...configuration.codex, model: 'second' },
    })));
    await advance(400);
    await settle();
    expect(putCalls).toBe(2);
    await advance(15_000);
    await settle();
    expect(putCalls).toBe(2);
  });

  it('does not defer a pending save when a heartbeat lands inside the debounce', async () => {
    const operations: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      operations.push(String(input).endsWith('/heartbeat') ? 'heartbeat' : init?.method ?? 'GET');
      return Response.json(lease());
    }));
    mount('key-1');
    await settle();
    operations.length = 0;

    // Edit with 200ms of the debounce window left before the heartbeat falls
    // due. The heartbeat adopts a freshly issued lease, and the save is timed
    // by the edit rather than by that.
    await advance(59_800);
    await settle();
    await act(async () => current().updateDraft(configuration => ({
      ...configuration,
      codex: { ...configuration.codex, model: 'gpt-debounced' },
    })));
    await advance(200);
    await settle();
    expect(operations).toEqual(['heartbeat']);

    await advance(200);
    await settle();
    expect(operations).toEqual(['heartbeat', 'PUT']);
  });
});
