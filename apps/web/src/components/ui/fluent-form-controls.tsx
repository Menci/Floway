import type { ListboxProps } from '@fluentui/react-components';
import { ChevronDown12Regular } from '@fluentui/react-icons';
import { Children, createElement, forwardRef, useLayoutEffect, useRef } from 'react';
import type { ComponentProps, ElementType, MouseEvent, ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { initializeScrollArea, scrollAreaHostClassName, useOverlayScrollbarsEnabled } from './scroll-area';
import { fluentComponents } from '../../fluent';

const {
  Checkbox: FluentCheckbox,
  Combobox: FluentCombobox,
  Dropdown: FluentDropdown,
  Input: FluentInput,
  Option,
  Switch: FluentSwitch,
  Textarea: FluentTextarea,
  mergeClasses,
  useMergedRefs,
} = fluentComponents;

// Read-only, as distinct from disabled: the setting is available, this operator
// just does not set it. Fluent offers it only on a text field, so every control
// here stays enabled and keeps its own appearance, states `aria-readonly`, and
// refuses the change at the source.
interface ReadOnlyProp {
  readOnly?: boolean;
}

// Fluent's minimum width and the wrapped input's own `min-width: auto` form an
// intrinsic floor that propagates up through every auto-sized grid track above
// the control, so a field in a fluid column can push its layout wider than the
// container. Zeroing both lets the column decide.
const MIN_WIDTH_CLASS = '!min-w-[0px] [&_input]:!min-w-[0px]';

// A select is only as wide as the value it currently shows, so clearing Fluent's
// 250px leaves nothing under it. The floor is WinUI's own ComboBoxThemeMinWidth,
// stated as a token in ../../winui/tokens.ts, and the variable raises it where a
// column of selects has to line up. Carried by a variable rather than a second
// class, so a caller sets a value instead of racing the `!important` this one
// needs to clear Fluent's.
const SELECT_MIN_WIDTH_CLASS = '!min-w-[var(--floway-select-min-width,var(--winui-combo-box-min-width))] [&_input]:!min-w-[0px]';

// Fluent flips the popup to whichever side has room for its natural height, so
// a long list ends up beside the field rather than under it. Restricting the
// fallbacks to the opposite edge keeps the list attached, and `autoSize` trims
// it to the space that edge has instead of moving it.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-positioning/library/src/types.ts#L244-L264
export const LISTBOX_POSITIONING = {
  position: 'below',
  align: 'start',
  autoSize: 'height',
  fallbackPositions: ['above'],
  overflowBoundaryPadding: 8,
} satisfies NonNullable<ComponentProps<typeof FluentCombobox>['positioning']>;

// The 12px cut rather than Fluent's default 20px artwork scaled down: that
// stroke is one unit in a twenty-unit box, so at 12px no pixel reaches full
// strength -- measured, the darkest came out 145 where a solid glyph on that
// fill reaches 97.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L582-L586
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
  emptyMessage,
  freeform,
  listboxProps,
}: {
  emptyMessage: string | undefined;
  freeform: boolean;
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
  const { t } = useTranslation();
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
    // JSX rather than createElement, so the ref is a ref to the compiler and not
    // an ordinary prop it has to assume is read in render.
    <div className="floway-combobox-listbox-viewport" ref={viewportRef} style={{ overflowX: 'hidden', overflowY: 'scroll' }}>
      {/* Fluent opens the popup whether or not there is anything in it, so an
          empty list would arrive as a bordered seam a few pixels tall. Filling
          it is not an ARIA obligation, despite appearances: 1.3 renamed the
          section to Allowed Accessibility Child Roles and dropped the existence
          requirement, 1.2's MUST applied only while loading, and axe files an
          empty listbox as review-only. The row must be an option: axe escalates
          a bare text node inside a listbox from review to a hard violation.
          Fluent ships this shape itself in useComboboxFilter's
          noOptionsMessage; this is that row with the one correction its version
          needs, the `disabled` prop rather than `aria-disabled` -- Fluent's
          useOption reads props.disabled, so aria-disabled alone leaves the row
          selectable and eligible to become the active descendant.
          https://w3c.github.io/aria/#mustContain */}
      <div className="floway-combobox-listbox-content">
        {Children.toArray(children).length === 0
          ? <Option disabled value="">{emptyMessage ?? t(freeform ? 'common.noSuggestions' : 'common.noOptions')}</Option>
          : children}
      </div>
    </div>,
  );
}

// MUI and Ant Design suppress the message outright on a free-text field, taking
// an empty suggestion list for a non-failure. A row stating there is nothing to
// suggest announces no failure either, and keeps the control from changing shape.
const listboxRenderer = (freeform: boolean, emptyMessage: string | undefined): ListboxRenderFunction =>
  (ListboxComponent, listboxProps) => (
    <ScrollableListbox ListboxComponent={ListboxComponent} emptyMessage={emptyMessage} freeform={freeform} listboxProps={listboxProps} />
  );

