import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CopyEditorOverlay from '../../../src/components/copy-editor/overlay';
import { setLanguage } from '../../../src/i18n';
import { wrapWithKeyMarkers } from '../../../src/i18n/copy-editor/markers';
import { __testing as storeTesting } from '../../../src/i18n/copy-editor/store';
import { stubLocalStorage } from '../../local-storage-stub';
import { renderInApp } from '../../render';

stubLocalStorage();

describe('CopyEditorOverlay', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    storeTesting.reset();
    await setLanguage('en');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stays hidden with zero drafts until Alt is held, and freezes external pointerleave while Alt is down', async () => {
    const onExternalLeave = vi.fn();
    renderInApp(
      <>
        <button data-testid="trigger" onMouseLeave={onExternalLeave} type="button">
          {wrapWithKeyMarkers('Cancel', 'common.cancel', 'common.cancel')}
        </button>
        <CopyEditorOverlay />
      </>,
    );

    expect(screen.queryByRole('region', { name: 'Copy editor' })).toBeNull();

    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    expect(await screen.findByRole('region', { name: 'Copy editor' })).toBeTruthy();

    // Mouse leaving an external trigger while Alt is pressed is swallowed to
    // keep hover tooltips/popovers frozen.
    fireEvent.mouseLeave(screen.getByTestId('trigger'));
    expect(onExternalLeave).not.toHaveBeenCalled();

    fireEvent.keyUp(window, { key: 'Alt', altKey: false });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Copy editor' })).toBeNull());
  });

  it('opens the flyout on Alt+click without triggering the underlying button and intercepts Escape', async () => {
    const onButtonClick = vi.fn();
    const onExternalEscape = vi.fn();
    window.addEventListener('keydown', onExternalEscape);

    const { container } = renderInApp(
      <>
        <button data-testid="target-btn" onClick={onButtonClick} type="button">
          {wrapWithKeyMarkers('Cancel', 'common.cancel', 'common.cancel')}
        </button>
        <CopyEditorOverlay />
      </>,
    );

    const button = screen.getByTestId('target-btn');
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 40, 100, 32));
    const originalElementsFromPoint = (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [button, container, document.body],
    });

    // Wait for MutationObserver to strip markers and register the node.
    await waitFor(() => expect(button.textContent).toBe('Cancel'));

    fireEvent.click(button, { altKey: true, button: 0, clientX: 60, clientY: 50 });

    expect(onButtonClick).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: 'Edit' })).toBeTruthy();

    // Escape closes the copy editor flyout without leaking to underlying listeners.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit' })).toBeNull());
    expect(onExternalEscape).not.toHaveBeenCalled();

    window.removeEventListener('keydown', onExternalEscape);
    if (originalElementsFromPoint === undefined) {
      delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    } else {
      Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: originalElementsFromPoint });
    }
  });
});
