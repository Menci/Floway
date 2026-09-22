import { ReOrderDotsVerticalRegular } from '@fluentui/react-icons';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

import { fluentComponents } from '../../fluent';
import { REPOSITION_ANIMATION_MS, REPOSITION_EASING } from '../../winui/motion';

const { Button, makeStyles, mergeClasses } = fluentComponents;

// ListView reorders by drag when CanReorderItems is set. The item under the
// pointer states that it is in flight by opacity alone, and the items it
// displaces are re-arranged into their new slots live, which their
// ReorderThemeTransition carries -- a reposition, which is the duration and
// spline ../../winui/motion.ts already transcribes.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L8
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L496-L500
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ListViewBase_Partial_Reorder.cpp#L2254-L2282
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L9298-L9306
const REORDER_OPACITY = 0.8;

// A ListViewItem does not jump out of its drag state: the whole DragStates
// group carries one transition back to NotDragging, so the opacity the pick-up
// took returns over this while the item is still travelling to its slot.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L530-L533
const DRAG_RETURN_MS = 200;

// The gesture addresses the list through the DOM rather than through a ref the
// caller threads down: a handle sits inside the item it moves, the item inside
// the list, and both facts are already load-bearing. The item carries its own
// index as the attribute's value, so an item the caller withheld -- the rows an
// access list leaves unordered -- is absent from the measurement instead of
// shifting every index after it.
const LIST_ATTRIBUTE = 'data-reorder-list';
const ITEM_ATTRIBUTE = 'data-reorder-item';
const REORDERING_ATTRIBUTE = 'data-reordering';
// Where an item sits to the eye while a gesture is moving rows, for the
// separators that are drawn from a list's ends. Those rules read the document,
// and under a gesture the document is no longer the order on screen.
const EDGE_ATTRIBUTE = 'data-reorder-edge';
// Marks the grips so one can find its neighbours: the arrows travel between
// them, which is what leaves the reorder to a modified chord.
const HANDLE_ATTRIBUTE = 'data-reorder-handle';

// The travel of the item under the pointer, written to the list rather than
// held in state: it changes at pointer rate, and a render per move would put
// the whole list through React to move one row. The row reads it by inheritance.
const DRAG_Y = '--floway-reorder-drag-y';

// Constant, so React has nothing to rewrite on the row that is moving.
const TRACKING_TRANSFORM: CSSProperties = { transform: `translateY(var(${DRAG_Y}, 0px))` };

const useStyles = makeStyles({
  // A drag that starts on the handle travels over the rows, and without this
  // the browser reads that travel as a text selection across them.
  list: { [`&[${REORDERING_ATTRIBUTE}]`]: { userSelect: 'none' } },
  // Carried by a row only while it is travelling to a slot. Off the gesture the
  // rows are already where the committed order puts them, so a transition left
  // on would animate them away from it and back.
  travelling: {
    transitionProperty: 'transform',
    transitionDuration: `${REPOSITION_ANIMATION_MS}ms`,
    transitionTimingFunction: REPOSITION_EASING,
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: 'var(--winui-reduced-motion-duration)' },
  },
  // Above the rows it passes over, which a transform alone does not settle:
  // painting order would otherwise follow the document.
  lifted: { position: 'relative', zIndex: 1 },
  grabbed: { opacity: REORDER_OPACITY },
  // The row leaves the pointer: it travels the rest of the way to its slot
  // while the drag opacity returns, on the two durations their owners state.
  settling: {
    transitionProperty: 'transform, opacity',
    transitionDuration: `${REPOSITION_ANIMATION_MS}ms, ${DRAG_RETURN_MS}ms`,
    transitionTimingFunction: `${REPOSITION_EASING}, linear`,
    '@media (prefers-reduced-motion: reduce)': {
      transitionDuration: 'var(--winui-reduced-motion-duration)',
    },
  },
  // Without the touch action the browser claims a vertical drag for panning and
  // cancels the pointer, so the grip would move nothing under a finger.
  handle: { cursor: 'grab', touchAction: 'none', '&:active': { cursor: 'grabbing' } },
});

