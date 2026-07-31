import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { fluentComponents } from '../../fluent';
import {
  INDICATOR_DURATION_MS,
  INDICATOR_POSITION_SNAP,
  INDICATOR_SETTLE_EASING,
  INDICATOR_STRETCH_EASING,
} from '../../winui/motion';

const { makeStyles, tokens } = fluentComponents;

// A row of mutually exclusive choices, shaped after WinUI's SelectorBar.
//
// The control this replaces was a segmented control: a recessed grey track with
// the selected option raised out of it as a white pill. Windows has no such
// thing -- no WinUI control marks a selection by lifting it out of a groove.
// SelectorBar states the opposite at every turn: the track, the item borders
// and every item background including the selected one are all transparent, and
// selection is carried by a 3px accent pill under the chosen item. Its states
// live in the foreground, which steps *down* the text ramp on pointer where a
// raised pill steps up.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar_themeresources.xaml
const useStyles = makeStyles({
  // SelectorBarItemSpacing is 8. SelectorBar's own vertical metrics are not
  // kept: its padding of 0,4 over an item padded 12,10,12,7 stands the control
  // 45px tall, and this one is a form field sitting in a row with inputs and
  // dropdowns that are 32. A control that does not line up with the field
  // beside it is a worse answer than one that departs from the dictionary, so
  // the block padding goes to the item and the row comes to 32. The asymmetry
  // stays, because the shallower bottom is the room the pill occupies.
  root: {
    alignItems: 'center',
    display: 'flex',
    position: 'relative',
    flexWrap: 'nowrap',
    gap: '8px',
    maxWidth: '100%',
    width: 'fit-content',
  },
  // Seven above and below a 20px line is 34, the height of the fields beside it.
  // SelectorBar's own padding is three pixels shallower at the bottom to leave
  // the pill its room, but the pill here lives in a track of its own laid over
  // the row rather than inside the item's box, so the item owes it nothing and
  // the label sits centred instead of low.
  item: {
    alignItems: 'center',
    cursor: 'pointer',
    display: 'inline-flex',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    padding: '7px 12px',
    position: 'relative',
    whiteSpace: 'nowrap',
    '&:has(input:not(:disabled)):hover': { color: 'var(--winui-text-fill-secondary)' },
    '&:has(input:not(:disabled)):active': { color: 'var(--winui-text-fill-tertiary)' },
    '&:has(input:focus-visible)': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '-2px',
    },
    '&:has(input:disabled)': {
      color: 'var(--winui-text-fill-disabled)',
      cursor: 'not-allowed',
    },
  },
  // SelectorBarItemPillHeight is 3 and SelectorBarItemPillWidth 4, the latter
  // being the diameter its ends round by. SelectorBarItemSelectionVisualMargin
  // is 0, so the pill spans the item it marks rather than only its label. It is
  // one element for the group instead of one per item, because WinUI slides it
  // between items and a pseudo-element cannot outlive the item it belongs to.
  // The track carries the pill's place in the row and nothing else; the pill
  // inside it carries the whole animation on one transform. Writing a
  // translation and a scale as separate properties would compose them in CSS's
  // fixed order -- translate, rotate, scale, then transform -- and multiply the
  // travel by the stretch.
  pillTrack: {
    bottom: '0',
    height: '3px',
    pointerEvents: 'none',
    position: 'absolute',
  },
  // The offset below solves for a pinned edge assuming the scale grows from the
  // leading one, so the origin is stated here rather than left at the centre it
  // defaults to.
  pill: {
    backgroundColor: 'var(--winui-accent-fill-default)',
    borderRadius: '2px',
    display: 'block',
    height: '100%',
    transformOrigin: 'left',
    width: '100%',
  },
  pillDisabled: { backgroundColor: 'var(--winui-accent-fill-disabled)' },
  input: {
    height: '1px',
    inset: 0,
    opacity: 0,
    position: 'absolute',
    width: '1px',
  },
});

export interface ChoiceGroupItem {
  value: string;
  label: string;
  disabled?: boolean;
}

type PillBox = { left: number; width: number };

