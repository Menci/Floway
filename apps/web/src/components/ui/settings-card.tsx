import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { Switch } from './fluent-form-controls';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';

const { Text, makeStyles, mergeClasses, shorthands } = fluentComponents;

// Metrics transcribed from the Community Toolkit's SettingsCard and
// SettingsExpander, not microsoft-ui-xaml; brushes are resolved through the
// WinUI vocabulary this layer already carries. Forced colours are left to the
// user agent's own substitution, which reaches every brush the toolkit's
// HighContrast dictionary names except box-shadow.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L67-L112
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L52-L72
// https://drafts.csswg.org/css-color-adjust/#forced-colors-properties

// SettingsCardHeaderIconMargin 2,0,20,0. The wrapped control's inset is
// composed from the same measures rather than restated as their sum.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L106
const ICON_MARGIN_START = '2px';
const ICON_MARGIN_END = '20px';
const ICON_SIZE = '24px';
const ICON_COLUMN = `calc(${ICON_MARGIN_START} + ${ICON_SIZE} + ${ICON_MARGIN_END})`;

// A Griffel selector is rooted at the class it is written on, so a slot cannot
// reach backwards to ask whether an icon preceded it. The card asks instead and
// passes the answer down; the variable's absence is the no-icon case.
const ICON_MARKER = 'data-settings-card-icon';
const ICON_COLUMN_VAR = 'var(--floway-settings-icon-column, 0px)';

// SettingsCardWrapThreshold 476 and SettingsCardWrapNoIconThreshold 286. The
// toolkit's ControlSizeTrigger activates on `MinWidth <= ActualWidth <
// MaxWidth`, so range syntax keeps the two states the disjoint pair the
// triggers make.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L110-L111
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L312-L345
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/Triggers/src/ControlSizeTrigger.cs#L174-L175
const WRAPPED = '@container floway-settings-row (width < 476px)';
const WRAPPED_WITH_ICON = '@container floway-settings-row (286px <= width < 476px)';
const WRAPPED_NO_ICON = '@container floway-settings-row (width < 286px)';

