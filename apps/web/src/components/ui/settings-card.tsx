import { useId, useState } from 'react';
import type { DragEventHandler, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { SectionHeader } from './section-header';
import { fluentComponents } from '../../fluent';

const { Switch, Text, makeStyles, mergeClasses, shorthands } = fluentComponents;

// The row the Windows Settings app is built out of: an icon, a header, a
// description, and a control at the trailing edge -- the variant of the same
// row that also opens to reveal more, and the variant that is itself the
// button. Plus the section those rows are grouped into.
//
// This family is the Community Toolkit's SettingsCard and SettingsExpander
// rather than anything in microsoft-ui-xaml, so the metrics below come from
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

// SettingsCardHeaderIconMargin is 2,0,20,0 around the glyph. Those three
// measures are the width of the icon column, which is also the inset the
// wrapped control below takes, so the column is composed from the same values
// the icon states rather than restated as the number they come to.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L106
const ICON_MARGIN_START = '2px';
const ICON_MARGIN_END = '20px';
const ICON_SIZE = '24px';
const ICON_COLUMN = `calc(${ICON_MARGIN_START} + ${ICON_SIZE} + ${ICON_MARGIN_END})`;

// The icon column is a column the toolkit's grid declares whether or not
// anything is in it; here the span exists only when there is an icon, so the
// rule that indents the wrapped control has to ask whether one preceded it.
// The question is put on the card, which is the one element that can see both
// -- a Griffel selector is rooted at the class it is written on, so a slot
// cannot reach backwards to a sibling -- and the answer travels down as a
// custom property. Its absence is the no-icon case, which is why the reader
// supplies the zero rather than another rule stating it.
const ICON_MARKER = 'data-settings-card-icon';
const ICON_COLUMN_VAR = 'var(--floway-settings-icon-column, 0px)';

// SettingsCardWrapThreshold 476 and SettingsCardWrapNoIconThreshold 286. The
// toolkit reaches them through a ControlSizeTrigger, which activates on
// `MinWidth <= ActualWidth < MaxWidth`; the range syntax states that comparison
// as it is written, so RightWrapped and RightWrappedNoIcon stay the disjoint
// pair the two triggers make rather than one overriding the other.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L110-L111
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L312-L345
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/Triggers/src/ControlSizeTrigger.cs#L174-L175
const WRAPPED = '@container floway-settings-row (width < 476px)';
const WRAPPED_WITH_ICON = '@container floway-settings-row (286px <= width < 476px)';
const WRAPPED_NO_ICON = '@container floway-settings-row (width < 286px)';

// The card's PointerOver visual state: the secondary control fill under the
// elevation stroke.
//
// ControlElevationBorderBrush is a gradient with one heavier edge, which the
// vocabulary carries as --winui-control-elevation-border-color, a three-value
// border-color shorthand. Griffel will not take a shorthand beside the
// longhands this rule needs, so the two stops it is composed of are named
// directly -- and the arrangement is restated per theme, because the light
// dictionary flips the gradient (ScaleY="-1") and the dark one does not: the
// heavier ControlStrokeColorSecondary edge sits at the bottom in light and at
// the top in dark.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L10-L11
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L382-L390
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L186-L191
const POINTER_OVER = {
  backgroundColor: 'var(--winui-control-fill-secondary)',
  borderTopColor: 'var(--winui-control-stroke-default)',
  borderRightColor: 'var(--winui-control-stroke-default)',
  borderBottomColor: 'var(--winui-control-stroke-secondary)',
  borderLeftColor: 'var(--winui-control-stroke-default)',
  '@media (prefers-color-scheme: dark)': {
    borderTopColor: 'var(--winui-control-stroke-secondary)',
    borderBottomColor: 'var(--winui-control-stroke-default)',
  },
} as const;

const useStyles = makeStyles({
  // The box the two thresholds above are measured against. A size container
  // query reports its container's CONTENT box -- measured, not assumed: a 400px
  // border-box element with 50 of padding and 10 of border answers 280 -- while
  // the toolkit's trigger reads the whole grid, padding and border included.
  // Declaring the containment one level out of the row makes those the same
  // box, since this element carries neither. It also has to: a container query
  // styles the container's descendants and never the container, and the wrapped
  // state has something to say about the row itself.
  //
  // The row's own inline size never depends on its contents -- it is a block
  // filling the list it sits in -- so declaring the containment states what was
  // already true.
  // https://drafts.csswg.org/css-contain-3/#size-container
  row: {
    containerName: 'floway-settings-row',
    containerType: 'inline-size',
  },
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
    display: 'flex',
    minHeight: '68px',
    padding: '16px',
    // The narrow states put the control on a line of its own, and
    // ContentSpacingStates opens SettingsCardVerticalHeaderContentSpacing
    // between the two lines once it is there. Wrapping is stated inside the
    // query rather than at every width, because a flex line breaks on what its
    // items would like to be rather than on what they can be squeezed to: left
    // on, a header long enough to want the whole row would send the control
    // down on its own at any width at all.
    // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L109
    // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L388-L395
    [WRAPPED]: { flexWrap: 'wrap', rowGap: '8px' },
    // Wrapped, the control moves into the HEADER's column rather than to the
    // card's leading edge, so with the icon still shown it is indented to
    // where the header text starts. Below the no-icon threshold the icon is
    // gone and the indent goes with it, which is why this is the narrower of
    // the two ranges: the two queries are disjoint, so neither has to outrank
    // the other.
    [WRAPPED_WITH_ICON]: {
      [`&:has(> [${ICON_MARKER}])`]: { '--floway-settings-icon-column': ICON_COLUMN },
    },
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
    '&:hover': POINTER_OVER,
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
    // and so falls back to a zero margin. We give both rows the -3 placement.
    // Nothing sources that unification -- the toolkit's own answer is the two
    // margins it states, and taking one of them for both is ours.
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
  // The 24 the header keeps between itself and the control is HeaderPanel's own
  // trailing margin, and the wrapped states set that margin to 0: with the
  // control on the line below rather than beside it, there is nothing left for
  // the 24 to hold apart. The auto margin stays, because on an expander it is
  // what keeps the chevron against the trailing edge.
  //
  // The header also stops asking for its content width there. A flex line
  // breaks on what its items would LIKE to be rather than on what they can be
  // squeezed to, so a header wide enough to want the whole line was sending
  // the chevron down ahead of the control -- three lines where the toolkit has
  // two. Asking for its narrowest instead, and growing into what is left, is
  // the column the toolkit gives it anyway: HeaderPanel sits in the star-sized
  // one. Narrowest rather than nothing, because nothing is a line the control
  // exactly fits into: at 100% wide it would sit beside a zero-width header on
  // a row with no icon to push it off, and the header would then wrap a word
  // per line.
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
  // The holder collapses when there is no icon, so a card without one starts
  // its text at the padding rather than at an empty column. The glyph takes
  // the row's foreground rather than naming one, because the header icon
  // presenter is one of the two the pressed state repaints.
  //
  // The 20 bounds the layout box, not the ink: a Viewbox scales its child by
  // that child's DesiredSize, which for an icon is the box the glyph is laid
  // out in, so the literal transcription is a 20px box. The operator called
  // this icon too small at that size, so the 24 cut is rendered at 24 instead;
  // Fluent's 24 cut carries about 20 units of ink where its 20 cut carries
  // about 16, which is the measurement the substitution rests on. Which cut
  // answers him is ours -- he named no size.
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
  // Both rows take it. The same control moves between the two -- a caller
  // renders a card while its setting has nothing to reveal and an expander
  // once it has -- so a floor on one of them would make a row change width for
  // a reason that has nothing to do with its value. The operator scoped his
  // own instruction to a select on an expander row; carrying it to the card
  // row as well is ours.
  //
  // It applies at every width, as the toolkit's own does:
  // SettingsCardContentMinWidth goes into the card's content scope as an
  // implicit MinWidth on Slider, ComboBox and TextBox -- "so they neatly align"
  // -- and no visual state withdraws it. What the narrow states do instead is
  // give the control a line of its own, which is where the room for the floor
  // comes from. The 200 is the operator's, not the toolkit's 120: he asked for
  // a soft floor, put PowerToys' measured row at roughly 478 as too wide, and
  // named 200 or 160.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L146-L170
  //
  // Wrapped, the control takes the row below: PART_ContentPresenter moves to
  // row 1 and stretches, and its own content aligns Left inside that. The order
  // is what keeps an expander's chevron up on the header line -- flex fills its
  // lines in order-modified order, so a control that is 100% wide would
  // otherwise carry the chevron down with it. The inset it starts at is the
  // icon column, which the card measures out above.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L313-L345
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L453-L458
  action: {
    '--floway-select-min-width': '200px',
    [WRAPPED]: {
      flexBasis: `calc(100% - ${ICON_COLUMN_VAR})`,
      marginInlineStart: ICON_COLUMN_VAR,
      order: 1,
    },
  },
  // The same state, asserted rather than matched. A card that accepts a drop
  // has to answer while a drag is over it, and during an HTML drag operation
  // the user agent matches no `:hover` on anything -- so the row states the
  // visual it already has for "the pointer is on me and I will respond" rather
  // than acquiring a second one for the drag.
  // https://html.spec.whatwg.org/multipage/dnd.html#drag-and-drop-processing-model
  pointerOver: POINTER_OVER,
  expanderHeaderOpen: { borderEndStartRadius: 0, borderEndEndRadius: 0 },
  // The chrome a `button` element brings with it and the card does not want.
  // The expander header states the same reset alongside the padding only it
  // needs, so the two rules overlap rather than one deriving from the other.
  cardButton: {
    fontFamily: 'inherit',
    fontSize: 'inherit',
    textAlign: 'start',
    width: '100%',
  },
  // PART_ActionIconPresenterHolder: a 13px glyph held 14 clear of whatever
  // precedes it, shown only while the card is the button. The toolkit's own
  // default is the Segoe Fluent chevron E974, assigned in the constructor
  // rather than in the dependency property's metadata; a caller that wants a
  // different one sets ActionIcon, and one that wants none clears
  // IsActionIconVisible. Neither of those is offered here -- the chevron is
  // the only mark this app's clickable rows carry -- so the glyph is stated
  // once, as the path the expander's own chevron is drawn from turned a
  // quarter.
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L107-L108
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L459-L466
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.cs#L66-L72
  // https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.cs#L254-L266
  actionIcon: {
    alignItems: 'center',
    display: 'flex',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    justifyContent: 'center',
    marginInlineStart: '14px',
    '& svg': { height: '13px', width: '13px' },
  },
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
  // edge and eight from what precedes it. The construction is the toolkit's;
  // the step in is ours and nothing sources it.
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
  // with it: the close runs on the fast-out-slow-in spline the open does, not
  // on WinUI's cubic-bezier(1, 1, 0, 1), which is stationary at the midpoint
  // and puts half the travel into a fifth of the duration. The operator
  // reviewed the expander's curve and accepted it; the durations here are the
  // ones he accepted, the substituted close spline is not, and nothing sources
  // the substitution.
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
    // Wrapped, the content presenter stretches across the row below and aligns
    // what is in it Left. Every other control lands there on its own, but this
    // one is a flex row that was packing itself against the trailing edge, and
    // a stretched box would have kept it there.
    [WRAPPED]: { justifyContent: 'flex-start' },
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
    {icon !== undefined && <span aria-hidden className={styles.icon} {...{ [ICON_MARKER]: '' }}>{icon}</span>}
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

// The row when the row is itself the button. IsClickEnabled turns the card
// into the ButtonBase it already derives from, opens the pointer ramp the
// non-clickable row never wires up, and reveals the trailing action glyph.
// The toolkit means it for a row that navigates somewhere or opens something,
// which is what a picker is.
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.Properties.cs#L57-L61
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.cs#L117-L128
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/samples/SettingsCard.md#L20
export function SettingsCardButton({ description, drag, header, icon, onClick, pointerOver = false }: {
  description?: string;
  /**
   * The drop handlers, when the row also accepts what it would otherwise have
   * been clicked to choose. `pointerOver` is what draws the accepting state.
   */
  drag?: {
    onDragLeave: DragEventHandler;
    onDragOver: DragEventHandler;
    onDrop: DragEventHandler;
  };
  header: ReactNode;
  icon?: ReactNode;
  onClick: () => void;
  pointerOver?: boolean;
}) {
  const styles = useStyles();
  return <div className={styles.row}>
    <button
      className={mergeClasses(styles.card, styles.interactive, styles.cardButton, pointerOver && styles.pointerOver)}
      onClick={onClick}
      type="button"
      {...drag}
    >
      <CardText description={description} header={header} icon={icon} />
      <span aria-hidden className={styles.actionIcon}>
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M5.65 3.15c.2-.2.5-.2.7 0l4.5 4.5c.2.2.2.5 0 .7l-4.5 4.5a.5.5 0 0 1-.7-.7L9.79 8 5.65 3.85a.5.5 0 0 1 0-.7Z" />
        </svg>
      </span>
    </button>
  </div>;
}

// The group a settings page is read in: a heading, then the rows it names.
// The heading is BodyStrong with 30 above it and 6 below, and the rows sit 4
// apart -- the Gallery's SettingsSectionHeaderTextBlockStyle over the spacing
// its settings StackPanel states, which the toolkit's own sample page repeats
// verbatim. The 30 is not taken: the page grid these sections sit in already
// separates its children, and one rhythm for a page beats two.
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Pages/SettingsPage.xaml#L13-L21
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Pages/SettingsPage.xaml#L35-L41
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/samples/SettingsPageExample.xaml#L17-L24
export function SettingsSection({ children, description, title }: {
  children: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}) {
  return <div className="grid gap-[6px]">
    <SectionHeader description={description} level={4} title={title} />
    <div className="grid gap-[4px]">{children}</div>
  </div>;
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
  return <div className={styles.row}>
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
