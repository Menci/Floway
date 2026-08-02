// Fluent v9 resolves `appearance` into hashed Griffel atoms and keeps it off the
// DOM, so no CSS selector can name a variant. These wrappers put the resolved
// value back as `data-winui-*` for `winui/controls/*.css.ts` to address.
import { CheckmarkCircleFilled, ChevronDown12Regular, DismissCircleFilled, ErrorCircleFilled, InfoFilled } from '@fluentui/react-icons';
import * as React from 'react';

import { COLLAPSE_ANIMATION_MS, CONTROL_FAST_OUT_SLOW_IN_EASING, EXPAND_ANIMATION_MS } from './motion';

type FluentComponents = typeof import('@fluentui/react-components');

export const winuiAppearanceAttribute = 'data-winui-appearance';
const winuiIntentAttribute = 'data-winui-intent';
const winuiSizeAttribute = 'data-winui-size';
export const winuiCheckedAttribute = 'data-winui-checked';

type SlotProps = Record<string, unknown>;
type PropCarrier = Record<string, unknown>;
type MessageBarIntent = 'error' | 'warning' | 'success' | 'info';
interface IntentCarrier { intent?: MessageBarIntent; icon?: React.ReactNode }
type CheckedState = boolean | 'mixed';
interface CheckedCarrier {
  checked?: CheckedState;
  defaultChecked?: CheckedState;
  onChange?: (ev: React.ChangeEvent<HTMLInputElement>, data: { checked: CheckedState }) => void;
}

// Where the root is not the primary slot, `getPartitionedNativeProps` forwards a
// top-level `data-*` to the inner `<input>`/`<textarea>`/`<select>` instead of
// the `.fui-*` root, so those name `root` and get stamped twice. SplitButton's
// root is a plain `<div>` whose `.fui-Button` children are unreachable otherwise.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-utilities/src/utils/getNativeElementProps.ts#L86-L118
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-button/library/src/components/SplitButton/useSplitButton.ts#L32-L57
const rootIsPrimary: readonly string[] = [];
const rootAndPrimary = ['root'] as const;
const splitButtonSlots = ['primaryActionButton', 'menuButton'] as const;