const useStyles = makeStyles({
  // Containment sits one level out of the row so the query measures the same
  // box the toolkit's trigger reads (this element carries no padding or
  // border), and so the wrapped state can style the row itself -- a container
  // query never styles its own container.
  // https://drafts.csswg.org/css-contain-3/#size-container
  row: {
    containerName: 'floway-settings-row',
    containerType: 'inline-size',
  },
  // MinHeight 68, Padding 16, ControlCornerRadius, a 1px card stroke. The
  // header and header icon inherit the row's foreground, which is what lets the
  // pressed state move both from one rule.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L20-L21
  //
  // The 24 before the trailing control is an inset on the text block rather
  // than a row gap: a gap would also land between the icon and the text, which
  // already states its own 20.
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
    display: 'flex',
    minHeight: '68px',
    padding: '16px',
    // ContentSpacingStates opens SettingsCardVerticalHeaderContentSpacing once
    // the control is on its own line. Wrapping is stated inside the query
    // rather than at every width: a flex line breaks on what its items would
    // like to be, so an unconditional wrap would send the control down at any
    // width behind a long enough header.
    // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L109
    // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L388-L395
    [WRAPPED]: { flexWrap: 'wrap', rowGap: '8px' },
    // Wrapped, the control moves into the HEADER's column, so with the icon
    // still shown it is indented to where the header text starts.
    [WRAPPED_WITH_ICON]: {
      [`&:has(> [${ICON_MARKER}])`]: { '--floway-settings-icon-column': ICON_COLUMN },
    },
  },
  // Only a card that does something when clicked takes the pointer ramp. The
  // fill moves over the control's duration; the toolkit leaves the border
  // instant. WinUI sets that BrushTransition up only while
  // UISettings.AnimationsEnabled is on, which the web states as
  // prefers-reduced-motion.
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
      // ControlElevationBorderBrush is a gradient with one heavier edge, and
      // Griffel will not take the shorthand beside the longhands this rule
      // needs, so its two stops are named directly. The arrangement is restated
      // per theme because the light dictionary flips the gradient (ScaleY="-1")
      // and the dark one does not.
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
    // `:has` alongside each pointer state: the expander's own press lands on the
    // overlay inside the row, and a row that reacts only to a press on itself
    // would hold its rest fill while the reader is holding it down.
    '&:active, &:has(> :active)': {
      backgroundColor: 'var(--winui-control-fill-tertiary)',
      ...shorthands.borderColor('var(--winui-control-stroke-default)'),
    },
    // The system focus visual: a 2px FocusStrokeColorOuter ring with a 1px
    // FocusStrokeColorInner ring immediately inside it, around the border box
    // grown by FocusVisualMargin -3. The outline carries the outer ring and a
    // 1px spread shadow the inner one; forced colours drop the shadow and leave
    // a single repainted ring.
    //
    // SettingsCard states that -3 and the toolkit's keyed expander header
    // style, carrying no BasedOn, falls back to zero. Giving both rows the -3
    // is ours and nothing sources it.
    // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L138-L139
    // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml#L297
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L193
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L718
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L441-L451
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/DependencyObject/DependencyProperty.cpp#L22-L25
    // https://drafts.csswg.org/css-color-adjust/#forced-colors-properties
    //
    // The expander's row wears the ring for the disclosure inside it: the
    // element taking focus is a stretched overlay, and a ring on the overlay
    // would sit inside the row's own edge rather than around it.
    '&:focus-visible, &:has(> :focus-visible)': {
      boxShadow: '0 0 0 1px var(--winui-focus-stroke-inner)',
      outlineColor: 'var(--winui-focus-stroke-outer)',
      outlineOffset: '1px',
      outlineStyle: 'solid',
      outlineWidth: '2px',
    },
  },
  // HeaderPanel's own trailing margin of 24, which the wrapped states drop; the
  // auto margin stays because on an expander it holds the chevron against the
  // trailing edge.
  //
  // Wrapped, the header asks for its narrowest rather than its content width:
  // a flex line breaks on what its items would like to be, so a wide header was
  // sending the chevron down ahead of the control. Narrowest rather than zero,
  // because a zero-basis header on an icon-less row leaves the control the
  // whole line and wraps the header a word per line.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L200-L204
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L409-L412
  text: {
    display: 'grid',
    minWidth: 0,
    marginInlineEnd: 'auto',
    paddingInlineEnd: '24px',
    [WRAPPED]: { flexBasis: 'min-content', flexGrow: 1, paddingInlineEnd: 0 },
  },
  // SettingsCardHeaderIconMaxSize 20 with SettingsCardHeaderIconMargin 2,0,20,0.
  // The glyph inherits the row's foreground because the header icon presenter
  // is one of the two the pressed state repaints.
  //
  // The 20 bounds the layout box, not the ink -- a Viewbox scales its child by
  // DesiredSize -- and that read too small here, so the 24 cut is rendered at
  // 24: Fluent's 24 cut carries about 20 units of ink where its 20 cut carries
  // about 16. The substitution is ours and nothing sources it.
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
    fontSize: ICON_SIZE,
    justifyContent: 'center',
    '& svg': { height: ICON_SIZE, width: ICON_SIZE },
    marginInlineEnd: ICON_MARGIN_END,
    marginInlineStart: ICON_MARGIN_START,
    width: ICON_SIZE,
    // RightWrappedNoIcon collapses the holder outright, which is the same
    // display: none the toolkit's Visibility means.
    [WRAPPED_NO_ICON]: { display: 'none' },
  },
  // The header inherits the control content size; the description is the
  // caption step in the secondary fill the pressed state paints, so it holds
  // still while the header above it drops.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L424
  description: { color: 'var(--winui-text-fill-secondary)' },
  // Open, the header's bottom corners square off against the region below.
  // Opening changes nothing else: the header's Checked states repaint it in the
  // same brushes its unchecked ones do.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml#L420-L501
  expanderHeader: {
    position: 'relative',
    backgroundColor: 'var(--winui-card-background-fill-default)',
    ...shorthands.borderColor('var(--winui-card-stroke-default)'),
    fontFamily: 'inherit',
    fontSize: 'inherit',
    paddingInlineEnd: '4px',
    textAlign: 'start',
    width: '100%',
  },
  // A floor under a select, whose width otherwise tracks the value it currently
  // shows, leaving a column of rows with no edge to line up on. Only a select
  // reads the variable; ./fluent-form-controls.tsx declares it.
  //
  // One component, one floor: a card and an expander are the same row, and
  // whether a row happens to be expandable says nothing about the control the
  // floor sizes. The API keys retention row is the case that settles it -- the
  // same row renders as a card or as an expander depending on its own value and
  // on whether the key exists yet, so a floor scoped to one form would move
  // that row's width for a reason unrelated to what the row says.
  //
  // It applies at every width, as SettingsCardContentMinWidth does -- the
  // narrow states give the control a line of its own, which is where the room
  // comes from. The 200 is ours, not the toolkit's 120.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L146-L170
  //
  // Wrapped, the control takes the row below and starts at the icon column.
  // The order keeps an expander's chevron up on the header line: flex fills its
  // lines in order-modified order, so a 100%-wide control would otherwise carry
  // the chevron down with it.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L313-L345
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L453-L458
  action: {
    '--floway-select-min-width': '200px',
    // Above the disclosure's stretched target, so the control it holds keeps its
    // own clicks rather than opening the row.
    position: 'relative',
    [WRAPPED]: {
      flexBasis: `calc(100% - ${ICON_COLUMN_VAR})`,
      marginInlineStart: ICON_COLUMN_VAR,
      order: 1,
    },
  },
  expanderHeaderOpen: { borderEndStartRadius: 0, borderEndEndRadius: 0 },
  // The disclosure paints nothing and lays out nothing: it carries the row's
  // click target, stretched over the row from behind, and takes its name from
  // the header the row already renders, so the action keeps its own place in
  // the flex line and its own clicks.
  expanderDisclosure: {
    appearance: 'none',
    // The row paints the ring; see the interactive style above.
    ':focus-visible': { outline: 'none' },
    background: 'none',
    ...shorthands.borderWidth(0),
    cursor: 'pointer',
    inset: 0,
    margin: 0,
    padding: 0,
    position: 'absolute',
  },

  // The edge shared with the header above is suppressed rather than drawn twice.
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
  // A 32px square holding a 16px glyph, with no margin of its own: the square
  // is what spaces the glyph. It states no pointer states because the whole
  // header row is the button. The glyph names the primary text fill rather than
  // inheriting the row's, since ExpanderChevronForeground and its pointer-over
  // and pressed counterparts are all that same fill.
  //
  // The toolkit hangs the box beside the header card with eight more of
  // trailing margin; here it sits inside the header row, so the glyph reads
  // twelve from the edge rather than sixteen. That step in is ours.
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
  // The chevron's turn is the AnimatedIcon's own, not the region's: ten frames
  // of a 4.3333s 60fps composition either way, hence symmetric while the
  // Expander's open and close stay asymmetric.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L104
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L352
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L428-L440
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L789-L796
  chevronGlyph: {
    transitionDuration: '167ms',
    transitionProperty: 'rotate',
    transitionTimingFunction: 'cubic-bezier(0.167, 0.167, 0, 1)',
    // AnimatedIcon is gated on UISettings.AnimationsEnabled and displays the
    // final frame rather than playing it, which is what carries the state.
    // https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/animated-icon
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedIcon.cpp#L432-L444
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  // Expander's open and close, asymmetric in duration as the source is: 333ms
  // opening, 167ms closing. CSS states one duration per property rather than
  // per direction, so each direction's values sit on the rule becoming active.
  //
  // What travels is the region's own height, a simplification of ours: WinUI
  // translates the content under a composition clip. Animating the height
  // reflows everything below for the length of the transition, and the close
  // runs on the fast-out-slow-in spline rather than WinUI's
  // cubic-bezier(1, 1, 0, 1). Nothing sources that substituted spline.
  //
  // The reduce branch departs from shipped WinUI, which keeps sliding: the
  // Expander authors its motion as a VisualState storyboard, and the animations
  // gate only reaches Transition and Dynamic storyboards. A region growing from
  // nothing to full height is motion animation by WCAG's definition, so the
  // preference is honoured here.
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
  // A switch in a settings row reads its own state out BEFORE the track, which
  // is the reverse of the standalone ToggleSwitch template: SettingsCard pushes
  // an implicit style into its content scope that swaps the presenters into
  // column 0 and the track into column 2, and compacts the control to MinWidth
  // 0 / Height 36. The order is structural, so it survives the row wrapping.
  // The 12 is that retemplate's gap column, spent here on the wrapper because
  // the readout sits outside the Fluent control.
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
    // Wrapped, this row is the one control that was packing itself against the
    // trailing edge; a stretched box would have kept it there.
    [WRAPPED]: { justifyContent: 'flex-start' },
  },
  // In the retemplate the readout is the ToggleSwitch's own OnContent and
  // OffContent, painted TextFillColorDisabled with the track. Sitting outside
  // the Fluent control, it is out of reach of that styling and states the dim
  // itself.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L715-L724
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleSwitch_themeresources.xaml#L7-L8
  readoutDisabled: { color: 'var(--winui-text-fill-disabled)' },
});

