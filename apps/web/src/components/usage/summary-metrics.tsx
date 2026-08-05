import { formatSummaryMetric } from './format';
import { metricConfig, summaryMetrics } from './metrics';
import type { TokenSummary, UsageMetric } from './types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { useLocale } from '../../lib/use-locale';
const { Text, ToggleButton, makeStyles, mergeClasses } = fluentComponents;

// A metric tile is one of a set, so it is styled as a WinUI ListViewItem
// rather than as a checked ToggleButton.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L20-L22
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L26-L28
//
// Each state is restated because the checked-only rule ties with `.fXXX:hover`
// from ../../winui/controls/button.css.ts on specificity and loses on order.
// Pressed takes two selectors because Fluent's does. The border needs
// `!important` both ways: that same layer sets the checked accent stroke at a
// specificity a call site cannot reach.
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
    // The bar is declared on every tile and carries its state in its values;
    // gating `content` on [aria-pressed] left the departure nothing to animate.
    // Departure is the fade alone -- WinUI registers no scale key frame on
    // deselect -- hence the delayed zero-duration scale. Its length is the
    // quarter inset the rest of the layer uses -- see winui/controls/list.css.ts,
    // where the choice between that and the presenter's stepped formula is
    // written down.
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
    // WinUI's High Contrast dictionary holds one Highlight/HighlightText pair
    // across all three selected states and inverts the indicator; descendants
    // are named because the caption asks for a colour of its own.
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
        <Text size={500} weight="semibold" className="tabular-nums [overflow-wrap:anywhere]">{value}</Text>
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
