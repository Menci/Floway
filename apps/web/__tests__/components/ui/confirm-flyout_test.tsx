import { DismissRegular } from '@fluentui/react-icons';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { ConfirmFlyout } from '../../../src/components/ui/confirm-flyout';
import { renderInApp } from '../../render';

const renderFlyout = (onConfirm: () => Promise<string | null>) => renderInApp(<ConfirmFlyout
  actionLabel="Remove"
  icon={<DismissRegular />}
  message="Remove Alice from Platform?"
  onConfirm={onConfirm}
  title="Remove member"
  triggerLabel="Remove Alice"
/>);

test('keeps a failed confirmation open and allows retry', async () => {
  const confirm = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce('Membership changed elsewhere').mockResolvedValueOnce(null);
  renderFlyout(confirm);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove Alice' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })); });
  expect(await screen.findByText('Membership changed elsewhere')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })); });
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
});
