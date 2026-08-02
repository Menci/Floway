import { useTranslation } from 'react-i18next';

import { formatSummaryMetric, metricConfig, summaryMetrics } from './chart-model';
import type { TokenSummary, UsageMetric } from './types';
import { fluentComponents } from '../../fluent';
import { useLocale } from '../../lib/use-locale';
const { Text, ToggleButton, makeStyles, mergeClasses } = fluentComponents;

// One of a set of metrics, not a switch that happens to be on. WinUI fills a
// checked ToggleButton with the accent, which is the heaviest mark it has and
// the right one for an independent binary state; picking one item out of a set
// is a ListViewItem, and it is marked the way every other selected row and item
// in this dashboard is -- the subtle fill it would take under the pointer, held,
// with an accent bar down its leading edge.
//
// So the selected state table below is ListViewItem's rather than
// ToggleButton's: SubtleFillColorSecondary at rest, tertiary under the pointer,
// back to secondary while pressed, and TextFillColorPrimary throughout. The
// label never dims, which is where a selected row parts company with a pressed
// button. Every value is read from the token layer, which states its own pair
// per dictionary, so light and dark take the same declarations.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L20-L22
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L26-L28
//
// The fill and the label are restated per state rather than once, because each
// answers a Fluent atom that names the same state and would otherwise paint the
// accent ramp ../../winui/controls/button.css.ts hands the checked atoms. A
// rule naming the checked state alone ties with `.fXXX:hover` on specificity
// and loses on order, so stating it once left the tile's value in the
// on-accent white the moment the pointer arrived. Pressed is two selectors
// because Fluent's is: a pointer press is `:hover:active` and a keyboard press
// is `:active:focus-visible`, and whichever of the two goes unanswered flashes
// the accent under the space bar.
//
// The border belongs to that same layer, which gives a checked toggle the
// accent elevation stroke at a specificity a call site cannot reach -- so
// clearing it against a subtle fill takes `!important`, and handing it back for
// the focus visual takes the same. WinUI builds a ListViewItem's focus ring out
// of the two strokes every other control here uses, so the inner one returns to
// the value the layer names for it.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L29-L30
const useStyles = makeStyles({
  tile: {
    position: 'relative',
    '&[aria-pressed="true"]': {
      backgroundColor: 'var(--winui-subtle-fill-secondary)',
      borderTopColor: 'transparent !important',
      borderRightColor: 'transparent !important',
      borderBottomColor: 'transparent !important',
      borderLeftColor: 'transparent !important',
      color: 'var(--winui-text-fill-primary)',
    },
    '&[aria-pressed="true"]:hover': {
      backgroundColor: 'var(--winui-subtle-fill-tertiary)',
      color: 'var(--winui-text-fill-primary)',
    },
    '&[aria-pressed="true"]:hover:active,&[aria-pressed="true"]:active:focus-visible': {
      backgroundColor: 'var(--winui-subtle-fill-secondary)',
      color: 'var(--winui-text-fill-primary)',
    },
    '&[aria-pressed="true"][data-fui-focus-visible]': {
      borderTopColor: 'var(--winui-focus-stroke-inner) !important',
      borderRightColor: 'var(--winui-focus-stroke-inner) !important',
      borderBottomColor: 'var(--winui-focus-stroke-inner) !important',
      borderLeftColor: 'var(--winui-focus-stroke-inner) !important',
    },
    // The bar is a ListViewItem's, so it takes that presenter's arrival: a fade
    // over 83ms while it grows from nothing over 167ms, from its own centre. It
    // does not travel from the tile that lost the selection; only NavigationView
    // has a moving indicator. Its brush is the rest accent in all three selected
    // states, so one declaration carries it. Its length is the quarter inset the
    // rest of the layer uses -- see winui/controls/list.css.ts, where the choice
    // between that and the presenter's stepped formula is written down.
    //
    // The bar lives on every tile and carries its state in its values, which is
    // the same shape winui/controls/list.css.ts states for the row it copies.
    // Gating `content` on [aria-pressed] instead put the box into being with
    // the selection and took it out of being with the deselection, and a
    // property has nothing to run between when the box is absent on one side of
    // the change: the arrival did animate, but the departure was `content` `""`
    // -> `none` in a single frame, whatever was declared for it. Departure is
    // the fade alone, so the height snaps back once the 83ms is up -- WinUI
    // registers no scale key frame on deselect -- and the delayed zero-duration
    // scale below is what states that.
    //
    // Declared unconditionally and clamped, which is the shape ../../winui
    // states for motion the layer owns -- Fluent ships no reduced-motion rule
    // for this element, so there is no answer to stand aside for.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L60
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L75-L77
    // https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/core/core/elements/ListViewBaseItemChrome.cpp#L1750-L1758
    // https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/ListViewBaseItemPresenter_Partial.cpp#L945-L982
    '&::after': {
      backgroundColor: 'var(--winui-accent-fill-default)',
      borderRadius: '1.5px',
      content: '""',
      insetBlock: '25%',
      insetInlineStart: 0,
      opacity: 0,
      position: 'absolute',
      scale: '1 0',
      transition: 'opacity 83ms linear, scale 0s linear 83ms',
      width: '3px',
      '@media (prefers-reduced-motion: reduce)': { transitionDelay: '0s', transitionDuration: '0.01ms' },
    },
    '&[aria-pressed="true"]::after': {
      opacity: 1,
      scale: '1 1',
      transition: 'opacity 83ms linear, scale 167ms cubic-bezier(0.167, 0.167, 0, 1)',
      '@media (prefers-reduced-motion: reduce)': { transitionDelay: '0s', transitionDuration: '0.01ms' },
    },
    // Under a forced palette Fluent paints a checked toggle Highlight against
    // HighlightText and sets forced-color-adjust: none, which would hand every
    // colour above straight to the screen, and it inverts that pair for the
    // pointer and the press. WinUI's High Contrast dictionary holds one pair
    // across selected, selected-pointer-over and selected-pressed, and turns
    // the indicator HighlightText against it. The descendants are named too:
    // the caption asks for a colour of its own, and forced-color-adjust: none
    // is what would leave it there.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L85-L87
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L91-L93
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L151-L153
    '@media (forced-colors: active)': {
      '&[aria-pressed="true"]': {
        backgroundColor: 'Highlight',
        color: 'HighlightText',
        '& *': { color: 'HighlightText' },
      },
      '&[aria-pressed="true"]:hover': {
        backgroundColor: 'Highlight',
        color: 'HighlightText',
      },
      '&[aria-pressed="true"]:hover:active,&[aria-pressed="true"]:active:focus-visible': {
        backgroundColor: 'Highlight',
        color: 'HighlightText',
      },
      '&[aria-pressed="true"]::after': { backgroundColor: 'HighlightText' },
    },
  },
});

