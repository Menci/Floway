import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ControlPlaneUser } from '../../../src/api/types';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { UserDialog } from '../../../src/components/users/dialog';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const user: ControlPlaneUser = {
  id: 2, username: 'operator', isAdmin: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  preferences: { quotaDisplay: 'remaining', language: null },
};

afterEach(() => vi.unstubAllGlobals());

describe('user identity settings', () => {
  it.each(['create', 'edit'] as const)('saves %s identity and group selection without changing access records', async mode => {
    const fetch = vi.fn(async () => Response.json(user));
    vi.stubGlobal('fetch', fetch);
    const onSaved = vi.fn(async () => {});
    renderInApp(<OutcomeToastProvider><UserDialog
      {...(mode === 'create' ? { mode } : { mode, user, groupIds: [] })}
      actorId={1} groups={[]} onOpenChange={vi.fn()} onSaved={onSaved} open
    /></OutcomeToastProvider>);
    expect(screen.queryByRole('switch', { name: i18n.t('dashboard.upstreamAccess.title') })).toBeNull();
    expect(screen.queryByText(i18n.t('dashboard.accessControl.fields.permissions'))).toBeNull();
    if (mode === 'create') {
      await act(async () => {
        fireEvent.change(screen.getByLabelText(i18n.t('dashboard.users.form.username')), { target: { value: 'operator' } });
        fireEvent.change(screen.getByLabelText(i18n.t('dashboard.users.form.password')), { target: { value: 'password' } });
      });
    }
    await act(async () => { screen.getByRole('button', { name: i18n.t(mode === 'create' ? 'dashboard.users.actions.create' : 'dashboard.users.actions.save') }).click(); });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(mode === 'create' ? '/api/users' : '/api/users/2', expect.objectContaining({
      method: mode === 'create' ? 'POST' : 'PATCH',
      body: JSON.stringify({ username: 'operator', ...(mode === 'create' ? { password: 'password' } : {}), isAdmin: false, groupIds: [] }),
    }));
  });
});
