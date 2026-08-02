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

// Read-only, as distinct from disabled: a disabled control says the setting is
// not available, a read-only one says the value is but this operator does not
// set it. Fluent has it only for a text field, and HTML ignores `readonly` on a
// checkbox outright, so it is built the same way for each here -- the control
// stays enabled and keeps its own appearance, `aria-readonly` states the fact,
// and the change is refused at the source.
interface ReadOnlyProp {
  readOnly?: boolean;
}

// Fluent's minimum width and the wrapped input's own `min-width: auto` form an
// intrinsic floor that propagates up through every auto-sized grid track above
// the control, so a field in a fluid column can push its whole layout wider than
// the container. Zeroing both lets the column decide.
const MIN_WIDTH_CLASS = '!min-w-[0px] [&_input]:!min-w-[0px]';

// A select is only as wide as the value it currently shows, so a column of them
// has nothing to line up on. Prior art: PowerToys declares one 240 action-slot
// width for its whole settings surface, WinUI states only a 64px collapse floor,
// and the Community Toolkit's SettingsCard pushes an implicit 120 into its
// content scope.
// https://github.com/microsoft/PowerToys/blob/d2c53bf3861ed2688a1c30aafd66ea0fc0186399/src/settings-ui/Settings.UI/SettingsXAML/App.xaml#L68
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L321-L323
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L146-L170
//
// Here the floor is off by default and carried by a variable rather than a
// second class, so a caller sets a value instead of racing the `!important` this
// one needs to clear Fluent's own 250px. ./settings-card.tsx is the only place
// that raises it.
const SELECT_MIN_WIDTH_CLASS = '!min-w-[var(--floway-select-min-width,0px)] [&_input]:!min-w-[0px]';

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
// stroke is one unit in a twenty-unit box, so at 12px it is six tenths of a
// pixel of ink and no pixel reaches full strength -- measured, the darkest came
// out 145 where a solid glyph on that fill reaches 97.
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
  freeform,
  listboxProps,
}: {
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
          empty list arrives as a bordered seam a few pixels tall. Screen reader
          users meeting one are more likely to read it as a bug than an answer.

          The row must be an option: axe escalates any bare text node inside a
          listbox from review to a hard violation, so a plain div saying "no
          results" is worse than saying nothing. It also needs the `disabled`
          prop rather than `aria-disabled` -- Fluent's useOption reads
          props.disabled, so aria-disabled alone leaves the row selectable and
          eligible to become the active descendant.
          https://w3c.github.io/aria/#mustContain
          https://www.24a11y.com/2019/select-your-poison-part-2/ */}
      <div className="floway-combobox-listbox-content">
        {Children.toArray(children).length === 0
          ? <Option disabled value="">{t(freeform ? 'common.noSuggestions' : 'common.noOptions')}</Option>
          : children}
      </div>
    </div>,
  );
}

// MUI and Ant Design both suppress the message outright on a free-text field,
// reasoning that an empty suggestion list is not a failure. That reasoning is
// about announcing a failure; a row stating there is nothing to suggest
// announces none, and it keeps the control from changing shape.
const listboxRenderer = (freeform: boolean): ListboxRenderFunction =>
  (ListboxComponent, listboxProps) => (
    <ScrollableListbox ListboxComponent={ListboxComponent} freeform={freeform} listboxProps={listboxProps} />
  );

// Fluent writes the control's measured width straight onto the list, which pins
// a narrow control's list to the shortest thing it can offer and truncates every
// longer option. `listWidth="content"` keeps the measurement as a floor and lets
// the list grow past it, which is only useful together with an `align: 'end'`
// positioning: the list has to hang off the trailing edge and open away from it,
// or it would grow off the page.
const CONTENT_WIDTH_LISTBOX_CLASS = '!w-max !min-w-[var(--fui-match-target-size)] !max-w-[calc(100vw-16px)]';

const listboxFor = (listWidth: 'target' | 'content' | undefined, freeform: boolean) => ({
  children: listboxRenderer(freeform),
  ...(listWidth === 'content' ? { className: CONTENT_WIDTH_LISTBOX_CLASS } : {}),
});

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
      listbox={listboxFor(listWidth, props.freeform === true)}
      className={mergeClasses(className, SELECT_MIN_WIDTH_CLASS)}
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
      listbox={listboxFor(listWidth, false)}
      className={mergeClasses(className, SELECT_MIN_WIDTH_CLASS)}
      ref={ref}
    />
  ),
);

// A checkbox and a switch are both a native checkbox, for which HTML defines
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
