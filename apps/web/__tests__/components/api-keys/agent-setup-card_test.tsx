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
  vscode: { providerName: 'Floway', apiType: 'messages' },
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
    vscode: { sh: '/vscode.sh', ps1: '/vscode.ps1' },
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
// invalid name must never leave the component. Both editors share one field,
// and the suite is parameterized over them so a tab that hand-builds its own
// Input instead fails here.
describe.each([
  { tab: 'Zed', key: 'zed' as const },
  { tab: 'VS Code', key: 'vscode' as const },
])('$tab provider name', ({ key, tab }) => {
  const showTab = () => { act(() => { screen.getByRole('tab', { name: tab }).click(); }); };

  it('reports a padded name at the field and withholds it from the draft', () => {
    const saved = vi.fn(() => new Promise<Response>(() => {}));
    renderInApp(<Host />);
    showTab();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: /Provider name/ });
    vi.stubGlobal('fetch', saved);
    act(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Floway ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(screen.getByText('Enter a name with no leading or trailing spaces and no control characters.')).toBeTruthy();
    expect(input.value).toBe('Floway ');
    vi.unstubAllGlobals();
  });

  // A text input strips only CR and LF, so a tab pasted from a spreadsheet
  // reaches the field. The gateway rejects it with a 400 that is not retryable.
  it('withholds a name carrying a control character', () => {
    renderInApp(<Host />);
    showTab();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: /Provider name/ });
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ops\tbox');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(screen.getByText('Enter a name with no leading or trailing spaces and no control characters.')).toBeTruthy();
  });

  it('accepts a valid name', () => {
    renderInApp(<Host />);
    showTab();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: /Provider name/ });
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Floway prod');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(screen.queryByText('Enter a name with no leading or trailing spaces and no control characters.')).toBeNull();
    expect(input.value).toBe('Floway prod');
  });

  // The local hold exists only to keep an invalid value out of the draft. It is
  // keyed on the configuration it belongs to, so once a lease for another key
  // lands the field shows that lease's name rather than the half-typed one.
  it('yields to a configuration that arrives for another key', async () => {
    const arriving = configuration('key-2');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ ...lease('key-2'), configuration: { ...arriving, [key]: { ...arriving[key], providerName: 'Second' } } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))));
    renderInApp(<Host />);
    showTab();
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

// Both editor installers refuse a catalog with no chat models, and VS Code
// registers a group only `if (models.length)` — so an empty snippet would leave
// the operator with no provider and no error at all. The Host renders with an
// empty catalog, which is exactly that case.
describe.each(['Zed', 'VS Code'])('%s snippet with no chat models', tab => {
  it('offers the warning instead of a document that configures nothing', () => {
    renderInApp(<Host />);
    act(() => { screen.getByRole('tab', { name: tab }).click(); });
    act(() => { screen.getByRole('tab', { name: 'Config snippet' }).click(); });
    expect(screen.getByText('This gateway advertises no chat models, so there is nothing to configure yet. Add an upstream that serves one.')).toBeTruthy();
    expect(screen.queryByText(/customendpoint|anthropic_compatible/)).toBeNull();
  });
});

// Both tabs render the same field at the same position, so React keeps one
// component instance across a tab switch. The hold belongs to one editor's name,
// not to the configuration as a whole, or the other editor's field shows a value
// its own setting never had.
describe('provider name across editors', () => {
  const showTab = (tab: string) => { act(() => { screen.getByRole('tab', { name: tab }).click(); }); };
  const providerNameInput = () => screen.getByRole<HTMLInputElement>('textbox', { name: /Provider name/ });
  const type = (value: string) => {
    const input = providerNameInput();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('does not carry one editor\'s typed name into the other', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    renderInApp(<Host />);
    showTab('Zed');
    type('Zed Prod');
    showTab('VS Code');
    expect(providerNameInput().value).toBe('Floway');
    vi.unstubAllGlobals();
  });

  it('does not carry one editor\'s withheld invalid name into the other', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    renderInApp(<Host />);
    showTab('Zed');
    type('');
    expect(screen.getByText('Enter a name with no leading or trailing spaces and no control characters.')).toBeTruthy();
    showTab('VS Code');
    expect(providerNameInput().value).toBe('Floway');
    expect(screen.queryByText('Enter a name with no leading or trailing spaces and no control characters.')).toBeNull();
    vi.unstubAllGlobals();
  });
});
