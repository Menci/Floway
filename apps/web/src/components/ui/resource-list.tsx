import { AddRegular, ArrowClockwiseRegular } from '@fluentui/react-icons';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

import { EmptyStateLine } from './empty-state';
import { Panel, type PanelProps } from './panel';
import { fluentComponents } from '../../fluent';

const { Button, Spinner, Tooltip, makeStyles, mergeClasses } = fluentComponents;

// Scoped to this panel rather than the table layer: here the table is the
// card's only content and reaches its edges, so it carries the inset itself.
//
// Height rather than a minimum because a table row ignores min-height, and
// height is already the minimum there.
// https://drafts.csswg.org/css-tables-3/#row-layout
const DEFAULT_ROW_HEIGHT = '44px';
const ROW_HEIGHT = '--floway-resource-row-height';
const EDGE_INSET = 'var(--floway-panel-inset)';

const useStyles = makeStyles({
  table: {
    '& .fui-TableRow': { height: `var(${ROW_HEIGHT})` },
    // By type rather than by position: a DataGrid row carries Tabster's focus
    // dummies, `i` elements outside layout that an unrestricted
    // first-of-type/last-of-type would land on instead.
    '& .fui-TableRow > :is(th, td, div):first-of-type': { paddingInlineStart: EDGE_INSET },
    '& .fui-TableRow > :is(th, td, div):last-of-type': { paddingInlineEnd: EDGE_INSET },
    // Fluent fixes the selection column at 44 and styles it apart from an
    // ordinary cell, so it never took the trailing padding either.
    '& .fui-TableSelectionCell': {
      maxWidth: `calc(${EDGE_INSET} + 20px + var(--spacingHorizontalS))`,
      minWidth: `calc(${EDGE_INSET} + 20px + var(--spacingHorizontalS))`,
      paddingInlineEnd: 'var(--spacingHorizontalS)',
      width: `calc(${EDGE_INSET} + 20px + var(--spacingHorizontalS))`,
    },
    // The last row's edge and the card's own would otherwise stack into one
    // heavier line a pixel above the corner; the narrow-width list that stands
    // in for a table draws the same separator.
    '& :is(.fui-TableBody .fui-TableRow, .fui-List > .fui-ListItem):last-child': {
      borderBottomStyle: 'none',
    },
  },
  emptyState: { padding: EDGE_INSET },
});

export function ResourceListPanel({ className, rowHeight = DEFAULT_ROW_HEIGHT, style, ...props }: PanelProps & { rowHeight?: string }) {
  const styles = useStyles();
  return (
    <Panel
      {...props}
      className={mergeClasses('grid min-w-0 !gap-0 overflow-hidden', styles.table, className)}
      padding="flush"
      style={{ ...style, [ROW_HEIGHT]: rowHeight } as CSSProperties}
    />
  );
}

type ResourceListActionsProps = {
  appearance?: 'subtle';
  createDisabled?: boolean;
  disabled?: boolean;
  onRefresh: () => void;
  refreshLabel: string;
  refreshing?: boolean;
} & (
  | { createLabel: string; createTrailingIcon?: never; onCreate: () => void; createTrigger?: never }
  | { createLabel: string; createTrailingIcon?: ReactNode; createTrigger: (button: ReactElement) => ReactNode; onCreate?: never }
  | { createLabel?: never; createTrailingIcon?: never; onCreate?: never; createTrigger?: never }
);

// A refresh in flight leaves the control focusable while it reads disabled, so
// a keyboard is not thrown back to the document mid-action. `disabled` gates
// the whole group; `createDisabled` gates only the create button, so a page
// whose data failed to load can withhold create and still offer the refresh
// that recovers from it.
export function ResourceListActions(props: ResourceListActionsProps) {
  const { appearance, createDisabled = false, createLabel, createTrailingIcon, disabled = false, onRefresh, refreshLabel, refreshing = false } = props;
  const busy = disabled || createDisabled || refreshing;
  const createButton = createLabel !== undefined && (
    <Button
      appearance="primary"
      disabled={busy}
      icon={<AddRegular />}
      onClick={'onCreate' in props ? props.onCreate : undefined}
    >
      {createLabel}
      {createTrailingIcon}
    </Button>
  );

  return (
    <div aria-busy={refreshing} className="flex items-center gap-2 flex-none">
      <Tooltip content={refreshLabel} relationship="label">
        <Button
          appearance={appearance}
          aria-label={refreshLabel}
          disabled={disabled}
          disabledFocusable={refreshing}
          icon={refreshing ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />}
          onClick={onRefresh}
        />
      </Tooltip>
      {createButton && (props.createTrigger === undefined ? createButton : props.createTrigger(createButton))}
      <span aria-live="polite" className="sr-only">{refreshing ? `${refreshLabel}…` : ''}</span>
    </div>
  );
}

export function ResourceListEmptyState({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <EmptyStateLine className={styles.emptyState}>{children}</EmptyStateLine>;
}
