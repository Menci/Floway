import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// The centered placeholder a chart shows instead of a plot — loading, empty, or
// error — sized to the plot area it stands in for.
export const useChartStateStyles = makeStyles({
  root: { alignItems: 'center', color: 'var(--colorNeutralForeground3)', display: 'grid', fontSize: 'var(--fontSizeBase300)', height: '100%', lineHeight: 'var(--lineHeightBase300)', justifyItems: 'center' },
});
