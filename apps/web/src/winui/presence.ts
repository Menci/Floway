// Fluent v9 animates its overlays with `@fluentui/react-motion` presence
// components, which drive the Web Animations API from JavaScript rather than
// from a stylesheet. None of it is reachable from `winui/controls/*.css.ts`,
// so an overlay whose motion has to change is changed here instead.
//
// Fluent exposes the motion as a slot -- `surfaceMotion` on Dialog, Popover,
// Menu and Drawer, `backdropMotion` on DialogSurface -- and the slot forbids
// `as`, so the component that runs the animation cannot be swapped for one of
// ours by naming it. What the slot does accept is a render function, which
// receives the props Fluent would have passed its own motion component and
// renders whatever it likes with them. That is the seam every wrapper below
// goes through.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-motion/library/src/slots/presenceMotionSlot.ts#L13-L19
import * as React from 'react';

import {
  CONTROL_FASTER_ANIMATION_MS,
  CONTROL_FAST_ANIMATION_MS,
  CONTROL_FAST_OUT_SLOW_IN_EASING,
  CONTROL_NORMAL_ANIMATION_MS,
} from './motion';

type FluentComponents = typeof import('@fluentui/react-components');

type MotionSlotProps = { children?: unknown };
type MotionCarrier = Record<string, unknown>;

// WinUI's opacity legs are all the same animation: 83ms, linear, and filled in
// both directions because several of them finish well before the transform they
// accompany and their final value has to hold until the whole motion ends.
const fadeIn = { keyframes: [{ opacity: 0 }, { opacity: 1 }], duration: CONTROL_FASTER_ANIMATION_MS, easing: 'linear', fill: 'both' as const };
const fadeOut = { keyframes: [{ opacity: 1 }, { opacity: 0 }], duration: CONTROL_FASTER_ANIMATION_MS, easing: 'linear', fill: 'both' as const };

export const withWinuiMotion = (components: FluentComponents): FluentComponents => {
  // ContentDialog's show and hide states, transcribed. The dialog settles down
  // onto the page from 1.05 rather than growing into it from below 1, and the
  // fade is a separate, much shorter animation -- 83ms against the scale's 250
  // -- so the surface is fully opaque while it is still moving. Fluent's own
  // motion disagrees on both counts: it scales up from 0.85 and fades across
  // the whole of the scale.
  //
  // The two runs are asymmetric in WinUI, and only in their duration: hiding
  // takes 167ms where showing takes 250, on the one spline both directions
  // share. The fade keeps the linear interpolation the source states, and is
  // filled in both directions because it finishes well before the scale does
  // and its final opacity has to hold until the whole motion ends.
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

  // The dimming layer behind the dialog. WinUI hands it its own keyframes and
  // gives it nothing but the opacity leg -- the scale targets the dialog's own
  // background element, so the backdrop never moves -- and runs it symmetrically
  // in both directions. Fluent fades it over 300ms, which outlasts even the
  // dialog's 250ms entrance, so the page is still dimming after the dialog has
  // arrived.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/LayoutTransition_partial.cpp
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-dialog/library/src/components/DialogBackdropMotion.ts
  const DialogBackdropMotion = components.createPresenceComponent({
    enter: fadeIn,
    exit: fadeOut,
  });

  // A caller that states its own motion keeps it, the same way a caller that
  // states its own appearance does.
  const runMotion = <Component>(component: Component, slot: string, Motion: React.ElementType): Component => {
    const elementType = component as React.ElementType;
    const render = (_: unknown, motionProps: MotionSlotProps) => React.createElement(Motion, motionProps);

    const wrapped = React.forwardRef<unknown, MotionCarrier>((props, ref) => React.createElement(elementType, {
      ...props,
      [slot]: props[slot] ?? { children: render },
      ref,
    }));

    wrapped.displayName = (component as { displayName?: string }).displayName;

    return wrapped as Component;
  };

  return {
    ...components,
    Dialog: runMotion(components.Dialog, 'surfaceMotion', DialogSurfaceMotion),
    DialogSurface: runMotion(components.DialogSurface, 'backdropMotion', DialogBackdropMotion),
  };
};
