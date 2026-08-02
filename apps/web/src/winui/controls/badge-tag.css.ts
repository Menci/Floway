// Badge, Tag, InteractionTag, InteractionTagPrimary and
// InteractionTagSecondary, restyled from Fluent 2 Web onto WinUI 3.
//
// Tag has no WinUI counterpart: its fills, strokes and foregrounds are read off
// Button, and its split shape off SplitButton, whose accent chrome is the same
// AccentControlElevationBorderBrush a selected chip takes below.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L28-L30
//
// Under forced colours Fluent draws the chip outline itself and states
// Highlight and HighlightText for a selected chip with `forced-color-adjust:
// none`, so the author colours below survive only on that selected chip — where
// the on-accent strokes are translucent and composite over Highlight.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L58-L72
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L121-L125
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tags/library/src/components/InteractionTagPrimary/useInteractionTagPrimaryStyles.styles.ts#L57-L71
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tags/library/src/components/InteractionTagPrimary/useInteractionTagPrimaryStyles.styles.ts#L194-L198
export const badgeTagCss = `
/* The InfoBadge style sets a FontSize on its value TextBlock and no FontWeight,
   so the badge reads at the text weight around it rather than Fluent's semibold.
   InfoBadge's geometry is deliberately not transcribed: its bounds (MinWidth 4,
   MaxHeight 16, InfoBadgeValueFontSize 11) sink the floor under every Fluent
   size step and cap the box at 16px against the reset's 20px, which would
   replace Fluent's size ramp rather than restyle it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBadge/InfoBadge_themeresources.xaml#L82
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBadge/InfoBadge_themeresources.xaml#L8-L15 */
.fui-Badge.fui-Badge {
  font-weight: var(--fontWeightRegular);
}

/* The chip body. The InteractionTag halves are siblings rather than
   descendants, so the dismiss half reaches these tokens only by being named
   here. The outline appearance needs no fill row of its own: it reads
   --colorSubtleBackground and the steps beside it, which ../theme.ts already
   carries over for the whole library. Button holds its border on
   ControlStrokeColorDefault through disabled and SplitButton draws its divider
   with that brush in every state, where Fluent steps down to the strong
   disabled stroke.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L128
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L131-L132
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L136-L139
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L26-L27
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L25-L27 */
.fui-Tag.fui-Tag,
.fui-InteractionTagPrimary.fui-InteractionTagPrimary,
.fui-InteractionTagSecondary.fui-InteractionTagSecondary {
  --colorNeutralBackground3: var(--winui-control-fill-default);
  --colorNeutralBackgroundDisabled: var(--winui-control-fill-disabled);
  --colorNeutralForeground2: var(--winui-text-fill-primary);
  --colorNeutralStrokeDisabled: var(--winui-control-stroke-default);
}

/* Button flattens its stroke to ControlStrokeColorDefault under a press and
   while disabled, and holds the elevation border either side of that. Stated
   because Fluent's own filled chip is borderless and its outline chip carries
   one flat neutral stroke through every state, so neither half of the ramp
   arrives on its own.

   A chip that carries an identity colour publishes it as --floway-chip-stroke
   and keeps it through both steps: the flattening says pressed, and a chip whose
   edge is the only thing naming its provider has nothing left to say it with.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L129-L132 */
.fui-Tag.fui-Tag:active,
.fui-Tag.fui-Tag[disabled],
.fui-InteractionTagPrimary.fui-InteractionTagPrimary:active,
.fui-InteractionTagPrimary.fui-InteractionTagPrimary[disabled],
.fui-InteractionTagSecondary.fui-InteractionTagSecondary:active,
.fui-InteractionTagSecondary.fui-InteractionTagSecondary[disabled] {
  border-color: var(--floway-chip-stroke, var(--winui-control-stroke-default));
}

/* The pressable halves take Button's interaction ramp: the label holds at the
   primary text fill on hover and drops to secondary under a press, where Fluent
   darkens on hover and tints the outline appearance's glyph toward the brand.
   The primary half reads the plain Foreground2 steps and the dismiss half the
   Brand-suffixed ones for the same label, so both pairs are stated. The selected
   fill's own steps -- the rest accent at 90% and 80% rather than separate hues
   -- arrive through ../theme.ts with the rest of the accent ramp.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L128-L134
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L119-L121 */
.fui-InteractionTagPrimary.fui-InteractionTagPrimary,
.fui-InteractionTagSecondary.fui-InteractionTagSecondary {
  --colorNeutralBackground3Hover: var(--winui-control-fill-secondary);
  --colorNeutralBackground3Pressed: var(--winui-control-fill-tertiary);
  --colorNeutralForeground2Hover: var(--winui-text-fill-primary);
  --colorNeutralForeground2Pressed: var(--winui-text-fill-secondary);
  --colorNeutralForeground2BrandHover: var(--winui-text-fill-primary);
  --colorNeutralForeground2BrandPressed: var(--winui-text-fill-secondary);
}

/* The dismiss glyph is a subtle button in WinUI terms — InfoBar builds its
   close affordance that way — so it runs the neutral text ramp rather than
   Fluent's compound brand.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L88-L95
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L119-L121 */
.fui-Tag__dismissIcon.fui-Tag__dismissIcon {
  --colorCompoundBrandForeground1Hover: var(--winui-text-fill-primary);
  --colorCompoundBrandForeground1Pressed: var(--winui-text-fill-secondary);
}

/* The selected chip's stroke. WinUI draws the on-accent elevation gradient as a
   three-term border colour where Fluent draws one flat brand stroke; the accent
   fill under it arrives through ../theme.ts, which carries Fluent's brand ramps
   onto the accent ones. A TagGroup with the listbox role writes the selection as
   aria-selected instead, so both attributes name the same state. The sibling
   selector sits in :where() so the dismiss half's states stack in the same order
   the primary half's do rather than being lifted over the focus visual by the
   extra compound.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L9
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L28 */
.fui-Tag.fui-Tag[aria-pressed='true'],
.fui-Tag.fui-Tag[aria-selected='true'],
.fui-InteractionTagPrimary.fui-InteractionTagPrimary[aria-pressed='true'],
:where(.fui-InteractionTagPrimary[aria-pressed='true']) + .fui-InteractionTagSecondary.fui-InteractionTagSecondary {
  border-color: var(--winui-accent-control-elevation-border-color);
}

/* A plain Tag is a span, so Fluent ships it no pointer atoms at all and there is
   no token to re-point for the two steps a checked ToggleButton takes; both
   fills are stated outright.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L12
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tags/library/src/components/Tag/useTag.ts#L43 */
.fui-Tag.fui-Tag[aria-pressed='true']:not([disabled]):hover,
.fui-Tag.fui-Tag[aria-selected='true']:not([disabled]):hover {
  background-color: var(--winui-accent-fill-secondary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L13 */
.fui-Tag.fui-Tag[aria-pressed='true']:not([disabled]):active,
.fui-Tag.fui-Tag[aria-selected='true']:not([disabled]):active {
  background-color: var(--winui-accent-fill-tertiary);
}

/* WinUI draws two concentric focus rings, 2px over 1px. Fluent draws a single
   2px outline in --colorStrokeFocus2 flush against the border box, outside the
   chip's own 1px border, so recolouring that outline to the outer stroke and
   the border to the inner one lands the 2/1 pair with no width restated. The
   price is the chip's own edge, spent on the inner ring while focused; WinUI
   keeps its edge, because Button pushes the focus visual clear of the control
   with FocusVisualMargin -3. The border colour is repeated rather than
   inherited because this has to outrank the selected outline above.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L173-L182
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L383-L384
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L441-L452
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L167
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55 */
.fui-Tag.fui-Tag[data-fui-focus-visible],
.fui-InteractionTagPrimary.fui-InteractionTagPrimary[data-fui-focus-visible],
.fui-InteractionTagSecondary.fui-InteractionTagSecondary[data-fui-focus-visible] {
  border-color: var(--winui-focus-stroke-inner);
}

/* The accent outline drops away entirely under a press, and the label dims
   with it: AccentButtonForegroundPressed is TextOnAccentFillColorSecondary,
   where Fluent holds the on-accent primary through the press. This sits after
   the focus visual because WinUI's Pressed visual state is entered over the
   focused one and repaints the border either way. The press excludes a
   disabled chip: WinUI cannot leave Disabled for a pointer state, and a rule
   settling that by source order alone breaks the moment either selector gains
   a component. The guard names the attribute rather than :disabled, because
   Fluent renders a non-dismissible Tag as a span, which no form pseudo-class
   reaches.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L109
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L113
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tags/library/src/components/Tag/useTag.ts#L43 */
.fui-Tag.fui-Tag[aria-pressed='true']:active:not([disabled]),
.fui-Tag.fui-Tag[aria-selected='true']:active:not([disabled]),
.fui-InteractionTagPrimary.fui-InteractionTagPrimary[aria-pressed='true']:active:not([disabled]),
:where(.fui-InteractionTagPrimary[aria-pressed='true']) + .fui-InteractionTagSecondary.fui-InteractionTagSecondary:active:not([disabled]) {
  border-color: var(--winui-control-fill-transparent);
  color: var(--winui-text-on-accent-fill-secondary);
}

/* Fluent keeps writing the selection attribute while dropping every selected
   atom, so without this rule the accent rules above outlive the selection and
   leave an accent outline standing on the neutral disabled fill. ToggleButton
   is the control that ships a checked-disabled visual, and it keeps the accent
   side. Clearing the outline would take the divider between the two halves with
   it, so the dismiss half restates it: SplitButton draws that divider with
   ControlStrokeColorDefault and its Disabled state leaves it there.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L14
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L26
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L38
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L27
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton.xaml#L71-L79
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton.xaml#L225 */
.fui-Tag.fui-Tag[aria-pressed='true'][disabled],
.fui-Tag.fui-Tag[aria-selected='true'][disabled],
.fui-InteractionTagPrimary.fui-InteractionTagPrimary[aria-pressed='true'][disabled],
:where(.fui-InteractionTagPrimary[aria-pressed='true']) + .fui-InteractionTagSecondary.fui-InteractionTagSecondary[disabled] {
  background-color: var(--winui-accent-fill-disabled);
  border-color: var(--winui-control-fill-transparent);
  color: var(--winui-text-on-accent-fill-disabled);
}

:where(.fui-InteractionTagPrimary[aria-pressed='true']) + .fui-InteractionTagSecondary.fui-InteractionTagSecondary[disabled] {
  border-left-color: var(--winui-control-stroke-default);
}
`;
