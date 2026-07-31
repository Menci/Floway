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

interface MotionSlotProps { children?: unknown }
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

  // MenuFlyout's open and close. WinUI reveals a menu rather than moving it:
  // the presenter slides in from half its own height while a clip slides the
  // other way by exactly as much, which pins the visible window to the final
  // layout box and lets only the content travel through it. A menu below its
  // trigger therefore starts as its own bottom half drawn in the top half of
  // the box, and grows downward; one above its trigger starts as its top half
  // in the bottom half, and grows upward. Nothing fades in.
  //
  // XAML applies this clip inside the render transform, which is also what CSS
  // does with `clip-path`, so the pair transcribes directly onto one element and
  // `inset()`'s percentages resolve against the box without measuring anything.
  // The direction is the only input, and WinUI takes it from the placement --
  // Bottom only when the flyout sits above its target, Top otherwise.
  //
  // The 250ms reveal is the whole of the open. Closing is a bare 83ms linear
  // fade with no transform at all: WinUI's two directions are not a matched
  // pair here, and the clip keyframes its close registers hold one constant
  // value at both ends, pinning an interrupted open rather than animating.
  //
  // The submenu's deeper 0.67 ratio is not reproduced. Fluent renders a submenu
  // through the same components as a menu and writes nothing that tells them
  // apart, so there is no term in the DOM to branch on.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/MenuPopupThemeTransition_Partial.h#L24-L25
  // https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/LayoutTransition_partial.cpp#L423-L563
  // The slide is written to the `translate` property rather than into
  // `transform`, because `transform` is where Fluent's positioning already
  // lives: a popover is placed by translating it to the coordinates the
  // positioning engine computed, and a keyframe naming `transform` replaces
  // that outright and plays the whole reveal at the origin of the containing
  // block. `translate` composes with it instead.
  const MenuSurfaceMotion = components.createPresenceComponent(({ element }) => {
    const above = element.getAttribute('data-popper-placement')?.startsWith('top') ?? false;
    const closedOffset = above ? '0 50%' : '0 -50%';
    // The clip has to clear the surface's own elevation shadow, or it holds it
    // suppressed for the whole reveal and snaps it in when the animation drops.
    // Only the three edges that do not travel can go outside the box: beyond
    // the travelling edge lies the element's own translated body, which the
    // clip cannot tell from shadow, and a negative value there lets the surface
    // overshoot its final position mid-flight.
    //
    // 32px is headroom over what shadow16 needs. A blur radius spreads a shadow
    // by about its own length past the offset edge, so shadow16's key term,
    // 0 8px 16px, reaches about 24px below the border box and 16px to either
    // side, and its ambient term, 0 0 2px, about 2px all round.
    // https://www.w3.org/TR/css-backgrounds-3/#shadow-blur
    // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/tokens/src/utils/shadows.ts
    const closedClip = above ? 'inset(-32px -32px 50% -32px)' : 'inset(50% -32px -32px -32px)';
    const openClip = above ? 'inset(-32px -32px 0% -32px)' : 'inset(0% -32px -32px -32px)';

    return {
      enter: {
        keyframes: [
          { translate: closedOffset, clipPath: closedClip },
          { translate: '0 0', clipPath: openClip },
        ],
        duration: CONTROL_NORMAL_ANIMATION_MS,
        easing: CONTROL_FAST_OUT_SLOW_IN_EASING,
      },
      exit: fadeOut,
    };
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

  // Popover keeps Fluent's motion. Its WinUI counterpart is Flyout, whose
  // PopupThemeTransition reads its duration and easing out of the Windows theme
  // at runtime through uxtheme rather than declaring them; the only number the
  // source states is a 50 DIP entrance offset. There is nothing to transcribe
  // without reading it off a running Windows machine.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/FlyoutBase_partial.cpp#L69
  return {
    ...components,
    Dialog: runMotion(components.Dialog, 'surfaceMotion', DialogSurfaceMotion),
    DialogSurface: runMotion(components.DialogSurface, 'backdropMotion', DialogBackdropMotion),
    Menu: runMotion(components.Menu, 'surfaceMotion', MenuSurfaceMotion),
  };
};
