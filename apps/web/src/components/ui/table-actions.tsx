import type { TableCellProps, TableHeaderCellProps } from '@fluentui/react-components';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { TableCell, TableHeaderCell, makeStyles, mergeClasses } = fluentComponents;

// Column alignment lives here rather than at each call site. A header cell puts
// its label inside a button and needs the flex rule as well; a body cell is a
// `table-cell`, where `justify-content` is inert and the inline-level content
// moves with `text-align` alone. Stating each once is what stops a column's
// head and body drifting apart.
const useStyles = makeStyles({
  header: {
    textAlign: 'right',
    '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' },
  },
  centredHeader: {
    textAlign: 'center',
    '& .fui-TableHeaderCell__button': { justifyContent: 'center' },
  },
  centredCell: { textAlign: 'center' },
});

export function TableActionsHeader({ className, ...props }: TableHeaderCellProps) {
  const styles = useStyles();
  return <TableHeaderCell {...props} className={mergeClasses(styles.header, className)} />;
}

/** For a column whose content is a control or a short label, not prose. */
export function TableCentredHeader({ className, ...props }: TableHeaderCellProps) {
  const styles = useStyles();
  return <TableHeaderCell {...props} className={mergeClasses(styles.centredHeader, className)} />;
}

export function TableCentredCell({ className, ...props }: TableCellProps) {
  const styles = useStyles();
  return <TableCell {...props} className={mergeClasses(styles.centredCell, className)} />;
}

export function TableActions({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-1">{children}</div>;
}