export function ChoiceGroup({
  ariaLabel,
  items,
  onChange,
  readOnly,
  value,
}: {
  ariaLabel: string;
  items: ChoiceGroupItem[];
  onChange: (value: string) => void;
  /**
   * The choice is shown but is not this operator's to make -- as distinct from
   * disabled, which says the choice is not available at all. It reads as it
   * does at rest, takes focus, and refuses the selection. The same distinction,
   * and why the refusal has to cancel the click, is written down in
   * ./fluent-form-controls.tsx for the controls Fluent ships.
   */
  readOnly?: boolean;
  value: string;
}) {
  const styles = useStyles();
  const name = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const previousRef = useRef<PillBox | null>(null);
  const [box, setBox] = useState<PillBox | null>(null);
  const selected = items.find(item => item.value === value) ?? null;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const item = root?.querySelector<HTMLElement>(`[data-choice="${CSS.escape(value)}"]`);
    if (!root || !item) {
      setBox(null);
      return;
    }
    const rootBox = root.getBoundingClientRect();
    const itemBox = item.getBoundingClientRect();
    // Snapped to the device grid. An item's width is whatever its label
    // measures, so the track lands on a fraction of a pixel, and a fraction is
    // rasterized one way while the pill is a scaled layer and another way once
    // the transform is dropped: the far edge covers one device pixel more
    // during the animation than at rest, and drops it on the final frame. On
    // the grid both states paint the same column.
    const snap = (value: number) => Math.round(value * window.devicePixelRatio) / window.devicePixelRatio;
    setBox({ left: snap(itemBox.left - rootBox.left), width: snap(itemBox.width) });
  }, [items, value]);

  useEffect(() => {
    const pill = pillRef.current;
    const previous = previousRef.current;
    previousRef.current = box;
    if (!pill || !box || !previous) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const distance = box.left - previous.left;
    if (distance === 0 && previous.width === box.width) return;

    // WinUI's horizontal indicator carries the two widths as scales, because the
    // bar it leaves and the bar it becomes are not the same length. The element
    // is sized to the destination, so the end scale is one and the begin scale
    // is the ratio it starts from.
    const dimension = box.width;
    const beginScale = previous.width / dimension;
    const forward = distance > 0;
    const peak = Math.abs(distance) / dimension + (forward ? 1 : beginScale);

    // One animation, one property, one origin. WinUI expresses this as three --
    // an offset that steps, a scale, and an origin that flips at the step -- but
    // the flip only exists to pin the edge that must stay still, and pinning it
    // through the offset instead says the same thing without a discontinuity.
    // Three animations that must agree on a single frame will eventually not,
    // and the frame they disagree on shows the pill at its stretched length in
    // the wrong place.
    //
    // Solving for the offset that holds the pinned edge: travelling forward the
    // trailing edge stays at the source until the snap, so the offset is held
    // and then unwinds with the settle; travelling back the leading edge stays
    // at the source instead, so the offset unwinds during the stretch and is
    // held afterwards. Both are affine in the scale, so each follows its own
    // phase's curve exactly.
    const from = -distance;
    pill.animate([
      { transform: `translateX(${from}px) scaleX(${beginScale})`, easing: INDICATOR_STRETCH_EASING },
      { transform: `translateX(${forward ? from : 0}px) scaleX(${peak})`, offset: INDICATOR_POSITION_SNAP, easing: INDICATOR_SETTLE_EASING },
      { transform: 'translateX(0px) scaleX(1)' },
    ], { duration: INDICATOR_DURATION_MS });
  }, [box]);

  return <div aria-label={ariaLabel} aria-readonly={readOnly === true ? true : undefined} className={styles.root} ref={rootRef} role="radiogroup">
    {items.map(item => <label className={styles.item} data-choice={item.value} key={item.value}>
      <input
        checked={value === item.value}
        className={styles.input}
        disabled={item.disabled}
        name={name}
        onChange={readOnly === true ? undefined : () => onChange(item.value)}
        // A radio's default action is the selection, so cancelling the click is
        // what refuses it while leaving the control its own appearance.
        onClick={readOnly === true ? event => event.preventDefault() : undefined}
        type="radio"
        value={item.value}
      />
      <span>{item.label}</span>
    </label>)}
    {box && <span aria-hidden className={styles.pillTrack} style={{ left: box.left, width: box.width }}>
      <span
        className={selected?.disabled ? `${styles.pill} ${styles.pillDisabled}` : styles.pill}
        ref={pillRef}
      />
    </span>}
  </div>;
}
