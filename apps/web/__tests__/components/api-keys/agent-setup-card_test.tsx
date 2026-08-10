import { act, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKey } from '../../../src/api/types';
import type { AgentSetupConfiguration, AgentSetupLease } from '../../../src/components/api-keys/agent-setup';
import { AgentSetupCard } from '../../../src/components/api-keys/agent-setup-card';
import { renderInApp } from '../../render';

const configuration = (apiKeyId: string): AgentSetupConfiguration => ({
  apiKeyId,
  claudeCode: {
    model: null,
    defaultFableModel: null,
    defaultOpusModel: null,
    defaultSonnetModel: null,
    defaultHaikuModel: null,
    effortLevel: 'high',
    cleanupPeriodDays: null,
    optOutAiAttribution: true,
    modelDiscovery: false,
  },
  codex: { model: null, reasoningEffort: null },
  zed: { providerName: 'Floway' },
});

const lease = (apiKeyId: string): AgentSetupLease => ({
  status: 'ok',
  token: `lease-${apiKeyId}`,
  configuration: configuration(apiKeyId),
  configurationRevision: 1,
  expiresAt: Date.now() + 120_000,
  scripts: {
    claude: { sh: '/claude.sh', ps1: '/claude.ps1' },
    codex: { sh: '/codex.sh', ps1: '/codex.ps1' },
    zed: { sh: '/zed.sh', ps1: '/zed.ps1' },
  },
});

const apiKey = (id: string): ApiKey => ({
  id,
  name: `Key ${id}`,
  key: `sk-${id}`,
  upstream_ids: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_used_at: null,
  dump_retention_seconds: null,
  responses_retention_seconds: 0,
});

const clipboard = { copy: vi.fn(), outcomeFor: () => 'idle' as const };

const PICK_SECOND_KEY = 'pick the second key';

// What a stubbed fetch was asked to send. A field that shows an error while the
// value is already on its way is the failure these tests exist to catch, so the
// assertion has to read the request rather than the screen.
const requestBodies = (fetchMock: { mock: { calls: unknown[][] } }): string[] =>
  fetchMock.mock.calls.map(call => String((call[1] as RequestInit | undefined)?.body ?? ''));

const Host = () => {
  const [keyId, setKeyId] = useState('key-1');
  return <>
    <button onClick={() => setKeyId('key-2')} type="button">{PICK_SECOND_KEY}</button>
    <AgentSetupCard
      clipboard={clipboard}
      initialApiKeyId="key-1"
      initialError={null}
      initialLease={lease('key-1')}
      models={[]}
      selectedKey={apiKey(keyId)}
    />
  </>;
};

const shownSettings = () => ({
  effort: screen.getByRole('combobox', { name: 'Reasoning effort' }).textContent,
  modelDiscovery: screen.getByRole<HTMLInputElement>('switch', { name: 'Gateway model discovery' }).checked,
  attributionOptOut: screen.getByRole<HTMLInputElement>('switch', { name: 'Opt out of Claude Code AI attribution' }).checked,
});

// One store answers for the whole session, so the fields show the lease's
// configuration and nothing else. There is no second draft for the card to fall
// back to while a lease is being acquired for another key.
describe('Agent Setup card fields', () => {
  it('draws every setting from the lease the session holds', () => {
    renderInApp(<Host />);
    expect(shownSettings()).toEqual({ effort: 'high', modelDiscovery: false, attributionOptOut: true });
  });

  it('keeps the configuration on screen while another key is being leased', () => {
    // The lease request for the newly picked key never answers, and that window
    // is what the card used to spend showing a stale local copy of the form.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    renderInApp(<Host />);
    act(() => { screen.getByRole('button', { name: PICK_SECOND_KEY }).click(); });
    expect(shownSettings()).toEqual({ effort: 'high', modelDiscovery: false, attributionOptOut: true });
    vi.unstubAllGlobals();
  });
});

