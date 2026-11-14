import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { ExpanderRegion } from './expander-region';
import { fluentComponents } from '../../fluent';

const { TableCell, TableRow, makeStyles } = fluentComponents;
const useStyles = makeStyles({
  row: {
    height: 'auto', backgroundColor: 'transparent',
    '&.fui-TableRow:hover, &.fui-TableRow:active': { backgroundColor: 'transparent' },
    '& > .fui-TableCell.fui-TableCell': { padding: 0, height: 'auto' },
  },
});

export function TableExpansionRow({ children, columns, open, onCollapsed }: { children: ReactNode; columns: number; open: boolean; onCollapsed: () => void }) {
  const styles = useStyles();
  const row = useRef<HTMLTableRowElement>(null);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    row.current!.getBoundingClientRect();
    const frame = requestAnimationFrame(() => setExpanded(open));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return <TableRow className={styles.row} ref={row} data-table-expansion-row style={{ display: children ? undefined : 'none' }}><TableCell colSpan={columns}>
    <ExpanderRegion open={expanded} onCollapsed={onCollapsed}>{children}</ExpanderRegion>
  </TableCell></TableRow>;
}
