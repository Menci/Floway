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
import * as React from 'react';

type FluentComponents = typeof import('@fluentui/react-components');

export const winuiAppearanceAttribute = 'data-winui-appearance';

type SlotProps = Record<string, unknown>;
type AppearanceCarrier = { appearance?: string } & SlotProps;

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
// Input and Textarea spell their default as
// `overrides.inputDefaultAppearance ?? 'outline'`. That context is reachable
// only through `@fluentui/react-shared-contexts`, which `react-components` does
// not re-export, so `outline` is the value this app can resolve.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInput.ts#L21
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-textarea/library/src/components/Textarea/useTextarea.ts#L21
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

  const stampAppearance = <Component>(
    component: Component,
    defaultAppearance: string,
    stampedSlots: readonly string[],
  ): Component => {
    const elementType = component as React.ElementType;

    const wrapped = React.forwardRef<unknown, AppearanceCarrier>((props, ref) => {
      const stamp = { [winuiAppearanceAttribute]: props.appearance ?? defaultAppearance };
      const stampedSlotProps = Object.fromEntries(
        stampedSlots
          .filter(name => props[name] !== null)
          .map(name => [name, { ...resolveSlotProps(props[name]), ...stamp }]),
      );

      return React.createElement(elementType, { ...props, ...stamp, ...stampedSlotProps, ref });
    });

    wrapped.displayName = (component as { displayName?: string }).displayName;

    return wrapped as Component;
  };

  return {
    ...components,
    Button: stampAppearance(components.Button, 'secondary', rootIsPrimary),
    ToggleButton: stampAppearance(components.ToggleButton, 'secondary', rootIsPrimary),
    CompoundButton: stampAppearance(components.CompoundButton, 'secondary', rootIsPrimary),
    MenuButton: stampAppearance(components.MenuButton, 'secondary', rootIsPrimary),
    SplitButton: stampAppearance(components.SplitButton, 'secondary', splitButtonSlots),
    ToolbarButton: stampAppearance(components.ToolbarButton, 'subtle', rootIsPrimary),
    ToolbarToggleButton: stampAppearance(components.ToolbarToggleButton, 'subtle', rootIsPrimary),
    ToolbarRadioButton: stampAppearance(components.ToolbarRadioButton, 'subtle', rootIsPrimary),
    Link: stampAppearance(components.Link, 'default', rootIsPrimary),
    Input: stampAppearance(components.Input, 'outline', rootAndPrimary),
    Textarea: stampAppearance(components.Textarea, 'outline', rootAndPrimary),
    Combobox: stampAppearance(components.Combobox, 'outline', rootAndPrimary),
    Dropdown: stampAppearance(components.Dropdown, 'outline', rootAndPrimary),
    Card: stampAppearance(components.Card, 'filled', rootIsPrimary),
  };
};
