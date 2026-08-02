import { ArrowDownRegular, ArrowUpRegular } from '@fluentui/react-icons';

import { TooltipIconButton } from './tooltip-icon-button';

// A fragment rather than a container, so callers own the pair's layout.
export function ReorderButtons({ disabled = false, downLabel, isFirst, isLast, onMove, upLabel }: {
  disabled?: boolean;
  downLabel: string;
  isFirst: boolean;
  isLast: boolean;
  onMove: (direction: -1 | 1) => void;
  upLabel: string;
}) {
  return <>
    <TooltipIconButton disabled={disabled || isFirst} icon={<ArrowUpRegular />} label={upLabel} onClick={() => onMove(-1)} />
    <TooltipIconButton disabled={disabled || isLast} icon={<ArrowDownRegular />} label={downLabel} onClick={() => onMove(1)} />
  </>;
}
