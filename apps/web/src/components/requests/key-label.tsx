import { KeyRegular } from '@fluentui/react-icons';
import type { RefCallback } from 'react';

import { fluentComponents } from '../../fluent';
import { TruncationTooltip } from '../ui/truncation-tooltip';
import type { DumpKeyRef } from '@floway-dev/gateway/browser';

const { Text, mergeClasses } = fluentComponents;

// Secondary text rather than a chip, so the upstream badge stays the row's only
// chip. The last four characters only tell apart keys that share a name; the
// tooltip always carries them.
export function RequestKeyLabel({ apiKey, className, withSuffix }: {
  apiKey: DumpKeyRef;
  className?: string | undefined;
  withSuffix: boolean;
}) {
  const full = `${apiKey.name} (${apiKey.suffix})`;
  return <span className={mergeClasses('inline-flex items-center gap-1 min-w-0 text-fui-fg3', className)}>
    <KeyRegular aria-hidden="true" className="block flex-none" fontSize={16} />
    <TruncationTooltip content={full} relationship="description">
      {(measureRef: RefCallback<HTMLElement>) => <Text ref={measureRef} size={200} className="min-w-0" truncate wrap={false}>
        {withSuffix ? full : apiKey.name}
      </Text>}
    </TruncationTooltip>
  </span>;
}
