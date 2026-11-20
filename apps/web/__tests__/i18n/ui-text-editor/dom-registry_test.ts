import { afterEach, describe, expect, it, vi } from 'vitest';

import { UiTextEditorDomRegistry } from '../../../src/i18n/ui-text-editor/dom-registry';
import { wrapWithKeyMarkers } from '../../../src/i18n/ui-text-editor/markers';

describe('UiTextEditorDomRegistry', () => {
  const registry = new UiTextEditorDomRegistry();
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    registry.stop();
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  it('invalidates tracked text and attributes when replaced with plain content, removed, or reparented', () => {
    container = document.createElement('div');
    const hostA = document.createElement('button');
    const hostB = document.createElement('div');
    hostA.textContent = wrapWithKeyMarkers('Cancel', 'common.cancel');
    hostA.setAttribute('aria-label', wrapWithKeyMarkers('Close', 'common.uiTextEditor.close'));
    container.append(hostA, hostB);
    document.body.append(container);

    vi.spyOn(hostA, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 80, 28));
    vi.spyOn(hostB, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 50, 80, 28));
    const originalElementsFromPoint = (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    let stack: Element[] = [hostA, container, document.body];
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => stack,
    });

    try {
      registry.start(container);
      expect(hostA.textContent).toBe('Cancel');
      expect(hostA.getAttribute('aria-label')).toBe('Close');

      const initialHit = registry.resolveAtPoint(document, 20, 20);
      expect(initialHit?.candidates).toEqual(['common.cancel', 'common.uiTextEditor.close']);

      hostA.removeAttribute('aria-label');
      expect(registry.resolveAtPoint(document, 20, 20)?.candidates).toEqual(['common.cancel']);

      const textNode = hostA.firstChild as Text;
      hostB.append(textNode);
      expect(registry.resolveAtPoint(document, 20, 20)).toBeNull();

      textNode.data = 'Plain text';
      stack = [hostB, container, document.body];
      expect(registry.resolveAtPoint(document, 20, 60)).toBeNull();
    } finally {
      if (originalElementsFromPoint === undefined) {
        delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
      } else {
        Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: originalElementsFromPoint });
      }
    }
  });
  it('prefers visible text beneath an aria-label overlay and orders visible input values ahead of aria-label', () => {
    container = document.createElement('div');
    const disclosure = document.createElement('button');
    disclosure.setAttribute('aria-label', wrapWithKeyMarkers('Password', 'settings.account.password.title'));
    const description = document.createElement('span');
    description.textContent = wrapWithKeyMarkers('Change the account password', 'settings.account.password.description');

    const input = document.createElement('input');
    input.setAttribute('aria-label', wrapWithKeyMarkers('Applies to', 'permissions.fields.principal'));
    input.value = wrapWithKeyMarkers('All visible principals', 'permissions.filters.allPrincipals');

    container.append(disclosure, description, input);
    document.body.append(container);

    vi.spyOn(disclosure, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 68));
    vi.spyOn(description, 'getBoundingClientRect').mockReturnValue(new DOMRect(48, 36, 180, 18));
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 200, 34));

    const originalElementsFromPoint = (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    let stack: Element[] = [disclosure, description, container, document.body];
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => stack,
    });

    try {
      registry.start(container);

      const descHit = registry.resolveAtPoint(document, 80, 42);
      expect(descHit?.element).toBe(description);
      expect(descHit?.primaryKey).toBe('settings.account.password.description');
      expect(descHit?.primaryAttribute).toBeUndefined();
      expect(descHit?.candidates).toEqual(['settings.account.password.description']);

      stack = [disclosure, container, document.body];
      const ariaOnlyHit = registry.resolveAtPoint(document, 260, 20);
      expect(ariaOnlyHit?.element).toBe(disclosure);
      expect(ariaOnlyHit?.primaryKey).toBe('settings.account.password.title');
      expect(ariaOnlyHit?.primaryAttribute).toBe('aria-label');
      expect(ariaOnlyHit?.candidates).toEqual(['settings.account.password.title']);

      stack = [input, container, document.body];
      const inputHit = registry.resolveAtPoint(document, 40, 110);
      expect(inputHit?.element).toBe(input);
      expect(inputHit?.primaryKey).toBe('permissions.filters.allPrincipals');
      expect(inputHit?.primaryAttribute).toBeUndefined();
      expect(inputHit?.candidates).toEqual([
        'permissions.filters.allPrincipals',
        'permissions.fields.principal',
      ]);
    } finally {
      if (originalElementsFromPoint === undefined) {
        delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
      } else {
        Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: originalElementsFromPoint });
      }
    }
  });
  it('shrink-wraps unique interactive container hits to the inner text target and skips multi-key container backgrounds', () => {
    container = document.createElement('div');

    const navItem = document.createElement('a');
    const navIcon = document.createElement('span');
    const navLabel = document.createElement('span');
    navLabel.textContent = wrapWithKeyMarkers('Settings', 'nav.settings');
    navItem.append(navIcon, navLabel);

    const multiButton = document.createElement('button');
    const firstLabel = document.createElement('span');
    firstLabel.textContent = wrapWithKeyMarkers('Save', 'common.save');
    const secondLabel = document.createElement('span');
    secondLabel.textContent = wrapWithKeyMarkers('Cancel', 'common.cancel');
    multiButton.append(firstLabel, secondLabel);

    const directTextButton = document.createElement('button');
    const directIcon = document.createElement('span');
    directTextButton.append(directIcon, document.createTextNode(wrapWithKeyMarkers('Export', 'common.uiTextEditor.export')));

    container.append(navItem, multiButton, directTextButton);
    document.body.append(container);

    const navLabelRect = new DOMRect(44, 16, 62, 20);
    const directTextRect = new DOMRect(50, 126, 48, 18);
    vi.spyOn(navItem, 'getBoundingClientRect').mockReturnValue(new DOMRect(8, 8, 220, 36));
    vi.spyOn(navLabel, 'getBoundingClientRect').mockReturnValue(navLabelRect);
    vi.spyOn(directTextButton, 'getBoundingClientRect').mockReturnValue(new DOMRect(8, 120, 160, 32));
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
      return this.startContainer.parentElement === directTextButton ? directTextRect : new DOMRect(0, 0, 0, 0);
    });
    vi.spyOn(multiButton, 'getBoundingClientRect').mockReturnValue(new DOMRect(8, 60, 220, 48));
    vi.spyOn(firstLabel, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, 68, 40, 20));
    vi.spyOn(secondLabel, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, 88, 52, 20));

    const originalElementsFromPoint = (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    let stack: Element[] = [navItem, container, document.body];
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => stack,
    });

    try {
      registry.start(container);

      // Hovering empty padding on the nav item resolves to the inner text element and rect.
      const backgroundHit = registry.resolveAtPoint(document, 180, 20);
      expect(backgroundHit?.element).toBe(navLabel);
      expect(backgroundHit?.rect).toEqual(navLabelRect);
      expect(backgroundHit?.primaryKey).toBe('nav.settings');
      expect(backgroundHit?.candidates).toEqual(['nav.settings']);

      // Hovering directly on the text produces the exact same target and rect.
      stack = [navLabel, navItem, container, document.body];
      const textHit = registry.resolveAtPoint(document, 60, 24);
      expect(textHit?.element).toBe(navLabel);
      expect(textHit?.rect).toEqual(navLabelRect);
      expect(textHit?.primaryKey).toBe('nav.settings');

      // When text sits directly inside a button with a non-zero Range rect, hovering padding uses that Range rect.
      stack = [directTextButton, container, document.body];
      const directPaddingHit = registry.resolveAtPoint(document, 140, 132);
      expect(directPaddingHit?.element).toBe(directTextButton);
      expect(directPaddingHit?.rect).toEqual(directTextRect);
      expect(directPaddingHit?.primaryKey).toBe('common.uiTextEditor.export');

      // Hovering background space of an interactive container with multiple keys returns null.
      stack = [multiButton, container, document.body];
      expect(registry.resolveAtPoint(document, 180, 76)).toBeNull();
    } finally {
      if (originalElementsFromPoint === undefined) {
        delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
      } else {
        Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: originalElementsFromPoint });
      }
    }
  });
});
