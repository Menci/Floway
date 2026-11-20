import { extractKeySegments, mayContainKeyMarkers, type TextKeySegment } from './markers';

export const UI_TEXT_EDITOR_ROOT_ATTR = 'data-floway-ui-text-editor-root';

const VISIBLE_ATTRIBUTES = ['value', 'placeholder', 'alt'] as const;
const MONITORED_ATTRIBUTES = [...VISIBLE_ATTRIBUTES, 'aria-label'] as const;

interface AttributeKeyRecord {
  attribute: string;
  key: string;
}

export interface HitTarget {
  element: Element;
  rect: DOMRect;
  rects: DOMRect[];
  primaryKey: string;
  primaryAttribute?: string;
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

const isNonZeroRect = (rect: DOMRect): boolean => rect.width > 0 || rect.height > 0;

const unionRects = (rects: DOMRect[]): DOMRect | null => {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    if (r.left < left) left = r.left;
    if (r.top < top) top = r.top;
    if (r.right > right) right = r.right;
    if (r.bottom > bottom) bottom = r.bottom;
  }
  return new DOMRect(left, top, right - left, bottom - top);
};

// Merge adjacent client rects produced on the same visual line (e.g. mixed
// CJK/Latin font runs) into one clean rect per line.
const normalizeLineRects = (rawRects: DOMRect[]): DOMRect[] => {
  const sorted = rawRects.filter(isNonZeroRect).sort((a, b) => (a.top - b.top) || (a.left - b.left));
  const merged: DOMRect[] = [];
  for (const r of sorted) {
    const prev = merged[merged.length - 1];
    if (
      prev
      && Math.abs(r.top - prev.top) <= 4
      && Math.abs(r.bottom - prev.bottom) <= 4
      && r.left <= prev.right + 4
    ) {
      const left = Math.min(prev.left, r.left);
      const top = Math.min(prev.top, r.top);
      const right = Math.max(prev.right, r.right);
      const bottom = Math.max(prev.bottom, r.bottom);
      merged[merged.length - 1] = new DOMRect(left, top, right - left, bottom - top);
    } else {
      merged.push(new DOMRect(r.left, r.top, r.width, r.height));
    }
  }
  return merged;
};

interface TextSegmentMetrics {
  lineRects: DOMRect[];
  boundingRect: DOMRect;
}

const getTextSegmentMetrics = (textNode: Text, start: number, end: number): TextSegmentMetrics | null => {
  if (start >= end || end > textNode.data.length) return null;
  const range = textNode.ownerDocument.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);

  if (typeof range.getClientRects === 'function') {
    const lineRects = normalizeLineRects(Array.from(range.getClientRects()));
    if (lineRects.length > 0) {
      const boundingRect = unionRects(lineRects);
      if (boundingRect && isNonZeroRect(boundingRect)) {
        return { lineRects, boundingRect };
      }
    }
  }

  const rect = range.getBoundingClientRect();
  return isNonZeroRect(rect) ? { lineRects: [rect], boundingRect: rect } : null;
};

// Hit-test against each wrapped line's own rect without falling back to the
// outer bounding box, and return the full segment metrics so every line of a
// multi-line key highlights consistently regardless of which line is hovered.
const matchTextSegmentAtPoint = (
  textNode: Text,
  start: number,
  end: number,
  clientX: number,
  clientY: number,
): TextSegmentMetrics | null => {
  const metrics = getTextSegmentMetrics(textNode, start, end);
  if (!metrics) return null;
  return metrics.lineRects.some(lineRect => pointInsideRect(lineRect, clientX, clientY, 3))
    ? metrics
    : null;
};