function SummaryMetricButton({
  active,
  label,
  onClick,
  value,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  value: string;
}) {
  const s = useStyles();
  return (
    <ToggleButton
      appearance="subtle"
      checked={active}
      className={mergeClasses('!justify-start min-h-[62px] text-left min-w-0 !pl-3 !pr-2 !py-2', s.tile)}
      onClick={onClick}
    >
      <span className="grid gap-1 min-w-0">
        <Text size={200} weight="semibold" className="text-fui-fg2">{label}</Text>
        <Text size={500} weight="semibold" className="overflow-wrap-anywhere">{value}</Text>
      </span>
    </ToggleButton>
  );
}
export function SummaryMetrics({ metric, onMetricChange, summary }: { metric: UsageMetric; onMetricChange: (metric: UsageMetric) => void; summary: TokenSummary }) {
  const { t } = useTranslation();
  const locale = useLocale();
  return <div className="grid gap-2.5 grid-cols-5 max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
    {summaryMetrics.map(group => <div className="grid gap-2 min-w-0" key={group.join('-')}>
      {group.map(item => <SummaryMetricButton active={metric === item} key={item} label={t(metricConfig[item].labelKey)} onClick={() => onMetricChange(item)} value={formatSummaryMetric(summary, item, locale)} />)}
    </div>)}
  </div>;
}
