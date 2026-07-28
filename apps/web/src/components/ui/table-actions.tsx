import type { TableHeaderCellProps } from '@fluentui/react-components';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { TableHeaderCell, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  header: {
    textAlign: 'right',
    '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' },
  },
});

export function TableActionsHeader({ className, ...props }: TableHeaderCellProps) {
  const styles = useStyles();
  return <TableHeaderCell {...props} className={mergeClasses(styles.header, className)} />;
}

export function TableActions({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-1">{children}</div>;
}
