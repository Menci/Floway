import { KeyRegular } from '@fluentui/react-icons';
import type { RefCallback } from 'react';

import { Chip } from '../ui/chip';
import { TruncationTooltip } from '../ui/truncation-tooltip';
import type { DumpKeyRef } from '@floway-dev/gateway/browser';

// The source key of a captured request. The suffix is part of the label
// because key names are operator-chosen and two keys may share one; the id is
// not, because it says nothing a reader can use.
export function RequestKeyChip({ apiKey, className }: { apiKey: DumpKeyRef; className?: string | undefined }) {
  const label = `${apiKey.name} (${apiKey.suffix})`;
  return <TruncationTooltip content={label} relationship="description">
    {(measureRef: RefCallback<HTMLElement>) => <Chip className={className} icon={<KeyRegular />} textRef={measureRef}>{label}</Chip>}
  </TruncationTooltip>;
}
