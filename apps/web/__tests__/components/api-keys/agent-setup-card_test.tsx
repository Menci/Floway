import { act, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKey, ControlPlaneModel } from '../../../src/api/types';
import type { AgentSetupConfiguration, AgentSetupLease } from '../../../src/components/api-keys/agent-setup';
import { AgentSetupCard } from '../../../src/components/api-keys/agent-setup-card';
import { catalogModel } from '../../api/model-fixture';
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
    disableAutoMemory: true,
    disableAgentView: true,
    modelDiscovery: false,
  },
  codex: { model: null, reasoningEffort: null },
  pi: { provider: 'floway', model: null, thinkingLevel: null, retry: { enabled: null, maxRetries: null } },
  omp: { provider: 'floway', model: null, retry: { enabled: null, maxRetries: null } },
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
    pi: { sh: '/pi.sh', ps1: '/pi.ps1' },
    omp: { sh: '/omp.sh', ps1: '/omp.ps1' },
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

const Host = ({ models = [], piModel = null }: { models?: ControlPlaneModel[]; piModel?: string | null }) => {
  const [keyId, setKeyId] = useState('key-1');
  return <>
    <button onClick={() => setKeyId('key-2')} type="button">{PICK_SECOND_KEY}</button>
    <AgentSetupCard
      clipboard={clipboard}
      initialApiKeyId="key-1"
      initialError={null}
      initialLease={{ ...lease('key-1'), configuration: { ...configuration('key-1'), pi: { ...configuration('key-1').pi, model: piModel } } }}
      models={models}
      selectedKey={apiKey(keyId)}
    />
  </>;
};

const shownSettings = () => ({
  effort: screen.getByRole('combobox', { name: 'Reasoning effort' }).textContent,
  modelDiscovery: screen.getByRole<HTMLInputElement>('switch', { name: 'Gateway model discovery' }).checked,
  attributionOptOut: screen.getByRole<HTMLInputElement>('switch', { name: 'Opt out of Claude Code AI attribution' }).checked,
  autoMemoryOptOut: screen.getByRole<HTMLInputElement>('switch', { name: 'Disable auto memory' }).checked,
  agentViewOptOut: screen.getByRole<HTMLInputElement>('switch', { name: 'Disable agent view' }).checked,
});

// One store answers for the whole session, so the fields show the lease's
// configuration and nothing else. There is no second draft for the card to fall
// back to while a lease is being acquired for another key.
describe('Agent Setup card fields', () => {
  it('draws every setting from the lease the session holds', () => {
    renderInApp(<Host />);
    expect(shownSettings()).toEqual({ effort: 'high', modelDiscovery: false, attributionOptOut: true, autoMemoryOptOut: true, agentViewOptOut: true });
  });

  it('renders the Pi tab with dynamic discovery and no config snippet tab', () => {
    renderInApp(<Host />);
    act(() => { screen.getByRole('tab', { name: 'Pi' }).click(); });
    expect(screen.getByRole('combobox', { name: 'Default model' })).toBeTruthy();
    expect(screen.getByText(/The Floway extension refreshes available models/i)).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Config snippet' })).toBeNull();
  });

  it('renders OMP setup and discovery hint', () => {
    renderInApp(<Host />);
    act(() => { screen.getByRole('tab', { name: 'OMP' }).click(); });
    expect(screen.getByRole('combobox', { name: 'Default model' })).toBeTruthy();
    expect(screen.getByText(/OMP loads current Floway models at startup/i)).toBeTruthy();
    expect(screen.getByText(/\/floway-refresh/)).toBeTruthy();
  });

  it('retains distinct provider names when switching agent tabs', () => {
    renderInApp(<Host />);
    act(() => { screen.getByRole('tab', { name: 'Pi' }).click(); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider ID' }), { target: { value: 'floway-home' } });
    act(() => { screen.getByRole('tab', { name: 'OMP' }).click(); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider ID' }), { target: { value: 'floway-work' } });
    act(() => { screen.getByRole('tab', { name: 'Pi' }).click(); });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Provider ID' }).value).toBe('floway-home');
    act(() => { screen.getByRole('tab', { name: 'OMP' }).click(); });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Provider ID' }).value).toBe('floway-work');
  });

  it('offers the selected model thinking levels and retains explicit retry zero and disabled values', () => {
    const model = catalogModel('reasoning-model', { chat: { reasoning: { mandatory: true, effort: { supported: ['low', 'high'], default: 'high' } } } });
    renderInApp(<Host models={[model]} piModel={model.id} />);
    act(() => { screen.getByRole('tab', { name: 'Pi' }).click(); });
    fireEvent.click(screen.getByRole('combobox', { name: 'Default thinking level' }));
    expect(screen.queryByRole('option', { name: 'off', exact: true })).toBeNull();
    expect(screen.queryByRole('option', { name: 'medium', exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'high', exact: true }));
    expect(screen.getByRole('combobox', { name: 'Default thinking level' }).textContent).toContain('high');
    fireEvent.click(screen.getByRole('combobox', { name: 'Automatic retries' }));
    fireEvent.click(screen.getByRole('option', { name: 'Disabled', exact: true }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum retries' }), { target: { value: '0' } });
    expect(screen.getByRole('combobox', { name: 'Automatic retries' }).textContent).toContain('Disabled');
    expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Maximum retries' }).value).toBe('0');
    act(() => { screen.getByRole('tab', { name: 'OMP' }).click(); });
    expect(screen.queryByRole('combobox', { name: 'Default thinking level' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Automatic retries' }).textContent).toContain('Keep existing setting');
  });

  it('keeps the configuration on screen while another key is being leased', () => {
    // The lease request for the newly picked key never answers, and that window
    // is what the card used to spend showing a stale local copy of the form.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    renderInApp(<Host />);
    act(() => { screen.getByRole('button', { name: PICK_SECOND_KEY }).click(); });
    expect(shownSettings()).toEqual({ effort: 'high', modelDiscovery: false, attributionOptOut: true, autoMemoryOptOut: true, agentViewOptOut: true });
    vi.unstubAllGlobals();
  });
});
