import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultAgentSetupConfiguration, useAgentSetup } from '../../../src/components/api-keys/use-agent-setup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type SetupState = ReturnType<typeof useAgentSetup>;

const lease = (expiresAt = Date.now() + 120_000) => ({
  status: 'ok',
  token: 'lease-token',
  configuration: defaultAgentSetupConfiguration('key-1'),
  configurationRevision: 1,
  expiresAt,
  scripts: {
    claude: { sh: '/claude.sh', ps1: '/claude.ps1' },
    codex: { sh: '/codex.sh', ps1: '/codex.ps1' },
  },
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('Agent Setup lease lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: SetupState;

  const Harness = ({ apiKeyId }: { apiKeyId: string | null }) => {
    current = useAgentSetup(apiKeyId);
    return null;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not create a public lease until a key is explicitly selected', async () => {
    const fetch = vi.fn(async () => json(lease()));
    vi.stubGlobal('fetch', fetch);
    await act(async () => root.render(<Harness apiKeyId={null} />));
    await settle();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('expires copy permission at the exact server timestamp', async () => {
    const expiresAt = Date.now() + 500;
    vi.stubGlobal('fetch', vi.fn(async () => json(lease(expiresAt))));
    await act(async () => root.render(<Harness apiKeyId="key-1" />));
    await settle();
    expect(current.canCopy).toBe(true);
    await act(async () => vi.advanceTimersByTime(500));
    expect(current.canCopy).toBe(false);
  });

  it('retries a failed heartbeat after the retry delay', async () => {
    let heartbeatCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/heartbeat')) {
        heartbeatCalls += 1;
        return heartbeatCalls === 1 ? json({ error: 'temporary' }, 503) : json(lease());
      }
      return json(lease());
    }));
    await act(async () => root.render(<Harness apiKeyId="key-1" />));
    await settle();
    await act(async () => vi.advanceTimersByTime(60_000));
    await settle();
    expect(heartbeatCalls).toBe(1);
    await act(async () => vi.advanceTimersByTime(15_000));
    await settle();
    expect(heartbeatCalls).toBe(2);
  });

  it('does not let a successful heartbeat erase a save error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return json({ error: 'save rejected' }, 400);
      return json(lease());
    }));
    await act(async () => root.render(<Harness apiKeyId="key-1" />));
    await settle();
    await act(async () => current.updateDraft(configuration => ({
      ...configuration,
      codex: { ...configuration.codex, model: 'gpt-test' },
    })));
    await act(async () => vi.advanceTimersByTime(400));
    await settle();
    expect(current.error).toBe('save rejected');
    await act(async () => vi.advanceTimersByTime(60_000));
    await settle();
    expect(current.error).toBe('save rejected');
  });

  it('aborts an active request when the selected key changes', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }));
    await act(async () => root.render(<Harness apiKeyId="key-1" />));
    expect(signal?.aborted).toBe(false);
    await act(async () => root.render(<Harness apiKeyId={null} />));
    expect(signal?.aborted).toBe(true);
  });

  it('flushes one save before heartbeat when the page becomes visible', async () => {
    const operations: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      operations.push(String(input).endsWith('/heartbeat') ? 'heartbeat' : init?.method ?? 'GET');
      return json(lease());
    }));
    await act(async () => root.render(<Harness apiKeyId="key-1" />));
    await settle();
    operations.length = 0;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => current.updateDraft(configuration => ({
      ...configuration,
      codex: { ...configuration.codex, model: 'gpt-visible' },
    })));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(operations).toEqual(['PUT', 'heartbeat']);
    await act(async () => vi.advanceTimersByTime(400));
    await settle();
    expect(operations).toEqual(['PUT', 'heartbeat']);
  });

  it('cancels a stale save retry after a newer edit succeeds', async () => {
    let putCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        putCalls += 1;
        return putCalls === 1 ? json({ error: 'temporary' }, 503) : json(lease());
      }
      return json(lease());
    }));
    await act(async () => root.render(<Harness apiKeyId="key-1" />));
    await settle();
    await act(async () => current.updateDraft(configuration => ({
      ...configuration,
      codex: { ...configuration.codex, model: 'first' },
    })));
    await act(async () => vi.advanceTimersByTime(400));
    await settle();
    await act(async () => current.updateDraft(configuration => ({
      ...configuration,
      codex: { ...configuration.codex, model: 'second' },
    })));
    await act(async () => vi.advanceTimersByTime(400));
    await settle();
    expect(putCalls).toBe(2);
    await act(async () => vi.advanceTimersByTime(15_000));
    await settle();
    expect(putCalls).toBe(2);
  });
});
