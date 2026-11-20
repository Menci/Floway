import { extractKeySegments, mayContainKeyMarkers, type TextKeySegment } from './markers';

export const UI_TEXT_EDITOR_ROOT_ATTR = 'data-floway-ui-text-editor-root';

const MONITORED_ATTRIBUTES = ['aria-label', 'placeholder', 'alt', 'value'] as const;

interface AttributeKeyRecord {
  attribute: string;
  key: string;
}

export interface HitTarget {
  element: Element;
  rect: DOMRect;
  primaryKey: string;
  candidates: string[];
}

export const isInsideUiTextEditor = (target: EventTarget | Node | null, host?: HTMLElement | null): boolean => {
  if (!(target instanceof Node)) return false;
  if (host?.contains(target)) return true;
  let current: Node | null = target;
  while (current) {
    if (current instanceof Element && current.hasAttribute(UI_TEXT_EDITOR_ROOT_ATTR)) return true;
    current = current.parentNode;
  }
  return false;
};

const isRestrictedElement = (element: Element | null): boolean => {
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT';
};

const pointInsideRect = (rect: DOMRect, x: number, y: number, pad = 4): boolean =>
  x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;

const rectFromTextSegmentAtPoint = (
  textNode: Text,
  start: number,
  end: number,
  clientX: number,
  clientY: number,
): DOMRect | null => {
  if (start >= end || end > textNode.data.length) return null;
  const range = textNode.ownerDocument.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);

  // Prefer the individual line rect under the pointer for wrapped multi-line
  // segments before falling back to the combined bounding rect.
  if (typeof range.getClientRects === 'function') {
    const rects = Array.from(range.getClientRects());
    for (const r of rects) {
      if ((r.width > 0 || r.height > 0) && pointInsideRect(r, clientX, clientY, 8)) {
        return r;
      }
    }
  }

  const rect = range.getBoundingClientRect();
  return (rect.width > 0 || rect.height > 0) && pointInsideRect(rect, clientX, clientY, 8) ? rect : null;
};

interface CaretHit {
  node: Node;
  offset: number;
}

const caretAtPoint = (doc: Document, x: number, y: number): CaretHit | null => {
  const withCaretPosition = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node | null; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof withCaretPosition.caretPositionFromPoint === 'function') {
    const pos = withCaretPosition.caretPositionFromPoint(x, y);
    if (pos?.offsetNode) return { node: pos.offsetNode, offset: pos.offset };
  }
  if (typeof withCaretPosition.caretRangeFromPoint === 'function') {
    const range = withCaretPosition.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
};

const findSegmentAtOffset = (segments: TextKeySegment[], offset: number): TextKeySegment | null => {
  for (const seg of segments) {
    if (offset >= seg.start && offset < seg.end) return seg;
  }
  // Caret at the trailing edge of a segment (e.g. clicking right of the last character).
  for (const seg of segments) {
    if (offset === seg.end && seg.end > seg.start) return seg;
  }
  return null;
};

const dedupeKeys = (items: string[]): string[] => [...new Set(items)];

export class UiTextEditorDomRegistry {
  private readonly textSegments = new WeakMap<Text, TextKeySegment[]>();
  private readonly strippedTextValue = new WeakMap<Text, string>();
  private readonly elementTexts = new WeakMap<Element, Set<Text>>();
  private readonly elementAttrs = new WeakMap<Element, AttributeKeyRecord[]>();
  private readonly strippedAttrValues = new WeakMap<Element, Map<string, string>>();
  private observer: MutationObserver | null = null;
  private root: HTMLElement | null = null;

