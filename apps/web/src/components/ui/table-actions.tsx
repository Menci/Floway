import type { TableCellProps, TableHeaderCellProps } from '@fluentui/react-components';
import type { MouseEvent, ReactNode } from 'react';

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

// What a command in a selectable row has to say so that running it is not also
// a selection. Fluent raises the selection from a plain click: `DataGridRow`
// toggles its row from the row's own `onClick`, `ListItem` triggers its action
// from the item's, and a button inside either one carries its click on up to
// them -- through a portal as well, since a menu popover is a React child of
// the trigger it was opened from. So the cluster stops the click where it was
// handled, which is the guard ./settings-card.tsx puts on the SettingsExpander's
// action slot for the same reason.
//
// The click alone. Both rows already ignore a key that came from inside them --
// `DataGridRow` selects on Space only when the target is not interactive, and
// `ListItem` acts on Space or Enter only when it is itself the target -- so a
// button is activated by keyboard without selecting anything, while arrow keys
// have to keep travelling for the focus navigation between cells and items to
// answer them.
export const stopRowSelection = { onClick: (event: MouseEvent<HTMLElement>) => event.stopPropagation() };

// A row's commands sit against the cell's trailing edge. The row grows so that
// it owns the full width in either formatting context: a `table-cell` gives a
// block child the whole cell already, while a flex cell would otherwise size
// this row to its buttons and leave `justify-end` with nothing to distribute.
export function TableActions({ children }: { children: ReactNode }) {
  return <div className="flex grow items-center justify-end gap-1" {...stopRowSelection}>{children}</div>;
}
