import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProviderConfigHarness } from './provider-config-harness';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const imported = {
  config: { accounts: [{ email: 'operator@example.com', chatgptAccountId: null, chatgptUserId: null, planType: 'free' }] },
  state: {
    accounts: [{
      chatgptAccountId: null,
      refresh_token: 'refresh-token',
      state: 'active' as const,
      state_updated_at: '2026-09-30T00:00:00.000Z',
      openaiDeviceId: 'device-id',
      accessToken: null,
      quotaSnapshot: null,
    }],
  },
};

// Claude Code correlates its accounts on `accountUuid` and discriminates its
// credential on `tokenKind`, so it carries its own account shapes.
const importedClaudeCode = {
  config: { accounts: [{ email: null, accountUuid: 'uuid-1', organizationUuid: null, subscriptionType: 'max' as const, rateLimitTier: 'default_claude_max_20x' }] },
  state: {
    accounts: [{
      accountUuid: 'uuid-1',
      tokenKind: 'oauth' as const,
      state: 'active' as const,
      stateUpdatedAt: '2026-09-30T00:00:00.000Z',
      accessToken: null,
      quotaSnapshot: null,
      usageProbeSnapshot: null,
    }],
  },
};

const refreshLabel = () => i18n.t('dashboard.upstreamEditor.oauth.refresh');

describe('OAuth credential actions gating', () => {
  it('hides refresh on a create-state Codex upstream and leaves reimport as the only credential action', () => {
    renderInApp(<ProviderConfigHarness record={upstreamRecord('', { kind: 'codex', ...imported })} />);

    expect(screen.queryByRole('button', { name: refreshLabel() })).toBeNull();
    expect(screen.getByRole('button', { name: i18n.t('dashboard.upstreamEditor.oauth.reimport') })).toBeTruthy();
  });

  it('shows refresh once the Codex upstream is persisted', () => {
    renderInApp(<ProviderConfigHarness record={upstreamRecord('up_codex', { kind: 'codex', ...imported })} />);

    expect(screen.getByRole('button', { name: refreshLabel() })).toBeTruthy();
  });

  it('hides refresh on a create-state Claude Code upstream', () => {
    renderInApp(<ProviderConfigHarness record={upstreamRecord('', { kind: 'claude-code', ...importedClaudeCode })} />);

    expect(screen.queryByRole('button', { name: refreshLabel() })).toBeNull();
  });
});