// Each fallback below is Fluent's own default for that component, read from its
// state hook — they do not agree, so none may be assumed. The Toolbar buttons
// delegate a base hook carrying no default and name `subtle` themselves.
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
// `overrides.inputDefaultAppearance ?? 'outline'`, whose context
// `react-components` does not re-export — so `outline` is what this app resolves.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-input/library/src/components/Input/useInput.ts#L21
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-textarea/library/src/components/Textarea/useTextarea.ts#L21
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-select/library/src/components/Select/useSelect.tsx#L21
//
// Card defaults to `filled`; its companions declare no appearance and stay
// unwrapped. TableRow defaults to `none`, and its selected appearances are a
// second, independent selection signal beside aria-selected.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCard.ts#L54
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-table/library/src/components/TableRow/useTableRow.ts#L21
//
// A Tab reads its appearance from TabList's context and never carries it
// itself, so the strip is what gets stamped and the tab rules select through
// it.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tabs/library/src/components/TabList/useTabList.tsx#L20
export const withWinuiAppearance = (components: FluentComponents): FluentComponents => {
  // Only a props object can take one more prop by merging; Fluent's own
  // normalization folds the other shorthand forms into `{ children: value }`.
  // `null` is left alone — merging into it would render a suppressed slot back.
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

  // A tri-state check box carries its mixed state only as the input's
  // `indeterminate` property, which Fluent assigns from a layout effect keyed on
  // that state. The browser clears the property on user activation, and the
  // effect does not re-run while the state stays mixed, so `:indeterminate` is
  // gone for good on a box held at mixed while Fluent keeps painting mixed. The
  // resolved tri-state is stamped instead, and ./controls/choice.css.ts reads
  // the stamp rather than the property.
  //
  // Fluent's own resolution is mirrored here: the prop wins where it is given,
  // otherwise the last value its onChange reported, seeded from defaultChecked.
  // https://html.spec.whatwg.org/multipage/input.html#the-input-element:legacy-pre-activation-behavior
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-checkbox/library/src/components/Checkbox/useCheckbox.tsx#L163-L169
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-checkbox/library/src/components/Checkbox/useCheckbox.tsx#L93-L97
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-checkbox/library/src/components/Checkbox/useCheckbox.tsx#L152-L156
  const stampCheckedState = <Component>(component: Component): Component => {
    const elementType = component as React.ElementType;

    const wrapped = React.forwardRef<unknown, CheckedCarrier>((props, ref) => {
      const [uncontrolled, setUncontrolled] = React.useState<CheckedState>(props.defaultChecked ?? false);
      const checked = props.checked ?? uncontrolled;

      return React.createElement(elementType, {
        ...props,
        [winuiCheckedAttribute]: String(checked),
        onChange: (ev: React.ChangeEvent<HTMLInputElement>, data: { checked: CheckedState }) => {
          setUncontrolled(data.checked);
          props.onChange?.(ev, data);
        },
        ref,
      });
    });

    wrapped.displayName = (component as { displayName?: string }).displayName;

    return wrapped as Component;
  };

  // The table builds the selection cell's check box itself, so the stamp reaches
  // it through that slot, carrying the cell's own tri-state. The slot is left
  // alone where the cell draws a radio or suppresses the box, because a slot
  // object of our making would render a box the cell had not asked for.
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-table/library/src/components/TableSelectionCell/useTableSelectionCell.ts#L20-L36
  const stampSelectionCellCheckedState = <Component>(component: Component): Component => {
    const elementType = component as React.ElementType;

    const wrapped = React.forwardRef<unknown, PropCarrier>((props, ref) => {
      const drawsCheckbox = (props.type ?? 'checkbox') === 'checkbox' && props.checkboxIndicator !== null;
      const checkboxIndicator = {
        ...resolveSlotProps(props.checkboxIndicator),
        [winuiCheckedAttribute]: String(props.checked ?? false),
      };

      return React.createElement(elementType, {
        ...props,
        ...(drawsCheckbox ? { checkboxIndicator } : {}),
        ref,
      });
    });

    wrapped.displayName = (component as { displayName?: string }).displayName;

    return wrapped as Component;
  };

  // Every InfoBar severity is a circle in WinUI, where Fluent reaches for a
  // diamond for `error` and a triangle for `warning`. The intent is stamped
  // alongside because Fluent settles it in JavaScript.
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

  // WinUI ends the header row with the chevron, points it down when collapsed,
  // and states 12 for the glyph where Fluent leads with it, points it right, and
  // hands 20px artwork to a 12px box. Fluent only rotates a chevron it supplies
  // itself, so with ours the turn belongs to ./controls/accordion.css.
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

  // WinUI's Expander slides its content region open and never touches its
  // opacity: all four expand storyboards animate ExpanderContent's Visibility
  // and TranslateY alone, and the template carries no opacity animation at all.
  // Fluent's Collapse fades the panel with the height, which takes the card's
  // own fill and stroke transparent mid-animation, so the fade atom is switched
  // off.
  //
  // The size animation then runs on the pair of durations those storyboards
  // state, 333ms opening and 167ms closing, read from ./motion so this and the
  // SettingsExpander cannot drift apart. What travels is the panel's own size
  // rather than the clipped translate WinUI animates -- the SettingsExpander's
  // simplification too -- and on that geometry both directions take the opening
  // KeySpline; nothing sources the substitution for the close, which upstream
  // states as cubic-bezier(1, 1, 0, 1).
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander.xaml#L33-L90
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-accordion/library/src/components/AccordionPanel/useAccordionPanel.ts#L42-L48
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-motion-components-preview/library/src/components/Collapse/Collapse.ts#L30-L48
  const winuiPanelMotion = <Component>(component: Component): Component => {
    const elementType = component as React.ElementType;
    const wrapped = React.forwardRef<unknown, PropCarrier>((props, ref) => React.createElement(elementType, {
      collapseMotion: {
        animateOpacity: false,
        duration: EXPAND_ANIMATION_MS,
        exitDuration: COLLAPSE_ANIMATION_MS,
        easing: CONTROL_FAST_OUT_SLOW_IN_EASING,
        exitEasing: CONTROL_FAST_OUT_SLOW_IN_EASING,
      },
      ...props,
      ref,
    }));
    wrapped.displayName = (component as { displayName?: string }).displayName;
    return wrapped as Component;
  };

  // The map covers Fluent's whole appearance-carrying surface, not just the
  // subset the dashboard renders today, so a later component arrives stamped.
  return {
    ...components,
    AccordionHeader: winuiChevron(components.AccordionHeader),
    AccordionPanel: winuiPanelMotion(components.AccordionPanel),
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
    TableRow: stamp(components.TableRow, appearance('none', rootIsPrimary)),
    TabList: stamp(components.TabList, appearance('transparent', rootIsPrimary)),
    Checkbox: stampCheckedState(components.Checkbox),
    TableSelectionCell: stampSelectionCellCheckedState(components.TableSelectionCell),
    Switch: stamp(components.Switch, size('medium', rootAndPrimary)),
  };
};
