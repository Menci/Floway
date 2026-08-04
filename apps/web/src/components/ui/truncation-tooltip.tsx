import { useCallback, useEffect, useRef, useState, type ReactElement, type RefCallback } from 'react';

import { fluentComponents } from '../../fluent';

const { Tooltip } = fluentComponents;

// `scrollWidth` and `clientWidth` are integers, so a box whose layout lands on
// a fraction can report scrollable overflow while every glyph is painted.
// Measured in Chromium over ~1800 fractional widths of a flex child and of a
// fixed-layout table cell: text that fits reports 0, and a box short of its
// text by under 2px reports 0, 1 or 2. So this pixel is the margin kept for
// engines whose rounding was not measured, and it forgives nothing wider than
// a box one pixel short of its own text.
// https://drafts.csswg.org/cssom-view/#dom-element-scrollwidth
const OVERFLOW_TOLERANCE_PX = 1;

const collapseWhitespace = (text: string) => text.replace(/\s+/gu, ' ').trim();

// Whether the element leaves any of `content` unread: either the box clips it,
// or what it renders is an elision of it. Both are answered from the element,
// so a caller cannot get the two out of step.
const hidesContent = (node: HTMLElement, content: string) =>
  node.scrollWidth - node.clientWidth > OVERFLOW_TOLERANCE_PX
  || collapseWhitespace(node.textContent ?? '') !== collapseWhitespace(content);

/**
 * A tooltip that restores text its trigger cannot show, and stays away when the
 * trigger shows all of it — a tooltip repeating a string already in full view
 * is noise.
 *
 * `measureRef` goes on the element that clips, which is not always the element
 * the tooltip opens on: a `Chip` clips inside its text slot, a
 * `TableCellLayout` inside its `main` slot. Measuring an ancestor that does not
 * clip reports no overflow and the tooltip never appears.
 */
export const useTruncation = (content: string, relationship: 'description' | 'label') => {
  const [truncated, setTruncated] = useState(false);
  const [visible, setVisible] = useState(false);
  const nodeRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef(content);

  const measure = useCallback(() => {
    const node = nodeRef.current;
    if (!node) return;
    const hides = hidesContent(node, contentRef.current);
    setTruncated(hides);
    // A trigger that grows while its tooltip is open now shows the string
    // itself, and the tooltip has become the repetition it exists to avoid.
    if (!hides) setVisible(false);
  }, []);

  // A resize is the element's own; a text swap that keeps the box changes no
  // size at all, and a webfont arriving after first paint re-measures every
  // glyph. None of the three is observable through the other two.
  const measureRef = useCallback<RefCallback<HTMLElement>>(node => {
    nodeRef.current = node;
    if (!node) return;
    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(node);
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(node, { characterData: true, childList: true, subtree: true });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      nodeRef.current = null;
    };
  }, [measure]);

  useEffect(() => {
    contentRef.current = content;
    measure();
  }, [content, measure]);

  useEffect(() => {
    let mounted = true;
    void document.fonts.ready.then(() => {
      if (mounted) measure();
    });
    return () => {
      mounted = false;
    };
  }, [measure]);

  // Fluent owns the delays and the pointer and focus handling; what it asks for
  // is answered here, so a request to open on a trigger that hides nothing
  // resolves to closed. Deciding at the request keeps `visible` equal to what
  // Fluent last reported, which is what makes it report the next change.
  return {
    measureRef,
    tooltipProps: {
      content,
      relationship,
      visible,
      onVisibleChange: (_: unknown, data: { visible: boolean }) => setVisible(data.visible && truncated),
    },
  };
};

export function TruncationTooltip({ children, content, relationship }: {
  children: (measureRef: RefCallback<HTMLElement>) => ReactElement;
  content: string;
  relationship: 'description' | 'label';
}) {
  const { measureRef, tooltipProps } = useTruncation(content, relationship);
  return <Tooltip {...tooltipProps}>{children(measureRef)}</Tooltip>;
}
