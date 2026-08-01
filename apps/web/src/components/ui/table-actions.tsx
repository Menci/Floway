import type { TableCellProps, TableHeaderCellProps } from '@fluentui/react-components';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { TableCell, TableHeaderCell, makeStyles, mergeClasses } = fluentComponents;

// Column alignment lives here rather than at each call site, and each class
// states its alignment three times because one class lands in three different
// formatting contexts. A header cell puts its label inside a button and needs
// the flex rule on that button; a `Table` body cell is a `table-cell`, where
// `justify-content` is inert and the inline-level content moves with
// `text-align` alone; a `DataGrid` cell and header cell are flex boxes, where
// it is `text-align` that is inert. Stating all three is what makes a class
// read the same in every one of those contexts, and what stops a column's head
// and body drifting apart. The button rule is carried by the body cells too,
// where it simply matches nothing.
const useStyles = makeStyles({
  trailing: {
    justifyContent: 'flex-end',
    textAlign: 'right',
    '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' },
  },
  centred: {
    justifyContent: 'center',
    textAlign: 'center',
    '& .fui-TableHeaderCell__button': { justifyContent: 'center' },
  },
});

/** The trailing rule itself, for a cell that is not a `TableHeaderCell`. */
export const useTrailingCellClass = (): string => useStyles().trailing;

export function TableActionsHeader({ className, ...props }: TableHeaderCellProps) {
  const styles = useStyles();
  return <TableHeaderCell {...props} className={mergeClasses(styles.trailing, className)} />;
}

/** For a column whose content is a control or a short label, not prose. */
export function TableCentredHeader({ className, ...props }: TableHeaderCellProps) {
  const styles = useStyles();
  return <TableHeaderCell {...props} className={mergeClasses(styles.centred, className)} />;
}

export function TableCentredCell({ className, ...props }: TableCellProps) {
  const styles = useStyles();
  return <TableCell {...props} className={mergeClasses(styles.centred, className)} />;
}

// A row's commands sit against the cell's trailing edge. The row grows so that
// it owns the full width in either formatting context: a `table-cell` gives a
// block child the whole cell already, while a flex cell would otherwise size
// this row to its buttons and leave `justify-end` with nothing to distribute.
export function TableActions({ children }: { children: ReactNode }) {
  return <div className="flex grow items-center justify-end gap-1">{children}</div>;
}
