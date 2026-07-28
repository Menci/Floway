import { AddRegular, ArrowClockwiseRegular } from '@fluentui/react-icons';
import type { ReactElement, ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Button, Spinner, Text, Tooltip } = fluentComponents;

export function ResourceListToolbar({
  createLabel,
  createTrailingIcon,
  createTrigger,
  detail,
  disabled = false,
  onCreate,
  onRefresh,
  refreshLabel,
  refreshing = false,
  title,
}: {
  createLabel: string;
  createTrailingIcon?: ReactNode;
  createTrigger?: (button: ReactElement) => ReactNode;
  detail?: string;
  disabled?: boolean;
  onCreate?: () => void;
  onRefresh: () => void;
  refreshLabel: string;
  refreshing?: boolean;
  title: string;
}) {
  const createButton = (
    <Button
      appearance="primary"
      disabled={disabled}
      icon={<AddRegular />}
      onClick={onCreate}
    >
      {createLabel}
      {createTrailingIcon}
    </Button>
  );

  return (
    <div className="flex items-center justify-between gap-3 min-w-0 max-[560px]:items-start">
      <div className="min-w-0">
        <Text block size={400} weight="semibold">{title}</Text>
        {detail !== undefined && (
          <Text block size={200} className="text-fui-fg2 mt-1">{detail}</Text>
        )}
      </div>
      <div className="flex items-center gap-2 flex-none">
        <Tooltip content={refreshLabel} relationship="label">
          <Button
            aria-label={refreshLabel}
            disabled={disabled || refreshing}
            icon={refreshing ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />}
            onClick={onRefresh}
          />
        </Tooltip>
        {createTrigger === undefined ? createButton : createTrigger(createButton)}
      </div>
    </div>
  );
}

export function ResourceListEmptyState({ children }: { children: ReactNode }) {
  return <Text block size={300} className="text-fui-fg2 py-2">{children}</Text>;
}
