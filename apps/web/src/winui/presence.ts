// Every motion Fluent runs from JavaScript, restated as WinUI states it. A
// component that animates takes its motion from a slot, so the slot is the one
// seam this file writes through: a presence component where WinUI states its own
// keyframes, motion parameters where Fluent's own component keeps the shape, and
// nothing at all where a stylesheet takes the motion over. Fluent's motion slot
// forbids `as`, so a presence component reaches it through the slot's render
// function rather than by being named.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-motion/library/src/slots/presenceMotionSlot.tsx#L13-L19
import * as React from 'react';

import {
  CHEVRON_TURN_EASING,
  CHEVRON_TURN_MS,
  COLLAPSE_ANIMATION_MS,
  CONTROL_FASTER_ANIMATION_MS,
  CONTROL_FAST_ANIMATION_MS,
  CONTROL_FAST_OUT_SLOW_IN_EASING,
  CONTROL_NORMAL_ANIMATION_MS,
  EXPAND_ANIMATION_MS,
  PANE_SLIDE_EASING,
  PANE_SLIDE_MS,
  PANE_SLIDE_OUT_MS,
  POPUP_FADE_DELAY_MS,
  POPUP_FADE_MS,
  POPUP_HIDE_MS,
  POPUP_SLIDE_EASING,
  POPUP_SLIDE_MS,
  POP_IN_OFFSET_PX,
} from './motion';
import { wrapFluent } from './wrap';
import type { FluentComponents, PropCarrier } from './wrap';

interface MotionSlotProps { children?: unknown }

// One rule for every motion slot this layer fills: ours is the base, a caller's
// object is merged over it -- onMotionFinish above all -- and a caller's null
// suppresses the slot rather than being merged into, which is how a caller
// switches the motion off entirely.
const resolveMotionSlot = (ours: PropCarrier | null, stated: PropCarrier | null | undefined) => {
  if (stated === undefined) return ours;
  if (stated === null) return null;
  return { ...ours, ...stated };
};

const motionSlot = <Component>(component: Component, slot: string, ours: PropCarrier | null): Component =>
  wrapFluent(component, (props: PropCarrier) => ({
    ...props,
    [slot]: resolveMotionSlot(ours, props[slot] as PropCarrier | null | undefined),
  }));

// Filled in both directions: several opacity legs finish well before the
// transform they accompany, and their final value has to hold until the whole
// motion ends.
const fadeIn = { keyframes: [{ opacity: 0 }, { opacity: 1 }], duration: CONTROL_FASTER_ANIMATION_MS, easing: 'linear', fill: 'both' as const };
const fadeOut = { keyframes: [{ opacity: 1 }, { opacity: 0 }], duration: CONTROL_FASTER_ANIMATION_MS, easing: 'linear', fill: 'both' as const };

// Fluent parameterises a drawer's motion by its edge and the reading direction,
// and keeps the drawer's own extent in a custom property, which is what the
// closed offset is measured in.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-drawer/library/src/shared/drawerMotions.ts#L9-L11
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-drawer/library/src/shared/useDrawerBaseStyles.styles.ts#L11-L13
type DrawerMotionParams = {
  dir: 'ltr' | 'rtl';
  position: 'start' | 'end' | 'bottom';
};

const DRAWER_SIZE_VAR = '--fui-Drawer--size';

// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-drawer/library/src/shared/drawerMotions.ts#L24-L46
const closedDrawerTransform = ({ dir, position }: DrawerMotionParams): string => (position === 'bottom'
  ? `translate3d(0, var(${DRAWER_SIZE_VAR}), 0)`
  : `translate3d(calc(var(${DRAWER_SIZE_VAR}) * ${(position === 'start') === (dir === 'ltr') ? -1 : 1}), 0, 0)`);

