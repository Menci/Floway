import * as React from 'react';

import { isUiTextEditorEnabled } from './mirror';
import { wrapFluent, type FluentComponents, type PropCarrier } from '../../winui/wrap';

// Tracks whether the UI text editor currently wants open floating surfaces
// (tooltips, popovers, dropdowns, menus, dialogs, drawers) to resist dismissal.
// True while Alt is held or while an editor flyout/panel is open.
let frozen = false;

export const isUiTextEditorFreezeActive = (): boolean => frozen;

export const setUiTextEditorFreezeActive = (next: boolean): void => {
  frozen = next;
};

// Signals that a floating control lives inside the UI text editor's own chrome so
// its own confirmation flyouts and popovers open and close normally even while
// external page popovers are frozen.
export const UiTextEditorInternalContext = React.createContext(false);

interface OpenCarrier extends PropCarrier {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (event: unknown, data: { open: boolean }) => void;
}

interface VisibleCarrier extends PropCarrier {
  visible?: boolean;
  onVisibleChange?: (event: unknown, data: { visible: boolean }) => void;
}

// Wraps Fluent open/close floating controls so that, when the UI text editor is
// active, any dismissal request arriving while Alt is held or while the editor
// UI is open is ignored. Uncontrolled surfaces are always controlled from the
// first render so Fluent's `useControllableState` never warns about switching
// modes.
const wrapOpenSurface = <Component>(component: Component): Component =>
  wrapFluent(component, (props: OpenCarrier) => {
    const insideEditor = React.useContext(UiTextEditorInternalContext);
    const controlled = props.open !== undefined;
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState<boolean>(() => Boolean(props.defaultOpen));
    const currentOpen = controlled ? Boolean(props.open) : uncontrolledOpen;
    const { defaultOpen: _droppedDefaultOpen, ...rest } = props;

    return {
      ...rest,
      open: currentOpen,
      onOpenChange: (event: unknown, data: { open: boolean }) => {
        if (!insideEditor && !data.open && isUiTextEditorFreezeActive()) return;
        if (!controlled) setUncontrolledOpen(data.open);
        props.onOpenChange?.(event, data);
      },
    };
  });

const wrapTooltipSurface = <Component>(component: Component): Component =>
  wrapFluent(component, (props: VisibleCarrier) => {
    const insideEditor = React.useContext(UiTextEditorInternalContext);
    const controlled = props.visible !== undefined;
    const [uncontrolledVisible, setUncontrolledVisible] = React.useState(false);
    const currentVisible = controlled ? Boolean(props.visible) : uncontrolledVisible;

    return {
      ...props,
      visible: currentVisible,
      onVisibleChange: (event: unknown, data: { visible: boolean }) => {
        if (!insideEditor && !data.visible && isUiTextEditorFreezeActive()) return;
        if (!controlled) setUncontrolledVisible(data.visible);
        props.onVisibleChange?.(event, data);
      },
    };
  });

export const withUiTextEditorFreeze = (components: FluentComponents): FluentComponents => {
  if (!isUiTextEditorEnabled()) return components;
  return {
    ...components,
    Tooltip: wrapTooltipSurface(components.Tooltip),
    Popover: wrapOpenSurface(components.Popover),
    Menu: wrapOpenSurface(components.Menu),
    Dropdown: wrapOpenSurface(components.Dropdown),
    Combobox: wrapOpenSurface(components.Combobox),
    Dialog: wrapOpenSurface(components.Dialog),
    OverlayDrawer: wrapOpenSurface(components.OverlayDrawer),
  };
};
