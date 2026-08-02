import { fluentComponents } from '../../fluent';

const { makeStyles, shorthands } = fluentComponents;

// A drop target has no counterpart in either library, so it is composed from
// the WinUI families the rest of the dashboard already spends. It is a button,
// and it takes SubtleButtonStyle whole: the transparent fill at rest, the
// secondary and tertiary subtle fills under the pointer and under the press,
// the primary text fill for label and glyph, and the drop to the secondary
// text fill while pressed. The radius is the overlay step, matching the card
// the zone sits in.
//
// Two things are not the subtle button's. The stroke is the unchecked check
// box's CheckBoxCheckBackgroundStroke rather than the subtle button's own
// border, which follows its fill and is therefore invisible: this outline has
// to be seen. That family carries its own ramp -- unchanged under the pointer,
// dropped to the disabled stroke while pressed and while disabled -- and the
// zone takes all of it. And the dashed pattern has no WinUI provenance at all:
// it is the affordance itself, and nothing in the corpus describes a drop
// target.
//
// Dragging a file over it is the accepting state, which has no counterpart
// either, so it is drawn as the accent stroke over the pointer-over fill.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L17-L28
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L115-L126
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L41-L44
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L217-L220
export const useDropzoneStyles = makeStyles({
  root: {
    alignItems: 'center',
    ...shorthands.border('2px', 'dashed', 'var(--winui-control-strong-stroke-default)'),
    ...shorthands.borderRadius('var(--winui-overlay-corner-radius)'),
    backgroundColor: 'var(--winui-subtle-fill-transparent)',
    color: 'var(--winui-text-fill-primary)',
    cursor: 'pointer',
    display: 'flex',
    font: 'inherit',
    flexDirection: 'column',
    gap: '8px',
    justifyContent: 'center',
    minHeight: '120px',
    padding: '24px',
    textAlign: 'center',
    // WinUI wires its brush transitions only while UISettings.AnimationsEnabled
    // is on, which the web states as prefers-reduced-motion.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/panel.cpp#L68-L76
    transitionDuration: 'var(--winui-control-faster-animation-duration)',
    transitionProperty: 'border-color, background-color, color',
    transitionTimingFunction: 'var(--winui-control-fast-out-slow-in-easing)',
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
    ':hover': { backgroundColor: 'var(--winui-subtle-fill-secondary)' },
    ':active': {
      backgroundColor: 'var(--winui-subtle-fill-tertiary)',
      ...shorthands.borderColor('var(--winui-control-strong-stroke-disabled)'),
      color: 'var(--winui-text-fill-secondary)',
    },
    // The system focus visual: a 2px FocusStrokeColorOuter ring with a 1px
    // FocusStrokeColorInner ring immediately inside it, around a rect that
    // FocusVisualMargin -3 grows three pixels past the control bounds. An
    // outline offset by one carries the outer ring and a 1px spread shadow
    // carries the inner one. The rings are drawn outside the border box rather
    // than on it, so the pressed border colour above -- which Griffel sorts
    // after :focus-visible -- cannot consume the indicator.
    //
    // A forced palette drops the shadow and repaints the outline in a system
    // colour, the same single-ring reduction the rest of the layer takes.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/DependencyObject/DependencyProperty.cpp#L22-L25
    // https://drafts.csswg.org/css-color-adjust/#forced-colors-properties
    ':focus-visible': {
      boxShadow: '0 0 0 1px var(--winui-focus-stroke-inner)',
      outlineColor: 'var(--winui-focus-stroke-outer)',
      outlineOffset: '1px',
      outlineStyle: 'solid',
      outlineWidth: '2px',
    },
  },
  // Under a forced palette the accent stroke is repainted in the same colour as
  // the resting one and the accepting state would read as nothing, so it is
  // handed over as SystemColorHighlight -- the colour the same check box slot
  // takes in WinUI's High Contrast dictionary when the pointer is on it.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L129-L132
  active: {
    ...shorthands.borderColor('var(--winui-accent-fill-default)'),
    backgroundColor: 'var(--winui-subtle-fill-secondary)',
    '@media (forced-colors: active)': {
      ...shorthands.borderColor('Highlight'),
    },
  },
  // A disabled subtle button keeps the transparent fill and moves only its
  // stroke and its foreground. The pointer fill has to be restated here: a
  // disabled button still matches :hover, and Griffel sorts every :hover atom
  // after every unqualified one, so the rest rule above would otherwise wash a
  // dead zone as the pointer crossed it.
  //
  // Forced colours reach the stroke and the label but paint them the same as an
  // enabled zone's, so both are handed over as SystemColorGrayText, which is
  // what the check box's High Contrast dictionary and TextFillColorDisabled
  // both resolve to there.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L129-L132
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L419
  disabled: {
    ...shorthands.borderColor('var(--winui-control-strong-stroke-disabled)'),
    backgroundColor: 'var(--winui-subtle-fill-transparent)',
    color: 'var(--winui-text-fill-disabled)',
    cursor: 'not-allowed',
    ':hover': { backgroundColor: 'var(--winui-subtle-fill-transparent)' },
    '@media (forced-colors: active)': {
      ...shorthands.borderColor('GrayText'),
      color: 'GrayText',
    },
  },
});
