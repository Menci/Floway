import { ArrowClockwiseRegular, CheckmarkRegular, CopyRegular, DeleteRegular, DismissRegular, EditRegular, MoreHorizontalRegular } from '@fluentui/react-icons';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { UpstreamOption } from './types';
import type { ApiKey } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { dateTime, relativeTime, shortDate } from '../../lib/format-time';
import { useMediaQuery } from '../../lib/use-media-query';
import { ResourceListEmptyState } from '../ui/resource-list-toolbar';
import { ScrollArea } from '../ui/scroll-area';
import { TooltipIconButton } from '../ui/tooltip-icon-button';

const {
  Button,
  DataGrid, DataGridBody, DataGridCell, DataGridHeader, DataGridHeaderCell, DataGridRow,
  List, ListItem, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, TableCellLayout, Text,
  createTableColumn, makeStyles,
} = fluentComponents;

const useStyles = makeStyles({
  actionsCell: {
    justifyContent: 'flex-end',
    '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' },
  },
  accentText: { color: 'var(--colorBrandForeground1)' },
  dangerText: { color: 'var(--colorPaletteRedForeground1)' },
  mobileItem: {
    borderBottom: '1px solid var(--colorNeutralStroke2)',
    borderRadius: 'var(--borderRadiusMedium)',
    padding: '10px 8px',
    '&[aria-selected="true"]': { backgroundColor: 'var(--colorSubtleBackgroundSelected)' },
  },
});

