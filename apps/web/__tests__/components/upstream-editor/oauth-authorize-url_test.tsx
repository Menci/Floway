import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderConfigHarness } from './provider-config-harness';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import { settle } from '../../settle';

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

const record = upstreamRecord('up_claude', {
  name: 'Claude',
  kind: 'claude-code',
  config: { accounts: [] },
  state: { accounts: [] },
});

let fetchMock: ReturnType<typeof vi.fn>;
let authorizeResponse: (state: string) => Promise<Response>;
let authorizeSignals: AbortSignal[];

const authorizeUrlCount = () =>
  fetchMock.mock.calls.filter(([input]) => String(input).includes(AUTHORIZE_URL_PATH)).length;

const stashed = (flowKind: string) => {
  const raw = sessionStorage.getItem(`floway-pkce:claude-code:${flowKind}`);
  return raw === null ? null : JSON.parse(raw) as { verifier: string; state: string };
};

beforeEach(() => {
  pkceResolvers.length = 0;
  sessionStorage.clear();
  authorizeSignals = [];
  authorizeResponse = async state => Response.json({ authorize_url: `https://claude.ai/oauth/authorize?state=${state}` });
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input), 'http://localhost');
    if (pathname !== AUTHORIZE_URL_PATH) throw new Error(`Unexpected request to ${pathname}`);
    const body = JSON.parse(String(init?.body)) as { state: string };
    if (!init?.signal) throw new Error('Authorize URL request has no abort signal');
    authorizeSignals.push(init.signal);
    return await authorizeResponse(body.state);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('OAuth authorize-url preparation', () => {
  it('keeps the stashed verifier with the authorize URL when a superseded run resolves last', async () => {
    renderInApp(<ProviderConfigHarness record={record} />);
    await settle();

    fireEvent.click(screen.getByRole('tab', { name: 'Setup Token' }));
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'OAuth' }));
    await settle();
    expect(pkceResolvers).toHaveLength(3);

    // Newest first: the two superseded runs then finish their crypto against a
    // generation that has already moved on.
    pkceResolvers[2]!(material(3));
    await settle();
    pkceResolvers[1]!(material(2));
    pkceResolvers[0]!(material(1));
    await settle();

    expect(authorizeUrlCount()).toBe(1);
    const link = await screen.findByRole('link');
    expect(link.getAttribute('href')).toBe('https://claude.ai/oauth/authorize?state=state-3');
    expect(stashed('oauth')).toEqual({ verifier: 'verifier-3', state: 'state-3' });
    expect(stashed('setup-token')).toBeNull();
  });

  it('keeps the newest authorize URL when an older request answers last', async () => {
    const responses = new Map<string, (response: Response) => void>();
    authorizeResponse = state => new Promise(resolve => { responses.set(state, resolve); });
    renderInApp(<ProviderConfigHarness record={record} />);
    await settle();

    pkceResolvers[0]!(material(1));
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Setup Token' }));
    await settle();
    pkceResolvers[1]!(material(2));
    await settle();

    expect(authorizeUrlCount()).toBe(2);
    expect(authorizeSignals[0]?.aborted).toBe(true);
    responses.get('state-2')!(Response.json({ authorize_url: 'https://claude.ai/oauth/authorize?state=state-2' }));
    await settle();
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://claude.ai/oauth/authorize?state=state-2');

    responses.get('state-1')!(Response.json({ authorize_url: 'https://claude.ai/oauth/authorize?state=state-1' }));
    await settle();
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://claude.ai/oauth/authorize?state=state-2');
    expect(stashed('setup-token')).toEqual({ verifier: 'verifier-2', state: 'state-2' });
  });

  it('does not stash or request authorization when PKCE generation finishes after unmount', async () => {
    const view = renderInApp(<ProviderConfigHarness record={record} />);
    await settle();
    expect(pkceResolvers).toHaveLength(1);

    view.unmount();
    pkceResolvers[0]!(material(1));
    await settle();

    expect(authorizeUrlCount()).toBe(0);
    expect(stashed('oauth')).toBeNull();
  });
});
