import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import UiTextEditorOverlay from '../../../src/components/ui-text-editor/overlay';
import { setLanguage } from '../../../src/i18n';
import { wrapWithKeyMarkers } from '../../../src/i18n/ui-text-editor/markers';
import { __testing as storeTesting } from '../../../src/i18n/ui-text-editor/store';
import { stubLocalStorage } from '../../local-storage-stub';
import { renderInApp } from '../../render';

stubLocalStorage();

describe('UiTextEditorOverlay', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    storeTesting.reset();
    await setLanguage('en');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stays hidden with zero edits until Alt is held, and freezes external pointerleave while Alt is down', async () => {
    const onExternalLeave = vi.fn();
    renderInApp(
      <>
        <button data-testid="trigger" onMouseLeave={onExternalLeave} type="button">
          {wrapWithKeyMarkers('Cancel', 'common.cancel')}
        </button>
        <UiTextEditorOverlay />
      </>,
    );

    expect(screen.queryByRole('region', { name: 'UI text editor' })).toBeNull();

    fireEvent.keyDown(window, { key: 'Alt', altKey: true });
    expect(await screen.findByRole('region', { name: 'UI text editor' })).toBeTruthy();

    // Mouse leaving an external trigger while Alt is pressed is swallowed to
    // keep hover tooltips/popovers frozen.
    fireEvent.mouseLeave(screen.getByTestId('trigger'));
    expect(onExternalLeave).not.toHaveBeenCalled();

    fireEvent.keyUp(window, { key: 'Alt', altKey: false });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'UI text editor' })).toBeNull());
  });

  it('opens the flyout on Alt+click without triggering the underlying button and intercepts Escape', async () => {
    const onButtonClick = vi.fn();
    const onExternalEscape = vi.fn();
    window.addEventListener('keydown', onExternalEscape);

    const { container } = renderInApp(
      <>
        <button data-testid="target-btn" onClick={onButtonClick} type="button">
          {wrapWithKeyMarkers('Cancel', 'common.cancel')}
        </button>
        <UiTextEditorOverlay />
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

    // Escape closes the UI text editor flyout without leaking to underlying listeners.
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

  it('auto-opens the header selector for multi-key hits, closes it before the dialog on Escape, and switches keys', async () => {
    const { container } = renderInApp(
      <>
        <p data-testid="multi-key">
          {`${wrapWithKeyMarkers('Cancel', 'common.cancel')} ${wrapWithKeyMarkers('Save', 'common.save')}`}
        </p>
        <UiTextEditorOverlay />
      </>,
    );

    const target = screen.getByTestId('multi-key');
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 40, 160, 24));
    const originalElementsFromPoint = (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [target, container, document.body],
    });

    await waitFor(() => expect(target.textContent).toBe('Cancel Save'));

    fireEvent.click(target, { altKey: true, button: 0, clientX: 60, clientY: 50 });

    expect(await screen.findByRole('dialog', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(2);

    // First Escape closes only the candidate dropdown while keeping the flyout open.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Edit' })).toBeTruthy();

    // Re-opening the header trigger and choosing the other option switches the active key.
    const trigger = screen.getByRole('button', { name: 'common.save' });
    fireEvent.click(trigger);
    const otherOption = screen.getByRole('option', { name: /common\.cancel/ });
    fireEvent.click(otherOption);

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeTruthy();

    if (originalElementsFromPoint === undefined) {
      delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    } else {
      Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: originalElementsFromPoint });
    }
  });
});
