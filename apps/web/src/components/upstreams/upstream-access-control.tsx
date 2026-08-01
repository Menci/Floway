import { ShieldKeyhole24Regular } from '@fluentui/react-icons';
import { useCallback, useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { ProviderBadge } from './provider-badge';
import type { ControlPlaneModel, UpstreamOption } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useDangerTextClass } from '../ui/danger';
import { ReorderButtons } from '../ui/reorder-buttons';
import { ScrollArea } from '../ui/scroll-area';
import { SettingsExpander, SettingsSwitch } from '../ui/settings-card';

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
  color: UpstreamOption['color'];
  enabled: boolean;
  id: string;
  kind: UpstreamOption['kind'] | null;
  modelCount: number;
  name: string;
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

  // The switch says "this scope picks its own upstreams", not "this scope
  // reaches nothing". Opening it on an empty selection would state the second
  // and fail validation before the operator has touched a row, so it opens on
  // everything the scope can see and is narrowed from there.
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
          {/* Fluent's Table is already `width: 100%; table-layout: fixed`, so the
              only thing this minimum decides is when the region starts scrolling.
              It is the three sized columns plus enough room for a provider chip to
              stay readable — a dialog wide enough to show that much never scrolls,
              and a chip narrower than its column truncates on its own. */}
          <Table aria-label={t('dashboard.upstreamAccess.tableLabel')} className="min-w-[440px]">
            <colgroup><col className="w-[80px]" /><col className="w-[96px]" /><col /><col className="w-[120px]" /></colgroup>
            <TableHeader><TableRow>
              <TableHeaderCell>{t('dashboard.upstreamAccess.enabled')}</TableHeaderCell>
              <TableHeaderCell>{t('dashboard.upstreamAccess.order')}</TableHeaderCell>
              <TableHeaderCell>{t('dashboard.upstreamAccess.upstream')}</TableHeaderCell>
              <TableHeaderCell>{t('dashboard.upstreamAccess.models')}</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>{rows.map(row => {
              const index = ids.indexOf(row.id);
              return <TableRow key={row.id}>
                <TableCell><Checkbox aria-label={`${t('dashboard.upstreamAccess.enabled')}: ${row.name}`} checked={row.enabled} disabled={disabled || !override} onChange={(_, data) => toggleUpstream(row.id, !!data.checked)} /></TableCell>
                <TableCell><div className="inline-flex items-center gap-1"><ReorderButtons disabled={disabled || !override} downLabel={t('dashboard.upstreamAccess.moveDown')} isFirst={index <= 0} isLast={index === -1 || index >= ids.length - 1} onMove={direction => moveUpstream(row.id, direction)} upLabel={t('dashboard.upstreamAccess.moveUp')} /></div></TableCell>
                <TableCell><ProviderBadge color={row.color} kind={row.kind} label={row.name} /></TableCell>
                <TableCell><Text>{t('dashboard.upstreamAccess.modelCount', { count: row.modelCount })}</Text></TableCell>
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
  const rowFor = (upstream: UpstreamOption, enabled: boolean): UpstreamAccessRow => ({
    ...upstream,
    enabled,
    modelCount: modelCounts.get(upstream.id) ?? 0,
  });
  return [
    ...ids.map(id => {
      const upstream = byId.get(id);
      return upstream
        ? rowFor(upstream, true)
        : { id, name: `Unknown (${id})`, kind: null, color: null, enabled: true, modelCount: 0 };
    }),
    ...available.filter(upstream => !selected.has(upstream.id)).map(upstream => rowFor(upstream, false)),
  ];
};