// Fluent writes the control's measured width straight onto the list, truncating
// every option longer than a narrow control. `listWidth="content"` keeps the
// measurement as a floor and lets the list grow past it, which is only usable
// together with an `align: 'end'` positioning -- the list has to hang off the
// trailing edge and open away from it, or it would grow off the page.
const CONTENT_WIDTH_LISTBOX_CLASS = '!w-max !min-w-[var(--fui-match-target-size)] !max-w-[calc(100vw-16px)]';

const listboxFor = (listWidth: 'target' | 'content' | undefined, freeform: boolean, emptyMessage: string | undefined) => ({
  children: listboxRenderer(freeform, emptyMessage),
  ...(listWidth === 'content' ? { className: CONTENT_WIDTH_LISTBOX_CLASS } : {}),
});

interface ListWidthProp {
  listWidth?: 'target' | 'content';
}

// A caller that filters its own options says here what it wants the empty
// result to read as, instead of adding a row of its own beside this one.
interface EmptyMessageProp {
  emptyMessage?: string;
}

export const Input = forwardRef<HTMLInputElement, ComponentProps<typeof FluentInput>>(
  ({ className, ...props }, ref) => (
    <FluentInput {...props} className={mergeClasses(className, MIN_WIDTH_CLASS)} ref={ref} />
  ),
) as typeof FluentInput;

// WinUI carries one ComboBox style and no variant beside it, so Fluent's
// underline, filled-darker and filled-lighter fills have nothing to be faithful
// to and ../../winui/controls/select.css.ts restyles none of them. Withholding
// the prop leaves Fluent's own outline default as the only thing either control
// can render.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L358-L359
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-combobox/library/src/components/Combobox/useCombobox.tsx#L216
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-combobox/library/src/components/Dropdown/useDropdown.tsx#L165
export const Combobox = forwardRef<HTMLInputElement, Omit<ComponentProps<typeof FluentCombobox>, 'appearance' | 'listbox'> & ListWidthProp & EmptyMessageProp & ReadOnlyProp>(
  ({ className, emptyMessage, expandIcon, listWidth, onOptionSelect, positioning, readOnly, ...props }, ref) => (
    <FluentCombobox
      {...props}
      aria-readonly={readOnly === true ? true : undefined}
      expandIcon={expandIcon === undefined ? EXPAND_ICON : expandIcon}
      input={{ readOnly, ...(typeof props.input === 'object' && props.input !== null ? props.input : {}) }}
      onOptionSelect={readOnly === true ? undefined : onOptionSelect}
      positioning={positioning ?? LISTBOX_POSITIONING}
      listbox={listboxFor(listWidth, props.freeform === true, emptyMessage)}
      className={mergeClasses(className, SELECT_MIN_WIDTH_CLASS)}
      ref={ref}
    />
  ),
);

export const Dropdown = forwardRef<HTMLButtonElement, Omit<ComponentProps<typeof FluentDropdown>, 'appearance' | 'listbox'> & ListWidthProp & EmptyMessageProp & ReadOnlyProp>(
  ({ className, emptyMessage, expandIcon, listWidth, onOptionSelect, positioning, readOnly, ...props }, ref) => (
    <FluentDropdown
      {...props}
      aria-readonly={readOnly === true ? true : undefined}
      expandIcon={expandIcon === undefined ? EXPAND_ICON : expandIcon}
      onOptionSelect={readOnly === true ? undefined : onOptionSelect}
      positioning={positioning ?? LISTBOX_POSITIONING}
      listbox={listboxFor(listWidth, false, emptyMessage)}
      className={mergeClasses(className, SELECT_MIN_WIDTH_CLASS)}
      ref={ref}
    />
  ),
);

// A checkbox and a switch are both a native checkbox, on which HTML accepts
// `readonly` and does nothing with it. Cancelling the click refuses the change,
// since that is the default action the toggle is.
const refuseToggle = (event: MouseEvent<HTMLInputElement>) => event.preventDefault();

export const Checkbox = forwardRef<HTMLInputElement, ComponentProps<typeof FluentCheckbox> & ReadOnlyProp>(
  ({ input, onChange, readOnly, ...props }, ref) => (
    <FluentCheckbox
      {...props}
      aria-readonly={readOnly === true ? true : undefined}
      input={{ onClick: readOnly === true ? refuseToggle : undefined, ...(typeof input === 'object' && input !== null ? input : {}) }}
      onChange={readOnly === true ? undefined : onChange}
      ref={ref}
    />
  ),
);

export const Switch = forwardRef<HTMLInputElement, ComponentProps<typeof FluentSwitch> & ReadOnlyProp>(
  ({ input, onChange, readOnly, ...props }, ref) => (
    <FluentSwitch
      {...props}
      aria-readonly={readOnly === true ? true : undefined}
      input={{ onClick: readOnly === true ? refuseToggle : undefined, ...(typeof input === 'object' && input !== null ? input : {}) }}
      onChange={readOnly === true ? undefined : onChange}
      ref={ref}
    />
  ),
);

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<typeof FluentTextarea>>(
  ({ className, ...props }, ref) => (
    <FluentTextarea {...props} className={mergeClasses(className, MIN_WIDTH_CLASS)} ref={ref} />
  ),
) as typeof FluentTextarea;
