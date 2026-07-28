import { ArrowClockwiseRegular, CheckmarkRegular, CopyRegular, DeleteRegular, DismissRegular, EditRegular, MoreHorizontalRegular } from '@fluentui/react-icons';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { UpstreamOption } from './types';
import type { ApiKey } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { dateTime, relativeTime, shortDate } from '../../lib/format-time';
import { ScrollArea } from '../ui/scroll-area';
import { TooltipIconButton } from '../ui/tooltip-icon-button';

const {
  Button, DataGrid, DataGridBody, DataGridCell, DataGridHeader, DataGridHeaderCell, DataGridRow,
  Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, TableCellActions, TableCellLayout, Text,
  createTableColumn, makeStyles,
} = fluentComponents;

const useStyles = makeStyles({
  accentText: { color: 'var(--colorBrandForeground1)' },
  dangerText: { color: 'var(--colorPaletteRedForeground1)' },
});

export function KeysTable({
  copiedTag, copyFailedTag, keys, onCopy, onDelete, onEdit, onRotate, onSelect, selectedKeyId, upstreams,
}: {
  copiedTag: string | null; copyFailedTag: string | null; keys: ApiKey[];
  onCopy: (text: string, tag: string) => void; onDelete: (key: ApiKey) => void;
  onEdit: (key: ApiKey) => void; onRotate: (key: ApiKey) => void;
  onSelect: (id: string) => void; selectedKeyId: string; upstreams: UpstreamOption[];
}) {
  const { t } = useTranslation();
  const s = useStyles();
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
          <code className="bg-fui-bg2 border border-fui-stroke1 rounded-md text-fui-fg2 inline-block font-mono text-xs max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap p-[2px_6px]">
            {truncateKey(key.key)}
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
      // The row's actions ride in this last cell instead of a column of their
      // own: TableCellActions reveals them on hover and on keyboard focus, so a
      // dedicated column would only reserve width for something usually hidden.
      createTableColumn<ApiKey>({
        columnId: 'lastUsed', compare: (a, b) => (a.last_used_at ?? '').localeCompare(b.last_used_at ?? ''),
        renderHeaderCell: () => t('dashboard.apiKeys.table.lastUsed'),
        renderCell: key => <>
          {key.last_used_at
            ? <span title={dateTime(key.last_used_at)}>
                {relativeTime(key.last_used_at) ?? t('dashboard.apiKeys.table.usedOn', { date: shortDate(key.last_used_at) })}
              </span>
            : <span>{t('dashboard.apiKeys.table.never')}</span>}
          <RowActions
            apiKey={key}
            copiedTag={copiedTag}
            copyFailedTag={copyFailedTag}
            onCopy={onCopy}
            onDelete={onDelete}
            onEdit={onEdit}
            onRotate={onRotate}
          />
        </>,
      }),
    ],
    [copiedTag, copyFailedTag, onCopy, onDelete, onEdit, onRotate, s, t, upstreamById],
  );

  const columnSizingOptions = useMemo(
    () => ({
      name: { defaultWidth: 180 }, key: { defaultWidth: 160 },
      upstreams: { defaultWidth: 240 }, lastUsed: { defaultWidth: 220 },
    }), [],
  );

  if (keys.length === 0) {
    return <Text size={300} className="text-fui-fg3 !m-0 text-center p-[18px_0]">{t('dashboard.apiKeys.empty')}</Text>;
  }

  return (
    <ScrollArea axes="horizontal" className="min-w-0">
      <DataGrid
        aria-label={t('dashboard.apiKeys.table.title')}
        columns={columns}
        columnSizingOptions={columnSizingOptions}
        focusMode="composite"
        getRowId={key => key.id}
        items={keys}
        onSelectionChange={(_, data) => {
          const [id] = [...data.selectedItems];
          if (typeof id === 'string') onSelect(id);
        }}
        resizableColumns
        selectedItems={selectedKeyId === '' ? [] : [selectedKeyId]}
        selectionMode="single"
        sortable
        subtleSelection
      >
        <DataGridHeader>
          <DataGridRow selectionCell={{ 'aria-label': t('dashboard.apiKeys.table.select') }}>
            {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
          </DataGridRow>
        </DataGridHeader>
        <DataGridBody<ApiKey>>
          {({ item, rowId }) => (
            <DataGridRow<ApiKey>
              key={rowId}
              selectionCell={{ radioIndicator: { 'aria-label': t('dashboard.apiKeys.table.selectNamed', { name: item.name }) } }}
            >
              {({ renderCell, columnId }) => (
                <DataGridCell focusMode={columnId === 'lastUsed' ? 'group' : 'cell'}>
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

const truncateKey = (key: string) =>
  key.length <= 14 ? key : `${key.slice(0, 7)}...${key.slice(-4)}`;

// Row actions ride in TableCellActions, which Fluent keeps at opacity 0 until
// the row is hovered or holds focus. An open menu portals its popover out of
// the row, so without pinning the actions visible the trigger fades out from
// under its own menu as soon as the pointer travels to a menu item.
function RowActions({ apiKey, copiedTag, copyFailedTag, onCopy, onDelete, onEdit, onRotate }: {
  apiKey: ApiKey;
  copiedTag: string | null;
  copyFailedTag: string | null;
  onCopy: (text: string, tag: string) => void;
  onDelete: (key: ApiKey) => void;
  onEdit: (key: ApiKey) => void;
  onRotate: (key: ApiKey) => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const copyTag = `key-${apiKey.id}`;

  return (
    <TableCellActions visible={menuOpen}>
      <TooltipIconButton
        icon={copyFailedTag === copyTag ? <DismissRegular /> : copiedTag === copyTag ? <CheckmarkRegular /> : <CopyRegular />}
        label={copyFailedTag === copyTag ? t('dashboard.apiKeys.copy.failed') : copiedTag === copyTag ? t('dashboard.apiKeys.copy.copied') : t('dashboard.apiKeys.actions.copy')}
        onClick={() => onCopy(apiKey.key, copyTag)}
      />
      <Menu onOpenChange={(_, data) => setMenuOpen(data.open)} open={menuOpen}>
        <MenuTrigger disableButtonEnhancement>
          <Button appearance="subtle" aria-label={t('dashboard.apiKeys.actions.more', { name: apiKey.name })} icon={<MoreHorizontalRegular />} />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem icon={<EditRegular />} onClick={() => onEdit(apiKey)}>{t('dashboard.apiKeys.actions.edit')}</MenuItem>
            <MenuItem icon={<ArrowClockwiseRegular />} onClick={() => onRotate(apiKey)}>{t('dashboard.apiKeys.actions.rotate')}</MenuItem>
            <MenuItem icon={<DeleteRegular />} onClick={() => onDelete(apiKey)}>{t('dashboard.apiKeys.actions.delete')}</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
    </TableCellActions>
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
