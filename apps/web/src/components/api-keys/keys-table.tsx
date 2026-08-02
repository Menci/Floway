import { ArrowClockwiseRegular, DeleteRegular, EditRegular, MoreHorizontalRegular } from '@fluentui/react-icons';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiKey, UpstreamOption } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { dateTime, relativeTime, shortDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useMediaQuery } from '../../lib/use-media-query';
import { useNow } from '../../lib/use-now';
import { useDangerActionClasses, useDangerTextClass } from '../ui/danger';
import { ResourceListEmptyState } from '../ui/resource-list';
import { ScrollArea } from '../ui/scroll-area';
import { TableActions, stopRowSelection, useTrailingCellClass } from '../ui/table-actions';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { copyOutcomeIcon, useCopyLabel, type ClipboardCopy } from '../ui/use-copy-to-clipboard';

const {
  Button,
  DataGrid, DataGridBody, DataGridCell, DataGridHeader, DataGridHeaderCell, DataGridRow,
  List, ListItem, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, TableCellLayout, Text, Tooltip,
  createTableColumn, makeStyles,
} = fluentComponents;

const useStyles = makeStyles({
  // WinUI types accent text on the accent text ramp, not the accent fill a button takes.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L93
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L297
  accentText: { color: 'var(--winui-accent-text-fill-primary)' },
  // Only what ../../winui/controls/list.css.ts has no ListViewItem counterpart for:
  // a four-line row, and a divider separator rather than the card stroke, which is
  // black in both themes and disappears against a dark page.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L250
  mobileItem: {
    borderBottom: '1px solid var(--winui-divider-stroke-default)',
    paddingBlock: '10px',
  },
});

const RELATIVE_REFRESH_MS = 30_000;

