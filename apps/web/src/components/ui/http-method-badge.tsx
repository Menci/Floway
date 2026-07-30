import { fluentComponents } from '../../fluent';

const { Badge, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  root: {
    fontFamily: 'var(--fontFamilyMonospace)',
    fontSize: '13px',
    fontWeight: 'var(--fontWeightRegular)',
    justifyContent: 'center',
    minWidth: '48px',
  },
});

export function HttpMethodBadge({ method }: { method: string }) {
  const styles = useStyles();
  return <Badge
    appearance="tint"
    className={styles.root}
    color={method === 'GET' ? 'brand' : method === 'POST' ? 'success' : 'informative'}
    size="medium"
    translate="no"
  >{method}</Badge>;
}
