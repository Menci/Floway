import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePollWhileVisible } from '../../../src/components/ui/use-poll-while-visible';
import { advance } from '../../settle';

// happy-dom reports a document that is always visible, so the tab state is
// what the suite drives.
let visibility: DocumentVisibilityState = 'visible';

const setVisibility = async (next: DocumentVisibilityState) => {
  visibility = next;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
};

describe('polling while visible', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('polls in the background while the tab is being looked at', async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    renderHook(() => { usePollWhileVisible(poll, 60_000); });

    await advance(59_999);
    expect(poll).not.toHaveBeenCalled();

    await advance(1);
    expect(poll.mock.calls).toEqual([[{ background: true }]]);
  });

  it('does not poll a tab nobody is looking at', async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    renderHook(() => { usePollWhileVisible(poll, 60_000); });

    await setVisibility('hidden');
    await advance(180_000);

    expect(poll).not.toHaveBeenCalled();
  });

  // Somebody is looking now, so a failure on the catch-up refresh is one they
  // should see: the return to the tab is a foreground run, not a background one.
  it('pays one foreground refresh on the return to the tab', async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    renderHook(() => { usePollWhileVisible(poll, 60_000); });

    await setVisibility('hidden');
    await setVisibility('visible');

    expect(poll.mock.calls).toEqual([[{ background: false }]]);
  });

  it('stops polling once the page is gone', async () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => { usePollWhileVisible(poll, 60_000); });

    unmount();
    await advance(180_000);
    await setVisibility('hidden');
    await setVisibility('visible');

    expect(poll).not.toHaveBeenCalled();
  });
});
