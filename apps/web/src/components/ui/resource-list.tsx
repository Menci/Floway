import { AddRegular, ArrowClockwiseRegular } from '@fluentui/react-icons';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

import { EmptyStateLine } from './empty-state';
import { Panel, type PanelProps } from './panel';
import { fluentComponents } from '../../fluent';

const { Button, Spinner, Tooltip, makeStyles, mergeClasses } = fluentComponents;

// Scoped to this panel rather than stated on the table layer: this panel is a
// card whose only content is a table, so the table reaches the card's edges and
// carries the inset itself. A table elsewhere sits in a container that states
// its own padding.
//
// Height rather than a minimum because a table row ignores min-height, and
// height is already the minimum there -- a row still grows to what its cells
// need.
// https://drafts.csswg.org/css-tables-3/#row-layout
const DEFAULT_ROW_HEIGHT = '44px';
const ROW_HEIGHT = '--floway-resource-row-height';
// A flush panel states no inset of its own, so the leading and trailing cells
// carry the measure every other panel keeps from its edge, sourced in
// `global.css`.
const EDGE_INSET = 'var(--floway-panel-inset)';

const useStyles = makeStyles({
  table: {
    '& .fui-TableRow': { height: `var(${ROW_HEIGHT})` },
    // By type rather than by position: a DataGrid row carries Tabster's focus
    // dummies, `i` elements outside layout that first-of-type/last-of-type
    // selectors would land on instead, leaving the body inset while the header
    // -- which has no leading dummy -- kept it.
    '& .fui-TableRow > :is(th, td, div):first-of-type': { paddingInlineStart: EDGE_INSET },
    '& .fui-TableRow > :is(th, td, div):last-of-type': { paddingInlineEnd: EDGE_INSET },
    // Fluent sizes the selection column at a fixed 44 and styles it apart from
    // an ordinary cell, so it never took the trailing padding either. Rebuilt
    // here from what is actually in it.
    '& .fui-TableSelectionCell': {
      maxWidth: `calc(${EDGE_INSET} + 20px + var(--spacingHorizontalS))`,
      minWidth: `calc(${EDGE_INSET} + 20px + var(--spacingHorizontalS))`,
      paddingInlineEnd: 'var(--spacingHorizontalS)',
      width: `calc(${EDGE_INSET} + 20px + var(--spacingHorizontalS))`,
    },
    // The last row's edge and the card's own would otherwise stack into one
    // heavier line a pixel above the corner. The narrow-width list that stands
    // in for a table draws the same separator, so it takes the same answer.
    '& :is(.fui-TableBody .fui-TableRow, .fui-List > .fui-ListItem):last-child': {
      borderBottomStyle: 'none',
    },
  },
  emptyState: { padding: EDGE_INSET },
});

// States no padding: the table's own cells already inset their contents, and a
// second inset only pushes the rows away from the edge they are meant to reach.
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
// a keyboard is not thrown back to the document mid-action; Fluent applies the
// same disabled atoms to both forms. The ring keeps the accent rather than
// following the label down to the disabled foreground, as a WinUI ProgressRing
// does — its own style sets the brush.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressRing/ProgressRing.xaml#L4
export function ResourceListActions(props: ResourceListActionsProps) {
  const { appearance, createLabel, createTrailingIcon, disabled = false, onRefresh, refreshLabel, refreshing = false } = props;
  const busy = disabled || refreshing;
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

// An empty list has no rows to reach the panel's edge, so this one thing inside
// it carries the inset the panel no longer states.
export function ResourceListEmptyState({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <EmptyStateLine className={styles.emptyState}>{children}</EmptyStateLine>;
}