export function KeysTable({
  copiedTag, copyFailedTag, disabled, keys, onCopy, onDelete, onEdit, onRotate, onSelect, selectedKeyId, upstreams,
}: {
  copiedTag: string | null; copyFailedTag: string | null; keys: ApiKey[];
  disabled: boolean;
  onCopy: (text: string, tag: string) => void; onDelete: (key: ApiKey) => void;
  onEdit: (key: ApiKey) => void; onRotate: (key: ApiKey) => void;
  onSelect: (id: string) => void; selectedKeyId: string; upstreams: UpstreamOption[];
}) {
  const { t } = useTranslation();
  const s = useStyles();
  const narrow = useMediaQuery('(max-width: 760px)');
  const upstreamById = useMemo(
    () => new Map(upstreams.map(upstream => [upstream.id, upstream])),
    [upstreams],
  );

  const columns = useMemo(
    () => [
      createTableColumn<ApiKey>({
        columnId: 'name', compare: (a, b) => a.name.localeCompare(b.name),
        renderHeaderCell: () => t('dashboard.apiKeys.table.name'),
        renderCell: key => <TableCellLayout truncate>{key.name}</TableCellLayout>,
      }),
      createTableColumn<ApiKey>({
        columnId: 'key', renderHeaderCell: () => t('dashboard.apiKeys.table.key'),
        renderCell: key => (
          <code className="max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap" title={key.key}>
            {key.key}
          </code>
        ),
      }),
      createTableColumn<ApiKey>({
        columnId: 'upstreams', renderHeaderCell: () => t('dashboard.apiKeys.table.upstreams'),
        renderCell: key => (
          <TableCellLayout
            truncate
            className={
              !key.upstream_ids ? undefined
                : key.upstream_ids.length === 0 ? s.dangerText : s.accentText
            }
            title={upstreamsTitle(key, upstreamById, t)}
          >
            {upstreamsText(key, upstreamById, t)}
          </TableCellLayout>
        ),
      }),
      createTableColumn<ApiKey>({
        columnId: 'created', compare: (a, b) => a.created_at.localeCompare(b.created_at),
        renderHeaderCell: () => t('dashboard.apiKeys.table.created'),
        renderCell: key => <span title={dateTime(key.created_at)}>{shortDate(key.created_at)}</span>,
      }),
      createTableColumn<ApiKey>({
        columnId: 'lastUsed', compare: (a, b) => (a.last_used_at ?? '').localeCompare(b.last_used_at ?? ''),
        renderHeaderCell: () => t('dashboard.apiKeys.table.lastUsed'),
        renderCell: key => key.last_used_at
          ? <span title={dateTime(key.last_used_at)}>
              {relativeTime(key.last_used_at) ?? t('dashboard.apiKeys.table.usedOn', { date: shortDate(key.last_used_at) })}
            </span>
          : <span>{t('dashboard.apiKeys.table.never')}</span>,
      }),
      createTableColumn<ApiKey>({
        columnId: 'actions', renderHeaderCell: () => t('dashboard.apiKeys.table.actions'),
        renderCell: key => {
          const copyTag = `key-${key.id}`;
          return (
            <div className="inline-flex items-center gap-[2px]">
              <TooltipIconButton
                disabled={disabled}
                icon={copyFailedTag === copyTag ? <DismissRegular /> : copiedTag === copyTag ? <CheckmarkRegular /> : <CopyRegular />}
                label={copyFailedTag === copyTag ? t('dashboard.apiKeys.copy.failed') : copiedTag === copyTag ? t('dashboard.apiKeys.copy.copied') : t('dashboard.apiKeys.actions.copy')}
                onClick={() => onCopy(key.key, copyTag)}
              />
              <TooltipIconButton disabled={disabled} icon={<EditRegular />} label={t('dashboard.apiKeys.actions.edit')} onClick={() => onEdit(key)} />
              <TooltipIconButton disabled={disabled} icon={<ArrowClockwiseRegular />} label={t('dashboard.apiKeys.actions.rotate')} onClick={() => onRotate(key)} />
              <TooltipIconButton danger disabled={disabled} icon={<DeleteRegular />} label={t('dashboard.apiKeys.actions.delete')} onClick={() => onDelete(key)} />
            </div>
          );
        },
      }),
    ],
    [copiedTag, copyFailedTag, disabled, onCopy, onDelete, onEdit, onRotate, s, t, upstreamById],
  );

  if (keys.length === 0) {
    return <ResourceListEmptyState>{t('dashboard.apiKeys.empty')}</ResourceListEmptyState>;
  }

  if (narrow) return <List
    aria-label={t('dashboard.apiKeys.table.title')}
    onSelectionChange={(_, data) => {
      if (disabled) return;
      const id = data.selectedItems[0];
      if (typeof id === 'string') onSelect(id);
    }}
    selectedItems={selectedKeyId === '' ? [] : [selectedKeyId]}
    selectionMode="single"
  >
    {keys.map(key => {
      const copyTag = `key-${key.id}`;
      const lastUsed = key.last_used_at
        ? relativeTime(key.last_used_at) ?? t('dashboard.apiKeys.table.usedOn', { date: shortDate(key.last_used_at) })
        : t('dashboard.apiKeys.table.never');
      return <ListItem checkmark={null} className={s.mobileItem} disabledSelection={disabled} key={key.id} value={key.id}>
        <div className="flex items-start gap-2 min-w-0 w-full">
          <div className="grid gap-0.5 min-w-0 flex-1">
            <Text truncate size={300}>{key.name}</Text>
            <code className="block truncate" title={key.key}>{key.key}</code>
            <Text truncate size={200} className="text-fui-fg2" title={upstreamsTitle(key, upstreamById, t)}>{upstreamsText(key, upstreamById, t)}</Text>
            <Text size={200} className="text-fui-fg3">{shortDate(key.created_at)} · {lastUsed}</Text>
          </div>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button appearance="subtle" aria-label={t('dashboard.apiKeys.table.actions')} disabled={disabled} icon={<MoreHorizontalRegular />} />
            </MenuTrigger>
            <MenuPopover><MenuList>
              <MenuItem icon={copyFailedTag === copyTag ? <DismissRegular /> : copiedTag === copyTag ? <CheckmarkRegular /> : <CopyRegular />} onClick={() => onCopy(key.key, copyTag)}>{t('dashboard.apiKeys.actions.copy')}</MenuItem>
              <MenuItem icon={<EditRegular />} onClick={() => onEdit(key)}>{t('dashboard.apiKeys.actions.edit')}</MenuItem>
              <MenuItem icon={<ArrowClockwiseRegular />} onClick={() => onRotate(key)}>{t('dashboard.apiKeys.actions.rotate')}</MenuItem>
              <MenuItem className={s.dangerText} icon={<DeleteRegular />} onClick={() => onDelete(key)}>{t('dashboard.apiKeys.actions.delete')}</MenuItem>
            </MenuList></MenuPopover>
          </Menu>
        </div>
      </ListItem>;
    })}
  </List>;

  return (
    <ScrollArea axes="horizontal" className="min-w-0">
      <DataGrid
        aria-label={t('dashboard.apiKeys.table.title')}
        columns={columns}
        focusMode="composite"
        getRowId={key => key.id}
        items={keys}
        onSelectionChange={(_, data) => {
          if (disabled) return;
          const [id] = [...data.selectedItems];
          if (typeof id === 'string') onSelect(id);
        }}
        selectedItems={selectedKeyId === '' ? [] : [selectedKeyId]}
        selectionMode="single"
        sortable
      >
        <DataGridHeader>
          <DataGridRow selectionCell={{ 'aria-label': t('dashboard.apiKeys.table.select') }}>
            {({ renderHeaderCell, columnId }) => (
              <DataGridHeaderCell className={columnId === 'actions' ? s.actionsCell : undefined}>
                {renderHeaderCell()}
              </DataGridHeaderCell>
            )}
          </DataGridRow>
        </DataGridHeader>
        <DataGridBody<ApiKey>>
          {({ item, rowId }) => (
            <DataGridRow<ApiKey>
              key={rowId}
              selectionCell={{ radioIndicator: { 'aria-label': t('dashboard.apiKeys.table.selectNamed', { name: item.name }) } }}
            >
              {({ renderCell, columnId }) => (
                <DataGridCell
                  className={columnId === 'actions' ? s.actionsCell : undefined}
                  focusMode={columnId === 'actions' ? 'group' : 'cell'}
                >
                  {renderCell(item)}
                </DataGridCell>
              )}
            </DataGridRow>
          )}
        </DataGridBody>
      </DataGrid>
    </ScrollArea>
  );
}

const upstreamsText = (
  key: ApiKey,
  upstreamById: Map<string, UpstreamOption>,
  t: ReturnType<typeof useTranslation>['t'],
) => {
  if (!key.upstream_ids) return t('dashboard.apiKeys.upstreams.all');
  if (key.upstream_ids.length === 0) return t('dashboard.apiKeys.upstreams.none');
  const names = key.upstream_ids.map(id => upstreamById.get(id)?.name ?? id);
  return names.length <= 2
    ? names.join(', ')
    : t('dashboard.apiKeys.upstreams.summary', {
        first: names.slice(0, 2).join(', '),
        count: names.length - 2,
      });
};

const upstreamsTitle = (
  key: ApiKey,
  upstreamById: Map<string, UpstreamOption>,
  t: ReturnType<typeof useTranslation>['t'],
) => {
  if (!key.upstream_ids) return t('dashboard.apiKeys.upstreams.inheritsTitle');
  if (key.upstream_ids.length === 0) return t('dashboard.apiKeys.upstreams.none');
  return key.upstream_ids.map(id => upstreamById.get(id)?.name ?? id).join('\n');
};
