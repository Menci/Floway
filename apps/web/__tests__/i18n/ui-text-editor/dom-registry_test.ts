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
      expect(descHit?.primaryInvisible).toBeUndefined();
      expect(descHit?.candidates).toEqual(['settings.account.password.description']);

      stack = [disclosure, container, document.body];
      const ariaOnlyHit = registry.resolveAtPoint(document, 260, 20);
      expect(ariaOnlyHit?.element).toBe(disclosure);
      expect(ariaOnlyHit?.primaryKey).toBe('settings.account.password.title');
      expect(ariaOnlyHit?.primaryInvisible).toBe(true);
      expect(ariaOnlyHit?.candidates).toEqual(['settings.account.password.title']);

      stack = [input, container, document.body];
      const inputHit = registry.resolveAtPoint(document, 40, 110);
      expect(inputHit?.element).toBe(input);
      expect(inputHit?.primaryKey).toBe('permissions.filters.allPrincipals');
      expect(inputHit?.primaryInvisible).toBeUndefined();
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
  it('returns all line rects consistently across wrapped lines and ignores trailing blank space', () => {
    container = document.createElement('div');
    const hint = document.createElement('div');
    hint.textContent = wrapWithKeyMarkers(
      'Protocol-native fields override the controls above.',
      'playground.customJsonHint',
    );
    container.append(hint);
    document.body.append(container);

    const line1 = new DOMRect(20, 200, 250, 18);
    const line2 = new DOMRect(20, 220, 44, 18);
    const combined = new DOMRect(20, 200, 250, 38);

    vi.spyOn(hint, 'getBoundingClientRect').mockReturnValue(combined);
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([line1, line2] as unknown as DOMRectList);
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(combined);

    const originalElementsFromPoint = (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [hint, container, document.body],
    });

    try {
      registry.start(container);

      const firstLineHit = registry.resolveAtPoint(document, 120, 208);
      const secondLineHit = registry.resolveAtPoint(document, 36, 228);

      expect(firstLineHit?.primaryKey).toBe('playground.customJsonHint');
      expect(firstLineHit?.rects).toEqual([line1, line2]);
      expect(firstLineHit?.rect).toEqual(combined);

      expect(secondLineHit?.primaryKey).toBe('playground.customJsonHint');
      expect(secondLineHit?.rects).toEqual([line1, line2]);
      expect(secondLineHit?.rect).toEqual(combined);

      // Empty space to the right of the shorter second line does not fall back to the bounding box.
      expect(registry.resolveAtPoint(document, 180, 228)).toBeNull();
    } finally {
      if (originalElementsFromPoint === undefined) {
        delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
      } else {
        Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: originalElementsFromPoint });
      }
    }
  });
  it('treats visually hidden text as invisible like aria-label, keeping visible text priority and dimensions', () => {
    container = document.createElement('div');

    const badge = document.createElement('span');
    const visibleText = document.createTextNode(wrapWithKeyMarkers('Use models', 'permissions.columns.Model.Use'));
    const srState = document.createElement('span');
    srState.style.position = 'absolute';
    srState.style.width = '1px';
    srState.style.height = '1px';
    srState.style.overflow = 'hidden';
    srState.style.clipPath = 'inset(50%)';
    srState.textContent = wrapWithKeyMarkers('On', 'permissions.states.on');
    badge.append(visibleText, srState);

    const srOnlyHeader = document.createElement('th');
    const srHeaderLabel = document.createElement('span');
    srHeaderLabel.style.clip = 'rect(0px, 0px, 0px, 0px)';
    srHeaderLabel.textContent = wrapWithKeyMarkers('Actions', 'permissions.actions.column');
    srOnlyHeader.append(srHeaderLabel);

    container.append(badge, srOnlyHeader);
    document.body.append(container);

    const badgeRect = new DOMRect(40, 20, 90, 24);
    const visibleTextRect = new DOMRect(56, 23, 66, 18);
    const headerRect = new DOMRect(200, 20, 48, 28);
    vi.spyOn(badge, 'getBoundingClientRect').mockReturnValue(badgeRect);
    vi.spyOn(srOnlyHeader, 'getBoundingClientRect').mockReturnValue(headerRect);
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      return (this.startContainer === visibleText ? [visibleTextRect] : []) as unknown as DOMRectList;
    });
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
      return this.startContainer === visibleText ? visibleTextRect : new DOMRect(0, 0, 0, 0);
    });

    const originalElementsFromPoint = (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
    let stack: Element[] = [badge, container, document.body];
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => stack,
    });

    try {
      registry.start(container);

      // Hovering visible text inside a badge with an sr-only sibling prioritizes visible text and its rect.
      const visibleHit = registry.resolveAtPoint(document, 70, 30);
      expect(visibleHit?.primaryKey).toBe('permissions.columns.Model.Use');
      expect(visibleHit?.primaryInvisible).toBeUndefined();
      expect(visibleHit?.rect).toEqual(visibleTextRect);
      expect(visibleHit?.candidates).toEqual(['permissions.columns.Model.Use', 'permissions.states.on']);

      // Hovering an element whose only tracked text is sr-only hits as invisible.
      stack = [srOnlyHeader, container, document.body];
      const srOnlyHit = registry.resolveAtPoint(document, 210, 30);
      expect(srOnlyHit?.primaryKey).toBe('permissions.actions.column');
      expect(srOnlyHit?.primaryInvisible).toBe(true);
      expect(srOnlyHit?.rect).toEqual(headerRect);

      // Outer wrapper with no direct aria-label/sr-only child does not claim nested invisible labels.
      stack = [container, document.body];
      expect(registry.resolveAtPoint(document, 10, 10)).toBeNull();
    } finally {
      if (originalElementsFromPoint === undefined) {
        delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint;
      } else {
        Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: originalElementsFromPoint });
      }
    }
  });
});
