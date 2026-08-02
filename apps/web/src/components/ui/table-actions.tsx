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

const ACTION_GAP = 'var(--spacingHorizontalXS)';

// Fluent pins a small icon-only Button to 24px.
// https://github.com/microsoft/fluentui/blob/c771f587c6634a356605e6d7d4658681f15d689b/packages/react-components/react-button/library/src/components/Button/useButtonStyles.styles.ts#L502-L509
const ACTION_BUTTON_SIZE = '24px';

// Every actions column is this one budget, whatever a given row's strip holds:
// the widest strip in the dashboard is three buttons, and the column is the
// last in its row, so its trailing padding is the panel's inset rather than the
// cell's own. A single number keeps the strips of two routes on the same
// vertical, which a per-route width does not.
export const TABLE_ACTIONS_WIDTH = `calc(3 * ${ACTION_BUTTON_SIZE} + 2 * ${ACTION_GAP} + var(--spacingHorizontalS) + var(--floway-panel-inset))`;

// `grow` is for the flex `DataGrid` cell, which would otherwise size this row to
// its buttons and leave `justify-end` nothing to distribute.
export function TableActions({ children }: { children: ReactNode }) {
  return <div className="flex grow items-center justify-end gap-[var(--spacingHorizontalXS)]" {...stopRowSelection}>{children}</div>;
}
