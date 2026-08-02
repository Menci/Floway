// TabList and Tab restyled after WinUI 3's inline tab strip: Pivot supplies the
// shape, TabView the foreground ramp. Nothing in the corpus picks between
// Pivot's legacy SystemControl* brushes and TabView's modern TextFillColor*
// resources; the modern layer is our choice, and it lets selection outrank the
// pointer instead of the reverse.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L47-L53
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L504-L574
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L265-L285
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L12-L21
//
// The foreground ramp is the inline strip's alone, because Fluent's circular
// appearances set color: inherit on the label so it reads on the chip's fill.
// The strip is named through the stamp ../appearance.ts writes for TabList.
// The chip shape has no WinUI counterpart and is kept, but its fill follows
// WinUI: a tab surface is transparent in every state, selected included, in
// both SelectorBarItem and PivotHeaderItem. So subtle-circular loses Fluent's
// tinted-accent fill and rejoins the ramp, carrying selection on the accent
// ring Fluent already draws through colorCompoundBrandStroke. filled-circular
// keeps its fill: a solid accent under an on-accent label is what WinUI states
// for an accent-intent control, and theme.ts maps both halves of that pair.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tabs/library/src/components/Tab/useTabStyles.styles.ts#L184-L189
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar_themeresources.xaml#L21-L25
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L40-L46
//
// Focus stays Fluent's: PivotHeaderItem draws no per-item focus visual, and
// transcribing that silence would leave the strip looking unfocusable.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L486
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L587
//
// The disabled foreground is left to Fluent: it withholds `aria-selected` from
// a disabled tab, so no selector below reaches one, and its disabled atom
// already resolves to TextFillColorDisabled.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tabs/library/src/components/Tab/useTab.ts#L97-L99
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L16
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L21
//
// Rules run rest → hover → pressed → selected, and each selected step repeats
// the interaction pseudo-classes it has to outweigh.
const inlineStrip = ".fui-TabList:not([data-winui-appearance$='-circular'])";
const subtleChip = ".fui-TabList[data-winui-appearance='subtle-circular']";

export const tabsCss = `
/* TabViewItemHeaderForegroundPointerOver resolves to the same
   TextFillColorSecondary as rest, so the pointer alone carries the state.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L15
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L20 */
${inlineStrip} .fui-Tab:enabled:hover .fui-Tab__content.fui-Tab__content,
${inlineStrip} .fui-Tab:enabled:hover .fui-Tab__icon.fui-Tab__icon {
  color: var(--winui-text-fill-secondary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L13
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L18 */
${inlineStrip} .fui-Tab:enabled:active .fui-Tab__content.fui-Tab__content,
${inlineStrip} .fui-Tab:enabled:active .fui-Tab__icon.fui-Tab__icon {
  color: var(--winui-text-fill-tertiary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L14 */
${inlineStrip} .fui-Tab[aria-selected='true'] .fui-Tab__content.fui-Tab__content {
  color: var(--winui-text-fill-primary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L19 */
${inlineStrip} .fui-Tab[aria-selected='true'] .fui-Tab__icon.fui-Tab__icon {
  color: var(--winui-text-fill-primary);
}

/* Selection holds the primary fill through both pointer states in WinUI, but
   Fluent moves it in both, hence these two combinations.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView.xaml#L354-L372
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView.xaml#L373-L391 */
${inlineStrip} .fui-Tab[aria-selected='true']:enabled:hover .fui-Tab__content.fui-Tab__content,
${inlineStrip} .fui-Tab[aria-selected='true']:enabled:hover .fui-Tab__icon.fui-Tab__icon,
${inlineStrip} .fui-Tab[aria-selected='true']:enabled:active .fui-Tab__content.fui-Tab__content,
${inlineStrip} .fui-Tab[aria-selected='true']:enabled:active .fui-Tab__icon.fui-Tab__icon {
  color: var(--winui-text-fill-primary);
}

/* The subtle chip drops Fluent's tinted-accent fill in all three of its
   selected states and takes the selected foreground the inline strip already
   uses; the label and icon inherit it through the circular base. Selection
   still outranks the pointer, as above.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar_themeresources.xaml#L21-L25
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar_themeresources.xaml#L18
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L19 */
${subtleChip} .fui-Tab[aria-selected='true'],
${subtleChip} .fui-Tab[aria-selected='true']:enabled:hover,
${subtleChip} .fui-Tab[aria-selected='true']:enabled:active {
  background-color: transparent;
  color: var(--winui-text-fill-primary);
}

/* Repainted only outside High Contrast: Fluent's forced-colors rules hold these
   pseudo-elements on Highlight and ButtonText, and a media query carries no
   specificity, so our rules would otherwise win inside that mode.
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tabs/library/src/components/Tab/useTabStyles.styles.ts#L359-L366
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tabs/library/src/components/Tab/useTabStyles.styles.ts#L453-L463 */
@media not (forced-colors: active) {
  /* Every unselected Pivot state collapses SelectedPipe, so Fluent's neutral
     selection-preview bar is nulled out; it contributes only a fill.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L536-L538
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L559-L561 */
  .fui-Tab.fui-Tab:hover::before,
  .fui-Tab.fui-Tab:active::before {
    background-color: transparent;
  }

  /* SelectedPipe takes its fill once from the template and no visual state
     overrides it, so Fluent's hover and pressed steps collapse onto the one
     accent fill.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L587
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L55
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L189 */
  .fui-Tab.fui-Tab::after,
  .fui-Tab.fui-Tab:enabled:hover::after,
  .fui-Tab.fui-Tab:enabled:active::after {
    background-color: var(--winui-accent-fill-default);
  }

  /* A disabled tab collapses the pipe outright rather than greying it.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L499-L501 */
  .fui-Tab.fui-Tab:disabled::after {
    background-color: transparent;
  }
}

/* Pivot floats the pipe clear of the header's bottom edge with a 2px margin
   where Fluent sits it flush, and states its thickness once as 3px. Horizontal
   only: Fluent's vertical strip reuses the bottom inset as the far edge of a
   left-edge bar, and there is no vertical Pivot to transcribe. Unscoped by tab
   size: Pivot has a single header size, so the one float and the one thickness
   cover Fluent's three, and only the small strip moves, since Fluent's medium
   and large already resolve to the same 3px.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L587 */
.fui-TabList[aria-orientation='horizontal'] > .fui-Tab.fui-Tab::after {
  bottom: 2px;
  height: 3px;
}

/* Pivot collapses every unselected pipe rather than moving one, so it states no
   timing for a travel and WinUI's general motion tokens stand in. The
   no-preference wrapper is insurance: Fluent's reduced-motion rule already sets
   transition-property to none.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L602-L603 */
@media (prefers-reduced-motion: no-preference) {
  .fui-Tab.fui-Tab::after {
    transition-duration: var(--winui-control-normal-animation-duration);
    transition-timing-function: var(--winui-control-fast-out-slow-in-easing);
  }
}

/* Selection does not move the label's weight, in any appearance: Pivot states
   FontWeight once as a style setter that no visual state can reach, and
   SelectorBarItem pins it to Normal. The placeholder holds the width the label
   would take once selected, so it follows the label back to regular weight
   rather than padding every tab by the semibold delta.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L478
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SelectorBar/SelectorBar.xaml#L58 */
.fui-Tab[aria-selected='true'] .fui-Tab__content.fui-Tab__content,
.fui-Tab__content--reserved-space.fui-Tab__content--reserved-space {
  font-weight: var(--fontWeightRegular);
}
`;
