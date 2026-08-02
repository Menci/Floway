// TabList and Tab restyled after WinUI 3's inline tab strip: Pivot supplies the
// shape, TabView the foreground ramp. Pivot routes its four foreground states
// through the legacy SystemControl* brushes while TabView states the same four
// over the modern TextFillColor* resources this file already speaks; nothing in
// the corpus picks between them, so the modern layer is our choice, not a
// source. They differ visibly — Pivot brightens an unselected item under the
// pointer and dims the selected one, TabView lets selection outrank the pointer
// entirely, which is what the rules below implement.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L47-L53
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L504-L574
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L265-L285
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L12-L21
//
// Fluent's appearance variants are carried entirely by Griffel atoms with no
// class or attribute to select them by, so the foreground ramp reaches the two
// circular appearances too, outranking the `color: inherit` they set so a
// brand-filled chip can hand its foreground down. A selected filled chip
// therefore shows WinUI's primary text over Fluent's brand fill; accepted
// rather than chasing hashed atoms.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tabs/library/src/components/Tab/useTabStyles.styles.ts#L184-L189
//
// Focus stays Fluent's by choice: PivotHeaderItem draws no per-item focus
// visual, and transcribing that silence would leave the strip looking
// unfocusable.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L486
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L587
//
// The disabled foreground is left to Fluent: it withholds `aria-selected` from
// a disabled tab, so no selector below reaches one, and its disabled atom
// already resolves to TextFillColorDisabled through the theme.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tabs/library/src/components/Tab/useTab.ts#L97-L99
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L16
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L21
//
// The state rules are ordered rest → hover → pressed → selected, and each
// selected step repeats the interaction pseudo-classes of the step it has to
// outweigh, so a pressed selected tab still reads as selected.
export const tabsCss = `
/* TabViewItemHeaderForegroundPointerOver resolves to the same
   TextFillColorSecondary as rest, so the pointer alone carries the state.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L15
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L20 */
.fui-Tab:enabled:hover .fui-Tab__content.fui-Tab__content,
.fui-Tab:enabled:hover .fui-Tab__icon.fui-Tab__icon {
  color: var(--winui-text-fill-secondary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L13
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L18 */
.fui-Tab:enabled:active .fui-Tab__content.fui-Tab__content,
.fui-Tab:enabled:active .fui-Tab__icon.fui-Tab__icon {
  color: var(--winui-text-fill-tertiary);
}

/* The label keeps its weight: PivotHeaderItem sets FontWeight once as a style
   setter, which no visual state can reach.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L14
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L478 */
.fui-Tab[aria-selected='true'] .fui-Tab__content.fui-Tab__content {
  color: var(--winui-text-fill-primary);
  font-weight: var(--fontWeightRegular);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L19 */
.fui-Tab[aria-selected='true'] .fui-Tab__icon.fui-Tab__icon {
  color: var(--winui-text-fill-primary);
}

/* PointerOverSelected and PressedSelected each restate the selected foreground,
   so a selected tab holds the primary fill through both; Fluent moves it in
   both, hence these two combinations.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView.xaml#L354-L372
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView.xaml#L373-L391 */
.fui-Tab[aria-selected='true']:enabled:hover .fui-Tab__content.fui-Tab__content,
.fui-Tab[aria-selected='true']:enabled:hover .fui-Tab__icon.fui-Tab__icon,
.fui-Tab[aria-selected='true']:enabled:active .fui-Tab__content.fui-Tab__content,
.fui-Tab[aria-selected='true']:enabled:active .fui-Tab__icon.fui-Tab__icon {
  color: var(--winui-text-fill-primary);
}

/* Repainted only outside High Contrast. Fluent guards these pseudo-elements
   with forced-colors rules holding them on Highlight and ButtonText; a media
   query carries no specificity, so our rules would otherwise win inside that
   mode and put a theme color where the contract is system colors.
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tabs/library/src/components/Tab/useTabStyles.styles.ts#L359-L366
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tabs/library/src/components/Tab/useTabStyles.styles.ts#L453-L463 */
@media not (forced-colors: active) {
  /* Fluent previews a selection by growing a neutral bar in the slot the accent
     pipe will take; every unselected Pivot state collapses SelectedPipe
     instead. The bar contributes only a fill, so nulling it removes the
     preview outright.
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
   left-edge bar, and there is no vertical Pivot to transcribe.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L587 */
.fui-TabList[aria-orientation='horizontal'] > .fui-Tab.fui-Tab::after {
  bottom: 2px;
  height: var(--strokeWidthThicker);
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

/* The placeholder holds the width the label would take once selected, so it
   follows the selected label back to regular weight rather than padding every
   tab by the semibold delta. */
.fui-Tab__content--reserved-space.fui-Tab__content--reserved-space {
  font-weight: var(--fontWeightRegular);
}
`;
