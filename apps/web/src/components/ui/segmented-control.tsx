import { useRef } from 'react';
import type { KeyboardEvent } from 'react';

import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

const useStyles = makeStyles({
  segmented: {
    backgroundColor: 'light-dark(#f5f5f5, #1e1e1e)',
    border: '1px solid light-dark(#e0e0e0, #3a3a3a)',
  },
  button: {
    color: 'light-dark(#616161, #a0a0a0)',
  },
  buttonHover: {
    color: 'light-dark(#242424, #e5e5e5)',
  },
  active: {
    backgroundColor: 'light-dark(#ffffff, #333333) !important',
    boxShadow: '0 1px 2px rgb(0 0 0 / 8%)',
    color: 'light-dark(#111827, #f5f5f5) !important',
  },
});

export interface SegmentedControlItem {
  value: string;
  label: string;
  disabled?: boolean;
}

export function SegmentedControl({
  ariaLabel,
  items,
  onChange,
  value,
}: {
  ariaLabel: string;
  items: SegmentedControlItem[];
  onChange: (value: string) => void;
  value: string;
}) {
  const s = useStyles();
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabStop = items.find(item => item.value === value && !item.disabled)?.value
    ?? items.find(item => !item.disabled)?.value;

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let target: number | null = null;
    let step = 1;
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') { target = items.length - 1; step = -1; }
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = index + 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { target = index - 1; step = -1; }
    if (target === null) return;
    event.preventDefault();
    for (let offset = 0; offset < items.length; offset += 1) {
      const candidate = (target + offset * step + items.length) % items.length;
      const item = items[candidate];
      if (!item || item.disabled) continue;
      onChange(item.value);
      buttonRefs.current[candidate]?.focus();
      return;
    }
  };

  return (
    <div
      aria-label={ariaLabel}
      className={`inline-flex gap-0.5 rounded-lg max-w-full min-h-[34px] overflow-x-auto p-0.5 ${s.segmented}`}
      aria-orientation="horizontal"
      role="tablist"
    >
      {items.map((item, index) => (
        <button
          aria-selected={value === item.value}
          disabled={item.disabled}
          className={
            value === item.value
              ? `bg-transparent border-0 rounded-md cursor-pointer flex-none font-fui-semibold text-fui-base200 min-h-[28px] px-2.5 whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 ${s.active}`
              : `bg-transparent border-0 rounded-md cursor-pointer flex-none font-fui-semibold text-fui-base200 min-h-[28px] px-2.5 whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 ${s.button} hover:${s.buttonHover}`
          }
          key={item.value}
          onClick={() => !item.disabled && onChange(item.value)}
          onKeyDown={event => move(event, index)}
          ref={element => { buttonRefs.current[index] = element; }}
          role="tab"
          tabIndex={tabStop === item.value ? 0 : -1}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
