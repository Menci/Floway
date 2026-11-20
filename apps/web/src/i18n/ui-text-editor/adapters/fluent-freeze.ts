import * as React from 'react';

import { defaultKeyMarkerChannel, type KeyMarkerChannel } from '../core/markers';

type PropCarrier = Record<string, unknown>;

interface OpenCarrier extends PropCarrier {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (event: unknown, data: { open: boolean }) => void;
}

interface VisibleCarrier extends PropCarrier {
  visible?: boolean;
  onVisibleChange?: (event: unknown, data: { visible: boolean }) => void;
}

interface OptionCarrier extends PropCarrier {
  text?: string;
}

export interface FreezableFluentNamespace {
  Tooltip: unknown;
  Popover: unknown;
  Menu: unknown;
  Dropdown: unknown;
  Combobox: unknown;
  Dialog: unknown;
  OverlayDrawer: unknown;
  Option: unknown;
}

export interface FluentFreezeController {
  setFreezeActive: (next: boolean) => void;
  InternalContext: React.Context<boolean>;
  wrapComponents: <T extends FreezableFluentNamespace>(components: T, enabled: boolean) => T;
}

const wrapComponent = <Component, Props extends object = PropCarrier>(
  component: Component,
  mapProps: (props: Props) => object,
): Component => {
  const elementType = component as React.ElementType;
  const wrapped = (props: Props) => React.createElement(elementType, mapProps(props));
  return Object.assign(wrapped, {
    displayName: (component as { displayName?: string }).displayName,
  }) as Component;
};

// Freezes Fluent UI v9 floating controls (tooltips, popovers, menus, dialogs,
// drawers) while the editor holds them open, and strips zero-width markers
// from Option.text so keyboard typeahead still matches leading characters.
export const createFluentFreezeController = (
  channel: KeyMarkerChannel = defaultKeyMarkerChannel,
): FluentFreezeController => {
  let frozen = false;
  const InternalContext = React.createContext(false);

  const wrapOpenSurface = <Component>(component: Component): Component =>
    wrapComponent(component, (props: OpenCarrier) => {
      const insideEditor = React.useContext(InternalContext);
      const controlled = props.open !== undefined;
      const [uncontrolledOpen, setUncontrolledOpen] = React.useState<boolean>(() => Boolean(props.defaultOpen));
      const currentOpen = controlled ? Boolean(props.open) : uncontrolledOpen;
      const { defaultOpen: _droppedDefaultOpen, ...rest } = props;

      return {
        ...rest,
        open: currentOpen,
        onOpenChange: (event: unknown, data: { open: boolean }) => {
          if (!insideEditor && !data.open && frozen) return;
          if (!controlled) setUncontrolledOpen(data.open);
          props.onOpenChange?.(event, data);
        },
      };
    });

  const wrapTooltipSurface = <Component>(component: Component): Component =>
    wrapComponent(component, (props: VisibleCarrier) => {
      const insideEditor = React.useContext(InternalContext);
      const controlled = props.visible !== undefined;
      const [uncontrolledVisible, setUncontrolledVisible] = React.useState(false);
      const currentVisible = controlled ? Boolean(props.visible) : uncontrolledVisible;

      return {
        ...props,
        visible: currentVisible,
        onVisibleChange: (event: unknown, data: { visible: boolean }) => {
          if (!insideEditor && !data.visible && frozen) return;
          if (!controlled) setUncontrolledVisible(data.visible);
          props.onVisibleChange?.(event, data);
        },
      };
    });

  const wrapOptionText = <Component>(component: Component): Component =>
    wrapComponent(component, (props: OptionCarrier) => {
      if (typeof props.text !== 'string' || !channel.mayContain(props.text)) return props;
      return { ...props, text: channel.strip(props.text) };
    });

  return {
    setFreezeActive(next: boolean) {
      frozen = next;
    },
    InternalContext,
    wrapComponents<T extends FreezableFluentNamespace>(components: T, enabled: boolean): T {
      if (!enabled) return components;
      return {
        ...components,
        Tooltip: wrapTooltipSurface(components.Tooltip),
        Popover: wrapOpenSurface(components.Popover),
        Menu: wrapOpenSurface(components.Menu),
        Dropdown: wrapOpenSurface(components.Dropdown),
        Combobox: wrapOpenSurface(components.Combobox),
        Dialog: wrapOpenSurface(components.Dialog),
        OverlayDrawer: wrapOpenSurface(components.OverlayDrawer),
        Option: wrapOptionText(components.Option),
      };
    },
  };
};
