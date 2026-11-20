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
      expect(descHit?.candidates).toEqual(['settings.account.password.description']);

      stack = [input, container, document.body];
      const inputHit = registry.resolveAtPoint(document, 40, 110);
      expect(inputHit?.element).toBe(input);
      expect(inputHit?.primaryKey).toBe('permissions.filters.allPrincipals');
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
});
