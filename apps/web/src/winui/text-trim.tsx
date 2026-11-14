import { Fragment, isValidElement } from 'react';
import type { ComponentProps, ReactNode } from 'react';

import { wrapFluent } from './wrap';
import type { FluentComponents } from './wrap';

const trimLabel = (children: ReactNode) => {
  // Structured labels own their layout. Another block around an inline-flex
  // label would add a line box and change its height or baseline.
  if (children == null || typeof children === 'boolean' || children === '' || (isValidElement(children) && children.type !== Fragment)) return children;
  return <span className="floway-control-label">{children}</span>;
};

export const withTextTrim = (components: FluentComponents): FluentComponents => {
  const trim = <Component,>(component: Component): Component => wrapFluent(component, (props: { children?: ReactNode }) => ({
    ...props,
    children: trimLabel(props.children),
  }));

  const useCounterText = (props: ComponentProps<typeof components.CounterBadge>) => {
    // Fluent owns count/overflow formatting and whether a zero or dot has
    // visible text. Reuse its resolved label without duplicating those rules.
    const state = components.useCounterBadge_unstable(props, null);
    return { ...props, children: trimLabel(state.root.children) };
  };

  return {
    ...components,
    Button: trim(components.Button),
    ToggleButton: trim(components.ToggleButton),
    CompoundButton: trim(components.CompoundButton),
    MenuButton: trim(components.MenuButton),
    SplitButton: trim(components.SplitButton),
    ToolbarButton: trim(components.ToolbarButton),
    ToolbarToggleButton: trim(components.ToolbarToggleButton),
    ToolbarRadioButton: trim(components.ToolbarRadioButton),
    Badge: trim(components.Badge),
    CounterBadge: wrapFluent(components.CounterBadge, useCounterText),
    NavItem: trim(components.NavItem),
    NavSubItem: trim(components.NavSubItem),
    NavCategoryItem: trim(components.NavCategoryItem),
    Tab: trim(components.Tab),
    MenuItem: trim(components.MenuItem),
    MenuItemCheckbox: trim(components.MenuItemCheckbox),
    MenuItemRadio: trim(components.MenuItemRadio),
    MenuItemLink: trim(components.MenuItemLink),
    MenuItemSwitch: trim(components.MenuItemSwitch),
  };
};
