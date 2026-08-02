import { ArrowDownRegular, ArrowUpRegular } from '@fluentui/react-icons';

import { TooltipIconButton } from './tooltip-icon-button';

// A fragment rather than a container: callers place the pair in a flex row, a
// fixed grid track, or a bare `inline-flex`, and own that choice.
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
