import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import UiTextEditorOverlay from '../../../src/components/ui-text-editor/overlay';
import { setLanguage } from '../../../src/i18n';
import { wrapWithKeyMarkers } from '../../../src/i18n/ui-text-editor/markers';
import { __testing as storeTesting, useUiTextEditorStore } from '../../../src/i18n/ui-text-editor/store';
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

    await waitFor(() => {
      expect(button.textContent).toBe('Cancel');
      expect(useUiTextEditorStore.getState().initialized).toBe(true);
    });

    fireEvent.click(button, { altKey: true, button: 0, clientX: 60, clientY: 50 });

    expect(onButtonClick).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: 'Edit' })).toBeTruthy();

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

    await waitFor(() => {
      expect(target.textContent).toBe('Cancel Save');
      expect(useUiTextEditorStore.getState().initialized).toBe(true);
    });

    fireEvent.click(target, { altKey: true, button: 0, clientX: 60, clientY: 50 });

    expect(await screen.findByRole('dialog', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(2);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Edit' })).toBeTruthy();

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
  it('anchors the hover tag inside the viewport with an aria-label suffix for full-height targets', async () => {
    const { container } = renderInApp(
      <>
        <nav
          aria-label={wrapWithKeyMarkers('Navigation', 'app.navigation.label')}
          data-testid="full-nav"
        />
        <UiTextEditorOverlay />
      </>,
    );

    const nav = screen.getByTestId('full-nav');
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 240, window.innerHeight));
    const originalElementsFromPoint = (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [nav, container, document.body],
    });

    await waitFor(() => {
      expect(nav.getAttribute('aria-label')).toBe('Navigation');
      expect(useUiTextEditorStore.getState().initialized).toBe(true);
    });

    fireEvent.pointerMove(window, { altKey: true, clientX: 100, clientY: 200 });

    const tag = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.floway-ui-text-editor-highlight-tag');
      expect(el).not.toBeNull();
      return el!;
    });

    expect(tag.textContent).toBe('app.navigation.label (aria-label)');
    const top = Number.parseFloat(tag.style.top);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top).toBeLessThanOrEqual(window.innerHeight - 32);

    if (originalElementsFromPoint === undefined) {
      delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    } else {
      Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: originalElementsFromPoint });
    }
  });
  it('renders a unified multi-line SVG contour when a wrapped text key spans multiple line rects', async () => {
    const { container } = renderInApp(
      <>
        <div data-testid="wrapped-hint">
          {wrapWithKeyMarkers('Protocol-native fields override the controls above.', 'playground.customJsonHint')}
        </div>
        <UiTextEditorOverlay />
      </>,
    );

    const hint = screen.getByTestId('wrapped-hint');
    const line1 = new DOMRect(20, 200, 250, 18);
    const line2 = new DOMRect(20, 220, 44, 18);
    vi.spyOn(hint, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 200, 250, 38));
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([line1, line2] as unknown as DOMRectList);
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 200, 250, 38));
    const originalElementsFromPoint = (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [hint, container, document.body],
    });

    await waitFor(() => {
      expect(hint.textContent).toBe('Protocol-native fields override the controls above.');
      expect(useUiTextEditorStore.getState().initialized).toBe(true);
    });

    fireEvent.pointerMove(window, { altKey: true, clientX: 120, clientY: 208 });

    const svg = await waitFor(() => {
      const el = document.querySelector<SVGSVGElement>('.floway-ui-text-editor-highlight-svg');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(svg.querySelectorAll('mask')).toHaveLength(2);

    if (originalElementsFromPoint === undefined) {
      delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    } else {
      Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: originalElementsFromPoint });
    }
  });
});
