import { AddRegular, ArrowClockwiseRegular } from '@fluentui/react-icons';
import type { ReactElement, ReactNode } from 'react';

import { Panel, type PanelProps } from './panel';
import { fluentComponents } from '../../fluent';

const { Button, Spinner, Text, Tooltip, mergeClasses } = fluentComponents;

// The surface a resource table sits on. It holds the table and nothing else, so
// it states no padding: the table's own cells already inset their contents, and
// a second inset around them only pushes the rows away from the edge the rows
// are meant to reach.
export function ResourceListPanel({ className, ...props }: PanelProps) {
  return (
    <Panel
      {...props}
      className={mergeClasses('grid min-w-0 !gap-0 !p-0 overflow-hidden', className)}
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
  return <Text block size={300} className="text-fui-fg2 p-[18px]">{children}</Text>;
}
