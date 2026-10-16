import { useLayoutEffect, useRef, useState } from 'react';

import { GroupBadge, GroupBadgeLink } from './badge';
import { visibleBadgeCount } from './overflow';
import type { ControlPlaneGroup } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Chip } from '../ui/chip';

const { Popover, PopoverSurface, PopoverTrigger, Tooltip, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  // Badge visibility must not change the column's intrinsic width and feed
  // back into its own overflow decision.
  row: { contain: 'inline-size', position: 'relative', overflow: 'hidden', width: '100%', minWidth: 0, height: '24px', display: 'flex', alignItems: 'center', gap: 'var(--spacingHorizontalXS)' },
  measurement: { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', display: 'flex', width: 'max-content', top: 0, left: 0 },
});

export function GroupBadges({ groups }: { groups: ControlPlaneGroup[] }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const container = useRef<HTMLDivElement>(null);
  const measurement = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(groups.length);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  useLayoutEffect(() => {
    const row = container.current;
    const rail = measurement.current;
    if (!row || !rail) return;
    const measure = () => {
      const widths = [...rail.querySelectorAll<HTMLElement>('[data-measure-badge]')].map(node => node.getBoundingClientRect().width);
      const overflow = [...rail.querySelectorAll<HTMLElement>('[data-measure-overflow]')].map(node => node.getBoundingClientRect().width);
      const gap = parseFloat(getComputedStyle(row).columnGap);
      setVisible(visibleBadgeCount(row.getBoundingClientRect().width, widths, overflow, gap));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(rail);
    let mounted = true;
    void document.fonts.ready.then(() => { if (mounted) measure(); });
    return () => { mounted = false; observer.disconnect(); };
  }, [groups]);
  if (groups.length === 0) return <span className="text-fui-fg3">{'\u2014'}</span>;
  const count = Math.min(visible, groups.length);
  const hidden = groups.slice(count);
  return <div className={styles.row} ref={container} data-group-badges>
    {groups.slice(0, count).map(group => <span className="inline-flex flex-none" data-visible-badge key={group.id}><GroupBadgeLink group={group} /></span>)}
    {hidden.length > 0 && <Popover onOpenChange={(_, data) => { setOverflowOpen(data.open); setTooltipVisible(false); }} open={overflowOpen} positioning={{ position: 'below', align: 'start' }}>
      <Tooltip content={hidden.map(group => group.name).join('\n')} onVisibleChange={(_, data) => setTooltipVisible(data.visible)} relationship="description" visible={!overflowOpen && tooltipVisible}>
        <PopoverTrigger disableButtonEnhancement><button aria-label={t('dashboard.groupsManagement.more', { count: hidden.length })} className="winui-focus-rect inline-flex flex-none rounded-full bg-transparent border-0 p-0 cursor-pointer" type="button"><Chip data-overflow-count={hidden.length}>{`+${hidden.length}`}</Chip></button></PopoverTrigger>
      </Tooltip>
      <PopoverSurface aria-label={t('dashboard.users.table.groups')} className="grid justify-items-start gap-2 max-w-[calc(100vw-32px)] !p-3">
        {hidden.map(group => <GroupBadgeLink group={group} key={group.id} />)}
      </PopoverSurface>
    </Popover>}
    <div aria-hidden className={styles.measurement} inert ref={measurement}>
      {groups.map(group => <span className="inline-flex flex-none" data-measure-badge key={group.id}><GroupBadge group={group} /></span>)}
      {groups.map((group, index) => <span className="inline-flex flex-none" data-measure-overflow key={group.id}><Chip>{`+${index + 1}`}</Chip></span>)}
    </div>
  </div>;
}