/** One item's box in the layout a gesture started in, and the index it stands for. */
interface ItemBox {
  index: number;
  /** Relative to the list, so the page may scroll under a gesture in flight. */
  top: number;
  height: number;
}

interface Gesture {
  pointerId: number;
  list: HTMLElement;
  /** Where the pointer was when the item was picked up. */
  originY: number;
  from: number;
  items: ItemBox[];
}

/** What the list is rendering: the move being previewed, or settled into. */
interface Preview {
  from: number;
  to: number;
  items: readonly ItemBox[];
  /** The pointer is up and the item is travelling the rest of the way to its slot. */
  settling: boolean;
}

type DropOutcome = { ok: true } | { ok: false; error: unknown };

/** The move every caller commits and the preview reads, stated once. */
export const moveItem = <Item, >(items: readonly Item[], from: number, to: number): Item[] => {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};

// XAML's insertion rule: the container under the point takes the drag, and a
// point at or past that container's midpoint inserts after it rather than
// before. Applied to the boxes the gesture measured when it started, where XAML
// re-measures containers it has already shifted and needs a hysteresis term to
// keep them from oscillating under a still pointer. A frozen layout cannot
// oscillate, so that term has nothing to do here.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/moco/lib/StackingLayoutStrategyImpl.cpp#L356-L364
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/livereorderhelper/lib/LiveReorderHelper.cpp#L79-L102
const insertionPosition = (items: readonly ItemBox[], y: number): number => {
  for (const [position, item] of items.entries()) {
    if (y < item.top) return position;
    if (y < item.top + item.height) return y - item.top >= item.height / 2 ? position + 1 : position;
  }
  return items.length;
};

const positionOf = (items: readonly ItemBox[], index: number) => items.findIndex(item => item.index === index);

// An insertion point sits between items and an index names one, so the two
// differ by one for every insertion past the item being moved -- removing it
// closes its own place up.
const indexUnderPointer = (items: readonly ItemBox[], from: number, y: number): number => {
  const insertion = insertionPosition(items, y);
  return items[insertion > positionOf(items, from) ? insertion - 1 : insertion].index;
};

/**
 * How far each item has to travel for the move to read as done, laid out from
 * the boxes the gesture measured. Stacking the heights rather than shifting
 * every displaced item by the moved item's own height is what keeps a list of
 * unequal rows -- an expanded alias target beside a collapsed one -- landing on
 * its slots rather than near them.
 */
const slotOffsets = (items: readonly ItemBox[], from: number, to: number): Map<number, number> => {
  const reordered = moveItem(items, positionOf(items, from), positionOf(items, to));
  // These lists space their items evenly or not at all, so one reading stands
  // for every gap; a list that spaced them apart would need one per slot.
  const gap = items.length > 1 ? items[1].top - (items[0].top + items[0].height) : 0;
  const offsets = new Map<number, number>();
  let cursor = items[0].top;
  for (const item of reordered) {
    offsets.set(item.index, cursor - item.top);
    cursor += item.height + gap;
  }
  return offsets;
};

const measure = (handle: HTMLElement, from: number, pointerId: number, originY: number): Gesture => {
  const list = handle.closest<HTMLElement>(`[${LIST_ATTRIBUTE}]`);
  // Both halves are rendered by the same call site from the same hook, so
  // neither absence is a list that cannot be dragged: it is the contract having
  // come apart, which a quiet return would leave as a handle that does nothing.
  if (!list) throw new Error('A reorder handle was rendered outside the list its gesture reorders.');
  const listTop = list.getBoundingClientRect().top;
  const items = [...list.querySelectorAll<HTMLElement>(`[${ITEM_ATTRIBUTE}]`)]
    // A list nested in another list's item would otherwise contribute its own
    // items to the outer measurement.
    .filter(element => element.closest(`[${LIST_ATTRIBUTE}]`) === list)
    .map(element => {
      const box = element.getBoundingClientRect();
      return { index: Number(element.getAttribute(ITEM_ATTRIBUTE)), top: box.top - listTop, height: box.height };
    });
  if (positionOf(items, from) === -1) {
    throw new Error(`A reorder handle for index ${from} found no item carrying that index.`);
  }
  return { from, items, list, originY, pointerId };
};

