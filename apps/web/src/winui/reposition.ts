// RepositionThemeAnimation, for elements that neither arrive nor leave. A
// presence component cannot carry it: presence is about a thing being there or
// not, and these are there throughout -- what changed is where the ones around
// them are. So the motion is measured rather than declared, from the layout the
// browser has already committed to the layout it is about to show.
//
// Offsets are read with offsetTop rather than a bounding rect, because a rect
// includes the transform an unfinished reposition is still applying and would
// feed its own output back in as the next measurement.
import { REPOSITION_ANIMATION_MS, REPOSITION_DELETE_DELAY_MS, REPOSITION_EASING } from './motion';

/**
 * Tracks one stack of elements across layout changes.
 *
 * Call the returned function from a layout effect with the stack in document
 * order, on every render: it is the comparison against the previous call that
 * detects a move, so a call that finds nothing changed is not a wasted one.
 */
export const createReposition = () => {
  const offsets = new Map<HTMLElement, number>();
  const running = new Map<HTMLElement, Animation>();

  return (elements: readonly HTMLElement[]) => {
    const present = new Set(elements);
    const moved: [HTMLElement, number][] = [];

    for (const element of elements) {
      const before = offsets.get(element);
      const after = element.offsetTop;
      offsets.set(element, after);
      if (before !== undefined && before !== after) moved.push([element, before - after]);
    }

    let departed = false;
    for (const element of offsets.keys()) {
      if (present.has(element)) continue;
      offsets.delete(element);
      running.delete(element);
      departed = true;
    }

    for (const [element, delta] of moved) {
      running.get(element)?.cancel();
      running.set(element, element.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: 'none' }],
        {
          delay: departed ? REPOSITION_DELETE_DELAY_MS : 0,
          duration: REPOSITION_ANIMATION_MS,
          easing: REPOSITION_EASING,
          // The delayed form holds its first key frame through the delay. Without
          // it the survivors would snap into the gap and then slide back out of it.
          fill: 'backwards',
        },
      ));
    }
  };
};