function CardText({ description, header, icon, id }: { description?: string; header: ReactNode; icon?: ReactNode; id?: string }) {
  const styles = useStyles();
  return <>
    {icon !== undefined && <span aria-hidden className={styles.icon} {...{ [ICON_MARKER]: '' }}>{icon}</span>}
    <span className={styles.text}>
      <Text block id={id}>{header}</Text>
      {description !== undefined && <Text block size={200} className={styles.description}>{description}</Text>}
    </span>
  </>;
}

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

export function SettingsCard({ action, description, header, icon }: {
  action?: ReactNode;
  description?: string;
  header: ReactNode;
  icon?: ReactNode;
}) {
  const styles = useStyles();
  return <div className={styles.row}>
    <div className={styles.card}>
      <CardText description={description} header={header} icon={icon} />
      {action !== undefined && <span className={styles.action}>{action}</span>}
    </div>
  </div>;
}

// The disclosure and the trailing control are independent: the switch can be
// thrown without opening the row and the row can be opened without touching the
// switch. In the toolkit that falls out of routed events, which the DOM does
// not do on its own.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml
export function SettingsExpander({ action, children, defaultOpen = false, description, header, icon, revealOn, toggledOn }: {
  action?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  description?: string;
  header: ReactNode;
  icon?: ReactNode;
  /**
   * Whether the region currently holds something that has to be seen -- a
   * validation message that refused a submit. Rising, it opens the row.
   * Falling, it does nothing: closing the row mid-correction would take the
   * editing surface off the screen.
   */
  revealOn?: boolean;
  /**
   * The state of the switch in `action`, when there is one. It moves the
   * disclosure in both directions -- what the switch admits is what the region
   * configures -- while the row stays independently openable by hand.
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
  // The toolkit nests the trailing control inside the header's own click target,
  // which HTML forbids: a button may not contain a button, and the row's action
  // slot takes whatever the caller passes -- a switch is an input, a select is a
  // button. So the disclosure is its own element beside the action rather than
  // around it, and reaches the rest of the row through a stretched overlay,
  // which leaves the action a sibling that sits above it.
  // https://html.spec.whatwg.org/multipage/form-elements.html#the-button-element
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsExpander/SettingsExpander.xaml
  return <div className={styles.row}>
    <div className={mergeClasses(styles.card, styles.interactive, styles.expanderHeader, open && styles.expanderHeaderOpen)}>
      <button
        aria-controls={contentId}
        aria-expanded={open}
        aria-labelledby={headerId}
        className={styles.expanderDisclosure}
        onClick={() => setOpen(value => !value)}
        type="button"
      />
      <CardText description={description} header={header} icon={icon} id={headerId} />
      {action !== undefined && <span className={styles.action}>{action}</span>}
      <span aria-hidden className={styles.chevron}>
        <svg className={mergeClasses(styles.chevronGlyph, open && styles.chevronOpen)} width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M3.15 5.65c.2-.2.5-.2.7 0L8 9.79l4.15-4.14a.5.5 0 0 1 .7.7l-4.5 4.5a.5.5 0 0 1-.7 0l-4.5-4.5a.5.5 0 0 1 0-.7Z" />
        </svg>
      </span>
    </div>
    <div className={mergeClasses(styles.contentFrame, open && styles.contentFrameOpen)}>
      <div className={styles.contentClip}>
        {/* Closed, the region is inert rather than hidden: `hidden` is
            `display: none`, which takes the content out of flow in the same
            frame the row starts collapsing, leaving nothing to animate
            towards. `inert` withdraws it without touching layout. */}
        <div aria-labelledby={headerId} className={styles.content} id={contentId} inert={!open} role="group">{children}</div>
      </div>
    </div>
  </div>;
}
