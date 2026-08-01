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

// Read-only, as distinct from disabled. A disabled control says the setting is
// not available; a read-only one says the value is, and this operator is not
// the one who sets it -- an upstream whose catalog the provider owns is the
// case throughout. Fluent has it for a text field, where it reads exactly
// right: the field keeps its resting look, takes focus, and refuses the edit.
// Nothing else it ships has it, and the two that are inputs cannot: HTML
// ignores `readonly` on a checkbox outright.
//
// So it is built the same way for each: the control stays enabled and keeps
// its own appearance, `aria-readonly` states the fact, and the change is
// refused at the source. The list of a read-only combo box still opens, which
// is the same bargain a read-only text field makes by still taking a caret.
interface ReadOnlyProp {
  readOnly?: boolean;
}

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
    // JSX rather than createElement for the viewport, so the ref is a ref to
    // the compiler and not an ordinary prop it has to assume is read in render.
    <div className="floway-combobox-listbox-viewport" ref={viewportRef} style={{ overflowX: 'hidden', overflowY: 'scroll' }}>
      {/* Fluent opens the popup whether or not there is anything in it -- it
          counts options nowhere and gates only on disabled -- so an empty list
          arrived as a bordered seam a few pixels tall.

          Not an ARIA violation, despite appearances: 1.3 renamed the section to
          Allowed Accessibility Child Roles and dropped the existence
          requirement, 1.2's MUST applied only while loading, and axe files an
          empty listbox as review-only. The reason to do something is the user
          research rather than the spec -- screen reader users meeting an empty
          list were more likely to read it as a bug than as an answer.

          The row must be an option, though, and that is a real constraint:
          axe treats any bare text node inside a listbox as content and
          escalates it from review to a hard violation, so a plain div saying
          "no results" is worse than saying nothing. Fluent ships this shape
          itself in useComboboxFilter's noOptionsMessage; this is that row with
          the one correction its version needs, the disabled prop rather than
          aria-disabled. Fluent's useOption reads props.disabled, so
          aria-disabled alone leaves the row selectable and eligible to become
          the active descendant -- announced as inert without being inert.
          https://w3c.github.io/aria/#mustContain
          https://www.24a11y.com/2019/select-your-poison-part-2/ */}
      <div className="floway-combobox-listbox-content">
        {Children.toArray(children).length === 0
          ? <Option disabled value="">{t('common.noOptions')}</Option>
          : children}
      </div>
    </div>,
  );
}

const renderScrollableListbox: ListboxRenderFunction = (ListboxComponent, listboxProps) => (
  <ScrollableListbox ListboxComponent={ListboxComponent} listboxProps={listboxProps} />
);

const SCROLLABLE_LISTBOX: NonNullable<ComponentProps<typeof FluentCombobox>['listbox']> = {
  children: renderScrollableListbox,
};

// Fluent matches the list to the control it drops from, writing the measured
// width straight onto the list. That is right for a field, where the two read
// as one column, and wrong for a control that is only as wide as the value it
// currently shows -- there the list would be pinned to the shortest thing it
// can offer, and every longer option would truncate. `listWidth="content"`
// keeps the measurement as a floor and lets the list grow past it, which is
// only useful together with an `align: 'end'` positioning: the list has to hang
// off the trailing edge and open away from it, or it would grow off the page.
const CONTENT_WIDTH_LISTBOX: NonNullable<ComponentProps<typeof FluentCombobox>['listbox']> = {
  children: renderScrollableListbox,
  className: '!w-max !min-w-[var(--fui-match-target-size)] !max-w-[calc(100vw-16px)]',
};

const listboxFor = (listWidth: 'target' | 'content' | undefined) =>
  (listWidth === 'content' ? CONTENT_WIDTH_LISTBOX : SCROLLABLE_LISTBOX);

interface ListWidthProp {
  /** Whether the list is pinned to the control's width or free to exceed it. */
  listWidth?: 'target' | 'content';
}

export const Input = forwardRef<HTMLInputElement, ComponentProps<typeof FluentInput>>(
  ({ className, ...props }, ref) => (
    <FluentInput {...props} className={mergeClasses(className, MIN_WIDTH_CLASS)} ref={ref} />
  ),
) as typeof FluentInput;

export const Combobox = forwardRef<HTMLInputElement, Omit<ComponentProps<typeof FluentCombobox>, 'listbox'> & ListWidthProp & ReadOnlyProp>(
  ({ className, expandIcon, listWidth, onOptionSelect, positioning, readOnly, ...props }, ref) => (
    <FluentCombobox
      {...props}
      aria-readonly={readOnly === true ? true : undefined}
      expandIcon={expandIcon === undefined ? EXPAND_ICON : expandIcon}
      input={{ readOnly, ...(typeof props.input === 'object' && props.input !== null ? props.input : {}) }}
      onOptionSelect={readOnly === true ? undefined : onOptionSelect}
      positioning={positioning ?? LISTBOX_POSITIONING}
      listbox={listboxFor(listWidth)}
      className={mergeClasses(className, MIN_WIDTH_CLASS)}
      ref={ref}
    />
  ),
);

export const Dropdown = forwardRef<HTMLButtonElement, Omit<ComponentProps<typeof FluentDropdown>, 'listbox'> & ListWidthProp & ReadOnlyProp>(
  ({ className, expandIcon, listWidth, onOptionSelect, positioning, readOnly, ...props }, ref) => (
    <FluentDropdown
      {...props}
      aria-readonly={readOnly === true ? true : undefined}
      expandIcon={expandIcon === undefined ? EXPAND_ICON : expandIcon}
      onOptionSelect={readOnly === true ? undefined : onOptionSelect}
      positioning={positioning ?? LISTBOX_POSITIONING}
      listbox={listboxFor(listWidth)}
      className={mergeClasses(className, MIN_WIDTH_CLASS)}
      ref={ref}
    />
  ),
);

// A checkbox and a switch are both a native checkbox, which HTML gives no
// read-only behaviour at all: the attribute is defined for it and does nothing.
// Cancelling the click is what refuses the change, since that is the default
// action the toggle is.
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
