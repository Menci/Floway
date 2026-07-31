import type { ListboxProps } from '@fluentui/react-components';
import { ChevronDown12Regular } from '@fluentui/react-icons';
import { createElement, forwardRef, useLayoutEffect, useRef } from 'react';
import type { ComponentProps, ElementType, ReactNode, Ref } from 'react';

import { initializeScrollArea, scrollAreaHostClassName, useOverlayScrollbarsEnabled } from './scroll-area';
import { fluentComponents } from '../../fluent';

const {
  Combobox: FluentCombobox,
  Dropdown: FluentDropdown,
  Input: FluentInput,
  Textarea: FluentTextarea,
  mergeClasses,
  useMergedRefs,
} = fluentComponents;

// Fluent sizes these controls with a minimum width, and the native input they
// wrap contributes its own `min-width: auto`. That intrinsic floor propagates
// up through every auto-sized grid track above the control, so a field in a
// fluid column can push its whole layout wider than the container. Zeroing both
// the wrapper and the native input lets the column decide.
const MIN_WIDTH_CLASS = '!min-w-[0px] [&_input]:!min-w-[0px]';

// Fluent lets the popup keep its natural height and flips it to whichever
// side has room for that height, so a long list ends up beside the field
// rather than under it. Restricting the fallbacks to the opposite edge keeps
// the list attached to its control, and `autoSize` then trims it to the space
// that edge actually has instead of moving it.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-positioning/library/src/types.ts#L244-L264
export const LISTBOX_POSITIONING = {
  position: 'below',
  align: 'start',
  autoSize: 'height',
  fallbackPositions: ['above'],
  overflowBoundaryPadding: 8,
} satisfies NonNullable<ComponentProps<typeof FluentCombobox>['positioning']>;

// The chevron is drawn at 12px, and Fluent's default is the 20px artwork scaled
// down to fit. Its stroke is one unit in a twenty-unit box, so at 12px it is
// six tenths of a pixel of ink and no pixel of the glyph ever reaches full
// strength -- measured, the darkest pixel came out 145 where a solid glyph on
// that fill reaches 97. WinUI draws the same chevron from Segoe Fluent Icons at
// a size the artwork was made for, which is why its arrow reads solid. The 12px
// cut of the same icon is that: one unit of stroke in a twelve-unit box.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ComboBox_themeresources.xaml#L582-L586
const EXPAND_ICON = <ChevronDown12Regular />;

type ListboxRenderFunction = (
  ListboxComponent: ElementType<ListboxProps>,
  listboxProps: Omit<ListboxProps, 'as'>,
) => ReactNode;
type ListboxRenderPropsWithRef = Omit<ListboxProps, 'as'> & {
  ref?: Ref<HTMLDivElement>;
};

function ScrollableListbox({
  ListboxComponent,
  listboxProps,
}: {
  ListboxComponent: ElementType<ListboxProps>;
  listboxProps: Omit<ListboxProps, 'as'>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const overlayScrollbarsEnabled = useOverlayScrollbarsEnabled();
  const {
    children,
    className,
    ref: fluentRef,
    style,
    ...rootProps
  } = listboxProps as ListboxRenderPropsWithRef;
  const mergedRef = useMergedRefs(fluentRef, hostRef);
  useLayoutEffect(() => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (!host || !viewport) return;
    return initializeScrollArea(host, viewport, 'vertical', true, overlayScrollbarsEnabled);
  }, [overlayScrollbarsEnabled]);

  return createElement(
    ListboxComponent as ElementType,
    {
      ...rootProps,
      className: mergeClasses(className, scrollAreaHostClassName, 'floway-combobox-listbox'),
      ...(overlayScrollbarsEnabled ? { 'data-overlayscrollbars-initialize': '' } : {}),
      ref: mergedRef,
      style: { ...style, overflowX: 'hidden', overflowY: 'hidden' },
    },
    // JSX rather than createElement for the viewport, so the ref is a ref to
    // the compiler and not an ordinary prop it has to assume is read in render.
    <div className="floway-combobox-listbox-viewport" ref={viewportRef} style={{ overflowX: 'hidden', overflowY: 'scroll' }}>
      <div className="floway-combobox-listbox-content">{children}</div>
    </div>,
  );
}

const renderScrollableListbox: ListboxRenderFunction = (ListboxComponent, listboxProps) => (
  <ScrollableListbox ListboxComponent={ListboxComponent} listboxProps={listboxProps} />
);

const SCROLLABLE_LISTBOX: NonNullable<ComponentProps<typeof FluentCombobox>['listbox']> = {
  children: renderScrollableListbox,
};

export const Input = forwardRef<HTMLInputElement, ComponentProps<typeof FluentInput>>(
  ({ className, ...props }, ref) => (
    <FluentInput {...props} className={mergeClasses(className, MIN_WIDTH_CLASS)} ref={ref} />
  ),
) as typeof FluentInput;

export const Combobox = forwardRef<HTMLInputElement, Omit<ComponentProps<typeof FluentCombobox>, 'listbox'>>(
  ({ className, expandIcon, positioning, ...props }, ref) => (
    <FluentCombobox
      {...props}
      expandIcon={expandIcon === undefined ? EXPAND_ICON : expandIcon}
      positioning={positioning ?? LISTBOX_POSITIONING}
      listbox={SCROLLABLE_LISTBOX}
      className={mergeClasses(className, MIN_WIDTH_CLASS)}
      ref={ref}
    />
  ),
);

export const Dropdown = forwardRef<HTMLButtonElement, Omit<ComponentProps<typeof FluentDropdown>, 'listbox'>>(
  ({ className, expandIcon, positioning, ...props }, ref) => (
    <FluentDropdown
      {...props}
      expandIcon={expandIcon === undefined ? EXPAND_ICON : expandIcon}
      positioning={positioning ?? LISTBOX_POSITIONING}
      listbox={SCROLLABLE_LISTBOX}
      className={mergeClasses(className, MIN_WIDTH_CLASS)}
      ref={ref}
    />
  ),
);

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<typeof FluentTextarea>>(
  ({ className, ...props }, ref) => (
    <FluentTextarea {...props} className={mergeClasses(className, MIN_WIDTH_CLASS)} ref={ref} />
  ),
) as typeof FluentTextarea;