// Clamped where it is painted rather than where it is accumulated, so a drag
// that overshoots an end and comes back picks the row up from the pointer
// instead of from wherever the clamp had parked it -- the rule the Switch drag
// follows.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ToggleSwitch_Partial.cpp#L452-L458
const paint = (gesture: Gesture, travel: number) => {
  const items = gesture.items;
  const grabbed = items[positionOf(items, gesture.from)];
  const last = items[items.length - 1];
  const lowest = items[0].top - grabbed.top;
  const highest = last.top + last.height - (grabbed.top + grabbed.height);
  gesture.list.style.setProperty(DRAG_Y, `${Math.min(Math.max(travel, lowest), highest)}px`);
};

export interface ReorderHandleProps {
  [HANDLE_ATTRIBUTE]: string;
  disabled: boolean;
  disabledFocusable: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}

// XAML's reorder chord: Alt and Shift, and explicitly not Control.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ListViewBaseItem_Partial.cpp#L2100-L2104
const REORDER_CHORD = 'Alt+Shift';
const isReorderChord = (event: ReactKeyboardEvent) => event.altKey && event.shiftKey && !event.ctrlKey;

// The grips of one list, in the order they are drawn, skipping those that have
// left the tab order. A grip the list has made unavailable but kept focusable
// stays reachable, so an operator mid-write is not stranded on it.
const siblingHandles = (handle: HTMLElement): HTMLElement[] => {
  const list = handle.closest<HTMLElement>(`[${LIST_ATTRIBUTE}]`);
  if (!list) throw new Error('A reorder handle was rendered outside the list its gesture reorders.');
  return [...list.querySelectorAll<HTMLElement>(`[${HANDLE_ATTRIBUTE}]`)]
    .filter(element => element.closest(`[${LIST_ATTRIBUTE}]`) === list && !element.hasAttribute('disabled'));
};

/**
 * Drag-to-position reordering for a list the caller renders.
 *
 * The caller spreads `listProps` on the element that holds the items,
 * `itemProps` on each item and `handleProps` on the grip, and keeps rendering
 * in its own order throughout. A gesture moves the rows with transforms,
 * starts `onDrop` at release when the caller has a write to perform, and keeps
 * the preview in place until both that write and the settle animation finish.
 * `onReorder` then commits the rendered order without another visible move.
 * `position` gives an item's previewed rank, for a list that shows one.
 */
