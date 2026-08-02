// TabList and Tab restyled after WinUI 3's inline tab strip. Two XAML controls
// stand behind the result. Pivot supplies the shape — a chromeless header row
// whose only selection affordance is an accent pipe floated under the selected
// item — and TabView supplies the foreground ramp. Pivot routes its four
// foreground states through the legacy SystemControl* system-brush layer,
// which generic.xaml resolves to opacity-scaled black and white; TabView
// states the same four over the modern TextFillColor* resources this file
// already transcribes. Preferring the modern layer is our own call, and the
// two ramps differ where it shows: Pivot brightens an unselected item under
// the pointer and dims the selected one, while TabView holds the unselected
// item, dims it only on press, and lets selection outrank the pointer
// entirely. The state notes below describe TabView's.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L47-L53
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L504-L574
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L265-L285
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L12-L21
//
// Fluent's appearance variants — `subtle`, `subtle-circular`, `filled-circular`
// — are carried entirely by Griffel atoms, and the rendered button exposes no
// class or attribute to select them by, so the foreground ramp below reaches
// all of them. On `subtle` that is the intent. On the two circular appearances
// it is a repaint we cannot opt out of: those set `color: inherit` on the label
// and icon slots so a brand-filled chip can hand its on-brand foreground down,
// and our ramp outranks that. WinUI has no round-chip tab to transcribe
// against, and the gallery route renders both circular appearances, so a
// selected filled chip shows WinUI's primary text over Fluent's brand fill. We
// accept that rather than chase Griffel's hashed atoms.
//
// Focus stays Fluent's, because PivotHeaderItem draws no per-item focus visual
// at all: UseSystemFocusVisuals is off on the style, and the only pipe the
// template contains is SelectedPipe. PivotHeaderItemFocusPipeFill is declared
// in the dictionary and no template consumes it. Transcribing that silence
// would leave the strip looking unfocusable, so Fluent's indicator stays by
// choice.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L486
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L587
//
// The disabled foreground is left to Fluent. Fluent withholds `aria-selected`
// from a disabled tab, so no selector below can reach one, and its disabled
// atom paints label and icon with colorNeutralForegroundDisabled, which the
// theme already re-points at TextFillColorDisabled -- the brush TabView names
// for both slots, selected or not.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L16
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L21
//
// The state rules are ordered rest → hover → pressed → selected, and each
// selected step repeats the interaction pseudo-classes of the step it has to
// outweigh, so a pressed selected tab still reads as selected.
export const tabsCss = `
/* Hover holds the rest brush: TabViewItemHeaderForegroundPointerOver resolves
   to the same TextFillColorSecondary, so the pointer alone carries the state.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L15
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L20 */
.fui-Tab:enabled:hover .fui-Tab__content.fui-Tab__content,
.fui-Tab:enabled:hover .fui-Tab__icon.fui-Tab__icon {
  color: var(--winui-text-fill-secondary);
}

/* Press dims an unselected tab from the rest brush down to the tertiary fill.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L13
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView_themeresources.xaml#L18 */
.fui-Tab:enabled:active .fui-Tab__content.fui-Tab__content,
.fui-Tab:enabled:active .fui-Tab__icon.fui-Tab__icon {
  color: var(--winui-text-fill-tertiary);
}

/* Selected: the pipe is the whole distinction, so the label is only promoted
   to the primary fill and keeps its weight -- PivotHeaderItem sets FontWeight
   once as a style setter, which no visual state can reach.
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

/* Selection outranks the pointer: PointerOverSelected and PressedSelected each
   restate the selected foreground rather than the hover or the pressed one, so
   a selected tab holds the primary fill through both. Fluent moves it in both,
   to its neutral hover and pressed steps for the label and to the compound
   brand ramp for the icon, so the two combinations are restated here.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView.xaml#L354-L372
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TabView/TabView.xaml#L373-L391 */
.fui-Tab[aria-selected='true']:enabled:hover .fui-Tab__content.fui-Tab__content,
.fui-Tab[aria-selected='true']:enabled:hover .fui-Tab__icon.fui-Tab__icon,
.fui-Tab[aria-selected='true']:enabled:active .fui-Tab__content.fui-Tab__content,
.fui-Tab[aria-selected='true']:enabled:active .fui-Tab__icon.fui-Tab__icon {
  color: var(--winui-text-fill-primary);
}

/* Both pseudo-elements are repainted only outside High Contrast. Fluent guards
   them with @media (forced-colors: active) rules that keep the pending bar and
   the selected pipe on Highlight and ButtonText; a media query carries no
   specificity, so our rules would otherwise win inside that mode and put a
   theme color where the whole contract is system colors. Standing aside hands
   the mode back to Fluent without us naming a system color of our own. */
@media not (forced-colors: active) {
  /* Fluent previews a selection by growing a neutral bar in the slot the accent
     pipe will take. Every unselected Pivot state collapses SelectedPipe
     instead, so the strip only ever shows one pipe and the preview is erased.
     The bar is absolutely positioned and contributes only a fill, so nulling
     the fill removes it outright.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L536-L538
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L559-L561 */
  .fui-Tab.fui-Tab:hover::before,
  .fui-Tab.fui-Tab:active::before {
    background-color: transparent;
  }

  /* SelectedPipe takes its fill once from the template and no visual state
     overrides it, so the pipe never reacts to the pointer and Fluent's hover
     and pressed steps of the compound brand ramp collapse onto the one accent
     fill. Both theme dictionaries name the same key, so light and dark differ
     only in what the accent resolves to.
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

/* Pivot floats the pipe clear of the header's bottom edge with a 2px bottom
   margin where Fluent sits it flush, and states its thickness once as a 3px
   Rectangle. Horizontal only: in the vertical strip Fluent reuses the bottom
   inset as the far edge of a left-edge bar rather than as an offset from an
   edge, and there is no vertical Pivot to transcribe. Pivot has a single
   header size, so the one float and the one thickness cover Fluent's three;
   only the small strip moves, since Fluent's medium and large already resolve
   to the same 3px.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Pivot_themeresources.xaml#L587 */
.fui-TabList[aria-orientation='horizontal'] > .fui-Tab.fui-Tab::after {
  bottom: 2px;
  height: var(--strokeWidthThicker);
}

/* The pipe's travel between tabs takes WinUI's normal duration and its
   fast-out-slow-in spline, whose four numbers are the two control points of a
   cubic-bezier. Pivot gives every header item its own pipe and collapses all
   but the selected one, so it states no timing for a travel and WinUI's
   general motion tokens stand in for one. The no-preference wrapper is
   insurance: Fluent's reduced-motion rule already sets transition-property to
   none, which holds a declared duration inert on its own.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L602-L603 */
@media (prefers-reduced-motion: no-preference) {
  .fui-Tab.fui-Tab::after {
    transition-duration: var(--winui-control-normal-animation-duration);
    transition-timing-function: var(--winui-control-fast-out-slow-in-easing);
  }
}

/* The reserved-space placeholder exists only to hold the width the label would
   take once selected, so it follows the selected label back to the regular
   weight and stops padding every tab by the semibold delta. */
.fui-Tab__content--reserved-space.fui-Tab__content--reserved-space {
  font-weight: var(--fontWeightRegular);
}
`;
