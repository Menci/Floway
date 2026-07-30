// Fluent v9 keeps `appearance` off the DOM: `primary`, `subtle`, `transparent`,
// `outline` and `underline` exist only as hashed Griffel atoms composed in
// JavaScript, so no CSS selector can name one variant. The WinUI layer needs to,
// because several WinUI traits belong to one appearance and must not reach the
// others — the elevation stroke of a default Button above all, which a plain
// border rule on the root would also paint onto the deliberately borderless
// subtle and transparent buttons.
//
// The wrappers below put the resolved appearance back on the DOM as
// `data-winui-appearance`, so `winui/controls/*.css.ts` can address exactly one
// variant. They wrap the components at the single runtime chokepoint in
// `fluent.ts`, which is the only module in the app that imports
// `@fluentui/react-components` for values.
//
// The other axis a WinUI rule needs — a toggle's checked state — is already in
// the DOM: Fluent writes `aria-pressed`, or `aria-checked` when the role is
// checkbox-like, so nothing here has to restate it.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/utils/useToggleState.ts#L49
import { CheckmarkCircleFilled, DismissCircleFilled, ErrorCircleFilled, InfoFilled } from '@fluentui/react-icons';
import * as React from 'react';

type FluentComponents = typeof import('@fluentui/react-components');

export const winuiAppearanceAttribute = 'data-winui-appearance';
export const winuiIntentAttribute = 'data-winui-intent';
export const winuiSizeAttribute = 'data-winui-size';
export const winuiShapeAttribute = 'data-winui-shape';

type SlotProps = Record<string, unknown>;
type PropCarrier = Record<string, unknown>;
type IntentCarrier = { intent?: string; icon?: React.ReactNode };

// A top-level prop does not always reach the element that carries the WinUI
// trait, so each component also names the slots that must be stamped. When the
// root IS the primary slot — every button, and Link — unrecognised props reach
// the root element on their own and the list is empty. When it is not,
// `getPartitionedNativeProps` forwards everything except `style` and
// `className` to the primary slot, so a top-level `data-*` lands on the inner
// `<input>` or `<button>` and never on the `.fui-Input`, `.fui-Combobox` or
// `.fui-Dropdown` root; those name `root`, and end up
// stamped twice so a rule can address whichever element carries the trait it is
// restating. SplitButton is a third shape: its root is a plain `<div>` and the
// two `.fui-Button` elements are slots it renders from Fluent's own unwrapped
// Button and MenuButton, which this module cannot reach any other way.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-utilities/src/utils/getNativeElementProps.ts#L86-L118
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/components/SplitButton/useSplitButton.ts#L32-L57
const rootIsPrimary: readonly string[] = [];
const rootAndPrimary = ['root'] as const;
const splitButtonSlots = ['primaryActionButton', 'menuButton'] as const;

// Each default is Fluent's own for that component, read from its state hook —
// they do not agree, so none of them may be assumed. ToggleButton, ToolbarButton
// and CompoundButton take theirs from the plain button hook they delegate to.
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
// `overrides.inputDefaultAppearance ?? 'outline'`. That context is reachable
// only through `@fluentui/react-shared-contexts`, which `react-components` does
// not re-export, so `outline` is the value this app can resolve.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInput.ts#L21
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-textarea/library/src/components/Textarea/useTextarea.ts#L21
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-select/library/src/components/Select/useSelect.ts#L21
//
// Card defaults to `filled`, and its root is its primary slot, so the stamp
// reaches the painted element on its own. Its three companions — CardHeader,
// CardFooter and CardPreview — declare no appearance at all and are left
// unwrapped.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCard.ts#L54
export const withWinuiAppearance = (components: FluentComponents): FluentComponents => {
  // A slot arrives as a props object, a string, a number, an iterable or a JSX
  // element, and only the first of those can take one more prop by merging.
  // Reusing Fluent's own normalization folds the other four into
  // `{ children: value }` exactly as the component itself would, so a stamped
  // slot still accepts every shape the unwrapped component accepts. `null` is
  // the one value left alone: it is how a caller suppresses an optional slot,
  // and merging into it would render the slot back.
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-utilities/src/compose/slot.ts#L82-L93
  const resolveSlotProps = components.slot.resolveShorthand as (value: unknown) => SlotProps | undefined;

  // One axis of one component: the prop Fluent resolves in JavaScript, the
  // attribute the sheets read it back through, the default Fluent would have
  // applied, and the slots that need it in addition to the root.
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
  const size = (fallback: string) => ({ prop: 'size', attribute: winuiSizeAttribute, fallback });
  const shape = (fallback: string, slots?: readonly string[]) =>
    ({ prop: 'shape', attribute: winuiShapeAttribute, fallback, slots });

  // WinUI draws an InfoBar's severity as a filled disc with the symbol knocked
  // out of it, and picks the disc by severity. Fluent tints one outline glyph
  // instead and settles the choice in JavaScript, writing nothing a selector
  // could name, so both the shape and the reachability have to be answered
  // here. Each intent gets the filled counterpart of the glyph Fluent would
  // have drawn, and the intent is stamped so the sheet can finally colour it.
  // A caller that passes its own icon keeps it.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L5-L16
  const severityIcons: Record<string, React.ComponentType> = {
    error: DismissCircleFilled,
    warning: ErrorCircleFilled,
    success: CheckmarkCircleFilled,
    info: InfoFilled,
  };
  const stampIntent = <Component>(component: Component): Component => {
    const elementType = component as React.ElementType;
    const wrapped = React.forwardRef<unknown, IntentCarrier>((props, ref) => {
      const intent = props.intent ?? 'info';
      const Severity = severityIcons[intent];
      return React.createElement(elementType, {
        ...props,
        [winuiIntentAttribute]: intent,
        icon: props.icon ?? (Severity ? React.createElement(Severity) : undefined),
        ref,
      });
    });
    wrapped.displayName = (component as { displayName?: string }).displayName;
    return wrapped as Component;
  };

  return {
    ...components,
    MessageBar: stampIntent(components.MessageBar),
    Badge: stamp(components.Badge, size('medium')),
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
  };
};
