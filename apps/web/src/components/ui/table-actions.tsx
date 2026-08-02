import type { TableCellProps, TableHeaderCellProps } from '@fluentui/react-components';
import type { MouseEvent, ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { TableCell, TableHeaderCell, makeStyles, mergeClasses } = fluentComponents;

// All three declarations are load-bearing: a header cell's label sits inside a
// button, a `Table` body cell is a `table-cell` where `justify-content` is
// inert, and a `DataGrid` cell is a flex box where `text-align` is.
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

export const useTrailingCellClass = (): string => useStyles().trailing;

export function TableActionsHeader({ className, ...props }: TableHeaderCellProps) {
  const styles = useStyles();
  return <TableHeaderCell {...props} className={mergeClasses(styles.trailing, className)} />;
}

export function TableCentredHeader({ className, ...props }: TableHeaderCellProps) {
  const styles = useStyles();
  return <TableHeaderCell {...props} className={mergeClasses(styles.centred, className)} />;
}

export function TableCentredCell({ className, ...props }: TableCellProps) {
  const styles = useStyles();
  return <TableCell {...props} className={mergeClasses(styles.centred, className)} />;
}

// `DataGridRow` and `ListItem` select from their own `onClick`, which a nested
// button reaches -- through a portal too, a menu popover being a React child of
// its trigger. The click alone: arrow keys must keep travelling for focus
// navigation.
export const stopRowSelection = { onClick: (event: MouseEvent<HTMLElement>) => event.stopPropagation() };

// `grow` is for the flex `DataGrid` cell, which would otherwise size this row to
// its buttons and leave `justify-end` nothing to distribute.
export function TableActions({ children }: { children: ReactNode }) {
  return <div className="flex grow items-center justify-end gap-1" {...stopRowSelection}>{children}</div>;
}
