import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../../fluent';

const { Switch, Text, makeStyles, mergeClasses, shorthands } = fluentComponents;

// The row the Windows Settings app is built out of: an icon, a header, a
// description, and a control at the trailing edge -- and a variant of the same
// row that also opens to reveal more.
//
// This pair is the Community Toolkit's SettingsCard and SettingsExpander rather
// than anything in microsoft-ui-xaml, so the metrics below come from
// CommunityToolkit/Windows at commit c076d3dd722e43204ffbeb16057090f8498c8166,
// components/SettingsControls/. The brushes are named there and resolved here
// through the WinUI vocabulary the layer already carries.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L98-L112
//
// Both controls carry a HighContrast dictionary, and every brush in it is a
// system colour. That is the substitution the user agent already performs on
// background, border, text and outline colours under forced colours, so no
// rule below states one; the only value forced colours cannot reach is a
// box-shadow, which it drops, and that is called out where one is spent.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L67-L95
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L52-L72
// https://drafts.csswg.org/css-color-adjust/#forced-colors-properties
const useStyles = makeStyles({
  // MinHeight 68, Padding 16, ControlCornerRadius, a 1px card stroke.
  //
  // The row's foreground is the primary text fill, and the header and the
  // header icon take it by inheritance rather than each pinning its own. That
  // is what lets the pressed state below move both from one rule.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L20-L21
  //
  // The 24 between the text and the trailing control is an inset on the text
  // block rather than a gap on the row: a gap falls between every pair of
  // children, so it also landed between the icon and the text, which already
  // states its own 20 and ended up 44 away.
  card: {
    alignItems: 'center',
    backgroundColor: 'var(--winui-card-background-fill-default)',
    borderTopStyle: 'solid',
    borderRightStyle: 'solid',
    borderBottomStyle: 'solid',
    borderLeftStyle: 'solid',
    borderTopWidth: '1px',
    borderRightWidth: '1px',
    borderBottomWidth: '1px',
    borderLeftWidth: '1px',
    ...shorthands.borderColor('var(--winui-card-stroke-default)'),
    borderRadius: 'var(--winui-control-corner-radius)',
    boxSizing: 'border-box',
    color: 'var(--winui-text-fill-primary)',
    // Named as a container so the trailing control can ask how much room the
    // row has before it takes a floor. The row's own inline size never depends
    // on its contents -- it is a block filling the list it sits in -- so
    // declaring the containment states what was already true.
    containerName: 'floway-settings-row',
    containerType: 'inline-size',
    display: 'flex',
    minHeight: '68px',
    padding: '16px',
  },
  // A card only takes the pointer ramp when it does something when clicked.
  // The fill moves over the control's own duration; the toolkit leaves the
  // border instant.
  //
  // WinUI sets that BrushTransition up only while UISettings.AnimationsEnabled
  // is on, so a card whose animations are off switches its fill in one frame.
  // The web states the same preference as prefers-reduced-motion, and the
  // button sheet already clamps this same 83ms fill on it.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L192-L194
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L206-L245
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/panel.cpp#L68-L76
  interactive: {
    cursor: 'pointer',
    transitionDuration: 'var(--winui-control-faster-animation-duration)',
    transitionProperty: 'background-color',
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
    '&:hover': {
      backgroundColor: 'var(--winui-control-fill-secondary)',
      // ControlElevationBorderBrush is a gradient with one heavier edge, which
      // the vocabulary carries as --winui-control-elevation-border-color, a
      // three-value border-color shorthand. Griffel will not take a shorthand
      // beside the longhands this rule needs, so the two stops it is composed
      // of are named directly -- and the arrangement is restated per theme,
      // because the light dictionary flips the gradient (ScaleY="-1") and the
      // dark one does not: the heavier ControlStrokeColorSecondary edge sits
      // at the bottom in light and at the top in dark.
      // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L382-L390
      // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L186-L191
      borderTopColor: 'var(--winui-control-stroke-default)',
      borderRightColor: 'var(--winui-control-stroke-default)',
      borderBottomColor: 'var(--winui-control-stroke-secondary)',
      borderLeftColor: 'var(--winui-control-stroke-default)',
      '@media (prefers-color-scheme: dark)': {
        borderTopColor: 'var(--winui-control-stroke-secondary)',
        borderBottomColor: 'var(--winui-control-stroke-default)',
      },
    },
    '&:active': {
      backgroundColor: 'var(--winui-control-fill-tertiary)',
      ...shorthands.borderColor('var(--winui-control-stroke-default)'),
    },
    // The system focus visual, which both rows opt into. It is a two-ring
    // composite: a 2px outer stroke in FocusStrokeColorOuter with a 1px inner
    // stroke in FocusStrokeColorInner immediately inside it, drawn around a
    // rect that is the element's bounds shrunk by FocusVisualMargin. That
    // margin is -3, so the rect sits three outside the border box, the outer
    // ring lands between one and three out, and the inner ring takes the pixel
    // against the card. An outline offset by one carries the outer ring and a
    // 1px spread shadow carries the inner one, both following the row's own
    // corners -- including the squared bottom of an open expander header.
    //
    // Under forced colours the shadow is dropped and the outline is repainted
    // in a system colour, which is the same single-ring reduction the rest of
    // the layer takes.
    //
    // SettingsCard states that -3 itself and the default ToggleButton style
    // states it too, but the toolkit's keyed header style carries no BasedOn
    // and so falls back to a zero margin. We give both rows the -3 placement:
    // they are one row to the reader, and a ring that shifts three pixels
    // between two rows of the same list reads as a defect.
    // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L138-L139
    // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml#L297
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L193
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L718
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L441-L451
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/DependencyObject/DependencyProperty.cpp#L22-L25
    // https://drafts.csswg.org/css-color-adjust/#forced-colors-properties
    '&:focus-visible': {
      boxShadow: '0 0 0 1px var(--winui-focus-stroke-inner)',
      outlineColor: 'var(--winui-focus-stroke-outer)',
      outlineOffset: '1px',
      outlineStyle: 'solid',
      outlineWidth: '2px',
    },
  },
  // Pressing a clickable card drops its header and its header icon to the
  // secondary text fill. The description is painted from that same fill at
  // rest, so it does not move even though the toolkit repaints it here too.
  //
  // The expander header does not take this. Its own
  // ExpanderHeaderForegroundPressed is the primary fill, and the SettingsCard
  // the toolkit puts inside that header is IsClickEnabled="False", so the
  // card's pressed foreground never runs there.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L24-L25
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L236-L267
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml#L87-L96
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L6-L8
  clickable: { '&:active': { color: 'var(--winui-text-fill-secondary)' } },
  text: { display: 'grid', minWidth: 0, marginInlineEnd: 'auto', paddingInlineEnd: '24px' },
  // SettingsCardHeaderIconMaxSize 20 with SettingsCardHeaderIconMargin 2,0,20,0.
  // The holder collapses when there is no icon, so a card without one starts
  // its text at the padding rather than at an empty column. The glyph takes
  // the row's foreground rather than naming one, because the header icon
  // presenter is one of the two the pressed state repaints.
  //
  // The 20 bounds the layout box, not the ink: a Viewbox scales its child by
  // that child's DesiredSize, which for an icon is the box the glyph is laid
  // out in, so the literal transcription is a 20px box. The 24 cut is rendered
  // at 24 instead, because Fluent's 24 cut carries about 20 units of ink where
  // its 20 cut carries about 16 -- an ink-weight choice of ours rather than a
  // size the Viewbox produces.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L103-L106
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L398-L402
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/Viewbox.cpp#L266-L289
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/icon.cpp#L109-L126
  icon: {
    alignItems: 'center',
    display: 'flex',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    fontSize: '24px',
    justifyContent: 'center',
    '& svg': { height: '24px', width: '24px' },
    marginInlineEnd: '20px',
    marginInlineStart: '2px',
    width: '24px',
  },
  // The header takes no TextBlock style in the toolkit: it inherits the control
  // content size, which is the body step at the regular weight. The description
  // is the caption, a step quieter, and the two lines carry no gap between them.
  // That quieter step is the same secondary fill the pressed state paints, so
  // the description holds still while the header above it drops.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L424
  description: { color: 'var(--winui-text-fill-secondary)' },
  // The expander's header keeps the card's leading padding and gives the
  // chevron its own room at the trailing edge; open, its bottom corners square
  // off against the region below. Opening changes nothing else: the header's
  // Checked states repaint it in the same brushes its unchecked ones do.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml#L420-L501
  expanderHeader: {
    backgroundColor: 'var(--winui-card-background-fill-default)',
    ...shorthands.borderColor('var(--winui-card-stroke-default)'),
    fontFamily: 'inherit',
    fontSize: 'inherit',
    paddingInlineEnd: '4px',
    textAlign: 'start',
    width: '100%',
  },
  // The floor under a select in a settings row. A select is as wide as the value
  // it currently shows, so a row answering "Off" leaves a control the size of a
  // button and a column of these rows has no edge to line up on. The reasoning,
  // and what Windows does about it, is in ./fluent-form-controls.tsx, which
  // declares the variable this raises. Only a select reads it: a switch or a
  // button in the same slot is already the size it is meant to be.
  //
  // Both rows take it, because a reader sees one list. The same control moves
  // between the two -- ../api-keys/retention-field.tsx renders a card when the
  // period has nothing to reveal and an expander when it has -- so a floor on
  // one of them would make a row change width for a reason that has nothing to
  // do with its value.
  //
  // A floor that always applied would be a hard one -- `min-width` cannot
  // yield, so it would push the row wider than its container instead of
  // giving way -- which is why the container query is the rule rather than a
  // guard on it. 480 is the width at which the row can afford the floor: 122
  // of chrome (16 of leading padding, 46 for the icon and its margins, 24
  // between text and control, the 32 chevron, 4 of trailing padding), 200 for
  // the control, and 160 left for the label, which is a readable line rather
  // than a squeezed one. Narrower than that and the select goes back to
  // sizing itself, which is what a phone-width row wants anyway.
  action: {
    '@container floway-settings-row (min-width: 480px)': {
      '--floway-select-min-width': '200px',
    },
  },
  expanderHeaderOpen: { borderEndStartRadius: 0, borderEndEndRadius: 0 },
  // The content region is the quieter step of the card ramp, and the edge it
  // shares with the header above is suppressed rather than drawn twice.
  content: {
    backgroundColor: 'var(--winui-card-background-fill-secondary)',
    borderRightStyle: 'solid',
    borderBottomStyle: 'solid',
    borderLeftStyle: 'solid',
    borderRightWidth: '1px',
    borderBottomWidth: '1px',
    borderLeftWidth: '1px',
    borderRightColor: 'var(--winui-card-stroke-default)',
    borderBottomColor: 'var(--winui-card-stroke-default)',
    borderLeftColor: 'var(--winui-card-stroke-default)',
    borderEndStartRadius: 'var(--winui-control-corner-radius)',
    borderEndEndRadius: 'var(--winui-control-corner-radius)',
    boxSizing: 'border-box',
    padding: '16px',
  },
  // A 32px square holding a 16px glyph. It is a ContentControl in the toolkit,
  // not a button: its background is SubtleFillColorTransparent and it states no
  // pointer states of its own, because the whole header row is the button and
  // the chevron only shows which way that button is pointing. The square is
  // also what spaces the glyph -- eight pixels of its own air on every side,
  // and no margin around the icon itself. The glyph names the primary text
  // fill rather than inheriting the row's: ExpanderChevronForeground and its
  // pointer-over and pressed counterparts are all that same fill, so the
  // chevron is the one part of the row that never follows a foreground state.
  //
  // The toolkit hangs that box beside the header card rather than inside it,
  // and gives it eight more of margin at the trailing edge: its glyph lands
  // sixteen from the header's edge, and twelve from whatever precedes it once
  // the card's own trailing padding of 4 is counted. Here the box sits in the
  // header row itself, inside that same 4, so the glyph reads twelve from the
  // edge and eight from what precedes it. The construction is the toolkit's,
  // one step tighter, and the step is ours.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml#L15
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml#L540-L574
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L99
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L15-L21
  chevron: {
    alignItems: 'center',
    color: 'var(--winui-text-fill-primary)',
    display: 'flex',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    height: '32px',
    justifyContent: 'center',
    width: '32px',
  },
  // The chevron's turn is WinUI's own, and it is not the region's. WinUI draws
  // the glyph as an AnimatedIcon, so the numbers sit in the generated visual
  // source rather than in a dictionary: a 4.3333s composition at 60fps, cut
  // into named state segments, of which the two that carry this rotation --
  // NormalOffToNormalOn and NormalOnToNormalOff -- each spend ten of those
  // frames turning. That is 167ms either way, on the cubic Bezier through
  // (0.167, 0.167) and (0, 1), and it is symmetric for that reason while the
  // Expander's own asymmetric open and close stay with the region they time.
  // ../../winui/controls/accordion.css.ts states the same turn on the other
  // disclosure this app has.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L104
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L352
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L428-L440
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L789-L796
  chevronGlyph: {
    transitionDuration: '167ms',
    transitionProperty: 'rotate',
    transitionTimingFunction: 'cubic-bezier(0.167, 0.167, 0, 1)',
    // WinUI's expander chevron is an AnimatedIcon, and AnimatedIcon is gated on
    // UISettings.AnimationsEnabled: with animations off it displays the final
    // frame of the transition rather than playing it. The chevron lands in its
    // correct orientation either way, which is what carries the state.
    // https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/animated-icon
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedIcon.cpp#L432-L444
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  // Expander's open and close, asymmetric in duration as the source is: 333ms
  // opening, 167ms closing. CSS states one duration per transitioned property
  // rather than one per direction, so each direction's values sit on the rule
  // that is becoming active -- the closed base here, the open modifier below.
  //
  // What travels is the region's own height, and that is a simplification of
  // ours. WinUI translates the content under a composition clip: its region
  // takes full height at once and only the content moves, and nothing about
  // that shape is out of reach here, since a percentage translate resolves
  // against the element's own border box and needs no measurement. Animating
  // the height buys one grid row and costs two things. Everything below the
  // row reflows for the length of the transition. And the closing spline goes
  // with it: WinUI's cubic-bezier(1, 1, 0, 1) is stationary at the midpoint,
  // so a fifth of the duration carries half the travel -- a flick of content
  // under a static clip, the rest of the page jolting when the same curve
  // drives a height. The close takes the fast-out-slow-in spline the open
  // does, which over 167ms reads as prompt rather than abrupt.
  //
  // The reduce branch departs from shipped WinUI, which keeps sliding: the
  // Expander authors its motion as a VisualState storyboard rather than a
  // VisualTransition, and the animations gate only reaches Transition and
  // Dynamic storyboards, so the content still travels with animations off. A
  // region that grows from nothing to its full height is motion animation by
  // WCAG's own definition, which turns on perceived size and position, so the
  // preference is honoured here as a web-platform obligation.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander.xaml#L62-L90
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/vsm/VisualStateManagerActuator.cpp#L590-L609
  // https://github.com/w3c/wcag/blob/900ea026b967bc306a2cdbe0c586330a508d6759/guidelines/terms/21/motion-animation.html
  contentFrame: {
    display: 'grid',
    gridTemplateRows: '0fr',
    transitionDuration: 'var(--winui-collapse-animation-duration)',
    transitionProperty: 'grid-template-rows',
    transitionTimingFunction: 'var(--winui-control-fast-out-slow-in-easing)',
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  contentFrameOpen: {
    gridTemplateRows: '1fr',
    transitionDuration: 'var(--winui-expand-animation-duration)',
    transitionTimingFunction: 'var(--winui-control-fast-out-slow-in-easing)',
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  contentClip: { minHeight: 0, overflow: 'hidden' },
  chevronOpen: {
    rotate: '180deg',
    transitionDuration: 'var(--winui-expand-animation-duration)',
  },
  // A switch in a settings row reads its own state out, and the reading sits
  // BEFORE the track. WinUI's own ToggleSwitch template puts OnContent after it
  // -- column 2 of a three column grid, twelve along from the track in column 0
  // -- and a SettingsCard overrides exactly that: it pushes an implicit
  // ToggleSwitch style into its own content scope whose retemplate keeps the
  // same three columns and swaps what sits in them, the presenters taking
  // column 0 and the track column 2. The ordering is structural, which is why
  // it survives the row wrapping and the control moving below the text.
  //
  // That style also compacts the control: MinWidth 0 and Height 36, against the
  // 154 and the content-sized height a standalone switch takes.
  //
  // The twelve between the readout and the track is that retemplate's own gap
  // column, spent here on the wrapper because the readout sits outside the
  // Fluent control rather than in a slot of it.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L140-L145
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L483-L492
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L985-L1053
  switchRow: {
    alignItems: 'center',
    columnGap: '12px',
    display: 'flex',
    height: '36px',
    justifyContent: 'flex-end',
    minWidth: 0,
  },
  // The readout is the ToggleSwitch's own OnContent and OffContent in that
  // retemplate, so a disabled switch paints it TextFillColorDisabled along
  // with the track. Sitting outside the Fluent control, it is out of reach of
  // the control's own disabled styling and states the dim itself.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L715-L724
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L7-L8
  readoutDisabled: { color: 'var(--winui-text-fill-disabled)' },
});

function CardText({ description, header, icon, id }: { description?: string; header: ReactNode; icon?: ReactNode; id?: string }) {
  const styles = useStyles();
  return <>
    {icon !== undefined && <span aria-hidden className={styles.icon}>{icon}</span>}
    <span className={styles.text}>
      <Text block id={id}>{header}</Text>
      {description !== undefined && <Text block size={200} className={styles.description}>{description}</Text>}
    </span>
  </>;
}

// A switch that reads its own state out, the way every toggle in a settings row
// does.
export function SettingsSwitch({ checked, disabled, label, onChange }: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  return <span className={styles.switchRow}>
    <Text className={disabled === true ? styles.readoutDisabled : undefined}>{t(checked ? 'common.on' : 'common.off')}</Text>
    <Switch aria-label={label} checked={checked} disabled={disabled} onChange={(_, data) => onChange(data.checked)} />
  </span>;
}

export function SettingsCard({ action, description, header, icon, onClick }: {
  action?: ReactNode;
  description?: string;
  header: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
}) {
  const styles = useStyles();
  const className = mergeClasses(styles.card, onClick !== undefined && styles.interactive, onClick !== undefined && styles.clickable);
  const content = <>
    <CardText description={description} header={header} icon={icon} />
    {action !== undefined && <span className={styles.action}>{action}</span>}
  </>;
  return onClick
    ? <div className={className} onClick={onClick} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }} role="button" tabIndex={0}>{content}</div>
    : <div className={className}>{content}</div>;
}

// The disclosure and the trailing control are independent: the switch can be
// thrown without opening the row and the row can be opened without touching the
// switch. In the toolkit that falls out of routed events -- the whole header is
// a ToggleButton and the trailing control marks the pointer handled before it
// gets there -- which the DOM does not do on its own.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml
export function SettingsExpander({ action, children, defaultOpen = false, description, header, icon, revealOn, toggledOn }: {
  action?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  description?: string;
  header: ReactNode;
  icon?: ReactNode;
  /**
   * Whether the region currently holds something the operator has to see --
   * a validation message that refused their submit. Rising, it opens the row:
   * an answer behind a closed disclosure is an answer nobody reads, and the
   * control that produced it is in here too. Falling, it does nothing, because
   * closing the row while someone is still editing inside it takes their work
   * off the screen mid-correction.
   */
  revealOn?: boolean;
  /**
   * The state of the switch in `action`, when there is one. Throwing it opens
   * the row, and turning it off closes the row again -- what the switch admits
   * is what the region configures, so there is nothing to read while it is off
   * and nothing to hide once it is on. The disclosure stays independent either
   * way: the row can still be opened and closed by hand without touching the
   * switch, and this only moves it when the switch itself changes.
   */
  toggledOn?: boolean;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(defaultOpen);
  const [toggleWas, setToggleWas] = useState(toggledOn);
  if (toggledOn !== undefined && toggledOn !== toggleWas) {
    setToggleWas(toggledOn);
    setOpen(toggledOn);
  }
  const [revealWas, setRevealWas] = useState(revealOn);
  if (revealOn !== revealWas) {
    setRevealWas(revealOn);
    if (revealOn === true) setOpen(true);
  }
  const contentId = useId();
  const headerId = useId();
  return <div>
    <button
      aria-controls={contentId}
      aria-expanded={open}
      className={mergeClasses(styles.card, styles.interactive, styles.expanderHeader, open && styles.expanderHeaderOpen)}
      onClick={() => setOpen(value => !value)}
      type="button"
    >
      <CardText description={description} header={header} icon={icon} id={headerId} />
      {/* The trailing control is inside the button, which is how the toolkit
          nests it too. There a routed event stops at the control that handled
          it; in the DOM the click would carry on to the header, so it is
          stopped here -- the switch throws without the row opening. */}
      {action !== undefined && <span className={styles.action} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>{action}</span>}
      <span aria-hidden className={styles.chevron}>
        <svg className={mergeClasses(styles.chevronGlyph, open && styles.chevronOpen)} width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.15 5.65c.2-.2.5-.2.7 0L8 9.79l4.15-4.14a.5.5 0 0 1 .7.7l-4.5 4.5a.5.5 0 0 1-.7 0l-4.5-4.5a.5.5 0 0 1 0-.7Z" />
        </svg>
      </span>
    </button>
    <div className={mergeClasses(styles.contentFrame, open && styles.contentFrameOpen)}>
      <div className={styles.contentClip}>
        {/* Closed, the region is inert rather than hidden. `hidden` is
            `display: none`, which takes the content out of flow in the same
            frame the row starts collapsing, leaving the row nothing to
            animate towards -- it just vanished. `inert` takes it out of the
            tab order and away from assistive technology without touching
            layout, so the row can close over its own duration. */}
        <div aria-labelledby={headerId} className={styles.content} id={contentId} inert={!open} role="group">{children}</div>
      </div>
    </div>
  </div>;
}