export function KeysTable({
  clipboard, disabled, keys, onDelete, onEdit, onRotate, onSelect, selectedKeyId, upstreams,
}: {
  clipboard: ClipboardCopy; keys: ApiKey[];
  disabled: boolean; onDelete: (key: ApiKey) => void;
  onEdit: (key: ApiKey) => void; onRotate: (key: ApiKey) => void;
  onSelect: (id: string) => void; selectedKeyId: string; upstreams: UpstreamOption[];
}) {
  const { t } = useTranslation();
  const copyLabel = useCopyLabel();
  const s = useStyles();
  const dangerText = useDangerTextClass();
  const dangerClasses = useDangerActionClasses();
  const trailingCell = useTrailingCellClass();
  const narrow = useMediaQuery('(max-width: 760px)');
  const locale = useLocale();
  const now = useNow(RELATIVE_REFRESH_MS);
  const upstreamById = useMemo(
    () => new Map(upstreams.map(upstream => [upstream.id, upstream])),
    [upstreams],
  );

  // Griffel injects after the utilities and Fluent states its own `flex: 1 1 0`,
  // so each basis has to be important to reach the cell.
  const columnWidth: Partial<Record<string, string>> = {
    name: '!basis-[180px]',
    key: '!basis-[240px]',
    upstreams: '!grow-0 !basis-[120px]',
    created: '!grow-0 !basis-[132px]',
    lastUsed: '!grow-0 !basis-[148px]',
  };

  const columns = useMemo(
    () => [
      createTableColumn<ApiKey>({
        columnId: 'name', compare: (a, b) => a.name.localeCompare(b.name),
        renderHeaderCell: () => t('dashboard.apiKeys.table.name'),
        renderCell: key => <TableCellLayout truncate>{key.name}</TableCellLayout>,
      }),
      createTableColumn<ApiKey>({
        columnId: 'key', renderHeaderCell: () => t('dashboard.apiKeys.table.key'),
        renderCell: key => {
          const copyTag = `key-${key.id}`;
          return (
            <span className="flex items-center gap-1 min-w-0">
              <Tooltip content={key.key} relationship="label">
                <code className="w-[144px] flex-none truncate" tabIndex={0}>{key.key}</code>
              </Tooltip>
              <span className="flex-none" {...stopRowSelection}><TooltipIconButton
                disabled={disabled}
                icon={copyOutcomeIcon(clipboard.outcomeFor(copyTag))}
                label={copyLabel(clipboard.outcomeFor(copyTag), t('dashboard.apiKeys.actions.copy'))}
                onClick={() => clipboard.copy(key.key, copyTag)}
              /></span>
            </span>
          );
        },
      }),
      createTableColumn<ApiKey>({
        columnId: 'upstreams', renderHeaderCell: () => t('dashboard.apiKeys.table.upstreams'),
        renderCell: key => (
          <Tooltip content={upstreamsTitle(key, upstreamById, t)} relationship="description">
            <TableCellLayout
              truncate
              className={
                !key.upstream_ids ? undefined
                  : key.upstream_ids.length === 0 ? dangerText : s.accentText
              }
              tabIndex={0}
            >
              {upstreamsText(key, upstreamById, t)}
            </TableCellLayout>
          </Tooltip>
        ),
      }),
      createTableColumn<ApiKey>({
        columnId: 'created', compare: (a, b) => a.created_at.localeCompare(b.created_at),
        renderHeaderCell: () => t('dashboard.apiKeys.table.created'),
        renderCell: key => <Tooltip content={dateTime(key.created_at, locale)} relationship="description">
          <span tabIndex={0}>{shortDate(key.created_at, locale)}</span>
        </Tooltip>,
      }),
      createTableColumn<ApiKey>({
        columnId: 'lastUsed', compare: (a, b) => (a.last_used_at ?? '').localeCompare(b.last_used_at ?? ''),
        renderHeaderCell: () => t('dashboard.apiKeys.table.lastUsed'),
        renderCell: key => key.last_used_at
          ? <Tooltip content={dateTime(key.last_used_at, locale)} relationship="description">
              <span tabIndex={0}>
                {relativeTime(key.last_used_at, locale, { now }) ?? t('dashboard.apiKeys.table.usedOn', { date: shortDate(key.last_used_at, locale) })}
              </span>
            </Tooltip>
          : <span>{t('dashboard.apiKeys.table.never')}</span>,
      }),
      createTableColumn<ApiKey>({
        columnId: 'actions', renderHeaderCell: () => t('dashboard.apiKeys.table.actions'),
        renderCell: key => {
          return (
            <TableActions>
              <TooltipIconButton disabled={disabled} icon={<EditRegular />} label={t('dashboard.apiKeys.actions.edit')} onClick={() => onEdit(key)} />
              <TooltipIconButton disabled={disabled} icon={<ArrowClockwiseRegular />} label={t('dashboard.apiKeys.actions.rotate')} onClick={() => onRotate(key)} />
              <TooltipIconButton danger disabled={disabled} icon={<DeleteRegular />} label={t('dashboard.apiKeys.actions.delete')} onClick={() => onDelete(key)} />
            </TableActions>
          );
        },
      }),
    ],
    [clipboard, copyLabel, dangerText, disabled, locale, now, onDelete, onEdit, onRotate, s, t, upstreamById],
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
        ? relativeTime(key.last_used_at, locale, { now }) ?? t('dashboard.apiKeys.table.usedOn', { date: shortDate(key.last_used_at, locale) })
        : t('dashboard.apiKeys.table.never');
      return <ListItem checkmark={null} className={s.mobileItem} disabledSelection={disabled} key={key.id} value={key.id}>
        <div className="flex items-start gap-2 min-w-0 w-full">
          <div className="grid gap-0.5 min-w-0 flex-1">
            <Text truncate size={300} wrap={false}>{key.name}</Text>
            <Tooltip content={key.key} relationship="label">
              <code className="block truncate" tabIndex={0}>{key.key}</code>
            </Tooltip>
            <Tooltip content={upstreamsTitle(key, upstreamById, t)} relationship="description">
              <Text truncate size={200} className="text-fui-fg2" tabIndex={0} wrap={false}>{upstreamsText(key, upstreamById, t)}</Text>
            </Tooltip>
            <div className="flex flex-wrap gap-x-3 text-fui-fg3">
              <Text size={200}>{shortDate(key.created_at, locale)}</Text>
              <Text size={200}>{lastUsed}</Text>
            </div>
          </div>
          <span {...stopRowSelection}><Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button appearance="subtle" aria-label={t('dashboard.apiKeys.table.actions')} disabled={disabled} icon={<MoreHorizontalRegular />} />
            </MenuTrigger>
            <MenuPopover><MenuList>
              <MenuItem icon={copyOutcomeIcon(clipboard.outcomeFor(copyTag))} onClick={() => clipboard.copy(key.key, copyTag)}>{copyLabel(clipboard.outcomeFor(copyTag), t('dashboard.apiKeys.actions.copy'))}</MenuItem>
              <MenuItem icon={<EditRegular />} onClick={() => onEdit(key)}>{t('dashboard.apiKeys.actions.edit')}</MenuItem>
              <MenuItem icon={<ArrowClockwiseRegular />} onClick={() => onRotate(key)}>{t('dashboard.apiKeys.actions.rotate')}</MenuItem>
              <MenuItem className={dangerClasses.menuItem} icon={<DeleteRegular />} onClick={() => onDelete(key)}>{t('dashboard.apiKeys.actions.delete')}</MenuItem>
            </MenuList></MenuPopover>
          </Menu></span>
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
              <DataGridHeaderCell className={columnId === 'actions' ? trailingCell : columnWidth[columnId]}>
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
                  className={columnId === 'actions' ? trailingCell : columnWidth[columnId]}
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
