import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Ref } from 'react';
import { expect, test, vi } from 'vitest';

import { ConfirmFlyout } from '../../../src/components/ui/confirm-flyout';
import { fluentComponents } from '../../../src/fluent';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const { Button, Tooltip } = fluentComponents;
const renderFlyout = (onConfirm: () => Promise<string | null>) => renderInApp(<ConfirmFlyout
  actionLabel="Remove"
  message="Remove Alice from Platform?"
  onConfirm={onConfirm}
  title="Remove member"
  trigger={props => <Tooltip content="Remove Alice" relationship="label"><Button {...props} as="button" ref={props.ref as Ref<HTMLButtonElement>}>Remove Alice</Button></Tooltip>}
/>);

test('opening and cancelling the anchored confirmation does not remove anything', async () => {
  const confirm = vi.fn(async () => null);
  renderFlyout(confirm);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove Alice' })); });
  expect(await screen.findByText('Remove Alice from Platform?')).toBeTruthy();
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
