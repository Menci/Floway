import { act, fireEvent, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { ProviderConfigSection } from '../../../src/components/upstream-editor/provider-config';
import { renderInApp } from '../../render';

const AUTHORIZE_URL_PATH = '/api/upstreams/claude-code/oauth/authorize-url';

// Only the generation is under test, so the material is handed out by the
// suite and the real stash / recall keep writing sessionStorage.
const { pkceResolvers } = vi.hoisted(() => ({
  pkceResolvers: [] as Array<(value: { verifier: string; challenge: string; state: string }) => void>,
}));

vi.mock('../../../src/components/upstream-editor/pkce', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/components/upstream-editor/pkce')>(),
  generatePkce: () => new Promise(resolve => { pkceResolvers.push(resolve); }),
}));

const material = (n: number) => ({ verifier: `verifier-${n}`, challenge: `challenge-${n}`, state: `state-${n}` });

const record = {
  id: 'up_claude',
  name: 'Claude',
  kind: 'claude-code',
  enabled: true,
  sort_order: 1,
  created_at: '',
  updated_at: '',
  flag_overrides: {},
  flag_defaults: {},
  disabled_public_model_ids: [],
  proxy_fallback_list: [],
  model_prefix: null,
  hue: 210,
  modelsCache: { fetchedAt: null, lastError: null },
  config: { accounts: [] },
  state: null,
} as unknown as UpstreamRecord;

function Harness() {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  return (
    <FormProvider {...form}>
      <ProviderConfigSection record={record} onPatch={vi.fn()} onRefreshModels={vi.fn()} />
    </FormProvider>
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

// `prepare` awaits the PKCE material and then the authorize-url round trip, so
// settling it takes a macrotask rather than a single microtask drain.
const flush = async () => {
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0); }); });
};

const authorizeUrlCount = () =>
  fetchMock.mock.calls.filter(([input]) => String(input).includes(AUTHORIZE_URL_PATH)).length;

const stashed = (flowKind: string) => {
  const raw = sessionStorage.getItem(`floway-pkce:claude-code:${flowKind}`);
  return raw === null ? null : JSON.parse(raw) as { verifier: string; state: string };
};

beforeEach(() => {
  pkceResolvers.length = 0;
  sessionStorage.clear();
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input), 'http://localhost');
    if (pathname !== AUTHORIZE_URL_PATH) throw new Error(`Unexpected request to ${pathname}`);
    const body = JSON.parse(String(init?.body)) as { state: string };
    return new Response(
      JSON.stringify({ authorize_url: `https://claude.ai/oauth/authorize?state=${body.state}` }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('OAuth authorize-url preparation', () => {
  it('keeps the stashed verifier with the authorize URL when a superseded run resolves last', async () => {
    renderInApp(<Harness />);
    await flush();

    fireEvent.click(screen.getByRole('tab', { name: 'Setup Token' }));
    await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'OAuth' }));
    await flush();
    expect(pkceResolvers).toHaveLength(3);

    // Newest first: the two superseded runs then finish their crypto against a
    // generation that has already moved on.
    pkceResolvers[2]!(material(3));
    await flush();
    pkceResolvers[1]!(material(2));
    pkceResolvers[0]!(material(1));
    await flush();

    expect(authorizeUrlCount()).toBe(1);
    const link = await screen.findByRole('link');
    expect(link.getAttribute('href')).toBe('https://claude.ai/oauth/authorize?state=state-3');
    expect(stashed('oauth')).toEqual({ verifier: 'verifier-3', state: 'state-3' });
    expect(stashed('setup-token')).toBeNull();
  });
});
