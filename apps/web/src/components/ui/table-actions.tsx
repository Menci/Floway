import type { TableCellProps, TableHeaderCellProps } from '@fluentui/react-components';
import type { MouseEvent, ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { TableCell, TableHeaderCell, makeStyles, mergeClasses } = fluentComponents;

// Both declarations are load-bearing: a cell aligns its own text, while a
// header cell's label sits inside a button that aligns itself.
//
// A trailing column is where this dashboard puts its measures -- request
// counts, durations, rates, model counts -- so its figures are tabular at the
// column's own level: rows then stack digit over digit, and a value that
// changes from a poll does not resize the cell under it.
const useStyles = makeStyles({
  trailing: {
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
    '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' },
  },
  centred: {
    textAlign: 'center',
    '& .fui-TableHeaderCell__button': { justifyContent: 'center' },
  },
});

export function TableTrailingHeader({ className, ...props }: TableHeaderCellProps) {
  const styles = useStyles();
  return <TableHeaderCell {...props} className={mergeClasses(styles.trailing, className)} />;
}

export function TableActionsHeader() {
  return <TableTrailingHeader />;
}

export function TableTrailingCell({ className, ...props }: TableCellProps) {
  const styles = useStyles();
  return <TableCell {...props} className={mergeClasses(styles.trailing, className)} />;
}

export function TableCentredHeader({ className, ...props }: TableHeaderCellProps) {
  const styles = useStyles();
  return <TableHeaderCell {...props} className={mergeClasses(styles.centred, className)} />;
}

export function TableCentredCell({ className, ...props }: TableCellProps) {
  const styles = useStyles();
  return <TableCell {...props} className={mergeClasses(styles.centred, className)} />;
}

// A selectable `TableRow` and a `ListItem` select from their own `onClick`,
// which a nested button reaches -- through a portal too, a menu popover being a
// React child of its trigger. The click alone: arrow keys must keep travelling
// for focus navigation.
export const stopRowSelection = { onClick: (event: MouseEvent<HTMLElement>) => event.stopPropagation() };

const ACTION_GAP = 'var(--spacingHorizontalXS)';

// Fluent pins a small icon-only Button to 24px.
// https://github.com/microsoft/fluentui/blob/c771f587c6634a356605e6d7d4658681f15d689b/packages/react-components/react-button/library/src/components/Button/useButtonStyles.styles.ts#L502-L509
const ACTION_BUTTON_SIZE = '24px';

export const TABLE_ACTIONS_WIDTH = `calc(3 * ${ACTION_BUTTON_SIZE} + 2 * ${ACTION_GAP} + var(--spacingHorizontalS) + var(--floway-panel-inset))`;

export const TABLE_ACTIONS_WITH_LEADING_WIDTH = `calc(4 * ${ACTION_BUTTON_SIZE} + 3 * ${ACTION_GAP} + var(--spacingHorizontalS) + var(--floway-panel-inset))`;

export function TableActions({ children, leading }: { children: ReactNode; leading?: ReactNode }) {
  return <div className="flex items-center justify-end" style={{ gap: ACTION_GAP }} {...stopRowSelection}>
    {leading}
    {children}
  </div>;
}
