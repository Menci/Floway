import { useLayoutEffect, useRef, useState } from 'react';

import { GroupBadge } from './badge';
import { visibleBadgeCount } from './overflow';
import type { ControlPlaneGroup } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { Chip } from '../ui/chip';

const { Tooltip, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  row: { contain: 'inline-size', position: 'relative', overflow: 'hidden', width: '100%', minWidth: 0, height: '24px', display: 'flex', alignItems: 'center', gap: 'var(--spacingHorizontalXS)' },
  measurement: { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', display: 'flex', width: 'max-content', top: 0, left: 0 },
});

export function GroupBadges({ groups }: { groups: ControlPlaneGroup[] }) {
  const styles = useStyles();
  const container = useRef<HTMLDivElement>(null);
  const measurement = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(groups.length);
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
    {groups.slice(0, count).map(group => <span className="inline-flex flex-none" data-visible-badge key={group.id}><GroupBadge group={group} /></span>)}
    {hidden.length > 0 && <Tooltip content={hidden.map(group => group.name).join('\n')} relationship="description">
      <Chip className="winui-focus-rect flex-none" data-overflow-count={hidden.length} tabIndex={0}>{`+${hidden.length}`}</Chip>
    </Tooltip>}
    <div aria-hidden className={styles.measurement} inert ref={measurement}>
      {groups.map(group => <span className="inline-flex flex-none" data-measure-badge key={group.id}><GroupBadge group={group} /></span>)}
      {groups.map((group, index) => <span className="inline-flex flex-none" data-measure-overflow key={group.id}><Chip>{`+${index + 1}`}</Chip></span>)}
    </div>
  </div>;
}
