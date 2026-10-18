import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ControlPlaneUser } from '../../../src/api/types';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { UserDialog } from '../../../src/components/users/dialog';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const user: ControlPlaneUser = {
  id: 2, username: 'restricted', isAdmin: false, upstreamIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('user discard dialog focus', () => {
  it('returns focus and editing to the user form after continuing', async () => {
    renderInApp(<OutcomeToastProvider><UserDialog
      mode="edit" user={user} actorId={1} models={[]} onOpenChange={vi.fn()}
      onSaved={vi.fn(async () => {})} open upstreams={[]}
    /></OutcomeToastProvider>);
    const username = screen.getByLabelText(i18n.t('dashboard.users.form.username'));
    await waitFor(() => expect(document.activeElement).toBe(username.closest('[role="dialog"]')), { timeout: 5000 });
    username.focus();

    await act(async () => { fireEvent.change(username, { target: { value: 'draft' } }); });
    await act(async () => { screen.getByRole('button', { name: i18n.t('common.cancel') }).click(); });
    const keepEditing = await screen.findByRole('button', { name: i18n.t('common.discard.keep') });
    await act(async () => { keepEditing.click(); });

    await waitFor(() => expect(document.activeElement).toBe(username));
    await act(async () => { fireEvent.change(username, { target: { value: 'editable-again' } }); });
    expect((username as HTMLInputElement).value).toBe('editable-again');
    expect(username.closest('[role="dialog"]')?.getAttribute('aria-hidden')).not.toBe('true');
    expect(username.closest('[role="dialog"]')?.hasAttribute('inert')).toBe(false);
  }, 15000);
});
