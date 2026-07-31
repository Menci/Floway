import { ArrowDownRegular, ArrowUpRegular } from '@fluentui/react-icons';

import { TooltipIconButton } from './tooltip-icon-button';

// The pair itself, and no container: a reorder pair sits in a flex row beside
// an index, in a fixed grid track beside a delete button, and in a bare
// `inline-flex` beside both. The caller owns whichever of those it is.
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
