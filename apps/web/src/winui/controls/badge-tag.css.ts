// Badge, Tag, InteractionTag, InteractionTagPrimary and
// InteractionTagSecondary, restyled from Fluent 2 Web onto WinUI 3.
//
// InfoBadge is Badge's counterpart. Its dictionary is flat — no
// VisualStateManager entry changes a colour — so rest is the only state either
// side paints.
//
// Tag has no WinUI counterpart. Its fills, strokes and foregrounds are derived
// from the families the corpus paints every other neutral inline control with,
// read off Button: ControlFill* for the body, AccentFill* and the on-accent
// elevation stroke for the selected chip, TextFill* for the label, and the
// Subtle ramp for the dismiss glyph. InteractionTag itself declares display,
// height and radius only, so it needs no rule of its own; its two halves are
// siblings under it, and WinUI states that split shape as SplitButton, whose
// accent chrome is the same AccentControlElevationBorderBrush a selected chip
// takes below.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L28-L30
//
// These components compose `appearance`, `color`, `shape` and `size` in
// JavaScript, so a variant is addressable only where the runtime chokepoint
// stamps it back onto the DOM. No rule here needs that: each one either
// applies to every variant or redefines a Fluent token read only by the
// intended atoms. Fluent writes the selection attribute whether or not the chip
// is disabled but drops its own selected atoms when it is, so every accent rule
// below that reads the attribute is answered by a disabled rule that outranks
// it.
//
// The Button, ToggleButton and SplitButton brushes cited below are bound to
// the same resource key in the Default dictionary and in the Light one, so a
// single citation carries both colour schemes: the values differ by theme,
// the roles do not.
//
// Windows high contrast is left to Fluent and the user agent. For Tag and
// InteractionTag, Fluent participates: it draws the chip's outline through a
// pseudo element under forced colours, because a chip with secondary text pulls
// a negative margin over the real border, and it states Highlight and
// HighlightText for a selected chip with `forced-color-adjust: none`. Forced
// colours therefore override the author colours below everywhere except on that
// selected chip — and there the on-accent strokes are translucent, so they
// composite over Highlight the way they do over the accent fill.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L58-L72
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L121-L125
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tags/library/src/components/InteractionTagPrimary/useInteractionTagPrimaryStyles.styles.ts#L57-L71
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-tags/library/src/components/InteractionTagPrimary/useInteractionTagPrimaryStyles.styles.ts#L194-L198
//
// @fluentui/react-badge declares no forced-colors rule at all, so for Badge the
// mode belongs entirely to the user agent.
export const badgeTagCss = `
/* Badge weight. The InfoBadge style sets a FontSize on its value TextBlock and
   no FontWeight, so the badge reads at the same weight as the text around it
   rather than Fluent's semibold. Weight is the whole correction the type
   needs: Fluent's reset already runs the label at 12px on a 16px line box,
   which is what WinUI's Caption ramp states.

   InfoBadge's geometry is deliberately not transcribed -- these badges are
   never the circle InfoBadge draws, and their height stays pinned on Fluent's
   own size ramp. Taking InfoBadge's bounds instead would mean the whole package
   (MinWidth 4, MaxHeight 16, ValueInfoBadgeTextMargin 4,0,4,2,
   InfoBadgeValueFontSize 11), which sinks the floor under every Fluent size
   step and caps the box at 16px against the reset's 20px -- replacing Fluent's
   size ramp rather than restyling it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBadge/InfoBadge_themeresources.xaml#L82
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBadge/InfoBadge_themeresources.xaml#L8-L15 */
.fui-Badge.fui-Badge {
  font-weight: var(--fontWeightRegular);
}

/* The chip body, shared by the plain Tag and by both halves of an
   InteractionTag — the halves are siblings, so the dismiss half only reaches
   these tokens by being named here. Fluent's filled fill is an opaque step of
   the page ramp; a WinUI control fill is translucent, so the chip composites
   over whatever surface it sits on instead of introducing a fourth flat grey.

   The outline appearance needs no fill row of its own: it reads
   --colorSubtleBackground and the Hover/Pressed steps beside it, which
   ../theme.ts already carries over for the whole library.

   The disabled outline joins the fills. Button holds its border on
   ControlStrokeColorDefault through disabled, and SplitButton draws its divider
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

/* The two InteractionTag halves are the pressable members of the family, so
   they take the button's interaction ramp on both the neutral and the accent
   side: the selected fill steps to the accent secondary and tertiary — the rest
   accent at 90% and 80% rather than separate hues — and the label holds at the
   primary text fill on hover, dropping to the secondary fill under a press,
   where Fluent darkens on hover and tints the outline appearance's glyph toward
   the brand. The primary half reads the plain Foreground2 steps and the dismiss
   half the Brand-suffixed ones for the same label, so both pairs are stated.
   All of them are read by the label and the icon swap alone, so a
   caller-supplied colour on the chip itself — the per-provider chips are all of
   that shape — still wins.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L128-L134
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L119-L121
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L104-L105 */
.fui-InteractionTagPrimary.fui-InteractionTagPrimary,
.fui-InteractionTagSecondary.fui-InteractionTagSecondary {
  --colorNeutralBackground3Hover: var(--winui-control-fill-secondary);
  --colorNeutralBackground3Pressed: var(--winui-control-fill-tertiary);
  --colorNeutralForeground2Hover: var(--winui-text-fill-primary);
  --colorNeutralForeground2Pressed: var(--winui-text-fill-secondary);
  --colorNeutralForeground2BrandHover: var(--winui-text-fill-primary);
  --colorNeutralForeground2BrandPressed: var(--winui-text-fill-secondary);
  --colorBrandBackgroundHover: var(--winui-accent-fill-secondary);
  --colorBrandBackgroundPressed: var(--winui-accent-fill-tertiary);
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

/* A selected chip is an accent button. Its fill is the accent one, where
   Fluent's --colorBrandBackground stays on its own brand ramp, so the rest fill
   is restated here to meet the hover and pressed steps above. What is left is
   the outline: WinUI draws the on-accent elevation gradient the foundation
   transcribes as a three-term border colour, where Fluent draws one flat brand
   stroke. A TagGroup with the listbox role writes the selection as
   aria-selected instead, so both attributes name the same state. The dismiss
   half writes no selection attribute of its own and is reached through its
   selected sibling, which is also how SplitButton states it -- one accent
   chrome across both halves. That sibling sits in :where() so the dismiss
   half's states stack in the same order the primary half's do rather than being
   lifted over the focus visual by the extra compound.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L103
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L107
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L111
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L9
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L28 */
.fui-Tag.fui-Tag[aria-pressed='true'],
.fui-Tag.fui-Tag[aria-selected='true'],
.fui-InteractionTagPrimary.fui-InteractionTagPrimary[aria-pressed='true'],
:where(.fui-InteractionTagPrimary[aria-pressed='true']) + .fui-InteractionTagSecondary.fui-InteractionTagSecondary {
  --colorBrandBackground: var(--winui-accent-fill-default);
  border-color: var(--winui-accent-control-elevation-border-color);
}

/* The focus visual. WinUI draws two concentric rings, 2px over 1px, so the
   indicator survives on any fill including accent. Fluent draws a single 2px
   outline in --colorStrokeFocus2, flush against the chip's border box and
   outside the chip's own 1px border, so recolouring that outline to the outer
   stroke and the border to the inner one lands WinUI's 2/1 pair with no width
   restated. The price is the chip's own edge, which is spent on the inner ring
   while the chip is focused; WinUI keeps its edge, because Button pushes the
   whole focus visual clear of the control with FocusVisualMargin -3. This also
   has to outrank the selected outline above, which is why the border colour is
   repeated rather than inherited from it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L173-L182
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L383-L384
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L441-L452
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button.xaml#L167
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55 */
.fui-Tag.fui-Tag[data-fui-focus-visible],
.fui-InteractionTagPrimary.fui-InteractionTagPrimary[data-fui-focus-visible],
.fui-InteractionTagSecondary.fui-InteractionTagSecondary[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  border-color: var(--winui-focus-stroke-inner);
}

/* The accent outline drops away entirely under a press, and the label dims
   with it: AccentButtonForegroundPressed is TextOnAccentFillColorSecondary,
   where Fluent holds the on-accent primary through the press. This sits after
   the focus visual because WinUI's Pressed visual state is entered over the
   focused one and repaints the border either way.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L109
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L113 */
.fui-Tag.fui-Tag[aria-pressed='true']:active,
.fui-Tag.fui-Tag[aria-selected='true']:active,
.fui-InteractionTagPrimary.fui-InteractionTagPrimary[aria-pressed='true']:active,
:where(.fui-InteractionTagPrimary[aria-pressed='true']) + .fui-InteractionTagSecondary.fui-InteractionTagSecondary:active {
  border-color: var(--winui-control-fill-transparent);
  color: var(--winui-text-on-accent-fill-secondary);
}

/* A disabled selected chip. Fluent keeps writing the selection attribute
   while dropping every selected atom, so the accent rules above would
   otherwise outlive the selection and leave an accent outline standing on
   the neutral disabled fill. ToggleButton is the control that ships a
   checked-disabled visual, and it keeps the accent side.

   The selector reaches every chip the DOM presents as a button. A Tag that
   is not dismissible is a span, and Fluent hands a span no attribute for a
   selector to read.

   Clearing the outline would take the divider between the two halves with
   it, so the dismiss half restates it. SplitButton draws that divider with
   ControlStrokeColorDefault and its Disabled state leaves it there.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L14
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L26
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L38
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L27
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton.xaml#L71-L79
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton.xaml#L225 */
.fui-Tag.fui-Tag[aria-pressed='true']:disabled,
.fui-Tag.fui-Tag[aria-selected='true']:disabled,
.fui-InteractionTagPrimary.fui-InteractionTagPrimary[aria-pressed='true']:disabled,
:where(.fui-InteractionTagPrimary[aria-pressed='true']) + .fui-InteractionTagSecondary.fui-InteractionTagSecondary:disabled {
  background-color: var(--winui-accent-fill-disabled);
  border-color: var(--winui-control-fill-transparent);
  color: var(--winui-text-on-accent-fill-disabled);
}

:where(.fui-InteractionTagPrimary[aria-pressed='true']) + .fui-InteractionTagSecondary.fui-InteractionTagSecondary:disabled {
  border-left-color: var(--winui-control-stroke-default);
}
`;
