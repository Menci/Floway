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
