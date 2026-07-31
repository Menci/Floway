import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// The centered placeholder a chart shows instead of a plot — loading, empty, or
// error — sized to the plot area it stands in for. It takes the same secondary
// foreground every other empty state takes: this is what the region holds, not
// something subordinate to a sibling that is present.
export const useChartStateStyles = makeStyles({
  root: { alignItems: 'center', color: 'var(--colorNeutralForeground2)', display: 'grid', fontSize: 'var(--fontSizeBase300)', height: '100%', lineHeight: 'var(--lineHeightBase300)', justifyItems: 'center' },
});
