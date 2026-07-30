// Badge, Tag, InteractionTag, InteractionTagPrimary and
// InteractionTagSecondary, restyled from Fluent 2 Web onto WinUI 3.
//
// InfoBadge is Badge's counterpart, and it is a much smaller control than
// Fluent's: one accent chip that tops out at 16px and carries either a dot, a
// glyph or a short value. Its dictionary is flat — no VisualStateManager entry
// changes a colour, only which of the three content presenters is visible — so
// rest is the only state either side paints.
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
// JavaScript. The runtime chokepoint stamps Badge's resolved size so its text
// ramp can be addressed without touching the tiny dot or large label; Tag
// variants remain unnamed. Everything else below either applies to every
// variant or redefines a Fluent token read only by the intended atoms. The
// states that survive into the DOM on their own are Fluent's: `:hover`,
// `:active`, `:disabled`, `aria-pressed` / `aria-selected` for the selected
// chip, and `[data-fui-focus-visible]`.
export const badgeTagCss = `
/* Badge weight. The InfoBadge style sets a FontSize on its value TextBlock and
   no FontWeight, so the badge reads at the same weight as the text around it
   rather than Fluent's semibold.

   InfoBadge's geometry is deliberately left to Fluent. MinWidth 4 and
   MaxHeight 16 are one package with ValueInfoBadgeTextMargin 4,0,4,2 and
   InfoBadgeValueFontSize 11, and neither of those two can be ported: Fluent
   composes size in JavaScript and writes no attribute, so a blanket font
   size and inline padding would land on the 6×6px tiny dot as well. Taking
   the bounds alone would sink the floor under every Fluent size step (20px
   base, 16/24/32px per size) and cap the box at 16px while the reset keeps a
   20px line box, so a one-glyph badge would leave its own circle.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBadge/InfoBadge_themeresources.xaml#L82
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBadge/InfoBadge_themeresources.xaml#L8-L15 */
.fui-Badge.fui-Badge {
  font-weight: var(--fontWeightRegular);
}

/* Product text badges use the medium 20px shell with WinUI's 12/16 caption.
   Large badges retain the 14px body label that scales with their 24px shell;
   tiny and small remain available only to the component gallery's size ramp. */
.fui-Badge.fui-Badge[data-winui-size='medium'] {
  font-size: 12px;
  line-height: 16px;
}

/* The chip body, shared by the plain Tag and by both halves of an
   InteractionTag — the halves are siblings, so the dismiss half only reaches
   these tokens by being named here. Fluent's filled fill is an opaque step of
   the page ramp; a WinUI control fill is translucent, so the chip composites
   over whatever surface it sits on instead of introducing a fourth flat grey.
   --colorNeutralBackground3 is the filled appearance's fill alone — brand
   reads --colorBrandBackground2 — while the disabled fill is shared by
   filled and brand. The label is the button foreground on all three: Fluent
   runs it at its secondary text colour, WinUI at the primary one.

   The outline appearance needs no fill row of its own: it reads
   --colorSubtleBackground and the Hover/Pressed steps beside it, which
   ../theme.ts already carries over to SubtleFillColorTransparent/Secondary/
   Tertiary for the whole library.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L128
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L131-L132
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L25-L27 */
.fui-Tag.fui-Tag,
.fui-InteractionTagPrimary.fui-InteractionTagPrimary,
.fui-InteractionTagSecondary.fui-InteractionTagSecondary {
  --colorNeutralBackground3: var(--winui-control-fill-default);
  --colorNeutralBackgroundDisabled: var(--winui-control-fill-disabled);
  --colorNeutralForeground2: var(--winui-text-fill-primary);
}

/* The two InteractionTag halves are the pressable members of the family, so
   they take the button's interaction ramp on both the neutral and the accent
   side: the fill steps to the secondary and tertiary control fills, the
   selected fill steps to the accent secondary and tertiary — the rest accent
   at 90% and 80% rather than separate hues — and the label holds at the
   primary text fill on hover, dropping to the secondary fill under a press,
   where Fluent darkens on hover and tints the outline appearance's glyph
   toward the brand. The primary half reads the plain Foreground2 steps and
   the dismiss half the Brand-suffixed ones for the same label, so both pairs
   are stated. All of them are read by the label and the icon swap alone, so a
   caller-supplied colour on the chip itself — the per-provider chips are all
   of that shape — still wins.
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
   Fluent's compound brand. Both tokens are read only by the glyph's own hover
   and active atoms.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L88-L95
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L119-L121 */
.fui-Tag__dismissIcon.fui-Tag__dismissIcon {
  --colorCompoundBrandForeground1Hover: var(--winui-text-fill-primary);
  --colorCompoundBrandForeground1Pressed: var(--winui-text-fill-secondary);
}

/* A selected chip is an accent button. Its fill and label already agree
   through the brand tokens, so what is left is the outline: WinUI draws the
   on-accent elevation gradient the foundation transcribes as a three-term
   border colour, where Fluent draws one flat brand stroke. A TagGroup with
   the listbox role writes the selection as aria-selected instead, so both
   attributes name the same state. The dismiss half writes no selection
   attribute of its own and is reached through its selected sibling, which is
   also how SplitButton states it — one accent chrome across both halves. That
   sibling sits in :where() so the dismiss half's states stack in the same
   order the primary half's do rather than being lifted over the focus visual
   by the extra compound.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L111
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L28 */
.fui-Tag.fui-Tag[aria-pressed='true'],
.fui-Tag.fui-Tag[aria-selected='true'],
.fui-InteractionTagPrimary.fui-InteractionTagPrimary[aria-pressed='true'],
:where(.fui-InteractionTagPrimary[aria-pressed='true']) + .fui-InteractionTagSecondary.fui-InteractionTagSecondary {
  border-color: var(--winui-accent-control-elevation-border-color);
}

/* The focus visual. WinUI draws two concentric rings so the indicator survives
   on any fill including accent; Fluent draws one, as an outline two pixels
   outside the chip. Recolouring that outline to the outer stroke and the
   chip's own border to the inner one yields WinUI's pair without restating a
   ring width, which no Tag-shaped WinUI style declares. This also has to
   outrank the selected outline above, which is why the border colour is
   repeated rather than inherited from it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55 */
.fui-Tag.fui-Tag[data-fui-focus-visible],
.fui-InteractionTagPrimary.fui-InteractionTagPrimary[data-fui-focus-visible],
.fui-InteractionTagSecondary.fui-InteractionTagSecondary[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  border-color: var(--winui-focus-stroke-inner);
}

/* The accent outline drops away entirely under a press. Fluent signals a press
   with a plain :active, which a pointer and a keyboard activation both
   raise, and both chip shapes reach it: an InteractionTag half is a button,
   and so is a dismissible Tag. This is the last selected-state rule in the
   sheet because WinUI's Pressed visual state is entered over the focused one
   and repaints the border either way.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L113 */
.fui-Tag.fui-Tag[aria-pressed='true']:active,
.fui-Tag.fui-Tag[aria-selected='true']:active,
.fui-InteractionTagPrimary.fui-InteractionTagPrimary[aria-pressed='true']:active,
:where(.fui-InteractionTagPrimary[aria-pressed='true']) + .fui-InteractionTagSecondary.fui-InteractionTagSecondary:active {
  border-color: var(--winui-control-fill-transparent);
}
`;
