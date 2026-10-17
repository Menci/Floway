import type { SlotRenderFunction } from '@fluentui/react-components';
import { forwardRef, useLayoutEffect, useRef } from 'react';
import type { ComponentProps } from 'react';

import { listboxRenderer, LISTBOX_POSITIONING } from './fluent-form-controls';
import { fluentComponents } from '../../fluent';

const { Combobox, makeStyles, mergeClasses, useMergedRefs } = fluentComponents;

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
  input: {
    '&.fui-Combobox__input': {
      position: 'absolute',
      inset: 0,
      // Leave room for the caret without widening the surrounding text run.
      width: 'calc(100% + 1px)',
      minWidth: 0,
      height: '100%',
      padding: 0,
      margin: 0,
      border: 0,
      backgroundColor: 'transparent',
      color: 'inherit',
      fontFamily: 'inherit',
      fontSize: 'inherit',
      fontWeight: 'inherit',
      lineHeight: 'inherit',
      outlineStyle: 'none',
      boxShadow: 'none',
      textOverflow: 'clip',
    },
  },
});

export const InlineCombobox = forwardRef<HTMLInputElement, Omit<ComponentProps<typeof Combobox>, 'appearance' | 'clearable' | 'clearIcon' | 'expandIcon' | 'input' | 'listbox' | 'root' | 'value'> & { emptyMessage: string; value: string }>(
  ({ className, emptyMessage, positioning, value, ...props }, ref) => {
    const styles = useStyles();
    const inputRef = useRef<HTMLInputElement>(null);
    const mirrorRef = useRef<HTMLSpanElement>(null);
    const mergedRef = useMergedRefs(ref, inputRef);
    useLayoutEffect(() => {
      const input = inputRef.current!;
      const mirror = mirrorRef.current!;
      if (mirror.getBoundingClientRect().height === 0) return;
      const context = document.createElement('canvas').getContext('2d')!;
      let mounted = true;
      // Native inputs center their untrimmed font box. Match the mirror's
      // trimmed baseline without changing the path's layout or input behavior.
      // https://html.spec.whatwg.org/multipage/canvas.html#textmetrics
      const align = () => {
        if (!mounted) return;
        context.font = getComputedStyle(mirror).font;
        const { fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: descent } = context.measureText('H');
        const range = document.createRange();
        range.selectNodeContents(mirror);
        const textBaseline = range.getBoundingClientRect().top - mirror.getBoundingClientRect().top + ascent;
        const inputBaseline = Math.floor((input.getBoundingClientRect().height - ascent - descent) / 2) + ascent;
        input.style.transform = `translateY(${Math.round(textBaseline - inputBaseline)}px)`;
      };
      align();
      const observer = new ResizeObserver(align);
      observer.observe(mirror);
      void document.fonts.ready.then(align);
      document.fonts.addEventListener('loadingdone', align);
      return () => { mounted = false; observer.disconnect(); document.fonts.removeEventListener('loadingdone', align); };
    }, [className]);
    const renderRoot: SlotRenderFunction<ComponentProps<'div'>> = (Component, rootProps) => <Component {...rootProps}>
      <span aria-hidden className={mergeClasses('floway-control-label', styles.mirror)} data-inline-combobox-mirror="" ref={mirrorRef}>{value || '\u200b'}</span>
      {rootProps.children}
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
      ref={mergedRef}
      value={value}
    />;
  },
);
