// Drag support for the Switch, which Fluent does not have and WinUI's
// ToggleSwitch does. XAML puts a transparent Thumb over the whole control and
// listens to its DragStarted / DragDelta / DragCompleted; there is no
// manipulation and no inertia, so the whole gesture is reproducible from
// pointer events.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ToggleSwitch_Partial.cpp#L245-L250
//
// The knob follows the pointer 1:1 and is clamped only where it is written, not
// where it is accumulated, so a drag that overshoots the end and comes back
// leaves the decision reading from the unclamped total. That is why the offset
// below is kept raw and clamped at paint time.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ToggleSwitch_Partial.cpp#L452-L458
import * as React from 'react';

import { CONTROL_FASTER_ANIMATION_MS } from './motion';
import type { FluentComponents, PropCarrier } from './wrap';

type SwitchProps = React.ComponentProps<FluentComponents['Switch']>;

const DRAG_X = '--winui-switch-drag-x';
const DRAGGING = 'data-winui-switch-dragging';
const SETTLING = 'data-winui-switch-settling';

// XAML defers "was that a tap or a drag" to the OS gesture recognizer, whose
// slop is not expressed anywhere in the corpus, and the web has no equivalent:
// a click follows every pointer sequence that starts and ends on the same
// element, however far it travelled. This stands in for that recognizer -- below
// it the gesture is a tap and the click toggles, above it the click is
// suppressed so a drag that wanders out and returns leaves the switch alone.
const TAP_SLOP_PX = 4;

interface Gesture {
  pointerId: number;
  root: HTMLElement;
  input: HTMLInputElement;
  /** Accumulated raw, and clamped only when painted. */
  offset: number;
  travel: number;
  lastClientX: number;
  originClientX: number;
  excursion: number;
  /** XAML's m_wasDragged, whose threshold is literally a non-zero delta. */
  moved: boolean;
  /** Toward the track's on end, which RTL puts on the left. */
  sign: 1 | -1;
}

const paint = (gesture: Gesture) => {
  const clamped = Math.min(Math.max(gesture.offset, 0), gesture.travel);
  gesture.root.style.setProperty(DRAG_X, `${clamped * gesture.sign}px`);
};

export const withWinuiDrag = (components: FluentComponents): FluentComponents => {
  const FluentSwitch = components.Switch;
  const { indicator: indicatorClass, input: inputClass } = components.switchClassNames;
  const resolveSlotProps = components.slot.resolveShorthand as (value: unknown) => PropCarrier | undefined;

  const DraggableSwitch = React.forwardRef<HTMLInputElement, SwitchProps>(({ root, ...props }, ref) => {
    const gestureRef = React.useRef<Gesture | null>(null);
    const suppressClickRef = React.useRef(false);
    const settleTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    React.useEffect(() => () => clearTimeout(settleTimerRef.current), []);

    // Every step below writes the DOM rather than React state, because the
    // ordering is load-bearing: the settling flag has to be in effect before the
    // checkbox flips, or the cross-fade it selects starts on the old duration,
    // and the drag position has to leave in the same style recalculation that
    // re-enables the travel transition, or the knob jumps instead of settling.
    //
    // The toggle is always issued here rather than left to the browser, because
    // capturing the pointer redirects the click that follows to the capture
    // target -- the root -- where it no longer reaches the checkbox at all.
    const end = (gesture: Gesture, toggle: boolean, fromDrag: boolean) => {
      gestureRef.current = null;
      gesture.root.removeAttribute(DRAGGING);
      gesture.root.style.removeProperty(DRAG_X);
      if (toggle) {
        if (fromDrag) {
          // Committing out of a drag fades both ways, where the click path's
          // off direction is instant.
          gesture.root.setAttribute(SETTLING, '');
          clearTimeout(settleTimerRef.current);
          settleTimerRef.current = setTimeout(() => gesture.root.removeAttribute(SETTLING), CONTROL_FASTER_ANIMATION_MS);
        }
        gesture.input.click();
      }
      // Set after our own click, which would otherwise suppress itself.
      suppressClickRef.current = true;
    };

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
      suppressClickRef.current = false;
      if (!event.isPrimary || event.button !== 0) return;
      const element = event.currentTarget;
      const input = element.querySelector<HTMLInputElement>(`.${inputClass}`);
      const indicator = element.querySelector<HTMLElement>(`.${indicatorClass}`);
      // Fluent renders both unconditionally, so their absence is not a switch
      // that cannot be dragged: it is the control this layer targets no longer
      // being there, which the quiet return below would hide.
      if (!input || !indicator) throw new Error('The Switch drag gesture found no input or indicator under the switch root.');
      if (input.disabled || input.getAttribute('aria-disabled') === 'true') return;
      if (element.getAttribute('aria-readonly') === 'true') return;

      // XAML's range is knob-bounds width minus knob width; Fluent's knob cell is
      // half the track at every size, so half the indicator is the same number.
      // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ToggleSwitch_Partial.cpp#L936-L952
      const travel = indicator.offsetWidth / 2;
      const gesture: Gesture = {
        excursion: 0,
        input,
        lastClientX: event.clientX,
        moved: false,
        offset: input.checked ? travel : 0,
        originClientX: event.clientX,
        pointerId: event.pointerId,
        root: element,
        sign: getComputedStyle(element).direction === 'rtl' ? -1 : 1,
        travel,
      };
      gestureRef.current = gesture;
      element.setPointerCapture(event.pointerId);
      // Dragging is entered with no movement at all: Thumb raises DragStarted from
      // OnPointerPressed.
      // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ToggleSwitch_Partial.cpp#L806-L816
      element.setAttribute(DRAGGING, '');
      paint(gesture);
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const delta = (event.clientX - gesture.lastClientX) * gesture.sign;
      // Ignoring vertical movement is what leaves a vertical swipe to the scroller.
      if (delta === 0) return;
      gesture.lastClientX = event.clientX;
      gesture.excursion = Math.max(gesture.excursion, Math.abs(event.clientX - gesture.originClientX));
      gesture.moved = true;
      gesture.offset += delta;
      paint(gesture);
    };

    const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      // Midpoint decides, inclusive both ways, with no velocity or direction term.
      // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ToggleSwitch_Partial.cpp#L592-L605
      const midpoint = gesture.travel / 2;
      const crossed = gesture.input.checked ? gesture.offset <= midpoint : gesture.offset >= midpoint;
      const committed = gesture.moved && crossed;
      end(gesture, committed || gesture.excursion <= TAP_SLOP_PX, committed);
    };

    const abandon = (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      end(gesture, false, false);
    };

    const onClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
      // Synthesised clicks -- keyboard space, and the toggle issued above -- carry a
      // zero detail where a pointer's click counts from one.
      if (!suppressClickRef.current || event.detail === 0) return;
      suppressClickRef.current = false;
      // stopPropagation alone would still leave the checkbox its default action.
      event.preventDefault();
      event.stopPropagation();
    };

    return (
      <FluentSwitch
        {...props}
        ref={ref}
        root={{
          ...resolveSlotProps(root),
          onClickCapture,
          onLostPointerCapture: abandon,
          onPointerCancel: abandon,
          onPointerDown,
          onPointerMove,
          onPointerUp,
        }}
      />
    );
  });

  DraggableSwitch.displayName = 'Switch';

  return { ...components, Switch: DraggableSwitch as FluentComponents['Switch'] };
};