export function useReorderList({ busy = false, disabled = false, length, onDrop, onDropError, onReorder }: {
  /**
   * The list's own write is in flight. The grip reads as unavailable but keeps
   * focus, so a keyboard move does not throw the operator back to the document
   * between steps -- the same line `TooltipIconButton` draws.
   */
  busy?: boolean;
  disabled?: boolean;
  length: number;
  /** Starts an asynchronous write as soon as the pointer is released. */
  onDrop?: (from: number, to: number) => Promise<void>;
  /** Runs after the visual preview has rolled back from a rejected write. */
  onDropError?: (error: unknown, from: number, to: number) => void | Promise<void>;
  onReorder: (from: number, to: number) => void;
}) {
  const styles = useStyles();
  const gestureRef = useRef<Gesture | null>(null);
  const settleRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  // A handle is dead while the list is locked, and a list of one has nowhere to
  // move its item to.
  const locked = busy || disabled || length < 2;
  // The list can be replaced under a gesture -- these pages poll -- and an index
  // the new list does not have would move the wrong row.
  const live = preview !== null && preview.from < length && preview.to < length ? preview : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(settleRef.current);
    };
  }, []);

  const offsets = useMemo(() => live && slotOffsets(live.items, live.from, live.to), [live]);
  const ranks = useMemo(
    () => live && moveItem(Array.from({ length }, (_, index) => index), live.from, live.to),
    [length, live],
  );

  const end = () => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    gesture?.list.removeAttribute(REORDERING_ATTRIBUTE);
    gesture?.list.style.removeProperty(DRAG_Y);
    setPreview(null);
  };

  // Escape has to be heard wherever focus is and a lost window has to be heard
  // at all, so the whole gesture is read from one owner rather than split
  // between the grip and the document.
  const dragging = live !== null && !live.settling;
  useEffect(() => {
    if (!dragging) return;
    // Read against the list rather than against the viewport, so a page that
    // scrolls mid-gesture moves the boxes and the pointer together.
    const indexAt = (gesture: Gesture, event: PointerEvent) =>
      indexUnderPointer(gesture.items, gesture.from, event.clientY - gesture.list.getBoundingClientRect().top);

    const onMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      paint(gesture, event.clientY - gesture.originY);
      const to = indexAt(gesture, event);
      setPreview(current => current?.to === to ? current : { from: gesture.from, items: gesture.items, settling: false, to });
    };

    const onUp = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const to = indexAt(gesture, event);
      // The row leaves the pointer and travels the rest of the way to its slot.
      // Dropping the drag attribute and writing the destination in one style
      // recalculation is what makes that a transition rather than a jump: the
      // row takes the duration the class it gains in the same commit declares.
      gesture.list.removeAttribute(REORDERING_ATTRIBUTE);
      gesture.list.style.setProperty(DRAG_Y, `${slotOffsets(gesture.items, gesture.from, to).get(gesture.from) ?? 0}px`);
      setPreview({ from: gesture.from, items: gesture.items, settling: true, to });
      clearTimeout(settleRef.current);
      if (to === gesture.from || onDrop === undefined) {
        settleRef.current = setTimeout(() => {
          if (to !== gesture.from) onReorder(gesture.from, to);
          end();
        }, REPOSITION_ANIMATION_MS);
        return;
      }

      let write: Promise<void>;
      try {
        write = onDrop(gesture.from, to);
      } catch (error) {
        write = Promise.reject(error);
      }
      const outcome = write.then<DropOutcome, DropOutcome>(
        () => ({ ok: true }),
        error => ({ ok: false, error }),
      );
      settleRef.current = setTimeout(() => {
        void outcome.then(async result => {
          if (!mountedRef.current) return;
          if (!result.ok) {
            end();
            await onDropError?.(result.error, gesture.from, to);
            return;
          }
          if (to !== gesture.from) onReorder(gesture.from, to);
          end();
        });
      }, REPOSITION_ANIMATION_MS);
    };

    const onCancel = (event: PointerEvent) => {
      if (event.pointerId === gestureRef.current?.pointerId) end();
    };
    // Abandoning leaves the list as it was, which is what the preview being a
    // transform rather than a committed move buys. A release outside the window
    // reports nothing at all, so losing the window abandons on the same terms.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      end();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', end);
    };
  }, [dragging, onDrop, onDropError, onReorder]);

  // An index outside the list is a caller stating that this row has no place in
  // the order -- the rows an access list leaves out of its cap -- so its grip
  // reads as the others do and does nothing.
  const handleProps = (index: number): ReorderHandleProps => {
    const inert = locked || index < 0 || index >= length;
    // A settling preview already blocks every gesture and key path. Keeping the
    // native button visually enabled avoids a one-frame disabled-colour pulse
    // when a fast write begins and ends under that preview.
    const visiblyInert = inert && live === null;
    return {
      // Everything but the list's own write in flight is the grip being made
      // unavailable from outside, which leaves the tab order.
      disabled: visiblyInert && !busy,
      disabledFocusable: visiblyInert && busy,
      [HANDLE_ATTRIBUTE]: '',
      onPointerDown: event => {
        if (inert || live || !event.isPrimary || event.button !== 0) return;
        const gesture = measure(event.currentTarget, index, event.pointerId, event.clientY);
        gestureRef.current = gesture;
        gesture.list.setAttribute(REORDERING_ATTRIBUTE, '');
        paint(gesture, 0);
        setPreview({ from: index, items: gesture.items, settling: false, to: index });
      },
    };
  };

  /** Where the item currently reads as sitting, which a gesture moves ahead of the commit. */
  const position = (index: number) => ranks?.indexOf(index) ?? index;

  // Read at the list rather than at the grip. Fluent hands a native button none
  // of its onKeyDown once the button is disabledFocusable, which is the state a
  // list holds its grips in while its own write is in flight -- exactly when an
  // operator is most likely to be pressing a key. The event still bubbles here.
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-aria/library/src/button/useARIAButtonProps.ts#L86
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (step === 0 || live) return;
    // Only a key pressed on a grip: the rows carry comboboxes and switches of
    // their own, whose arrows are theirs.
    const handle = (event.target as Element).closest<HTMLElement>(`[${HANDLE_ATTRIBUTE}]`);
    if (!handle) return;

    // The bare arrows travel between the grips, as they travel between the
    // items of a ListView, and the reorder is the chord that leaves them to it.
    // Travel is not gated on the list being writable: an operator whose last
    // move is still in flight keeps their bearings.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ListViewBaseItem_Partial.cpp#L2096-L2131
    if (!isReorderChord(event)) {
      if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
      const handles = siblingHandles(handle);
      const next = handles[handles.indexOf(handle) + step];
      if (!next) return;
      event.preventDefault();
      next.focus();
      return;
    }

    const index = Number(handle.closest(`[${ITEM_ATTRIBUTE}]`)?.getAttribute(ITEM_ATTRIBUTE) ?? -1);
    const to = index + step;
    if (locked || index < 0 || index >= length || to < 0 || to >= length) return;
    event.preventDefault();
    onReorder(index, to);
  };

  return {
    handleProps,
    itemProps: (index: number, className?: string) => {
      const grabbed = live?.from === index;
      const rank = live ? position(index) : index;
      return {
        [ITEM_ATTRIBUTE]: String(index),
        [EDGE_ATTRIBUTE]: !live ? undefined : rank === 0 ? 'first' : rank === length - 1 ? 'last' : undefined,
        className: mergeClasses(
          grabbed && styles.lifted,
          // The row under the pointer is not travelling toward anything -- it is
          // where the pointer put it -- so it wears the drag opacity flat, and
          // only the settle that follows the drop animates it away again.
          grabbed && (live.settling ? styles.settling : styles.grabbed),
          !!live && !grabbed && styles.travelling,
          className,
        ),
        style: !live ? undefined : grabbed ? TRACKING_TRANSFORM : { transform: `translateY(${offsets?.get(index) ?? 0}px)` },
      };
    },
    listProps: (className?: string) => ({ [LIST_ATTRIBUTE]: '', className: mergeClasses(styles.list, className), onKeyDown }),
    position,
  };
}

export type ReorderList = ReturnType<typeof useReorderList>;

export function ReorderHandle({ label, ...gesture }: ReorderHandleProps & { label: string }) {
  const styles = useStyles();
  return <Button
    appearance="subtle"
    // The grip is the only affordance left, so the chord that does the same
    // job has to announce itself from it.
    aria-keyshortcuts={`${REORDER_CHORD}+ArrowUp ${REORDER_CHORD}+ArrowDown`}
    aria-label={label}
    className={styles.handle}
    icon={<ReOrderDotsVerticalRegular />}
    size="small"
    {...gesture}
  />;
}
