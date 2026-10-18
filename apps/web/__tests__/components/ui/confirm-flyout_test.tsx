import { DismissRegular } from '@fluentui/react-icons';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { ConfirmFlyout } from '../../../src/components/ui/confirm-flyout';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const renderFlyout = (onConfirm: () => Promise<string | null>) => renderInApp(<ConfirmFlyout
  actionLabel="Remove"
  icon={<DismissRegular />}
  message="Remove Alice from Platform?"
  onConfirm={onConfirm}
  title="Remove member"
  triggerLabel="Remove Alice"
/>);

test('opening and cancelling the anchored confirmation does not remove anything', async () => {
  const confirm = vi.fn(async () => null);
  renderFlyout(confirm);
  await act(async () => { fireEvent.pointerEnter(screen.getByRole('button', { name: 'Remove Alice' }), { pointerType: 'mouse' }); });
  expect(await screen.findByRole('tooltip')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove Alice' })); });
  expect(await screen.findByText('Remove Alice from Platform?')).toBeTruthy();
  await waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull());
  expect(confirm).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: i18n.t('common.cancel') })); });
  expect(confirm).not.toHaveBeenCalled();
});

test('keeps a failed confirmation open and allows retry', async () => {
  const confirm = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce('Membership changed elsewhere').mockResolvedValueOnce(null);
  renderFlyout(confirm);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove Alice' })); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })); });
  expect(await screen.findByText('Membership changed elsewhere')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })); });
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
});

test('disabling an open confirmation also locks its submit action', async () => {
  const confirm = vi.fn(async () => null);
  const props = { actionLabel: 'Remove', icon: <DismissRegular />, message: 'Remove Alice from Platform?', onConfirm: confirm, title: 'Remove member', triggerLabel: 'Remove Alice' };
  const { rerender } = renderInApp(<ConfirmFlyout {...props} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove Alice' })); });
  rerender(<ConfirmFlyout {...props} disabled />);
  const submit = screen.getByRole('button', { name: 'Remove' });
  expect(submit.getAttribute('aria-disabled')).toBe('true');
  await act(async () => { fireEvent.click(submit); });
  expect(confirm).not.toHaveBeenCalled();
});
