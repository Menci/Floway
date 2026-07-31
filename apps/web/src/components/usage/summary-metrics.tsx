import { useTranslation } from 'react-i18next';

import { formatSummaryMetric, metricConfig, summaryMetrics } from './chart-model';
import type { TokenSummary, UsageMetric } from './types';
import { fluentComponents } from '../../fluent';
const { Text, ToggleButton, makeStyles, mergeClasses } = fluentComponents;

// One of a set of metrics, not a switch that happens to be on. WinUI fills a
// checked ToggleButton with the accent, which is the heaviest mark it has and
// the right one for an independent binary state; picking one item out of a set
// is a ListViewItem, and it is marked the way every other selected row and item
// in this dashboard is -- the subtle fill it would take under the pointer, held,
// with an accent bar down its leading edge.
//
// The fill, the bar and the label are stated here rather than left to the
// layer, because the layer paints a ToggleButton as WinUI paints one and is
// right to. Undoing that paint is what needs `!important` on the fill: the
// layer names the checked state at a specificity a call site cannot reach,
// which is correct for a rule meant to hold across the dashboard and is exactly
// the case the escape hatch is for. The accent border goes with it -- it is the
// accent's own elevation stroke, and against a subtle fill its heavier bottom
// edge reads as a rule under the tile.
//
// The label is restated for the pointer and the press as well as for rest. A
// checked ToggleButton's foreground is the on-accent one in every state, which
// is white here, and Fluent's own hover and pressed atoms outrank a rule that
// names the checked state alone -- so stating it once left the tile's value
// white on a pale fill the moment the pointer arrived.
const useStyles = makeStyles({
  tile: {
    '&[aria-pressed="true"]': {
      backgroundColor: 'var(--winui-subtle-fill-secondary)',
      borderTopColor: 'transparent !important',
      borderRightColor: 'transparent !important',
      borderBottomColor: 'transparent !important',
      borderLeftColor: 'transparent !important',
      color: 'var(--winui-text-fill-primary)',
      position: 'relative',
    },
    '&[aria-pressed="true"]:hover': {
      backgroundColor: 'var(--winui-subtle-fill-tertiary) !important',
      color: 'var(--winui-text-fill-primary)',
    },
    '&[aria-pressed="true"]:hover:active': {
      backgroundColor: 'var(--winui-subtle-fill-secondary) !important',
      color: 'var(--winui-text-fill-secondary)',
    },
    // The bar is a ListViewItem's, so it takes that presenter's arrival: a fade
    // over 83ms while it grows from nothing over 167ms, from its own centre. It
    // does not travel from the tile that lost the selection; only NavigationView
    // has a moving indicator. Its length is the quarter inset the rest of the
    // layer uses -- see winui/controls/list.css.ts, where the choice between
    // that and the presenter's stepped formula is written down.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/core/core/elements/ListViewBaseItemChrome.cpp#L1750-L1758
    // https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/dxaml/lib/ListViewBaseItemPresenter_Partial.cpp#L891-L1022
    '&[aria-pressed="true"]::after': {
      backgroundColor: 'var(--winui-accent-fill-default)',
      borderRadius: '1.5px',
      content: '""',
      insetBlock: '25%',
      insetInlineStart: 0,
      position: 'absolute',
      width: '3px',
      '@media (prefers-reduced-motion: no-preference)': {
        animation: 'winui-selection-indicator-fade 83ms linear, winui-selection-indicator-grow 167ms cubic-bezier(0.167, 0.167, 0, 1)',
      },
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
export function SummaryMetrics({ locale, metric, onMetricChange, summary }: { locale: string; metric: UsageMetric; onMetricChange: (metric: UsageMetric) => void; summary: TokenSummary }) {
  const { t } = useTranslation();
  return <div className="grid gap-2.5 grid-cols-5 max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
    {summaryMetrics.map(group => <div className="grid gap-2 min-w-0" key={group.join('-')}>
      {group.map(item => <SummaryMetricButton active={metric === item} key={item} label={t(metricConfig[item].labelKey)} onClick={() => onMetricChange(item)} value={formatSummaryMetric(summary, item, locale)} />)}
    </div>)}
  </div>;
}
