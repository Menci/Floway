// Fluent v9 keeps `appearance` off the DOM — the variants exist only as hashed
// Griffel atoms composed in JavaScript, so no CSS selector can name one. These
// wrappers put the resolved value back as `data-winui-*` so
// `winui/controls/*.css.ts` can address exactly one variant. A toggle's checked
// state needs no stamp: Fluent already writes `aria-pressed`/`aria-checked`.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/utils/useToggleState.ts#L49
import { CheckmarkCircleFilled, ChevronDown12Regular, DismissCircleFilled, ErrorCircleFilled, InfoFilled } from '@fluentui/react-icons';
import * as React from 'react';

type FluentComponents = typeof import('@fluentui/react-components');

export const winuiAppearanceAttribute = 'data-winui-appearance';
export const winuiIntentAttribute = 'data-winui-intent';
export const winuiSizeAttribute = 'data-winui-size';
export const winuiShapeAttribute = 'data-winui-shape';

type SlotProps = Record<string, unknown>;
type PropCarrier = Record<string, unknown>;
type MessageBarIntent = 'error' | 'warning' | 'success' | 'info';
interface IntentCarrier { intent?: MessageBarIntent; icon?: React.ReactNode }

// A top-level prop does not always reach the element that carries the WinUI
// trait. Where the root is not the primary slot, `getPartitionedNativeProps`
// forwards everything but `style` and `className` to the primary slot, so a
// top-level `data-*` lands on the inner `<input>`/`<textarea>`/`<select>` and
// never on the `.fui-*` root; those name `root` and get stamped twice.
// SplitButton's root is a plain `<div>` whose two `.fui-Button` elements come
// from Fluent's own unwrapped Button and MenuButton, unreachable any other way.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-utilities/src/utils/getNativeElementProps.ts#L86-L118
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/components/SplitButton/useSplitButton.ts#L32-L57
const rootIsPrimary: readonly string[] = [];
const rootAndPrimary = ['root'] as const;
const splitButtonSlots = ['primaryActionButton', 'menuButton'] as const;

