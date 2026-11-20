export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  left: number;
  top: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface HighlightContour {
  minX: number;
  minY: number;
  width: number;
  height: number;
  boxes: Box[];
  outerBridges: Box[];
  innerBridges: Box[];
}

export const HIGHLIGHT_PAD = 2;
export const HIGHLIGHT_BORDER = 1.5;
export const HIGHLIGHT_RADIUS = 4;
export const HIGHLIGHT_INNER_RADIUS = Math.max(0, HIGHLIGHT_RADIUS - HIGHLIGHT_BORDER);
const HIGHLIGHT_MAX_LINE_GAP = 8;

export const getViewportSize = (doc: Document = document, win: Window = window): Size => ({
  width: doc.documentElement.clientWidth || win.innerWidth,
  height: doc.documentElement.clientHeight || win.innerHeight,
});

export const clampPositionToViewport = (
  left: number,
  top: number,
  width: number,
  height: number,
  margin = 12,
  viewport: Size = getViewportSize(),
): Point => {
  const maxLeft = Math.max(margin, viewport.width - width - margin);
  const maxTop = Math.max(margin, viewport.height - height - margin);
  return {
    left: Math.round(Math.max(margin, Math.min(left, maxLeft))),
    top: Math.round(Math.max(margin, Math.min(top, maxTop))),
  };
};

export const computeAnchoredSurfacePosition = (
  anchorRect: DOMRect | null,
  width: number,
  height: number,
  margin = 12,
  gap = 8,
  viewport: Size = getViewportSize(),
): Point => {
  if (!anchorRect) {
    return clampPositionToViewport((viewport.width - width) / 2, (viewport.height - height) / 2, width, height, margin, viewport);
  }
  const preferredBelow = anchorRect.bottom + gap;
  const top = preferredBelow + height <= viewport.height - margin
    ? preferredBelow
    : anchorRect.top - height - gap >= margin
      ? anchorRect.top - height - gap
      : viewport.height - height - margin;
  return clampPositionToViewport(anchorRect.left, top, width, height, margin, viewport);
};

export const computeHighlightTagPosition = (
  rect: DOMRect,
  pointerX: number,
  pointerY: number,
  measuredSize: Size | null,
  viewport: Size = getViewportSize(),
): Point => {
  const margin = 8;
  const gap = 6;
  const tagWidth = measuredSize?.width ?? Math.min(440, Math.max(0, viewport.width - margin * 2));
  const tagHeight = measuredSize?.height ?? 24;
  let top: number;
  let preferredLeft = rect.left;
  if (rect.top >= tagHeight + margin) {
    top = rect.top - tagHeight - gap;
  } else if (rect.bottom + gap + tagHeight <= viewport.height - margin) {
    top = rect.bottom + gap;
  } else {
    // Full-height targets leave no room above or below the box, so anchor the
    // tag beside the pointer within the viewport.
    const abovePointer = pointerY - tagHeight - 14;
    top = abovePointer >= margin ? abovePointer : pointerY + 18;
    preferredLeft = pointerX;
  }
  return clampPositionToViewport(preferredLeft, top, tagWidth, tagHeight, margin, viewport);
};

// Builds a unified contour geometry from multiple wrapped line rects by
// bridging small vertical line-height gaps and generating outer/inner seam
// bridges so SVG masks render one seamless border with no interior dividers.
export const computeHighlightContour = (rects: DOMRect[]): HighlightContour => {
  const boxes: Box[] = rects.map(r => ({
    left: r.left - HIGHLIGHT_PAD,
    top: r.top - HIGHLIGHT_PAD,
    right: r.right + HIGHLIGHT_PAD,
    bottom: r.bottom + HIGHLIGHT_PAD,
  }));

  for (let i = 0; i < boxes.length - 1; i++) {
    const a = boxes[i]!;
    const b = boxes[i + 1]!;
    const overlapLeft = Math.max(a.left, b.left);
    const overlapRight = Math.min(a.right, b.right);
    if (overlapRight <= overlapLeft) continue;
    const gap = b.top - a.bottom;
    if (gap <= HIGHLIGHT_MAX_LINE_GAP) {
      const mid = (a.bottom + b.top) / 2;
      a.bottom = Math.max(a.bottom, mid + HIGHLIGHT_BORDER);
      b.top = Math.min(b.top, mid - HIGHLIGHT_BORDER);
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    if (box.left < minX) minX = box.left;
    if (box.top < minY) minY = box.top;
    if (box.right > maxX) maxX = box.right;
    if (box.bottom > maxY) maxY = box.bottom;
  }

  const outerBridges: Box[] = [];
  const innerBridges: Box[] = [];
  for (let i = 0; i < boxes.length - 1; i++) {
    const a = boxes[i]!;
    const b = boxes[i + 1]!;
    if (a.bottom <= b.top) continue;
    const outerLeft = Math.max(a.left, b.left);
    const outerRight = Math.min(a.right, b.right);
    if (outerRight > outerLeft) {
      const outerTop = Math.max(a.top + HIGHLIGHT_RADIUS, b.top - HIGHLIGHT_RADIUS);
      const outerBottom = Math.min(b.bottom - HIGHLIGHT_RADIUS, a.bottom + HIGHLIGHT_RADIUS);
      if (outerBottom > outerTop) {
        outerBridges.push({ left: outerLeft, top: outerTop, right: outerRight, bottom: outerBottom });
      }
    }
    const innerLeft = Math.max(a.left, b.left) + HIGHLIGHT_BORDER;
    const innerRight = Math.min(a.right, b.right) - HIGHLIGHT_BORDER;
    if (innerRight > innerLeft) {
      const innerTop = Math.max(a.top + HIGHLIGHT_BORDER, b.top - HIGHLIGHT_RADIUS);
      const innerBottom = Math.min(b.bottom - HIGHLIGHT_BORDER, a.bottom + HIGHLIGHT_RADIUS);
      if (innerBottom > innerTop) {
        innerBridges.push({ left: innerLeft, top: innerTop, right: innerRight, bottom: innerBottom });
      }
    }
  }

  return { minX, minY, width: maxX - minX, height: maxY - minY, boxes, outerBridges, innerBridges };
};
