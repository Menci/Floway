import { AddRegular, ArrowClockwiseRegular } from '@fluentui/react-icons';
import type { ReactElement, ReactNode } from 'react';

import { Panel, type PanelProps } from './panel';
import { fluentComponents } from '../../fluent';

const { Button, Spinner, Text, Tooltip, mergeClasses } = fluentComponents;

export function ResourceListPanel({ className, ...props }: PanelProps) {
  return (
    <Panel
      {...props}
      className={mergeClasses('grid min-w-0 !gap-4 !p-[18px] overflow-hidden', className)}
    />
  );
}

type ResourceListToolbarProps = {
  createLabel: string;
  createTrailingIcon?: ReactNode;
  detail?: string;
  disabled?: boolean;
  onRefresh: () => void;
  refreshLabel: string;
  refreshing?: boolean;
  title: string;
} & (
  | { onCreate: () => void; createTrigger?: never }
  | { createTrigger: (button: ReactElement) => ReactNode; onCreate?: never }
);

export function ResourceListToolbar(props: ResourceListToolbarProps) {
  const {
    createLabel,
    createTrailingIcon,
    detail,
    disabled = false,
    onRefresh,
    refreshLabel,
    refreshing = false,
    title,
  } = props;
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
    <div className="flex items-center justify-between gap-3 min-w-0 max-[560px]:flex-col max-[560px]:items-stretch">
      <div className="min-w-0">
        <Text block size={400} weight="semibold">{title}</Text>
        {detail !== undefined && (
          <Text block size={200} className="text-fui-fg2 mt-1">{detail}</Text>
        )}
      </div>
      <div className="flex items-center gap-2 flex-none max-[560px]:justify-end">
        <Tooltip content={refreshLabel} relationship="label">
          <Button
            aria-label={refreshLabel}
            disabled={busy}
            icon={refreshing ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />}
            onClick={onRefresh}
          />
        </Tooltip>
        {props.createTrigger === undefined ? createButton : props.createTrigger(createButton)}
      </div>
    </div>
  );
}

export function ResourceListEmptyState({ children }: { children: ReactNode }) {
  return <Text block size={300} className="text-fui-fg2 py-2">{children}</Text>;
}
