import { AddRegular, ArrowClockwiseRegular } from '@fluentui/react-icons';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

import { EmptyStateLine } from './empty-state';
import { Panel, type PanelProps } from './panel';
import { fluentComponents } from '../../fluent';

const { Button, Spinner, Tooltip, makeStyles, mergeClasses } = fluentComponents;

// Everything here is scoped to this panel rather than stated on the table
// layer, because it answers what this panel is: a card whose only content is a
// table, so the table has to reach the card's edges and carry the inset itself.
// A table anywhere else — inside the upstream editor, inside a dialog — sits in
// a container that still states its own padding and wants none of this.
// The row height is the panel's to state, and each list passes the height its
// own rows want: a single line of text takes the default, a row carrying a
// second line under the first takes more. The header takes the same number, so
// it never sits shorter than the rows under it.
//
// It is `height` rather than a minimum because these rows lay out as table
// rows, and a table row ignores min-height outright -- height is already the
// minimum there, since a row still grows to whatever its cells need.
// https://drafts.csswg.org/css-tables-3/#row-layout
const DEFAULT_ROW_HEIGHT = '44px';
const ROW_HEIGHT = '--floway-resource-row-height';
// What the leading and trailing cells hold off the card's edge. The rows put
// twelve pixels between their content and the lines above and below it, which
// is where this started; it is wider than that on purpose, because the card's
// edge is the page's boundary where a row's line is only the next row.
const EDGE_INSET = '16px';

const useStyles = makeStyles({
  table: {
    '& .fui-TableRow': { height: `var(${ROW_HEIGHT})` },
    // By type rather than by position, and naming every type a cell is drawn
    // as: a plain table's rows hold th and td, a DataGrid's hold div, and a
    // DataGrid row additionally carries Tabster's focus dummies, which are `i`
    // elements the first and last child selectors would land on instead. Those
    // sit outside layout, so the inset disappeared on the body while the
    // header -- which has no leading dummy -- still took it, and the two rows'
    // columns drifted apart by it.
    '& .fui-TableRow > :is(th, td, div):first-of-type': { paddingInlineStart: EDGE_INSET },
    '& .fui-TableRow > :is(th, td, div):last-of-type': { paddingInlineEnd: EDGE_INSET },
    // Fluent sizes the selection column at a fixed 44, which is its own 16px
    // radio plus the margins the layer has taken off the control, and it is
    // styled apart from an ordinary cell -- so it never took the trailing
    // padding every other cell carries either. It is rebuilt from what is
    // actually in it: the leading inset, the control, and that same trailing
    // padding, named from the token the other cells read it from.
    '& .fui-TableSelectionCell': {
      maxWidth: `calc(${EDGE_INSET} + 20px + var(--spacingHorizontalS))`,
      minWidth: `calc(${EDGE_INSET} + 20px + var(--spacingHorizontalS))`,
      paddingInlineEnd: 'var(--spacingHorizontalS)',
      width: `calc(${EDGE_INSET} + 20px + var(--spacingHorizontalS))`,
    },
    // The last row's edge and the card's own would otherwise stack into one
    // heavier line a pixel above the corner.
    '& .fui-TableBody .fui-TableRow:last-child': { borderBottomStyle: 'none' },
  },
});

// The surface a resource table sits on. It holds the table and nothing else, so
// it states no padding: the table's own cells already inset their contents, and
// a second inset around them only pushes the rows away from the edge the rows
// are meant to reach.
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
  appearance?: 'secondary' | 'subtle';
  disabled?: boolean;
  onRefresh: () => void;
  refreshLabel: string;
  refreshing?: boolean;
} & (
  | { createLabel: string; createTrailingIcon?: ReactNode; onCreate: () => void; createTrigger?: never }
  | { createLabel: string; createTrailingIcon?: ReactNode; createTrigger: (button: ReactElement) => ReactNode; onCreate?: never }
  | { createLabel?: never; createTrailingIcon?: never; onCreate?: never; createTrigger?: never }
);

// The page's own actions, which belong beside the page's own title rather than
// above the table. A second heading over the list only named the page again,
// and the count it carried is the list itself.
//
// A page that only reads — the monitor views, an upstream's quota card — has no
// create action and still wants the refresh control this states: the spinner in
// place of the glyph, and the live region that says so to a screen reader. Such
// a page also sits among subtle controls rather than beside a primary create
// button, so it picks the appearance.
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
  return <EmptyStateLine className="p-4">{children}</EmptyStateLine>;
}