// A toast is a floating surface with no edge to be clipped by, which is what the
// popup family is for: the arrival travels while a much shorter fade catches up,
// and the departure is that fade alone, with nothing to move a dismissed card
// across the stack it is leaving. The offset is stated on the horizontal because
// that is where the platform's own default puts it.
export const createToastPresence = (components: FluentComponents) => components.createPresenceComponent({
  enter: [
    {
      keyframes: [{ transform: `translateX(${POP_IN_OFFSET_PX}px)` }, { transform: 'none' }],
      duration: POPUP_SLIDE_MS,
      easing: POPUP_SLIDE_EASING,
    },
    { keyframes: [{ opacity: 0 }, { opacity: 1 }], duration: POPUP_FADE_MS, delay: POPUP_FADE_DELAY_MS, easing: 'linear', fill: 'both' },
  ],
  exit: { keyframes: [{ opacity: 1 }, { opacity: 0 }], duration: POPUP_HIDE_MS, easing: 'linear', fill: 'both' },
});

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

  // A drawer is SplitView's overlaying pane, which only travels: WinUI puts no
  // opacity and no shadow key frame on the pane itself, and NavigationView's
  // depth comes from a separate ShadowCaster element on the same spline, which
  // this layer does not transcribe -- see the tooltip note in ./tokens.ts for
  // how far WinUI depth is carried here. Fluent instead fades the surface in
  // and ramps shadow64 alongside the slide over a size-dependent duration, and
  // since it is the only shadow the drawer has, dropping the term leaves the
  // open surface flat.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/NavigationView/NavigationView.xaml#L96-L107
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitView/SplitView_themeresources.xaml#L185-L190
  // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-drawer/library/src/shared/drawerMotions.ts#L14-L19
  // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-drawer/library/src/shared/drawerMotions.ts#L85-L116
  // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-drawer/library/src/components/OverlayDrawer/useOverlayDrawerStyles.styles.ts#L20-L26
  const DrawerSurfaceMotion = components.createPresenceComponent<DrawerMotionParams>(params => {
    const closed = { transform: closedDrawerTransform(params) };
    const open = { transform: 'translate3d(0, 0, 0)' };

    return {
      enter: { keyframes: [closed, open], duration: PANE_SLIDE_MS, easing: PANE_SLIDE_EASING },
      exit: { keyframes: [open, closed], duration: PANE_SLIDE_OUT_MS, easing: PANE_SLIDE_EASING },
    };
  });

  // A nav category's chevron is the same AnimatedIcon as the Expander's, so it
  // turns on the same timing rather than Fluent's Rotate variant at
  // durationFast on curveEasyEase. The angles are Fluent's, and only the
  // rotation is animated -- the WinUI icon keeps its opacity throughout, which
  // is what Fluent's own `animateOpacity: false` already expresses.
  // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-nav/library/src/components/NavCategoryItem/useNavCategoryItem.tsx#L18-L24
  const chevronCollapsed = { rotate: '0deg' };
  const chevronExpanded = { rotate: '180deg' };
  const ChevronTurnMotion = components.createPresenceComponent({
    enter: { keyframes: [chevronCollapsed, chevronExpanded], duration: CHEVRON_TURN_MS, easing: CHEVRON_TURN_EASING },
    exit: { keyframes: [chevronExpanded, chevronCollapsed], duration: CHEVRON_TURN_MS, easing: CHEVRON_TURN_EASING },
  });

  const runMotion = <Component>(component: Component, slot: string, Motion: React.ElementType): Component =>
    motionSlot(component, slot, {
      children: (_: unknown, motionProps: MotionSlotProps) => React.createElement(Motion, motionProps),
    });

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
  // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-accordion/library/src/components/AccordionPanel/useAccordionPanel.ts#L42-L48
  // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-motion-components-preview/library/src/components/Collapse/Collapse.ts#L30-L48
  const panelCollapse = {
    animateOpacity: false,
    duration: EXPAND_ANIMATION_MS,
    exitDuration: COLLAPSE_ANIMATION_MS,
    easing: CONTROL_FAST_OUT_SLOW_IN_EASING,
    exitEasing: CONTROL_FAST_OUT_SLOW_IN_EASING,
  };

  return {
    ...components,
    AccordionPanel: motionSlot(components.AccordionPanel, 'collapseMotion', panelCollapse),
    Dialog: runMotion(components.Dialog, 'surfaceMotion', DialogSurfaceMotion),
    DialogSurface: runMotion(components.DialogSurface, 'backdropMotion', DialogBackdropMotion),
    Menu: runMotion(components.Menu, 'surfaceMotion', MenuSurfaceMotion),
    NavCategoryItem: runMotion(components.NavCategoryItem, 'expandIconMotion', ChevronTurnMotion),
    OverlayDrawer: runMotion(components.OverlayDrawer, 'surfaceMotion', DrawerSurfaceMotion),
    // Fluent runs the indeterminate ProgressBar from the Web Animations API
    // rather than a stylesheet -- one 33 per cent segment sweeping across in 3s,
    // or a full-width opacity pulse under a reduced-motion preference -- so no
    // rule can retime or reshape it. Its motion slot is documented as nullable,
    // and emptying it here is what hands the state to
    // ./progress-indeterminate.css, whose transcription of WinUI's own
    // storyboard is the only shape this control has.
    // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-progress/library/src/components/ProgressBar/progressBarMotions.ts#L8-L23
    // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-progress/library/src/components/ProgressBar/ProgressBar.types.ts#L13-L16
    ProgressBar: motionSlot(components.ProgressBar, 'indeterminateMotion', null),
  };
};
