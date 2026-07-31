import { AddRegular, ArrowClockwiseRegular } from '@fluentui/react-icons';
import type { ReactElement, ReactNode } from 'react';

import { Panel, type PanelProps } from './panel';
import { fluentComponents } from '../../fluent';

const { Button, Spinner, Text, Tooltip, makeStyles, mergeClasses } = fluentComponents;

// Everything here is scoped to this panel rather than stated on the table
// layer, because it answers what this panel is: a card whose only content is a
// table, so the table has to reach the card's edges and carry the inset itself.
// A table anywhere else — inside the upstream editor, inside a dialog — sits in
// a container that still states its own padding and wants none of this.
const ROW_MIN_HEIGHT = '44px';
// What the leading and trailing cells hold off the card's edge. The rows put
// twelve pixels between a username and the lines above and below it, which is
// where this started; it is wider than that on purpose, because the card's edge
// is the page's boundary where a row's line is only the next row.
const EDGE_INSET = '16px';

const useStyles = makeStyles({
  table: {
    '& .fui-TableRow': { minHeight: ROW_MIN_HEIGHT },
    // A header cell sizes itself, so the row's minimum alone would leave the
    // header text sitting in a short box inside a tall row.
    '& .fui-TableHeaderCell': { height: ROW_MIN_HEIGHT },
    '& .fui-TableRow > :first-child': { paddingInlineStart: EDGE_INSET },
    '& .fui-TableRow > :last-child': { paddingInlineEnd: EDGE_INSET },
    // The last row's edge and the card's own would otherwise stack into one
    // heavier line a pixel above the corner.
    '& .fui-TableBody .fui-TableRow:last-child': { borderBottomStyle: 'none' },
  },
});

// The surface a resource table sits on. It holds the table and nothing else, so
// it states no padding: the table's own cells already inset their contents, and
// a second inset around them only pushes the rows away from the edge the rows
// are meant to reach.
export function ResourceListPanel({ className, ...props }: PanelProps) {
  const styles = useStyles();
  return (
    <Panel
      {...props}
      className={mergeClasses('grid min-w-0 !gap-0 !p-0 overflow-hidden', styles.table, className)}
    />
  );
}

type ResourceListActionsProps = {
  createLabel: string;
  createTrailingIcon?: ReactNode;
  disabled?: boolean;
  onRefresh: () => void;
  refreshLabel: string;
  refreshing?: boolean;
} & (
  | { onCreate: () => void; createTrigger?: never }
  | { createTrigger: (button: ReactElement) => ReactNode; onCreate?: never }
);

// The page's own actions, which belong beside the page's own title rather than
// above the table. A second heading over the list only named the page again,
// and the count it carried is the list itself.
export function ResourceListActions(props: ResourceListActionsProps) {
  const { createLabel, createTrailingIcon, disabled = false, onRefresh, refreshLabel, refreshing = false } = props;
  const busy = disabled || refreshing;
  const createButton = (
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
          aria-label={refreshing ? `${refreshLabel}…` : refreshLabel}
          disabled={busy}
          icon={refreshing ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />}
          onClick={onRefresh}
        />
      </Tooltip>
      {props.createTrigger === undefined ? createButton : props.createTrigger(createButton)}
      <span aria-live="polite" className="sr-only">{refreshing ? `${refreshLabel}…` : ''}</span>
    </div>
  );
}

// An empty list has no rows to reach the panel's edge, so this one thing inside
// it carries the inset the panel no longer states.
export function ResourceListEmptyState({ children }: { children: ReactNode }) {
  return <Text block size={300} className="text-fui-fg2 p-[16px]">{children}</Text>;
}