// Each fallback below is Fluent's own default for that component, read from its
// state hook — they do not agree, so none may be assumed. The three Toolbar
// buttons delegate a base hook that carries no default and name `subtle`
// themselves.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/components/Button/useButton.ts#L20
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/components/ToggleButton/useToggleButton.ts#L19
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/components/CompoundButton/useCompoundButton.ts#L21
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/components/MenuButton/useMenuButton.tsx#L64
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/components/SplitButton/useSplitButton.ts#L17
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-toolbar/library/src/components/ToolbarButton/useToolbarButton.ts#L22
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-toolbar/library/src/components/ToolbarToggleButton/useToolbarToggleButton.ts#L24
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-toolbar/library/src/components/ToolbarRadioButton/useToolbarRadioButton.ts#L25
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-link/library/src/components/Link/useLink.ts#L20
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-combobox/library/src/components/Dropdown/useDropdown.tsx#L165
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-combobox/library/src/components/Combobox/useCombobox.tsx#L216
//
// Input, Textarea and Select spell their default as
// `overrides.inputDefaultAppearance ?? 'outline'`, and that context is reachable
// only through `@fluentui/react-shared-contexts`, which `react-components` does
// not re-export — so `outline` is the value this app can resolve.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInput.ts#L21
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-textarea/library/src/components/Textarea/useTextarea.ts#L21
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-select/library/src/components/Select/useSelect.ts#L21
//
// Card defaults to `filled`; its three companions declare no appearance at all
// and are left unwrapped.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCard.ts#L54
export const withWinuiAppearance = (components: FluentComponents): FluentComponents => {
  // A slot arrives as a props object, a string, a number, an iterable or a JSX
  // element, and only the first can take one more prop by merging. Fluent's own
  // normalization folds the other four into `{ children: value }`. `null` is
  // left alone: it is how a caller suppresses an optional slot, and merging into
  // it would render the slot back.
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-utilities/src/compose/slot.ts#L82-L93
  const resolveSlotProps = components.slot.resolveShorthand as (value: unknown) => SlotProps | undefined;

  const stamp = <Component>(
    component: Component,
    axis: { prop: string; attribute: string; fallback: string; slots?: readonly string[] },
  ): Component => {
    const elementType = component as React.ElementType;

    const wrapped = React.forwardRef<unknown, PropCarrier>((props, ref) => {
      const mark = { [axis.attribute]: props[axis.prop] ?? axis.fallback };
      const stampedSlotProps = Object.fromEntries(
        (axis.slots ?? [])
          .filter(name => props[name] !== null)
          .map(name => [name, { ...resolveSlotProps(props[name]), ...mark }]),
      );

      return React.createElement(elementType, { ...props, ...mark, ...stampedSlotProps, ref });
    });

    wrapped.displayName = (component as { displayName?: string }).displayName;

    return wrapped as Component;
  };

  const appearance = (fallback: string, slots?: readonly string[]) =>
    ({ prop: 'appearance', attribute: winuiAppearanceAttribute, fallback, slots });
  const size = (fallback: string, slots?: readonly string[]) =>
    ({ prop: 'size', attribute: winuiSizeAttribute, fallback, slots });
  const shape = (fallback: string, slots?: readonly string[]) =>
    ({ prop: 'shape', attribute: winuiShapeAttribute, fallback, slots });

  // Every InfoBar severity is a circle in WinUI. Fluent reaches for a diamond
  // for `error` and a triangle for `warning`, so those two are replaced with
  // their circular counterparts and the agreeing pair is restated so the whole
  // map reads in one place. The intent is stamped alongside because Fluent
  // settles it in JavaScript and writes nothing a selector could name.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L70-L74
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar.xaml#L107-L110
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-message-bar/library/src/components/MessageBar/getIntentIcon.tsx#L7-L19
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-message-bar/library/src/components/MessageBar/useMessageBar.ts#L22
  const severityIcons: Record<MessageBarIntent, React.ComponentType> = {
    error: DismissCircleFilled,
    warning: ErrorCircleFilled,
    success: CheckmarkCircleFilled,
    info: InfoFilled,
  };
  const stampIntent = <Component>(component: Component): Component => {
    const elementType = component as React.ElementType;
    const wrapped = React.forwardRef<unknown, IntentCarrier>((props, ref) => {
      const intent = props.intent ?? 'info';
      return React.createElement(elementType, {
        ...props,
        [winuiIntentAttribute]: intent,
        icon: props.icon === undefined ? React.createElement(severityIcons[intent]) : props.icon,
        ref,
      });
    });
    wrapped.displayName = (component as { displayName?: string }).displayName;
    return wrapped as Component;
  };

  // Expander puts its chevron at the end of the header row and points it down
  // when collapsed, where Fluent leads with it and points it right. Fluent also
  // hands the 20px chevron artwork to a 12px box, which is what makes the arrow
  // read thin -- WinUI states 12 for this glyph and the icon set has a 12px cut.
  // Fluent only rotates the chevron it supplies itself, so once the children are
  // ours the turn belongs to ./controls/accordion.css.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L82-L85
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L280-L281
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-accordion/library/src/components/AccordionHeader/useAccordionHeader.tsx#L42-L50
  const winuiChevron = <Component>(component: Component): Component => {
    const elementType = component as React.ElementType;
    const wrapped = React.forwardRef<unknown, PropCarrier>((props, ref) => React.createElement(elementType, {
      expandIconPosition: 'end',
      ...props,
      expandIcon: props.expandIcon ?? { children: React.createElement(ChevronDown12Regular) },
      ref,
    }));
    wrapped.displayName = (component as { displayName?: string }).displayName;
    return wrapped as Component;
  };

  // The map covers Fluent's whole appearance-carrying surface rather than the
  // subset the dashboard renders today, so a component reached for later arrives
  // already stamped. A wrapper costs one allocation at module scope and nothing
  // at all until its component is used.
  return {
    ...components,
    AccordionHeader: winuiChevron(components.AccordionHeader),
    MessageBar: stampIntent(components.MessageBar),
    Button: stamp(components.Button, appearance('secondary', rootIsPrimary)),
    ToggleButton: stamp(components.ToggleButton, appearance('secondary', rootIsPrimary)),
    CompoundButton: stamp(components.CompoundButton, appearance('secondary', rootIsPrimary)),
    MenuButton: stamp(components.MenuButton, appearance('secondary', rootIsPrimary)),
    SplitButton: stamp(components.SplitButton, appearance('secondary', splitButtonSlots)),
    ToolbarButton: stamp(components.ToolbarButton, appearance('subtle', rootIsPrimary)),
    ToolbarToggleButton: stamp(components.ToolbarToggleButton, appearance('subtle', rootIsPrimary)),
    ToolbarRadioButton: stamp(components.ToolbarRadioButton, appearance('subtle', rootIsPrimary)),
    Link: stamp(components.Link, appearance('default', rootIsPrimary)),
    Input: stamp(components.Input, appearance('outline', rootAndPrimary)),
    Textarea: stamp(components.Textarea, appearance('outline', rootAndPrimary)),
    Select: stamp(components.Select, appearance('outline', rootAndPrimary)),
    Combobox: stamp(components.Combobox, appearance('outline', rootAndPrimary)),
    Dropdown: stamp(components.Dropdown, appearance('outline', rootAndPrimary)),
    Card: stamp(components.Card, appearance('filled', rootIsPrimary)),
    Checkbox: stamp(components.Checkbox, shape('square', rootAndPrimary)),
    Switch: stamp(components.Switch, size('medium', rootAndPrimary)),
  };
};
