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
});
