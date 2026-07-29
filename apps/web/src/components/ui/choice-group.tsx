import { useId } from 'react';

import { fluentComponents } from '../../fluent';

const { makeStyles, tokens } = fluentComponents;

const useStyles = makeStyles({
  root: {
    alignItems: 'center',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: '6px',
    display: 'flex',
    flexWrap: 'nowrap',
    gap: '2px',
    maxWidth: '100%',
    padding: '2px',
    width: 'fit-content',
  },
  item: {
    alignItems: 'center',
    borderRadius: '4px',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    display: 'inline-flex',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    minHeight: '30px',
    padding: '2px 12px',
    position: 'relative',
    whiteSpace: 'nowrap',
    '&:has(input:checked)': {
      backgroundColor: tokens.colorNeutralBackground2,
      color: tokens.colorNeutralForeground1,
      fontWeight: tokens.fontWeightSemibold,
    },
    '&:has(input:not(:checked):not(:disabled)):hover': {
      backgroundColor: tokens.colorNeutralBackground2Hover,
      color: tokens.colorNeutralForeground1,
    },
    '&:has(input:not(:checked):not(:disabled)):active': {
      backgroundColor: tokens.colorNeutralBackground2Pressed,
      color: tokens.colorNeutralForeground1,
    },
    '&:has(input:focus-visible)': {
      boxShadow: tokens.shadow4,
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '1px',
    },
    '&:has(input:disabled)': {
      color: tokens.colorNeutralForegroundDisabled,
      cursor: 'not-allowed',
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
