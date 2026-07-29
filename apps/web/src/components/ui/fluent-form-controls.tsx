import type { ListboxProps } from '@fluentui/react-components';
import { createElement, forwardRef, useCallback, useLayoutEffect, useRef } from 'react';
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
const LISTBOX_POSITIONING: ComponentProps<typeof FluentCombobox>['positioning'] = {
  position: 'below',
  align: 'start',
  autoSize: 'height',
  fallbackPositions: ['above'],
  overflowBoundaryPadding: 8,
};

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
  const setViewportRef = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
  }, []);

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
    createElement('div', {
      className: 'floway-combobox-listbox-viewport',
      ref: setViewportRef,
      style: { overflowX: 'hidden', overflowY: 'scroll' },
    }, createElement('div', { className: 'floway-combobox-listbox-content' }, children)),
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
  ({ className, positioning, ...props }, ref) => (
    <FluentCombobox
      {...props}
      positioning={positioning ?? LISTBOX_POSITIONING}
      listbox={SCROLLABLE_LISTBOX}
      className={mergeClasses(className, MIN_WIDTH_CLASS)}
      ref={ref}
    />
  ),
);

export const Dropdown = forwardRef<HTMLButtonElement, Omit<ComponentProps<typeof FluentDropdown>, 'listbox'>>(
  ({ className, positioning, ...props }, ref) => (
    <FluentDropdown
      {...props}
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
