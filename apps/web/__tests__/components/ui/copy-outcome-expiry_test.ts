import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyToClipboard } from '../../../src/components/ui/copy-to-clipboard';
import { useCopyToClipboard } from '../../../src/components/ui/use-copy-to-clipboard';
import { advance } from '../../settle';

vi.mock('../../../src/components/ui/copy-to-clipboard', () => ({ copyToClipboard: vi.fn() }));

const copyResult = vi.mocked(copyToClipboard);

// The copy itself resolves on a microtask the fake timers do not hold, so a
// press has to be awaited before its outcome is on screen.
const press = async (copy: () => void) => { await act(async () => { copy(); }); };

describe('copy outcome expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    copyResult.mockResolvedValue(true);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('lets one hook serve a table of buttons', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await press(() => { result.current.copy('first', 'row-1'); });

    expect(result.current.outcomeFor('row-1')).toBe('copied');
    expect(result.current.outcomeFor('row-2')).toBe('idle');
    expect(result.current.outcomeFor()).toBe('idle');
  });

  it('does not let one button\'s expiry clear another button\'s result', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await press(() => { result.current.copy('first', 'row-1'); });
    await advance(1_000);
    await press(() => { result.current.copy('second', 'row-2'); });
    await advance(500);

    expect(result.current.outcomeFor('row-2')).toBe('copied');

    await advance(1_000);

    expect(result.current.outcomeFor('row-2')).toBe('idle');
  });

  it('leaves a failure up longer than a success', async () => {
    copyResult.mockResolvedValue(false);
    const { result } = renderHook(() => useCopyToClipboard());

    await press(() => { result.current.copy('first', 'row-1'); });
    expect(result.current.outcomeFor('row-1')).toBe('failed');

    await advance(1_500);
    expect(result.current.outcomeFor('row-1')).toBe('failed');

    await advance(500);
    expect(result.current.outcomeFor('row-1')).toBe('idle');
  });

  it('replaces a failure with the success of a retry', async () => {
    copyResult.mockResolvedValue(false);
    const { result } = renderHook(() => useCopyToClipboard());

    await press(() => { result.current.copy('first', 'row-1'); });
    copyResult.mockResolvedValue(true);
    await press(() => { result.current.copy('first', 'row-1'); });

    expect(result.current.outcomeFor('row-1')).toBe('copied');
  });

  it('gives an untagged button a slot of its own', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await press(() => { result.current.copy('first'); });

    expect(result.current.outcomeFor()).toBe('copied');
    expect(result.current.outcomeFor('row-1')).toBe('idle');
  });
});
