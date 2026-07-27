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

  return (
    <div
      aria-label={ariaLabel}
      className={`inline-flex gap-0.5 rounded-lg max-w-full min-h-[34px] overflow-x-auto p-0.5 ${s.segmented}`}
      role="tablist"
    >
      {items.map(item => (
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
          role="tab"
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
