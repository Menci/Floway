import { useId, type KeyboardEvent } from 'react';

import { refuseToggle } from './fluent-form-controls';
import { useRouteAddress } from './route-link';
import { fluentComponents } from '../../fluent';

const { makeStyles, tokens } = fluentComponents;

// A row of mutually exclusive choices, shaped after WinUI's SelectorBar: track,
// item borders and every item background including the selected one are
// transparent, selection is carried by a 3px accent pill under the chosen item,
// and the states live in the foreground, stepping *down* the text ramp on
// pointer.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar_themeresources.xaml
const useStyles = makeStyles({
  // The items sit flush: SelectorBar's horizontal StackLayout states no spacing,
  // so each item's 12px of side padding is the whole distance between one label
  // and the next. SelectorBarItemSpacing, 8, is the icon-to-text gap and these
  // items carry no icon; SelectorBarPadding, 0,4, is not taken either, as those
  // eight vertical pixels would stand outside the shared control-row height.
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
  // this dashboard is set to. That is ours, not WinUI's: WinUI pads the item
  // 12,10,12,7 and hangs the pill in a row of its own beneath, which stands the
  // control clear of the inputs and dropdowns it shares a form row with. On the
  // uniform row the pill finds its 3px inside the item's own bottom padding.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar_themeresources.xaml#L26-L32
  item: {
    alignItems: 'center',
    // Stated for the addressed item, whose anchor would otherwise take the
    // user-agent link colour and underline.
    color: 'inherit',
    textDecorationLine: 'none',
    // ControlCornerRadius, the radius SelectorBarItem states for itself; every
    // fill it can carry is transparent, so only the focus ring below reads it.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L53
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    display: 'inline-flex',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    padding: '7px 12px',
    position: 'relative',
    whiteSpace: 'nowrap',
    // Pressed steps on to tertiary only while the item is unselected, because
    // SelectedPressed re-states the pointer-over fill rather than the pressed
    // one. The two pressed rules are an exclusive pair so neither has to outrank
    // the other, and the selected one is spelled out rather than left to the
    // hover rule: a radio is also pressed by the keyboard, with no pointer over
    // it.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L70-L96
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L116-L149
    '&:not([data-disabled]):hover': { color: 'var(--winui-text-fill-secondary)' },
    '&:not([data-disabled]):not([data-checked]):active': {
      color: 'var(--winui-text-fill-tertiary)',
    },
    '&[data-checked]:not([data-disabled]):active': {
      color: 'var(--winui-text-fill-secondary)',
    },
    // The system focus visual: a 2px FocusStrokeColorOuter ring with a 1px
    // FocusStrokeColorInner ring inside it, held two pixels clear of the item by
    // FocusVisualMargin -2. The negative margin grows the focus rectangle, which
    // puts the outer stroke exactly where an outline at offset zero sits and
    // leaves the inner stroke the first pixel within.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar_themeresources.xaml#L34
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L472-L473
    // https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L173-L174
    '&:has(input:focus-visible)': {
      boxShadow: 'inset 0 0 0 1px var(--winui-focus-stroke-inner)',
      outline: '2px solid var(--winui-focus-stroke-outer)',
      outlineOffset: '0',
    },
    // The addressed item is the focusable element itself, where the field's is
    // the radio inside it.
    '&:focus-visible': {
      boxShadow: 'inset 0 0 0 1px var(--winui-focus-stroke-inner)',
      outline: '2px solid var(--winui-focus-stroke-outer)',
      outlineOffset: '0',
    },
    '&[data-disabled]': {
      color: 'var(--winui-text-fill-disabled)',
      cursor: 'not-allowed',
    },
    // PART_SelectionVisual: a 4px by 3px accent rectangle centred at the bottom
    // of every item, held at zero opacity until its item is the chosen one.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L200-L214
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar_themeresources.xaml#L96-L104
    '&::after': {
      backgroundColor: 'var(--winui-accent-fill-default)',
      // Stated per corner because Griffel splits the `border-radius` shorthand
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
    // Selecting scales the pill to four times its width about its centre, over
    // ComboBoxItemScaleAnimationDuration on the template's own KeySpline.
    // Deselecting states no storyboard at all, so the pill snaps away: the
    // timing sits on the rule becoming active, and the resting rule states none.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L97-L114
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L69
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L330
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L349-L357
    '&[data-checked]::after': {
      opacity: 1,
      transform: 'scaleX(4)',
      transitionDuration: '167ms',
      transitionProperty: 'opacity, transform',
      transitionTimingFunction: 'cubic-bezier(0, 0, 0, 1)',
      '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
    },
    // WinUI's Disabled state replaces only the pill's fill, so a disabled item
    // that is also the chosen one still shows the mark, in the disabled accent.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L164-L166
    '&[data-disabled]::after': { backgroundColor: 'var(--winui-accent-fill-disabled)' },
    // Without these the forced palette would repaint the pill on the canvas,
    // erasing the only mark the selection has, and flatten the pointer ramp onto
    // CanvasText where WinUI greys it. Each rule restates the selector it
    // overrides, because a media query carries no specificity of its own.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar_themeresources.xaml#L36-L49
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L456
    '@media (forced-colors: active)': {
      '&::after': { backgroundColor: 'Highlight', forcedColorAdjust: 'none' },
      '&:not([data-disabled]):hover': { color: 'GrayText' },
      '&:not([data-disabled]):not([data-checked]):active': { color: 'GrayText' },
      '&[data-checked]:not([data-disabled]):active': { color: 'GrayText' },
      '&[data-disabled]': { color: 'GrayText' },
      '&[data-disabled]::after': { backgroundColor: 'Canvas' },
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
  /**
   * Where this choice's view lives, for a group that picks between views of
   * data rather than between the values of a form field. The choice becomes an
   * anchor and can be opened in a second tab, which is the whole point of
   * addressing it: a range beside another range is a comparison.
   */
  to?: string;
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
   * appearance and pointer states, takes focus, and refuses the selection.
   */
  readOnly?: boolean;
  value: string;
}) {
  const styles = useStyles();
  const name = useId();
  const selectedIndex = items.findIndex(item => item.value === value);
  // An addressed group is a row of anchors, so the single tab stop and the
  // arrow keys that a native radiogroup gives for free are restated here.
  // Arrowing selects as well as moves, which is what a radio does.
  // https://www.w3.org/WAI/ARIA/apg/patterns/radio/
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    const choices = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('[role="radio"]:not([aria-disabled="true"])')];
    if (choices.length === 0) return;
    event.preventDefault();
    const next = choices[(choices.indexOf(event.target as HTMLAnchorElement) + step + choices.length) % choices.length];
    next.focus();
    next.click();
  };

  return <div aria-label={ariaLabel} aria-readonly={readOnly === true ? true : undefined} className={styles.root} onKeyDown={handleKeyDown} role="radiogroup">
    {items.map((item, index) => item.to === undefined
      ? <label
          className={styles.item}
          data-checked={value === item.value ? '' : undefined}
          data-disabled={item.disabled === true ? '' : undefined}
          key={item.value}
        >
          <input
            checked={value === item.value}
            className={styles.input}
            disabled={item.disabled}
            name={name}
            onChange={readOnly === true ? undefined : () => onChange(item.value)}
            onClick={readOnly === true ? refuseToggle : undefined}
            type="radio"
            value={item.value}
          />
          <span>{item.label}</span>
        </label>
      : <AddressedChoice
          checked={value === item.value}
          className={styles.item}
          item={item}
          key={item.value}
          onChange={onChange}
          to={item.to}
          tabIndex={(selectedIndex === -1 ? index === 0 : value === item.value) ? 0 : -1}
        />)}
  </div>;
}

function AddressedChoice({ checked, className, item, onChange, tabIndex, to }: {
  checked: boolean;
  className: string;
  item: ChoiceGroupItem;
  onChange: (value: string) => void;
  tabIndex: number;
  to: string;
}) {
  // The page owns the transition, holding the view in state and writing the URL
  // after it, so the address only has to say where the view lives.
  const address = useRouteAddress(to, () => onChange(item.value));
  return <a
    {...address}
    aria-checked={checked}
    aria-disabled={item.disabled === true ? true : undefined}
    className={className}
    data-checked={checked ? '' : undefined}
    data-disabled={item.disabled === true ? '' : undefined}
    // An anchor answers Enter on its own; Space is the radio's key and has to
    // be given back, and its default is the page scroll.
    onKeyDown={event => {
      if (event.key !== ' ') return;
      event.preventDefault();
      event.currentTarget.click();
    }}
    role="radio"
    tabIndex={tabIndex}
  >
    <span>{item.label}</span>
  </a>;
}