const INTERACTIVE_CONTAINER_SELECTOR = 'button, a, label, [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="tooltip"]';

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
    const isFormValueHost = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
    for (const attr of MONITORED_ATTRIBUTES) {
      if (attr === 'value' && isFormValueHost) continue;
      if (element.hasAttribute(attr) || this.strippedAttrValues.get(element)?.has(attr)) {
        this.processAttribute(element, attr);
      }
    }
    // Inputs and textareas carry controlled text on their DOM `value` property
    // without necessarily mirroring it onto the HTML `value` attribute.
    if (isFormValueHost) {
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

  private findTextSegmentHitInElement(
    element: Element,
    clientX: number,
    clientY: number,
  ): { key: string; rect: DOMRect; rects: DOMRect[]; allKeys: string[] } | null {
    const textNodes = this.elementTexts.get(element);
    if (!textNodes) return null;
    const allKeys: string[] = [];
    let matched: { key: string; rect: DOMRect; rects: DOMRect[] } | null = null;
    for (const textNode of textNodes) {
      if (!textNode.isConnected || textNode.parentElement !== element) {
        textNodes.delete(textNode);
        continue;
      }
      const segments = this.textSegments.get(textNode);
      if (!segments) continue;
      for (const seg of segments) {
        allKeys.push(seg.key);
        if (!matched) {
          const metrics = matchTextSegmentAtPoint(textNode, seg.start, seg.end, clientX, clientY);
          if (metrics) matched = { key: seg.key, rect: metrics.boundingRect, rects: metrics.lineRects };
        }
      }
    }
    return matched ? { ...matched, allKeys } : null;
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

  private collectVisibleAttributeKeys(element: Element): string[] {
    const attrs = this.elementAttrs.get(element);
    if (!attrs) return [];
    const out: string[] = [];
    for (const attr of VISIBLE_ATTRIBUTES) {
      for (const entry of attrs) {
        if (entry.attribute === attr) out.push(entry.key);
      }
    }
    return out;
  }

  private collectAriaLabelKeys(element: Element): string[] {
    const attrs = this.elementAttrs.get(element);
    if (!attrs) return [];
    return attrs.filter(entry => entry.attribute === 'aria-label').map(entry => entry.key);
  }

  private collectAttributeKeys(element: Element): string[] {
    return [
      ...this.collectVisibleAttributeKeys(element),
      ...this.collectAriaLabelKeys(element),
    ];
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

  // When hovering an interactive container's padding or icon area, resolve to
  // the inner text/visible-attribute source if the container maps to one
  // unique key so the highlight box stays identical across text and background.
  // Containers with multiple distinct keys do not claim empty background space.
  private resolveUniqueSubtreeVisibleTarget(container: Element): HitTarget | null {
    const visibleKeys = new Set<string>();
    let target: { element: Element; metrics: TextSegmentMetrics | null } | null = null;
    const walker = container.ownerDocument.createTreeWalker(
      container,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(candidate) {
          return candidate instanceof Element && candidate.hasAttribute(UI_TEXT_EDITOR_ROOT_ATTR)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      },
    );

    let el: Element | null = container;
    while (el) {
      const textNodes = this.elementTexts.get(el);
      if (textNodes) {
        for (const textNode of textNodes) {
          if (!textNode.isConnected || textNode.parentElement !== el) {
            textNodes.delete(textNode);
            continue;
          }
          const segments = this.textSegments.get(textNode);
          if (!segments) continue;
          for (const seg of segments) {
            visibleKeys.add(seg.key);
            if (visibleKeys.size > 1) return null;
            target ??= { element: el, metrics: getTextSegmentMetrics(textNode, seg.start, seg.end) };
          }
        }
      }
      for (const key of this.collectVisibleAttributeKeys(el)) {
        visibleKeys.add(key);
        if (visibleKeys.size > 1) return null;
        if (!target) {
          const rect = el.getBoundingClientRect();
          target = {
            element: el,
            metrics: isNonZeroRect(rect) ? { lineRects: [rect], boundingRect: rect } : null,
          };
        }
      }
      el = walker.nextNode() as Element | null;
    }

    if (visibleKeys.size !== 1 || !target) return null;
    const primaryKey = [...visibleKeys][0]!;
    const fallbackRect = target.element.getBoundingClientRect();
    const rect = target.metrics?.boundingRect ?? (isNonZeroRect(fallbackRect) ? fallbackRect : null);
    if (!rect) return null;
    const rects = target.metrics?.lineRects ?? [rect];
    const candidates = dedupeKeys([primaryKey, ...this.collectSubtreeKeys(container)]);
    return { element: target.element, rect, rects, primaryKey, candidates };
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
          const metrics = matchTextSegmentAtPoint(
            caret.node,
            hitSegment.start,
            hitSegment.end,
            clientX,
            clientY,
          );
          if (metrics) {
            const container = parent.closest('p, li, td, th, button, a, label, h1, h2, h3, h4, h5, h6, [role="tooltip"], [role="menuitem"], [role="option"]') ?? parent;
            const allCandidates = dedupeKeys([
              hitSegment.key,
              ...segments.map(seg => seg.key),
              ...this.collectSubtreeKeys(container),
            ]);
            return {
              element: parent,
              rect: metrics.boundingRect,
              rects: metrics.lineRects,
              primaryKey: hitSegment.key,
              candidates: allCandidates,
            };
          }
        }
      }
    }

    // 2. Two-pass elementsFromPoint scan: prefer elements carrying visible text
    // or visible attributes (value/placeholder/alt) first so transparent
    // full-row aria-label overlays (such as SettingsCard) do not shadow the
    // visible header/description beneath them; include aria-label as secondary
    // candidates on the matched element, and fall back to aria-label-only or
    // interactive containers in the second pass.
    const rawStack = typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(clientX, clientY) : [];
    const stack: Element[] = [];
    for (const element of rawStack) {
      if (isInsideUiTextEditor(element)) return null;
      this.processElementAttributes(element);
      stack.push(element);
    }

    for (const element of stack) {
      const textHit = this.findTextSegmentHitInElement(element, clientX, clientY);
      if (textHit) {
        const candidates = dedupeKeys([
          textHit.key,
          ...textHit.allKeys,
          ...this.collectVisibleAttributeKeys(element),
          ...this.collectAriaLabelKeys(element),
        ]);
        return {
          element,
          rect: textHit.rect,
          rects: textHit.rects,
          primaryKey: textHit.key,
          candidates,
        };
      }

      const visibleAttrs = dedupeKeys(this.collectVisibleAttributeKeys(element));
      if (visibleAttrs.length > 0) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          const candidates = dedupeKeys([
            ...visibleAttrs,
            ...this.collectTextKeys(element),
            ...this.collectAriaLabelKeys(element),
          ]);
          return {
            element,
            rect,
            rects: [rect],
            primaryKey: candidates[0]!,
            candidates,
          };
        }
      }
    }

    // Fallback for environments without Range layout metrics (e.g. Happy DOM)
    // or elements whose direct text node has zero-sized range rects: match the
    // element box directly when it carries tracked text.
    for (const element of stack) {
      const textKeys = dedupeKeys(this.collectTextKeys(element));
      if (textKeys.length > 0) {
        const textNodes = this.elementTexts.get(element);
        let hasNonZeroTextRect = false;
        if (textNodes) {
          for (const textNode of textNodes) {
            const segments = this.textSegments.get(textNode);
            if (!segments) continue;
            for (const seg of segments) {
              if (getTextSegmentMetrics(textNode, seg.start, seg.end)) {
                hasNonZeroTextRect = true;
                break;
              }
            }
            if (hasNonZeroTextRect) break;
          }
        }
        // When real text rects exist but the pointer missed them (for instance,
        // hovering empty space to the right of a block-level label), let the
        // next pass resolve an enclosing overlay/button instead.
        if (hasNonZeroTextRect) continue;

        const rect = element.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          const candidates = dedupeKeys([
            ...textKeys,
            ...this.collectVisibleAttributeKeys(element),
            ...this.collectAriaLabelKeys(element),
          ]);
          return {
            element,
            rect,
            rects: [rect],
            primaryKey: candidates[0]!,
            candidates,
          };
        }
      }
    }

    for (const element of stack) {
      if (element.matches(INTERACTIVE_CONTAINER_SELECTOR)) {
        const uniqueTarget = this.resolveUniqueSubtreeVisibleTarget(element);
        if (uniqueTarget) {
          return uniqueTarget;
        }
      }

      const aria = dedupeKeys(this.collectAriaLabelKeys(element));
      if (aria.length > 0) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          return {
            element,
            rect,
            rects: [rect],
            primaryKey: aria[0]!,
            primaryAttribute: 'aria-label',
            candidates: aria,
          };
        }
      }
    }

    return null;
  }
}

// Single shared registry instance so React StrictMode double-mounts never drop
// previously stripped TextNode mappings.
export const sharedUiTextEditorRegistry = new UiTextEditorDomRegistry();
