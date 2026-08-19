import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { OAuth2Account } from '../../../src/api/types';
import { OAuth2AccountList } from '../../../src/components/oauth2/accounts';
import { renderInApp } from '../../render';

const account = (provider: string, canUnlink: boolean): OAuth2Account => ({
  provider_id: provider,
  provider_display_name: `${provider} display`,
  provider_login: `${provider}-login`,
  created_at: '2026-08-19T00:00:00.000Z',
  last_login_at: '2026-08-19T00:00:00.000Z',
  can_unlink: canUnlink,
});

describe('OAuth2 account list', () => {
  it('offers unlink only when another sign-in credential remains', () => {
    const onUnlink = vi.fn();
    renderInApp(<OAuth2AccountList
      accounts={[account('gitea', true), account('last', false)]}
      busyProvider={null}
      disabled={false}
      failed={false}
      onUnlink={onUnlink}
    />);

    const buttons = screen.getAllByRole('button', { name: 'Unlink' });
    const [first, last] = buttons;
    if (!first || !last) throw new Error('expected two unlink buttons');
    fireEvent.click(first);
    fireEvent.click(last);

    expect(onUnlink).toHaveBeenCalledTimes(1);
    expect(onUnlink).toHaveBeenCalledWith(expect.objectContaining({ provider_id: 'gitea' }));
    expect(last.getAttribute('aria-disabled')).toBe('true');
  });
});
