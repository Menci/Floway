import { useId } from 'react';

import { fluentComponents } from '../../fluent';

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
  // The items sit flush against one another. SelectorBar hands them to an
  // ItemsView laid out by a horizontal StackLayout that states no spacing, so
  // the 12px each item pads by on either side is the whole distance between one
  // label and the next. SelectorBarItemSpacing, 8, is the gap between an item's
  // icon and its text rather than between items, and these items carry no icon.
  // SelectorBarPadding, 0,4, is not taken either: those eight vertical pixels
  // would stand outside the shared control-row height the item below is set to.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L14
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L29-L36
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L174-L178
  root: {
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'nowrap',
    maxWidth: '100%',
    width: 'fit-content',
  },
  // Seven above and below a 20px line is 34, the height every control row in
  // this dashboard is set to. That number is the operator's choice, not WinUI's:
  // WinUI pads the item 12,10,12,7 around the label and hangs the pill in a row
  // of its own beneath that, which stands the control well clear of the inputs
  // and dropdowns this one shares a form row with. The uniform row is taken
  // instead, so the label sits centred and the pill finds its 3px inside the
  // item's own bottom padding rather than adding a row below it.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar_themeresources.xaml#L26-L32
  item: {
    alignItems: 'center',
    // ControlCornerRadius, the radius SelectorBarItem states for itself. Every
    // fill it can carry is transparent, so the only drawing that reads it is
    // the focus ring below.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L53
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    display: 'inline-flex',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    padding: '7px 12px',
    position: 'relative',
    whiteSpace: 'nowrap',
    // The foreground carries every pointer state, since the item's background
    // and border are transparent in each of the six combined states. Pointer-
    // over steps to secondary whether or not the item is the chosen one;
    // pressed steps on to tertiary only while the item is unselected, because
    // SelectedPressed re-states the pointer-over fill rather than the pressed
    // one. The two pressed rules are written as an exclusive pair so that
    // neither has to outrank the other, and the selected one is spelled out
    // rather than left to the hover rule above: a radio is also pressed by the
    // keyboard, with no pointer over it.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L70-L96
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L116-L149
    '&:has(input:not(:disabled)):hover': { color: 'var(--winui-text-fill-secondary)' },
    '&:has(input:not(:disabled):not(:checked)):active': {
      color: 'var(--winui-text-fill-tertiary)',
    },
    '&:has(input:checked:not(:disabled)):active': {
      color: 'var(--winui-text-fill-secondary)',
    },
    // The system focus visual: a 2px FocusStrokeColorOuter ring with a 1px
    // FocusStrokeColorInner ring nested inside it, held two pixels clear of the
    // item by FocusVisualMargin -2 -- a negative margin grows the focus
    // rectangle, so the outer ring is drawn around the item's bounds rather
    // than inside them. That places the outer stroke in the two pixels outside
    // the border edge, which is where an outline at offset zero already sits,
    // and leaves the inner stroke the first pixel within. High Contrast is left
    // to the forced palette: it repaints the outline on CanvasText and drops
    // the shadow outright, which is the pair WinUI's own HighContrast
    // dictionary states as WindowText over Window.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar_themeresources.xaml#L34
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L472-L473
    // https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L173-L174
    '&:has(input:focus-visible)': {
      boxShadow: 'inset 0 0 0 1px var(--winui-focus-stroke-inner)',
      outline: '2px solid var(--winui-focus-stroke-outer)',
      outlineOffset: '0',
    },
    '&:has(input:disabled)': {
      color: 'var(--winui-text-fill-disabled)',
      cursor: 'not-allowed',
    },
    // PART_SelectionVisual: a 4px by 3px accent rectangle centred at the bottom
    // of every item, rounded half a pixel across and one down, held at zero
    // opacity until its item is the chosen one. Each item carries its own, so
    // the mark is a pseudo-element rather than one element the group shares.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L200-L214
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar_themeresources.xaml#L96-L104
    '&::after': {
      backgroundColor: 'var(--winui-accent-fill-default)',
      // Each corner is an ellipse quadrant, half a pixel across and one down,
      // stated per corner because Griffel splits the `border-radius` shorthand
      // on whitespace and would not survive its `/`.
      borderBottomLeftRadius: '0.5px 1px',
      borderBottomRightRadius: '0.5px 1px',
      borderTopLeftRadius: '0.5px 1px',
      borderTopRightRadius: '0.5px 1px',
      bottom: '0',
      content: '""',
      height: '3px',
      left: 'calc(50% - 2px)',
      opacity: 0,
      pointerEvents: 'none',
      position: 'absolute',
      width: '4px',
    },
    // Selecting fades the pill in and scales it to four times its width -- 16px
    // -- about its centre, over ComboBoxItemScaleAnimationDuration on the
    // template's own KeySpline. The centre is the origin SelectorBarItemPill
    // inherits from ComboBoxItemPill, which is why the pill grows evenly to
    // either side of where it rests. Deselecting states no storyboard at all,
    // so the pill snaps away; the timing therefore sits here, on the rule that
    // is becoming active, and the resting rule above states none.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L97-L114
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L69
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L330
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L349-L357
    '&:has(input:checked)::after': {
      opacity: 1,
      transform: 'scaleX(4)',
      transitionDuration: '167ms',
      transitionProperty: 'opacity, transform',
      transitionTimingFunction: 'cubic-bezier(0, 0, 0, 1)',
      '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
    },
    // WinUI's Disabled state replaces the pill's fill and leaves the rest of
    // its drawing alone, so a disabled item that is also the chosen one still
    // shows the mark, in the disabled accent.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L164-L166
    '&:has(input:disabled)::after': { backgroundColor: 'var(--winui-accent-fill-disabled)' },
    // WinUI states the whole control again for High Contrast, and a forced
    // palette would otherwise answer for it: it repaints the pill's fill on the
    // canvas, which erases the only mark the selection has, and it flattens the
    // pointer ramp onto CanvasText, where WinUI greys it. Each rule restates
    // the selector it overrides, because a media query carries no specificity
    // of its own. SelectorBarItemDisabledPillFill resolves through
    // AccentFillColorDisabledBrush, which the HighContrast dictionary re-points
    // at Window, so a disabled chosen item keeps a pill the canvas swallows.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar_themeresources.xaml#L36-L49
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L456
    '@media (forced-colors: active)': {
      '&::after': { backgroundColor: 'Highlight', forcedColorAdjust: 'none' },
      '&:has(input:not(:disabled)):hover': { color: 'GrayText' },
      '&:has(input:not(:disabled):not(:checked)):active': { color: 'GrayText' },
      '&:has(input:checked:not(:disabled)):active': { color: 'GrayText' },
      '&:has(input:disabled)': { color: 'GrayText' },
      '&:has(input:disabled)::after': { backgroundColor: 'Canvas' },
    },
  },
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
   * disabled, which says the choice is not available at all. It keeps its own
   * appearance and its own pointer states, takes focus, and refuses the
   * selection. The same distinction, and why the refusal has to cancel the
   * click, is written down in ./fluent-form-controls.tsx for the controls
   * Fluent ships.
   */
  readOnly?: boolean;
  value: string;
}) {
  const styles = useStyles();
  const name = useId();

  return <div aria-label={ariaLabel} aria-readonly={readOnly === true ? true : undefined} className={styles.root} role="radiogroup">
    {items.map(item => <label className={styles.item} key={item.value}>
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
  </div>;
}
