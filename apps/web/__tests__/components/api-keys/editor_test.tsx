import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiKey } from '../../../src/api/types';
import { KeyDialog } from '../../../src/components/api-keys/editor';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const apiKey: ApiKey = {
  id: 'empty', name: 'Empty key', key: 'sk-empty', upstream_ids: [],
  created_at: '2026-01-01T00:00:00.000Z', last_used_at: null,
  dump_retention_seconds: null, responses_retention_seconds: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe('API key upstream limits', () => {
  it.each(['create', 'edit'] as const)('saves %s with an empty limit or no limit', async mode => {
    const fetch = vi.fn(async () => Response.json(apiKey));
    vi.stubGlobal('fetch', fetch);
    const onSaved = vi.fn(async () => {});
    renderInApp(<OutcomeToastProvider><KeyDialog
      {...(mode === 'create' ? { mode } : { mode, apiKey })}
      models={[]} onOpenChange={vi.fn()} onSaved={onSaved} open upstreams={[]} userUpstreamIds={[]}
    /></OutcomeToastProvider>);
    const toggle = screen.getByRole('switch', { name: i18n.t('dashboard.upstreamAccess.title') });
    if (mode === 'create') {
      await act(async () => {
        fireEvent.change(screen.getByLabelText(i18n.t('dashboard.apiKeys.form.name')), { target: { value: 'Empty key' } });
        toggle.click();
      });
    }
    expect(screen.getByText(i18n.t('dashboard.upstreamAccess.emptyWarning'))).toBeTruthy();
    const save = screen.getByRole('button', { name: i18n.t(mode === 'create' ? 'dashboard.apiKeys.actions.create' : 'dashboard.apiKeys.actions.save') });
    await act(async () => { save.click(); });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenLastCalledWith(mode === 'create' ? '/api/keys' : '/api/keys/empty', expect.objectContaining({
      method: mode === 'create' ? 'POST' : 'PATCH',
      body: expect.stringContaining('"upstream_ids":[]'),
    }));

    await act(async () => { toggle.click(); });
    expect(screen.queryByText(i18n.t('dashboard.upstreamAccess.emptyWarning'))).toBeNull();
    await act(async () => { save.click(); });
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(mode === 'create' ? '/api/keys' : '/api/keys/empty', expect.objectContaining({
      body: expect.stringContaining('"upstream_ids":null'),
    }));
  });
});
