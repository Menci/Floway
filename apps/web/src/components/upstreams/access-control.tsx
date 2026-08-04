import { ProhibitedRegular, ShieldKeyhole24Regular } from '@fluentui/react-icons';
import { useCallback, useId, useMemo } from 'react';

import { ProviderBadge } from './provider-badge';
import type { ControlPlaneModel, UpstreamOption } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { useDangerTextClass } from '../ui/danger';
import { ReorderButtons } from '../ui/reorder-buttons';
import { ScrollArea } from '../ui/scroll-area';
import { SettingsExpander, SettingsSwitch } from '../ui/settings-card';
import { TableColumns } from '../ui/table-columns';

const {
  Checkbox,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} = fluentComponents;

interface UpstreamAccessRow {
  id: string;
  // Null is a count nobody knows: the upstream is disabled and never cached a
  // catalog while it was on.
  modelCount: number | null;
  name: string;
  selected: boolean;
  upstream: { hue: number; kind: UpstreamOption['kind'] };
  upstreamEnabled: boolean;
}

export function UpstreamAccessControl({
  available,
  disabled,
  error,
  ids,
  models,
  onChange,
  override,
}: {
  available: UpstreamOption[];
  disabled: boolean;
  error: string | null;
  ids: string[];
  models: ControlPlaneModel[];
  onChange: (value: { override: boolean; ids: string[] }) => void;
  override: boolean;
}) {
  const { t } = useTranslation();
  const dangerText = useDangerTextClass();
  const errorId = useId();
  const rows = useMemo(() => accessRows(available, ids, models), [available, ids, models]);

  // Opening on an empty selection would fail validation before the operator has
  // touched a row, so it opens on everything the scope can see.
  const toggleOverride = useCallback((next: boolean) => {
    onChange({
      override: next,
      ids: next && ids.length === 0 ? available.map(upstream => upstream.id) : ids,
    });
  }, [available, ids, onChange]);

  const toggleUpstream = useCallback((id: string, enabled: boolean) => {
    const nextIds = enabled ? [...new Set([...ids, id])] : ids.filter(candidate => candidate !== id);
    onChange({ override: true, ids: nextIds });
  }, [ids, onChange]);

  const moveUpstream = useCallback((id: string, direction: -1 | 1) => {
    const index = ids.indexOf(id);
    const nextIndex = index + direction;
    if (index === -1 || nextIndex < 0 || nextIndex >= ids.length) return;
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    next.splice(nextIndex, 0, moved);
    onChange({ override: true, ids: next });
  }, [ids, onChange]);

  return <section className="grid gap-3 min-w-0" aria-describedby={error ? errorId : undefined}>
    <SettingsExpander
      action={<SettingsSwitch
        checked={override}
        disabled={disabled}
        label={t('dashboard.upstreamAccess.title')}
        onChange={toggleOverride}
      />}
      description={t('dashboard.upstreamAccess.description')}
      header={t('dashboard.upstreamAccess.title')}
      icon={<ShieldKeyhole24Regular />}
      revealOn={error !== null}
      toggledOn={override}
    >
      <div className="grid gap-3 min-w-0">
        {error && <Text className={dangerText} id={errorId} role="alert" size={200}>{error}</Text>}
        <ScrollArea axes="horizontal" className="min-w-0">
          {/* The minimum only decides when the region starts scrolling: the
              three sized columns plus enough room for a provider chip to stay
              readable. */}
          <Table aria-label={t('dashboard.upstreamAccess.tableLabel')} className="min-w-[440px]">
            <TableColumns widths={['80px', '96px', null, '120px']} />
            <TableHeader><TableRow>
              <TableHeaderCell>{t('dashboard.upstreamAccess.enabled')}</TableHeaderCell>
              <TableHeaderCell>{t('dashboard.upstreamAccess.order')}</TableHeaderCell>
              <TableHeaderCell>{t('dashboard.upstreamAccess.upstream')}</TableHeaderCell>
              <TableHeaderCell>{t('dashboard.upstreamAccess.models')}</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>{rows.map(row => {
              const index = ids.indexOf(row.id);
              return <TableRow key={row.id}>
                <TableCell><Checkbox aria-label={`${t('dashboard.upstreamAccess.enabled')}: ${row.name}`} checked={row.selected} disabled={disabled || !override} onChange={(_, data) => toggleUpstream(row.id, !!data.checked)} /></TableCell>
                <TableCell><div className="inline-flex items-center gap-1"><ReorderButtons disabled={disabled || !override} downLabel={t('dashboard.upstreams.actions.moveDown', { name: row.name })} isFirst={index <= 0} isLast={index === -1 || index >= ids.length - 1} onMove={direction => moveUpstream(row.id, direction)} upLabel={t('dashboard.upstreams.actions.moveUp', { name: row.name })} /></div></TableCell>
                <TableCell><ProviderBadge label={row.name} upstream={row.upstream} /></TableCell>
                <TableCell><span className="inline-flex items-center gap-1.5 min-w-0">
                  {!row.upstreamEnabled && <ProhibitedRegular className="block flex-none text-fui-fg2" aria-label={t('dashboard.upstreamAccess.upstreamDisabled')} />}
                  {row.modelCount === null
                    ? t('dashboard.upstreamAccess.modelCountUnknown')
                    : t('dashboard.upstreamAccess.modelCount', { count: row.modelCount })}
                </span></TableCell>
              </TableRow>;
            })}</TableBody>
          </Table>
        </ScrollArea>
      </div>
    </SettingsExpander>
  </section>;
}

const accessRows = (
  available: UpstreamOption[],
  ids: string[],
  models: ControlPlaneModel[],
): UpstreamAccessRow[] => {
  const selected = new Set(ids);
  const byId = new Map(available.map(upstream => [upstream.id, upstream]));
  const modelCounts = new Map<string, number>();
  for (const model of models) {
    for (const id of new Set(model.upstreams.map(upstream => upstream.id))) {
      modelCounts.set(id, (modelCounts.get(id) ?? 0) + 1);
    }
  }
  // A disabled upstream contributes nothing to the live catalog these counts
  // come from, so it reports the size of the catalog it stored while it was on.
  const rowFor = (upstream: UpstreamOption, isSelected: boolean): UpstreamAccessRow => ({
    id: upstream.id,
    modelCount: upstream.enabled ? (modelCounts.get(upstream.id) ?? 0) : upstream.cachedModelCount,
    name: upstream.name,
    selected: isSelected,
    upstream: { hue: upstream.hue, kind: upstream.kind },
    upstreamEnabled: upstream.enabled,
  });
  // Selected first, in the order the cap states, then the rest. An id absent
  // from `available` has none: the control plane serves a cap already projected
  // through what the principal can reach, so every id here resolves.
  return [
    ...ids.flatMap(id => {
      const upstream = byId.get(id);
      return upstream ? [rowFor(upstream, true)] : [];
    }),
    ...available.filter(upstream => !selected.has(upstream.id)).map(upstream => rowFor(upstream, false)),
  ];
};
