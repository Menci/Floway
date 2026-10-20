import { useLayoutEffect, useRef, useState } from 'react';

import { GroupIdentity, GroupIdentityLink } from './identity';
import { visibleGroupCount } from './overflow';
import type { ControlPlaneGroup } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { IdentityAvatar } from '../ui/identity-avatar';

const { Popover, PopoverSurface, PopoverTrigger, Tooltip, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  // Membership visibility must not change the column's intrinsic width and feed
  // back into its own overflow decision.
  row: { contain: 'inline-size', position: 'relative', overflow: 'hidden', width: '100%', minWidth: 0, height: '24px', display: 'flex', alignItems: 'center', gap: 'var(--spacingHorizontalS)' },
  measurement: { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', display: 'flex', width: 'max-content', top: 0, left: 0 },
});

export function GroupMemberships({ groups }: { groups: readonly ControlPlaneGroup[] }) {
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
      const widths = [...rail.querySelectorAll<HTMLElement>('[data-measure-group]')].map(node => node.getBoundingClientRect().width);
      const overflow = rail.querySelector<HTMLElement>('[data-measure-overflow]')!.getBoundingClientRect().width;
      const gap = parseFloat(getComputedStyle(row).columnGap);
      setVisible(visibleGroupCount(row.getBoundingClientRect().width, widths, overflow, gap));
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
  return <div className={styles.row} ref={container} data-group-memberships>
    {groups.slice(0, count).map(group => <span className="inline-flex flex-none min-w-0" data-visible-group key={group.id}><GroupIdentityLink group={group} /></span>)}
    {hidden.length > 0 && <Popover onOpenChange={(_, data) => { setOverflowOpen(data.open); setTooltipVisible(false); }} open={overflowOpen} positioning={{ position: 'below', align: 'start' }}>
      <Tooltip content={<div className="grid gap-2">{hidden.map(group => <GroupIdentity group={group} key={group.id} />)}</div>} onVisibleChange={(_, data) => setTooltipVisible(data.visible)} relationship="description" visible={!overflowOpen && tooltipVisible}>
        <PopoverTrigger disableButtonEnhancement><button aria-label={t('dashboard.groupsManagement.more', { count: hidden.length })} className="winui-focus-rect floway-identity-action flex-none" type="button"><OverflowAvatar count={hidden.length} /></button></PopoverTrigger>
      </Tooltip>
      <PopoverSurface aria-label={t('dashboard.users.table.groups')} className="grid justify-items-start gap-2 max-w-[calc(100vw-32px)] !p-3">
        {hidden.map(group => <GroupIdentityLink group={group} key={group.id} />)}
      </PopoverSurface>
    </Popover>}
    <div aria-hidden className={styles.measurement} inert ref={measurement}>
      {groups.map(group => <span className="inline-flex flex-none" data-measure-group key={group.id}><GroupIdentity group={group} /></span>)}
      <span className="inline-flex flex-none" data-measure-overflow><OverflowAvatar count={groups.length} /></span>
    </div>
  </div>;
}

function OverflowAvatar({ count }: { count: number }) {
  return <IdentityAvatar aria-hidden className="floway-group-avatar" color="neutral" data-overflow-count={count} initials={`+${count}`} name={`+${count}`} shape="square" size={24} />;
}
