// Drag support for the Switch, which Fluent does not have and WinUI's
// ToggleSwitch does. XAML puts a transparent Thumb over the whole control and
// listens to its DragStarted / DragDelta / DragCompleted; there is no
// manipulation and no inertia, so the whole gesture is reproducible from
// pointer events.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/src/dxaml/xcp/dxaml/lib/ToggleSwitch_Partial.cpp#L245-L250
//
// The knob follows the pointer 1:1 and is clamped only where it is written, not
// where it is accumulated, so a drag that overshoots the end and comes back
// leaves the decision reading from the unclamped total. That is why the offset
// below is kept raw and clamped at paint time.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/src/dxaml/xcp/dxaml/lib/ToggleSwitch_Partial.cpp#L452-L458
import * as React from 'react';

import { CONTROL_FASTER_ANIMATION_MS } from './motion';

type FluentComponents = typeof import('@fluentui/react-components');
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
      const input = element.querySelector<HTMLInputElement>('.fui-Switch__input');
      const indicator = element.querySelector<HTMLElement>('.fui-Switch__indicator');
      // A read-only switch refuses the click, so it has to refuse the drag as
      // well -- the drag commits by issuing that same click.
      if (!input || !indicator || input.disabled || input.getAttribute('aria-disabled') === 'true') return;
      if (element.getAttribute('aria-readonly') === 'true') return;

      // XAML measures the range as SwitchKnobBounds.ActualWidth minus
      // SwitchKnob.ActualWidth, and the knob's cell is half the track at every
      // size Fluent offers, so half the indicator is the same number without a
      // second element to measure.
      // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/src/dxaml/xcp/dxaml/lib/ToggleSwitch_Partial.cpp#L936-L952
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
      // Entering Dragging takes no movement at all: Thumb raises DragStarted
      // from OnPointerPressed, and ToggleSwitch pins the knob's current
      // translate as a local value in the same breath.
      // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/src/dxaml/xcp/dxaml/lib/ToggleSwitch_Partial.cpp#L806-L816
      element.setAttribute(DRAGGING, '');
      paint(gesture);
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const delta = (event.clientX - gesture.lastClientX) * gesture.sign;
      // Vertical movement is deliberately ignored rather than treated as a drag,
      // which is what leaves a vertical swipe to the scroller.
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
      // The midpoint of travel decides, inclusively in both directions, with no
      // velocity or direction term anywhere in it.
      // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/src/dxaml/xcp/dxaml/lib/ToggleSwitch_Partial.cpp#L592-L605
      const midpoint = gesture.travel / 2;
      const crossed = gesture.input.checked ? gesture.offset <= midpoint : gesture.offset >= midpoint;
      const committed = gesture.moved && crossed;
      // A gesture that stayed inside the slop is also a tap, and taps commit
      // even when the knob never reached the midpoint.
      end(gesture, committed || gesture.excursion <= TAP_SLOP_PX, committed);
    };

    const abandon = (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      end(gesture, false, false);
    };

    const onClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
      // Only the click the pointer sequence itself produced. Space on the
      // checkbox synthesises one too, as does the toggle issued above, and both
      // carry a zero detail where a pointer's click counts from one.
      if (!suppressClickRef.current || event.detail === 0) return;
      suppressClickRef.current = false;
      // Both, because stopping propagation alone still leaves the checkbox its
      // default action.
      event.preventDefault();
      event.stopPropagation();
    };

    return (
      <FluentSwitch
        {...props}
        ref={ref}
        root={{
          ...(typeof root === 'object' && root !== null && !React.isValidElement(root) ? root : {}),
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
