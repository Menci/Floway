import { ProhibitedRegular, ShieldKeyhole24Regular } from '@fluentui/react-icons';
import { useCallback, useId, useMemo } from 'react';

import { ProviderBadge } from './provider-badge';
import type { ControlPlaneModel, UpstreamOption } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { moveItem, ReorderHandle, type ReorderList, useReorderList } from '../ui/reorder-list';
import { ScrollArea } from '../ui/scroll-area';
import { SettingsExpander, SettingsSwitch } from '../ui/settings-card';
import { TableColumns } from '../ui/table-columns';

const {
  Checkbox,
  MessageBar,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
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
  ids,
  models,
  onChange,
  override,
}: {
  available: UpstreamOption[];
  disabled: boolean;
  ids: string[];
  models: ControlPlaneModel[];
  onChange: (value: { override: boolean; ids: string[] }) => void;
  override: boolean;
}) {
  const { t } = useTranslation();
  const warningId = useId();
  const emptySelection = override && ids.length === 0;
  const rows = useMemo(() => accessRows(available, ids, models), [available, ids, models]);

  const toggleOverride = useCallback((next: boolean) => {
    onChange({ override: next, ids });
  }, [ids, onChange]);

  const toggleUpstream = useCallback((id: string, enabled: boolean) => {
    const nextIds = enabled ? [...new Set([...ids, id])] : ids.filter(candidate => candidate !== id);
    onChange({ override: true, ids: nextIds });
  }, [ids, onChange]);

  const moveUpstream = useCallback((from: number, to: number) => {
    onChange({ override: true, ids: moveItem(ids, from, to) });
  }, [ids, onChange]);

  // Only the selected rows carry an order, and the table puts them first, so
  // the orderable list is the head of it. An unselected row has no place in the
  // cap and answers with the index none of them has.
  const reorder = useReorderList({ disabled: disabled || !override, length: ids.length, onReorder: moveUpstream });

  return <section className="grid gap-3 min-w-0" aria-describedby={emptySelection ? warningId : undefined}>
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
      toggledOn={override}
    >
      <div className="grid gap-3 min-w-0">
        <ScrollArea axes="horizontal" className="min-w-0">
          {/* The minimum only decides when the region starts scrolling: the two
              sized columns plus enough room for a provider chip to stay
              readable. */}
          <Table aria-label={t('dashboard.upstreamAccess.tableLabel')} className="min-w-[344px]">
            <TableColumns widths={['80px', null, '120px']} />
            <TableHeader><TableRow>
              <TableHeaderCell>{t('dashboard.upstreamAccess.enabled')}</TableHeaderCell>
              <TableHeaderCell>{t('dashboard.upstreamAccess.upstream')}</TableHeaderCell>
              <TableHeaderCell>{t('dashboard.upstreamAccess.models')}</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody {...reorder.listProps()}>
              {rows.map(row => <AccessRow disabled={disabled || !override} index={ids.indexOf(row.id)} key={row.id} onToggle={toggleUpstream} reorder={reorder} row={row} />)}
            </TableBody>
          </Table>
        </ScrollArea>
      </div>
    </SettingsExpander>
    {emptySelection && <MessageBar id={warningId} intent="warning">
      <MessageBarBody>{t('dashboard.upstreamAccess.emptyWarning')}</MessageBarBody>
    </MessageBar>}
  </section>;
}

// An index outside the cap is a row the cap does not order: it renders the same
// grip, dead, beside its checkbox so the enabled column keeps one shape.
function AccessRow({ disabled, index, onToggle, reorder, row }: {
  disabled: boolean;
  index: number;
  onToggle: (id: string, enabled: boolean) => void;
  reorder: ReorderList;
  row: UpstreamAccessRow;
}) {
  const { t } = useTranslation();
  return <TableRow {...(index < 0 ? {} : reorder.itemProps(index))}>
    <TableCell><div className="inline-flex items-center gap-1">
      <Checkbox
        aria-label={`${t('dashboard.upstreamAccess.enabled')}: ${row.name}`}
        checked={row.selected}
        disabled={disabled}
        onChange={(_, data) => onToggle(row.id, !!data.checked)}
      />
      <ReorderHandle {...reorder.handleProps(index)} label={t('dashboard.upstreams.actions.reorder', { name: row.name })} />
    </div></TableCell>
    <TableCell><ProviderBadge label={row.name} upstream={row.upstream} /></TableCell>
    <TableCell><span className="inline-flex items-center gap-1.5 min-w-0">
      {!row.upstreamEnabled && <ProhibitedRegular className="block flex-none text-fui-fg2" aria-label={t('dashboard.upstreamAccess.upstreamDisabled')} />}
      {row.modelCount === null
        ? t('dashboard.upstreamAccess.modelCountUnknown')
        : t('dashboard.upstreamAccess.modelCount', { count: row.modelCount })}
    </span></TableCell>
  </TableRow>;
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
