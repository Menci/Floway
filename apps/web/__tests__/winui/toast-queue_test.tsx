import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';

import { fluentComponents } from '../../src/fluent';
import { renderInApp } from '../render';

const { Toast, Toaster, ToastTitle, useToastController } = fluentComponents;

const TOASTER_ID = 'toast-queue-suite';
const LIMIT = 1;

// Fluent renders a toast held behind the limit like any other, with `visible`
// false, and takes the finish of an exit motion as permission to drop it. A
// presence component that keeps such a toast mounted therefore animates it out
// and destroys it before it was ever shown, which is what this pins.
const QueueHarness = () => {
  const { dismissToast, dispatchToast } = useToastController(TOASTER_ID);
  const dispatched = useRef<string[]>([]);

  const fire = () => {
    dispatched.current = ['held', 'queued'].map(title => {
      const toastId = `${TOASTER_ID}-${title}`;
      dispatchToast(<Toast><ToastTitle>{title}</ToastTitle></Toast>, { timeout: -1, toastId });
      return toastId;
    });
  };

  return <>
    <Toaster limit={LIMIT} position="top-end" toasterId={TOASTER_ID} />
    <button onClick={fire} type="button">fire</button>
    <button onClick={() => dismissToast(dispatched.current[0]!)} type="button">dismiss</button>
  </>;
};

describe('winui toaster queue', () => {
  it('holds a toast dispatched past the limit until a slot frees instead of removing it', async () => {
    renderInApp(<QueueHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'fire' }));
    await screen.findByText('held');
    expect(screen.queryByText('queued')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    await screen.findByText('queued');
    await waitFor(() => expect(screen.queryByText('held')).toBeNull());
  });
});
