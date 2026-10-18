import type { SlotRenderFunction } from '@fluentui/react-components';
import { forwardRef } from 'react';
import type { ComponentProps } from 'react';

import { listboxRenderer, LISTBOX_POSITIONING } from './fluent-form-controls';
import { fluentComponents } from '../../fluent';

const { Combobox, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  // Inline editing retains Fluent's listbox behavior but deliberately omits
  // WinUI ComboBox's faceplate, expander and detached field focus rectangle.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L331-L382
  root: {
    '--floway-select-fill': 'transparent',
    '--floway-select-fill-hover': 'transparent',
    '--floway-select-fill-pressed': 'transparent',
    '--floway-select-border-width': '0px',
    '--floway-select-focus-shadow': 'none',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    fontWeight: 'inherit',
    lineHeight: 'inherit',
    '&.fui-Combobox.fui-Combobox': {
      display: 'inline-grid',
      gridTemplateColumns: 'minmax(0, 1fr)',
      position: 'relative',
      minWidth: '1ch',
      maxWidth: '100%',
      height: 'auto',
      minHeight: 0,
      padding: 0,
      gap: 0,
      outlineStyle: 'none',
      boxShadow: 'none',
      '&::before': { content: 'none' },
      '&::after': { content: 'none' },
    },
  },
  mirror: { gridArea: '1 / 1', minWidth: 0, overflow: 'hidden', visibility: 'hidden', whiteSpace: 'pre' },
  // Keep the native input in inline formatting inside the same trimmed text
  // box as the mirror. Absolute-positioning the input itself centers its font
  // box independently and rounds its baseline differently at fractional offsets.
  // https://drafts.csswg.org/css-inline-3/#text-box-trim
  editor: { position: 'absolute', top: 0, left: 0, width: '100%', whiteSpace: 'nowrap' },
  input: {
    '&.fui-Combobox__input': {
      display: 'inline-block',
      // Leave room for the caret without widening the surrounding text run.
      width: 'calc(100% + 1px)',
      minWidth: 0,
      height: 'auto',
      padding: 0,
      margin: 0,
      border: 0,
      backgroundColor: 'transparent',
      color: 'inherit',
      fontFamily: 'inherit',
      fontSize: 'inherit',
      fontWeight: 'inherit',
      lineHeight: 'normal',
      verticalAlign: 'baseline',
      outlineStyle: 'none',
      boxShadow: 'none',
      textOverflow: 'clip',
    },
  },
});

export const InlineCombobox = forwardRef<HTMLInputElement, Omit<ComponentProps<typeof Combobox>, 'appearance' | 'clearable' | 'clearIcon' | 'expandIcon' | 'input' | 'listbox' | 'root' | 'value'> & { emptyMessage: string; value: string }>(
  ({ className, emptyMessage, positioning, value, ...props }, ref) => {
    const styles = useStyles();
    const renderRoot: SlotRenderFunction<ComponentProps<'div'>> = (Component, rootProps) => <Component {...rootProps}>
      <span aria-hidden className={mergeClasses('floway-control-label', styles.mirror)} data-inline-combobox-mirror="">{value || '\u200b'}</span>
      <span className={mergeClasses('floway-control-label', styles.editor)}>{rootProps.children}</span>
    </Component>;
    return <Combobox
      {...props}
      className={mergeClasses(styles.root, className)}
      clearIcon={null}
      expandIcon={null}
      input={{ className: styles.input, size: 1 }}
      root={{ children: renderRoot }}
      listbox={{
        className: '!w-max !min-w-40 !max-w-[calc(100vw-16px)]',
        children: listboxRenderer(props.freeform === true, emptyMessage),
      }}
      positioning={positioning ?? LISTBOX_POSITIONING}
      ref={ref}
      value={value}
    />;
  },
);