  start(root: HTMLElement): void {
    if (this.observer && this.root === root) return;
    this.stop();
    this.root = root;
    this.scanSubtree(root);
    this.observer = new MutationObserver(records => this.handleRecords(records));
    this.observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...MONITORED_ATTRIBUTES],
    });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.root = null;
  }

  scanNow(): void {
    if (this.root) this.scanSubtree(this.root);
  }

  // Drain any queued MutationObserver records synchronously before hit-testing
  // without re-walking the entire document tree on every pointermove.
  flushMutations(): void {
    if (!this.observer) return;
    const pending = this.observer.takeRecords();
    if (pending.length > 0) this.handleRecords(pending);
  }

  private handleRecords(records: MutationRecord[]): void {
    for (const record of records) {
      if (record.type === 'characterData') {
        if (record.target instanceof Text) this.processTextNode(record.target);
      } else if (record.type === 'attributes') {
        if (record.target instanceof Element && record.attributeName) {
          this.processAttribute(record.target, record.attributeName);
        }
      } else if (record.type === 'childList') {
        if (record.target instanceof Element && record.removedNodes.length > 0) {
          const textSet = this.elementTexts.get(record.target);
          if (textSet) {
            for (const removed of record.removedNodes) {
              if (removed instanceof Text) textSet.delete(removed);
            }
          }
        }
        for (const added of record.addedNodes) {
          this.scanSubtree(added);
        }
      }
    }
  }

  private scanSubtree(node: Node): void {
    if (isInsideUiTextEditor(node)) return;
    if (node instanceof Text) {
      this.processTextNode(node);
      return;
    }
    if (!(node instanceof Element)) return;
    if (isRestrictedElement(node)) return;

    this.processElementAttributes(node);

    // FILTER_REJECT prunes a subtree while allowing TreeWalker to continue at
    // following siblings and ancestors.
    const walker = node.ownerDocument.createTreeWalker(
      node,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(candidate) {
          if (candidate instanceof Element) {
            if (candidate.hasAttribute(UI_TEXT_EDITOR_ROOT_ATTR) || isRestrictedElement(candidate)) {
              return NodeFilter.FILTER_REJECT;
            }
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    let current: Node | null = walker.nextNode();
    while (current) {
      if (current instanceof Element) {
        this.processElementAttributes(current);
      } else if (current instanceof Text) {
        this.processTextNode(current);
      }
      current = walker.nextNode();
    }
  }

  private processTextNode(textNode: Text): void {
    if (isInsideUiTextEditor(textNode)) return;
    const parent = textNode.parentElement;
    if (isRestrictedElement(parent)) return;
    const raw = textNode.data;

    if (!mayContainKeyMarkers(raw)) {
      // Skip observer callbacks matching the value we just stripped; invalidate
      // mappings when a node changes to any other plain text.
      if (this.strippedTextValue.get(textNode) !== raw) {
        this.textSegments.delete(textNode);
        this.strippedTextValue.delete(textNode);
        if (parent) this.elementTexts.get(parent)?.delete(textNode);
      }
      return;
    }

    const extracted = extractKeySegments(raw);
    if (!extracted.hadMarkers) return;

    // Strip invisible markers immediately so selection, copy, and layout see
    // plain text while the registry retains exact segment offsets.
    this.strippedTextValue.set(textNode, extracted.text);
    textNode.data = extracted.text;
    this.textSegments.set(textNode, extracted.segments);

    if (parent) {
      let set = this.elementTexts.get(parent);
      if (!set) {
        set = new Set<Text>();
        this.elementTexts.set(parent, set);
      }
      set.add(textNode);
    }
  }

  private processElementAttributes(element: Element): void {
    for (const attr of MONITORED_ATTRIBUTES) {
      if (element.hasAttribute(attr) || this.strippedAttrValues.get(element)?.has(attr)) {
        this.processAttribute(element, attr);
      }
    }
    // Inputs and textareas can also receive marked text via their DOM property
    // when controlled in React without setting the HTML `value` attribute.
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.type !== 'password') {
        const val = element.value;
        if (mayContainKeyMarkers(val)) {
          const extracted = extractKeySegments(val);
          if (extracted.hadMarkers) {
            this.recordStrippedAttr(element, 'value', extracted.text);
            element.value = extracted.text;
            this.recordAttributeKeys(element, 'value', extracted.segments);
          }
        } else if (this.strippedAttrValues.get(element)?.get('value') !== val) {
          this.clearAttributeKeys(element, 'value');
        }
      }
    }
  }

  private processAttribute(element: Element, attr: string): void {
    if (isInsideUiTextEditor(element) || isRestrictedElement(element)) return;
    const raw = element.getAttribute(attr);
    if (raw === null) {
      this.clearAttributeKeys(element, attr);
      return;
    }
    if (!mayContainKeyMarkers(raw)) {
      if (this.strippedAttrValues.get(element)?.get(attr) !== raw) {
        this.clearAttributeKeys(element, attr);
      }
      return;
    }

    const extracted = extractKeySegments(raw);
    if (!extracted.hadMarkers) return;

    this.recordStrippedAttr(element, attr, extracted.text);
    element.setAttribute(attr, extracted.text);
    this.recordAttributeKeys(element, attr, extracted.segments);
  }

  private recordStrippedAttr(element: Element, attr: string, value: string): void {
    let map = this.strippedAttrValues.get(element);
    if (!map) {
      map = new Map<string, string>();
      this.strippedAttrValues.set(element, map);
    }
    map.set(attr, value);
  }

  private recordAttributeKeys(element: Element, attribute: string, segments: TextKeySegment[]): void {
    const existing = this.elementAttrs.get(element) ?? [];
    const filtered = existing.filter(entry => entry.attribute !== attribute);
    for (const seg of segments) {
      filtered.push({ attribute, key: seg.key });
    }
    this.elementAttrs.set(element, filtered);
  }

  private clearAttributeKeys(element: Element, attribute: string): void {
    this.strippedAttrValues.get(element)?.delete(attribute);
    const existing = this.elementAttrs.get(element);
    if (!existing) return;
    const filtered = existing.filter(entry => entry.attribute !== attribute);
    if (filtered.length === 0) {
      this.elementAttrs.delete(element);
    } else {
      this.elementAttrs.set(element, filtered);
    }
  }

  private collectTextKeys(element: Element): string[] {
    const out: string[] = [];
    const textNodes = this.elementTexts.get(element);
    if (textNodes) {
      for (const textNode of textNodes) {
        if (!textNode.isConnected || textNode.parentElement !== element) {
          textNodes.delete(textNode);
          continue;
        }
        const segments = this.textSegments.get(textNode);
        if (!segments) continue;
        for (const seg of segments) {
          out.push(seg.key);
        }
      }
    }
    return out;
  }

  private collectAttributeKeys(element: Element): string[] {
    const attrs = this.elementAttrs.get(element);
    if (!attrs) return [];
    return attrs.map(entry => entry.key);
  }

  private collectSubtreeKeys(element: Element): string[] {
    const collected: string[] = [
      ...this.collectTextKeys(element),
      ...this.collectAttributeKeys(element),
    ];
    const walker = element.ownerDocument.createTreeWalker(
      element,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(candidate) {
          return candidate instanceof Element && candidate.hasAttribute(UI_TEXT_EDITOR_ROOT_ATTR)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    let child = walker.nextNode() as Element | null;
    while (child) {
      collected.push(...this.collectTextKeys(child), ...this.collectAttributeKeys(child));
      child = walker.nextNode() as Element | null;
    }
    return dedupeKeys(collected);
  }

  resolveAtPoint(doc: Document, clientX: number, clientY: number): HitTarget | null {
    this.flushMutations();

    // Resolve caret-level matches first so multi-key text returns the exact
    // segment under the pointer.
    const caret = caretAtPoint(doc, clientX, clientY);
    if (caret && caret.node instanceof Text && !isInsideUiTextEditor(caret.node)) {
      const segments = this.textSegments.get(caret.node);
      const parent = caret.node.parentElement;
      if (segments && segments.length > 0 && parent) {
        const hitSegment = findSegmentAtOffset(segments, caret.offset);
        if (hitSegment) {
          const segRect = rectFromTextSegmentAtPoint(
            caret.node,
            hitSegment.start,
            hitSegment.end,
            clientX,
            clientY,
          );
          if (segRect) {
            const container = parent.closest('p, li, td, th, button, a, label, h1, h2, h3, h4, h5, h6, [role="tooltip"], [role="menuitem"], [role="option"]') ?? parent;
            const allCandidates = dedupeKeys([
              hitSegment.key,
              ...segments.map(seg => seg.key),
              ...this.collectSubtreeKeys(container),
            ]);
            return {
              element: parent,
              rect: segRect,
              primaryKey: hitSegment.key,
              candidates: allCandidates,
            };
          }
        }
      }
    }

    // 2. Fallback to elementsFromPoint: catches icon buttons (aria-label),
    // inputs (placeholder/value), tooltips, and elements whose text sits inside
    // a child span.
    const stack = typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(clientX, clientY) : [];
    for (const element of stack) {
      if (isInsideUiTextEditor(element)) return null;
      this.processElementAttributes(element);
      const direct = dedupeKeys([
        ...this.collectTextKeys(element),
        ...this.collectAttributeKeys(element),
      ]);
      if (direct.length > 0) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          return {
            element,
            rect,
            primaryKey: direct[0]!,
            candidates: direct,
          };
        }
      }

      if (
        element.matches('button, a, label, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="tooltip"]')
      ) {
        const subtree = this.collectSubtreeKeys(element);
        if (subtree.length > 0) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            return {
              element,
              rect,
              primaryKey: subtree[0]!,
              candidates: subtree,
            };
          }
        }
      }
    }

    return null;
  }
}

// Single shared registry instance so React StrictMode double-mounts never drop
// previously stripped TextNode mappings.
export const sharedUiTextEditorRegistry = new UiTextEditorDomRegistry();
