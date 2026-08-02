// Fluent's motion slot forbids `as`, so the animating component cannot be
// swapped by naming it; the slot's render function is the seam every wrapper
// below goes through.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-motion/library/src/slots/presenceMotionSlot.ts#L13-L19
import * as React from 'react';

import {
  CONTROL_FASTER_ANIMATION_MS,
  CONTROL_FAST_ANIMATION_MS,
  CONTROL_FAST_OUT_SLOW_IN_EASING,
  CONTROL_NORMAL_ANIMATION_MS,
} from './motion';

type FluentComponents = typeof import('@fluentui/react-components');

interface MotionSlotProps { children?: unknown }
type MotionCarrier = Record<string, unknown>;

// Filled in both directions: several opacity legs finish well before the
// transform they accompany, and their final value has to hold until the whole
// motion ends.
const fadeIn = { keyframes: [{ opacity: 0 }, { opacity: 1 }], duration: CONTROL_FASTER_ANIMATION_MS, easing: 'linear', fill: 'both' as const };
const fadeOut = { keyframes: [{ opacity: 1 }, { opacity: 0 }], duration: CONTROL_FASTER_ANIMATION_MS, easing: 'linear', fill: 'both' as const };

export const withWinuiMotion = (components: FluentComponents): FluentComponents => {
  // ContentDialog settles down from 1.05 rather than growing in from below 1,
  // and its fade is a separate, much shorter animation, so the surface is fully
  // opaque while it is still moving; Fluent's own motion disagrees on both.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L97-L113
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L74-L94
  const DialogSurfaceMotion = components.createPresenceComponent({
    enter: [
      {
        keyframes: [{ scale: 1.05 }, { scale: 1 }],
        duration: CONTROL_NORMAL_ANIMATION_MS,
        easing: CONTROL_FAST_OUT_SLOW_IN_EASING,
      },
      fadeIn,
    ],
    exit: [
      {
        keyframes: [{ scale: 1 }, { scale: 1.05 }],
        duration: CONTROL_FAST_ANIMATION_MS,
        easing: CONTROL_FAST_OUT_SLOW_IN_EASING,
      },
      fadeOut,
    ],
  });

  // ContentDialog gives the scale to the dialog's own background element and
  // the opacity to LayoutRoot, which is what the dim rides, so the backdrop
  // never moves. Fluent's default here is FadeRelaxed at durationGentle, 250ms.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L82-L93
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L101-L112
  // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-dialog/library/src/components/DialogBackdropMotion.ts#L1-L3
  // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-motion-components-preview/library/src/components/Fade/Fade.ts#L46
  // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-motion/library/src/motions/motionTokens.ts#L9
  const DialogBackdropMotion = components.createPresenceComponent({
    enter: fadeIn,
    exit: fadeOut,
  });

  // MenuFlyout's close, and only its close: the open is a CSS animation in
  // ./controls/menu.css, because its direction comes from the placement
  // attribute and that attribute is written after this factory has already run.
  // The close needs a presence component to hold the surface mounted while it
  // runs, since Fluent mounts a menu with `unmountOnExit`. WinUI's close carries
  // no transform -- the clip keyframes it registers hold one constant value at
  // both ends, pinning an interrupted open rather than animating.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/MenuPopupThemeTransition_Partial.h#L24-L25
  const MenuSurfaceMotion = components.createPresenceComponent({
    enter: [],
    exit: fadeOut,
  });

  // Slot props from the caller are spread last, so a caller that states its own
  // motion keeps it and anything else -- `onMotionFinish` above all -- rides
  // along with ours.
  const runMotion = <Component>(component: Component, slot: string, Motion: React.ElementType): Component => {
    const elementType = component as React.ElementType;
    const render = (_: unknown, motionProps: MotionSlotProps) => React.createElement(Motion, motionProps);

    const wrapped = React.forwardRef<unknown, MotionCarrier>((props, ref) => React.createElement(elementType, {
      ...props,
      [slot]: { children: render, ...(props[slot] as MotionCarrier | null | undefined) },
      ref,
    }));

    wrapped.displayName = (component as { displayName?: string }).displayName;

    return wrapped as Component;
  };

  // Popover keeps Fluent's motion: PopupThemeTransition reads duration and
  // easing out of the Windows theme at runtime through uxtheme rather than
  // declaring them, so there is nothing to transcribe.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/FlyoutBase_partial.cpp#L69
  return {
    ...components,
    Dialog: runMotion(components.Dialog, 'surfaceMotion', DialogSurfaceMotion),
    DialogSurface: runMotion(components.DialogSurface, 'backdropMotion', DialogBackdropMotion),
    Menu: runMotion(components.Menu, 'surfaceMotion', MenuSurfaceMotion),
  };
};
