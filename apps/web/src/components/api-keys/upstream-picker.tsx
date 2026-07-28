import { ArrowDownRegular, ArrowUpRegular } from '@fluentui/react-icons';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { UpstreamOption } from './types';
import type { UpstreamColor, UpstreamProviderKind } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { ProviderBadge, providerLabel } from '../upstreams/provider-badge';

const { Button, Checkbox, Switch, Table, TableBody, TableCell, TableCellLayout, TableHeader, TableHeaderCell, TableRow, Text, Tooltip, createTableColumn, makeStyles, useTableColumnSizing_unstable, useTableFeatures, useTableSort } = fluentComponents;
const useStyles = makeStyles({ fieldError: { color: 'var(--colorPaletteRedForeground1)' } });
interface UpstreamRow { id: string; name: string; kind: UpstreamProviderKind | null; color: UpstreamColor | null; enabled: boolean }
function HintText({ children }: { children: string }) { return <Text size={200} className="text-fui-fg2 leading-[1.35] !m-0">{children}</Text>; }
function IconButton({ disabled, icon, label, onClick }: { disabled?: boolean; icon: React.ReactElement; label: string; onClick: () => void }) { return <Tooltip content={label} relationship="label"><Button appearance="subtle" aria-label={label} disabled={disabled} icon={icon} onClick={onClick} size="small" /></Tooltip>; }

function UpstreamPickerTable({
  columns, rows,
}: {
  columns: ReturnType<typeof createTableColumn<UpstreamRow>>[]; rows: UpstreamRow[];
}) {
  const upstreamSizingOptions = useMemo(
    () => ({
      enabled: { defaultWidth: 80, minWidth: 70 },
      order: { defaultWidth: 80, minWidth: 60 },
      kind: { defaultWidth: 140 },
    }),
    [],
  );
  const { getRows: getUpstreamRows, columnSizing_unstable: cs, tableRef: ref } = useTableFeatures(
    { columns, items: rows }, [
      useTableSort({}),
      useTableColumnSizing_unstable({ columnSizingOptions: upstreamSizingOptions }),
    ],
  );
  const upstreamRows = getUpstreamRows();
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table ref={ref} {...cs.getTableProps()} aria-label="Upstreams" sortable>
        <TableHeader><TableRow>{columns.map(col => (
          <TableHeaderCell key={col.columnId} {...cs.getTableHeaderCellProps(col.columnId)}>{col.renderHeaderCell()}</TableHeaderCell>
        ))}</TableRow></TableHeader>
        <TableBody>{upstreamRows.map(({ item }) => (
          <TableRow key={item.id}>{columns.map(col => (
            <TableCell key={col.columnId} {...cs.getTableCellProps(col.columnId)}>{col.renderCell(item)}</TableCell>
          ))}</TableRow>
        ))}</TableBody>
      </Table>
    </div>
  );
}

export function UpstreamPicker({
  available,
  disabled,
  error,
  ids,
  onChange,
  override,
}: {
  available: UpstreamOption[];
  disabled: boolean;
  error: string | null;
  ids: string[];
  onChange: (value: { override: boolean; ids: string[] }) => void;
  override: boolean;
}) {
  const { t } = useTranslation();
  const s = useStyles();
  const selectedCount = override ? ids.length : available.length;

  return (
    <div className="grid gap-[10px] min-w-0">
      <div className="flex items-center gap-3 justify-between rounded-lg border border-fui-stroke1 bg-fui-bg2 p-[10px_12px]">
        <div>
          <span className="text-fui-fg1 text-fui-base300 font-fui-semibold">
            {t('dashboard.apiKeys.upstreams.title', { count: selectedCount })}
          </span>
          <HintText>{t('dashboard.apiKeys.upstreams.inheritDescription')}</HintText>
        </div>
        <Switch
          checked={override}
          disabled={disabled}
          onChange={(_, data) => onChange({ override: !!data.checked, ids })}
        />
      </div>
      {error && <span className={`${s.fieldError} text-xs !m-0`}>{error}</span>}
      {override && (
        <UpstreamOverrideTable
          available={available}
          disabled={disabled}
          ids={ids}
          onChange={onChange}
        />
      )}
    </div>
  );
}

function UpstreamOverrideTable({ available, disabled, ids, onChange }: {
  available: UpstreamOption[];
  disabled: boolean;
  ids: string[];
  onChange: (value: { override: boolean; ids: string[] }) => void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => upstreamRows(available, ids), [available, ids]);
  const toggleUpstream = useCallback((id: string, enabled: boolean) => {
    const nextIds = enabled ? [...new Set([...ids, id])] : ids.filter(candidate => candidate !== id);
    onChange({ override: true, ids: nextIds });
  }, [ids, onChange]);
  const moveUpstream = useCallback((id: string, direction: -1 | 1) => {
    const index = ids.indexOf(id);
    const nextIndex = index + direction;
    if (index === -1 || nextIndex < 0 || nextIndex >= ids.length) return;
    const next = [...ids];
    const [item] = next.splice(index, 1);
    next.splice(nextIndex, 0, item);
    onChange({ override: true, ids: next });
  }, [ids, onChange]);
  const columns = useMemo(() => [
    createTableColumn<UpstreamRow>({ columnId: 'enabled', renderHeaderCell: () => t('dashboard.apiKeys.upstreams.enabled'), renderCell: row => <Checkbox checked={row.enabled} disabled={disabled} onChange={(_, data) => toggleUpstream(row.id, !!data.checked)} /> }),
    createTableColumn<UpstreamRow>({ columnId: 'order', renderHeaderCell: () => t('dashboard.apiKeys.upstreams.order'), renderCell: row => { const index = ids.indexOf(row.id); return <div className="inline-flex items-center gap-1"><IconButton disabled={disabled || index <= 0} icon={<ArrowUpRegular />} label={t('dashboard.apiKeys.upstreams.moveUp')} onClick={() => moveUpstream(row.id, -1)} /><IconButton disabled={disabled || index === -1 || index >= ids.length - 1} icon={<ArrowDownRegular />} label={t('dashboard.apiKeys.upstreams.moveDown')} onClick={() => moveUpstream(row.id, 1)} /></div>; } }),
    createTableColumn<UpstreamRow>({ columnId: 'name', compare: (a, b) => a.name.localeCompare(b.name), renderHeaderCell: () => t('dashboard.apiKeys.upstreams.name'), renderCell: row => <TableCellLayout><span className="truncate min-w-0">{row.name}</span></TableCellLayout> }),
    createTableColumn<UpstreamRow>({ columnId: 'kind', compare: (a, b) => providerLabel(a.kind).localeCompare(providerLabel(b.kind)), renderHeaderCell: () => t('dashboard.apiKeys.upstreams.kind'), renderCell: row => <ProviderBadge color={row.color} kind={row.kind} /> }),
  ], [disabled, ids, moveUpstream, t, toggleUpstream]);
  return <UpstreamPickerTable columns={columns} rows={rows} />;
}

const upstreamRows = (available: UpstreamOption[], ids: string[]): UpstreamRow[] => {
  const selected = new Set(ids);
  return [
    ...ids.map(id => {
      const upstream = available.find(candidate => candidate.id === id);
      return {
        id,
        name: upstream?.name ?? `Unknown (${id})`,
        kind: upstream?.kind ?? null,
        color: upstream?.color ?? null,
        enabled: true,
      };
    }),
    ...available
      .filter(upstream => !selected.has(upstream.id))
      .map(upstream => ({
        id: upstream.id,
        name: upstream.name,
        kind: upstream.kind,
        color: upstream.color,
        enabled: false,
      })),
  ];
};
