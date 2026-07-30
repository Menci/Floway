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
  // SelectorBarItemSpacing is 8, and SelectorBarPadding is 0,4 -- no fill, no
  // radius, and room only above and below.
  root: {
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'nowrap',
    gap: '8px',
    maxWidth: '100%',
    paddingBlock: '4px',
    width: 'fit-content',
  },
  // SelectorBarItemPadding is 12,10,12,7 -- three pixels shallower at the
  // bottom, which is the room the pill occupies.
  item: {
    alignItems: 'center',
    color: 'var(--winui-text-fill-primary)',
    cursor: 'pointer',
    display: 'inline-flex',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    padding: '10px 12px 7px',
    position: 'relative',
    whiteSpace: 'nowrap',
    // SelectorBarItemPillHeight is 3 and SelectorBarItemPillWidth 4, the latter
    // being the diameter its ends round by. SelectorBarItemSelectionVisualMargin
    // is 0, so the pill spans the item rather than only its label.
    '&:has(input:checked)::after': {
      backgroundColor: 'var(--winui-accent-fill-default)',
      borderRadius: '2px',
      bottom: 0,
      content: '""',
      height: '3px',
      insetInline: 0,
      position: 'absolute',
    },
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
    '&:has(input:disabled:checked)::after': { backgroundColor: 'var(--winui-accent-fill-disabled)' },
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
  value,
}: {
  ariaLabel: string;
  items: ChoiceGroupItem[];
  onChange: (value: string) => void;
  value: string;
}) {
  const styles = useStyles();
  const name = useId();
  return <div aria-label={ariaLabel} className={styles.root} role="radiogroup">
    {items.map(item => <label className={styles.item} key={item.value}>
      <input
        checked={value === item.value}
        className={styles.input}
        disabled={item.disabled}
        name={name}
        onChange={() => onChange(item.value)}
        type="radio"
        value={item.value}
      />
      <span>{item.label}</span>
    </label>)}
  </div>;
}