// The provider name is the only free-text field here, so the only one whose
// value the gateway can reject. A rejected draft is not retryable, so an
// invalid name must never leave the component.
describe('Zed provider name', () => {
  const showZedTab = () => { act(() => { screen.getByRole('tab', { name: 'Zed' }).click(); }); };

  it('reports a padded name at the field and withholds it from the draft', async () => {
    const saved = vi.fn(() => new Promise<Response>(() => {}));
    renderInApp(<Host />);
    showZedTab();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: /Provider name/ });
    vi.stubGlobal('fetch', saved);
    act(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Floway ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(screen.getByText('Enter a name with no leading or trailing spaces and no control characters.')).toBeTruthy();
    expect(input.value).toBe('Floway ');

    // The half of the name this test claims: past the save debounce, nothing
    // carrying the padding may have left.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    expect(requestBodies(saved).some(body => body.includes('Floway '))).toBe(false);
    vi.unstubAllGlobals();
  });

  // A text input strips only CR and LF, so a tab pasted from a spreadsheet
  // reaches the field. Showing the error is not the guarantee — never sending
  // the value is: the gateway rejects it with a 400 that is not retryable, so a
  // value that reaches the draft strands the lease.
  it('withholds a name carrying a control character', async () => {
    const sent = vi.fn(() => new Promise<Response>(() => {}));
    renderInApp(<Host />);
    showZedTab();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: /Provider name/ });
    vi.stubGlobal('fetch', sent);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ops\tbox');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(screen.getByText('Enter a name with no leading or trailing spaces and no control characters.')).toBeTruthy();

    // Past the save debounce: nothing carrying the tab may have left.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    expect(requestBodies(sent).some(body => body.includes('Ops\\tbox') || body.includes('Ops\tbox'))).toBe(false);
    vi.unstubAllGlobals();
  });

  // The mirror of the two withholding cases: showing no error is not the
  // guarantee, reaching the draft is. A name held back never reaches the served
  // script or the pasted snippet, and nothing on screen would say so.
  it('sends a valid name to the draft', async () => {
    const sent = vi.fn(() => new Promise<Response>(() => {}));
    renderInApp(<Host />);
    showZedTab();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: /Provider name/ });
    vi.stubGlobal('fetch', sent);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Floway prod');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(screen.queryByText('Enter a name with no leading or trailing spaces and no control characters.')).toBeNull();
    expect(input.value).toBe('Floway prod');

    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    expect(requestBodies(sent).some(body => body.includes('"providerName":"Floway prod"'))).toBe(true);
    vi.unstubAllGlobals();
  });

  // The local hold exists only to keep an invalid value out of the draft. It is
  // keyed on the configuration it belongs to, so once a lease for another key
  // lands the field shows that lease's name rather than the half-typed one.
  it('yields to a configuration that arrives for another key', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ ...lease('key-2'), configuration: { ...configuration('key-2'), zed: { providerName: 'Second' } } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))));
    renderInApp(<Host />);
    showZedTab();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: /Provider name/ });
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Half-typed ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('Half-typed ');

    await act(async () => { screen.getByRole('button', { name: PICK_SECOND_KEY }).click(); });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: /Provider name/ }).value).toBe('Second');
    vi.unstubAllGlobals();
  });
});

// The dashboard knows the installer will refuse this catalog before the
// operator runs anything, and the setup pane is the one they see first —
// handing over a command that fails there is worse than saying so.
describe('Zed with no chat models', () => {
  it('warns in the setup pane instead of offering a command', () => {
    renderInApp(<Host />);
    act(() => { screen.getByRole('tab', { name: 'Zed' }).click(); });
    expect(screen.getByText(/No chat model this gateway serves can be configured/)).toBeTruthy();
    expect(screen.queryByText(/curl |irm /)).toBeNull();
  });
});

// A catalog that is not known yet is not an empty catalog. Before a key is
// picked the card has nothing to project, and saying "no chat models" there
// tells a first-time visitor their upstreams are wrong when they have simply
// not chosen a key.
describe('Zed with an unknown catalog', () => {
  const renderUnknown = (selectedKey: ApiKey | null) => renderInApp(<AgentSetupCard
    clipboard={clipboard}
    initialApiKeyId={selectedKey?.id ?? null}
    initialError={null}
    initialLease={selectedKey ? lease(selectedKey.id) : null}
    models={null}
    selectedKey={selectedKey}
  />);

  // A listing that failed is not a gateway with nothing to serve. Both panes
  // have to tell those apart; the setup pane learned it first and the snippet
  // pane kept collapsing `null` to an empty array.
  // Codex and Claude build their snippets from the configuration alone, so a
  // catalog nobody could list is no reason to blank their pane.
  it('still offers the Codex snippet, which needs no catalog', () => {
    renderUnknown(apiKey('key-1'));
    act(() => { screen.getByRole('tab', { name: 'Codex' }).click(); });
    act(() => { screen.getByRole('tab', { name: 'Config snippet' }).click(); });
    expect(screen.getAllByText(/model_provider/).length).toBeGreaterThan(0);
  });

  it('blames the catalog on neither pane', () => {
    renderUnknown(apiKey('key-1'));
    act(() => { screen.getByRole('tab', { name: 'Zed' }).click(); });
    expect(screen.queryByText(/No chat model this gateway serves/)).toBeNull();
    act(() => { screen.getByRole('tab', { name: 'Config snippet' }).click(); });
    expect(screen.queryByText(/No chat model this gateway serves/)).toBeNull();
  });

  it('asks for a key rather than blaming the catalog', () => {
    renderUnknown(null);
    act(() => { screen.getByRole('tab', { name: 'Zed' }).click(); });
    expect(screen.getByText(/Select an API key above/)).toBeTruthy();
    expect(screen.queryByText(/No chat model this gateway serves/)).toBeNull();
  });
});
