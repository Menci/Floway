import { extractKeySegments, mayContainKeyMarkers, type TextKeySegment } from './markers';

export const COPY_EDITOR_ROOT_ATTR = 'data-floway-copy-editor-root';

const MONITORED_ATTRIBUTES = ['aria-label', 'placeholder', 'alt', 'value'] as const;

export interface AttributeKeyRecord {
  attribute: string;
  key: string;
}

export interface KeyCandidate {
  key: string;
  source: 'text' | 'attribute';
  attribute?: string;
}

export interface HitTarget {
  element: Element;
  rect: DOMRect;
  primaryKey: string;
  candidates: KeyCandidate[];
}

const isInsideEditorUi = (node: Node | null): boolean => {
  let current: Node | null = node;
  while (current) {
    if (current instanceof Element && current.hasAttribute(COPY_EDITOR_ROOT_ATTR)) return true;
    current = current.parentNode;
  }
  return false;
};

const isRestrictedElement = (element: Element | null): boolean => {
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT';
};

const rectFromTextSegment = (textNode: Text, start: number, end: number): DOMRect | null => {
  const length = textNode.data.length;
  const safeStart = Math.max(0, Math.min(start, length));
  const safeEnd = Math.max(safeStart, Math.min(end, length));
  if (safeStart === safeEnd) return null;
  const range = textNode.ownerDocument.createRange();
  range.setStart(textNode, safeStart);
  range.setEnd(textNode, safeEnd);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
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

const pointInsideRect = (rect: DOMRect, x: number, y: number, pad = 4): boolean =>
  x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;

const dedupeCandidates = (items: KeyCandidate[]): KeyCandidate[] => {
  const seen = new Set<string>();
  const out: KeyCandidate[] = [];
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out;
};

export class CopyEditorDomRegistry {
  private readonly textSegments = new WeakMap<Text, TextKeySegment[]>();
  private readonly elementTexts = new WeakMap<Element, Set<Text>>();
  private readonly elementAttrs = new WeakMap<Element, AttributeKeyRecord[]>();
  private observer: MutationObserver | null = null;
  private root: HTMLElement | null = null;

  start(root: HTMLElement): void {
    if (this.observer && this.root === root) return;
    this.stop();
    this.root = root;
    this.scanSubtree(root);
    this.observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'characterData') {
          if (record.target instanceof Text) this.processTextNode(record.target);
        } else if (record.type === 'attributes') {
          if (record.target instanceof Element && record.attributeName) {
            this.processAttribute(record.target, record.attributeName);
          }
        } else if (record.type === 'childList') {
          for (const added of record.addedNodes) {
            this.scanSubtree(added);
          }
        }
      }
    });
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

  private scanSubtree(node: Node): void {
    if (isInsideEditorUi(node)) return;
    if (node instanceof Text) {
      this.processTextNode(node);
      return;
    }
    if (!(node instanceof Element)) return;
    if (isRestrictedElement(node)) return;

    this.processElementAttributes(node);

    // FILTER_REJECT skips a subtree cleanly without terminating traversal of
    // following siblings/ancestors (unlike calling walker.nextSibling() manually).
    const walker = node.ownerDocument.createTreeWalker(
      node,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(candidate) {
          if (candidate instanceof Element) {
            if (candidate.hasAttribute(COPY_EDITOR_ROOT_ATTR) || isRestrictedElement(candidate)) {
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
    if (isInsideEditorUi(textNode)) return;
    const parent = textNode.parentElement;
    if (isRestrictedElement(parent)) return;
    const raw = textNode.data;
    if (!mayContainKeyMarkers(raw)) return;

    const extracted = extractKeySegments(raw);
    if (!extracted.hadMarkers) return;

    // Strip the invisible markers immediately so selection, copy, and layout
    // see plain text while the registry retains the exact segment offsets.
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
      if (element.hasAttribute(attr)) {
        this.processAttribute(element, attr);
      }
    }
    // Inputs and textareas can also receive marked text via their DOM property
    // when controlled in React without setting the HTML `value` attribute.
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.type !== 'password' && mayContainKeyMarkers(element.value)) {
        const extracted = extractKeySegments(element.value);
        if (extracted.hadMarkers) {
          element.value = extracted.text;
          this.recordAttributeKeys(element, 'value', extracted.segments);
        }
      }
    }
  }

  private processAttribute(element: Element, attr: string): void {
    if (isInsideEditorUi(element) || isRestrictedElement(element)) return;
    const raw = element.getAttribute(attr);
    if (raw === null || !mayContainKeyMarkers(raw)) return;

    const extracted = extractKeySegments(raw);
    if (!extracted.hadMarkers) return;

    element.setAttribute(attr, extracted.text);
    this.recordAttributeKeys(element, attr, extracted.segments);
  }

  private recordAttributeKeys(element: Element, attribute: string, segments: TextKeySegment[]): void {
    const existing = this.elementAttrs.get(element) ?? [];
    const filtered = existing.filter(entry => entry.attribute !== attribute);
    for (const seg of segments) {
      filtered.push({ attribute, key: seg.key });
    }
    this.elementAttrs.set(element, filtered);
  }

  private collectTextCandidates(element: Element): KeyCandidate[] {
    const out: KeyCandidate[] = [];
    const textNodes = this.elementTexts.get(element);
    if (textNodes) {
      for (const textNode of textNodes) {
        if (!textNode.isConnected) {
          textNodes.delete(textNode);
          continue;
        }
        const segments = this.textSegments.get(textNode);
        if (!segments) continue;
        for (const seg of segments) {
          out.push({ key: seg.key, source: 'text' });
        }
      }
    }
    return out;
  }

  private collectAttributeCandidates(element: Element): KeyCandidate[] {
    const attrs = this.elementAttrs.get(element);
    if (!attrs) return [];
    return attrs.map(entry => ({
      key: entry.key,
      source: 'attribute',
      attribute: entry.attribute,
    }));
  }

  /**
   * Collects all tracked keys within a compact interactive or text-bearing
   * element so a sentence composed of several locale strings (or a <Trans>
   * spanning inline tags) exposes every contributing key together.
   */
  private collectSubtreeCandidates(element: Element): KeyCandidate[] {
    const collected: KeyCandidate[] = [
      ...this.collectTextCandidates(element),
      ...this.collectAttributeCandidates(element),
    ];
    const walker = element.ownerDocument.createTreeWalker(
      element,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(candidate) {
          return candidate instanceof Element && candidate.hasAttribute(COPY_EDITOR_ROOT_ATTR)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    let child = walker.nextNode() as Element | null;
    let visited = 0;
    while (child && visited < 40) {
      collected.push(...this.collectTextCandidates(child), ...this.collectAttributeCandidates(child));
      visited += 1;
      child = walker.nextNode() as Element | null;
    }
    return dedupeCandidates(collected);
  }

  resolveAtPoint(doc: Document, clientX: number, clientY: number): HitTarget | null {
    // 1. Exact character-level hit test for multi-key text nodes.
    const caret = caretAtPoint(doc, clientX, clientY);
    if (caret && caret.node instanceof Text && !isInsideEditorUi(caret.node)) {
      const segments = this.textSegments.get(caret.node);
      const parent = caret.node.parentElement;
      if (segments && segments.length > 0 && parent) {
        const hitSegment = segments.find(seg => caret.offset >= seg.start && caret.offset <= seg.end) ?? segments[0]!;
        const segRect = rectFromTextSegment(caret.node, hitSegment.start, hitSegment.end);
        if (segRect && pointInsideRect(segRect, clientX, clientY, 8)) {
          // Include siblings in the same inline sentence/element so the user
          // can edit either the exact segment clicked or any adjacent key.
          const container = parent.closest('p, li, td, th, button, a, label, h1, h2, h3, h4, h5, h6, [role="tooltip"], [role="menuitem"], [role="option"]') ?? parent;
          const allCandidates = dedupeCandidates([
            { key: hitSegment.key, source: 'text' },
            ...segments.map(seg => ({ key: seg.key, source: 'text' as const })),
            ...this.collectSubtreeCandidates(container),
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

    // 2. Fallback to elementsFromPoint: catches icon buttons (aria-label),
    // inputs (placeholder), tooltips, and elements whose text sits inside a
    // child span.
    const stack = typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(clientX, clientY) : [];
    for (const element of stack) {
      if (isInsideEditorUi(element)) return null;
      const direct = dedupeCandidates([
        ...this.collectTextCandidates(element),
        ...this.collectAttributeCandidates(element),
      ]);
      if (direct.length > 0) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          return {
            element,
            rect,
            primaryKey: direct[0]!.key,
            candidates: direct,
          };
        }
      }

      // Check compact interactive elements whose tracked text lives in a child
      // (for example, a Button wrapping a Text or Icon+Label).
      if (
        element.matches('button, a, label, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="tooltip"]')
      ) {
        const subtree = this.collectSubtreeCandidates(element);
        if (subtree.length > 0) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            return {
              element,
              rect,
              primaryKey: subtree[0]!.key,
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
export const sharedCopyEditorRegistry = new CopyEditorDomRegistry();
