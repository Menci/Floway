import type { TableCellProps, TableHeaderCellProps } from '@fluentui/react-components';
import type { MouseEvent, ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { TableCell, TableHeaderCell, makeStyles, mergeClasses } = fluentComponents;

// Each class states its alignment three times because one class lands in three
// formatting contexts: a header cell's label sits inside a button, a `Table`
// body cell is a `table-cell` where `justify-content` is inert, and a `DataGrid`
// cell is a flex box where `text-align` is. Stating all three keeps a column's
// head and body from drifting apart.
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

// Fluent raises row selection from a plain click -- `DataGridRow` toggles from
// the row's own `onClick`, `ListItem` triggers its action from the item's -- and
// a button inside either carries its click on up, through a portal as well,
// since a menu popover is a React child of its trigger.
//
// The click alone. Both rows already ignore a key that came from inside them,
// while arrow keys have to keep travelling for cell and item focus navigation
// to answer them.
export const stopRowSelection = { onClick: (event: MouseEvent<HTMLElement>) => event.stopPropagation() };

// The row grows so that it owns the full width in either formatting context: a
// `table-cell` gives a block child the whole cell already, while a flex cell
// would otherwise size this row to its buttons and leave `justify-end` nothing
// to distribute.
export function TableActions({ children }: { children: ReactNode }) {
  return <div className="flex grow items-center justify-end gap-1" {...stopRowSelection}>{children}</div>;
}
