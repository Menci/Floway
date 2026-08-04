import { ArrowClockwiseRegular, DeleteRegular, EditRegular, MoreHorizontalRegular } from '@fluentui/react-icons';
import { useMemo } from 'react';

import type { ApiKey, UpstreamOption } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { type TFunction, useTranslation } from '../../i18n/translation';
import { dateTime, relativeTime, shortDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useMediaQuery } from '../../lib/use-media-query';
import { useNow } from '../../lib/use-now';
import { useDangerActionClasses, useDangerTextClass } from '../ui/danger';
import { ResourceListEmptyState } from '../ui/resource-list';
import { ScrollArea } from '../ui/scroll-area';
import { TABLE_ACTIONS_WIDTH, TableActions, TableTrailingHeader, stopRowSelection } from '../ui/table-actions';
import { TableColumns } from '../ui/table-columns';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { TruncationTooltip } from '../ui/truncation-tooltip';
import { copyOutcomeIcon, useCopyLabel, type ClipboardCopy } from '../ui/use-copy-to-clipboard';

const {
  Button, List, ListItem, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger,
  Table, TableBody, TableCell, TableCellLayout, TableHeader, TableHeaderCell, TableRow, TableSelectionCell,
  Text, Tooltip,
  createTableColumn, makeStyles, useArrowNavigationGroup, useTableFeatures, useTableSelection, useTableSort,
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
  const narrow = useMediaQuery('(max-width: 760px)');
  const locale = useLocale();
  const now = useNow(RELATIVE_REFRESH_MS);
  const upstreamById = useMemo(
    () => new Map(upstreams.map(upstream => [upstream.id, upstream])),
    [upstreams],
  );

  // Only sorting needs a column definition; the cells themselves are written
  // out below, the way every other table on the dashboard writes them.
  const columns = useMemo(() => [
    createTableColumn<ApiKey>({ columnId: 'name', compare: (a, b) => a.name.localeCompare(b.name) }),
    createTableColumn<ApiKey>({ columnId: 'created', compare: (a, b) => a.created_at.localeCompare(b.created_at) }),
    createTableColumn<ApiKey>({ columnId: 'lastUsed', compare: (a, b) => (a.last_used_at ?? '').localeCompare(b.last_used_at ?? '') }),
  ], []);

  // One rule for both branches: the table and the narrow list each report a
  // selection in their own shape, and only this decides what a selection means.
  const selectRow = (id: unknown) => {
    if (disabled || typeof id !== 'string') return;
    onSelect(id);
  };
  const selectedItems = selectedKeyId === '' ? [] : [selectedKeyId];

  const { getRows, selection, sort } = useTableFeatures(
    { columns, getRowId: key => key.id, items: keys },
    [
      useTableSelection({
        onSelectionChange: (_, data) => selectRow([...data.selectedItems][0]),
        selectedItems,
        selectionMode: 'single',
      }),
      useTableSort({}),
    ],
  );
  const gridNavigation = useArrowNavigationGroup({ axis: 'grid' });

  if (keys.length === 0) {
    return <ResourceListEmptyState>{t('dashboard.apiKeys.empty')}</ResourceListEmptyState>;
  }

  if (narrow) return <List
    aria-label={t('dashboard.apiKeys.table.title')}
    onSelectionChange={(_, data) => selectRow(data.selectedItems[0])}
    selectedItems={selectedItems}
    selectionMode="single"
  >
    {/* The same rows in the same order as the wide table: the sort a column
        header set is state of this component, so crossing the breakpoint is a
        change of presentation and not of what is being presented. */}
    {sort.sort(getRows()).map(({ item: key }) => {
      const copyTag = `key-${key.id}`;
      // No column heads the list, so a date too far back for a relative phrase
      // has to name itself: beside the created date, two bare dates read alike.
      const lastUsed = key.last_used_at
        ? relativeTime(key.last_used_at, locale, { now }) ?? t('dashboard.apiKeys.table.usedOn', { date: shortDate(key.last_used_at, locale) })
        : t('dashboard.apiKeys.table.never');
      return <ListItem checkmark={null} className={s.mobileItem} disabledSelection={disabled} key={key.id} value={key.id}>
        <div className="flex items-start gap-2 min-w-0 w-full">
          <div className="grid gap-0.5 min-w-0 flex-1">
            <Text block truncate size={300} wrap={false}>{key.name}</Text>
            <TruncationTooltip content={key.key} relationship="label">
              {measureRef => <code className="winui-focus-rect block truncate" ref={measureRef} tabIndex={0}>{key.key}</code>}
            </TruncationTooltip>
            <Tooltip content={upstreamsTitle(key, upstreamById, t)} relationship="description">
              <Text block truncate size={200} className="winui-focus-rect text-fui-fg2" tabIndex={0} wrap={false}>{upstreamsText(key, upstreamById, t)}</Text>
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
      <Table
        {...gridNavigation}
        aria-label={t('dashboard.apiKeys.table.title')}
        className="min-w-[960px]"
        role="grid"
      >
        <TableColumns widths={[null, null, '200px', '120px', '132px', '148px', TABLE_ACTIONS_WIDTH]} />
        <TableHeader>
          <TableRow>
            <TableSelectionCell
              aria-label={t('dashboard.apiKeys.table.select')}
              checked={false}
              invisible
              radioIndicator={null}
              type="radio"
            />
            <TableHeaderCell onClick={event => sort.toggleColumnSort(event, 'name')} sortDirection={sort.getSortDirection('name')} sortable>
              {t('dashboard.apiKeys.table.name')}
            </TableHeaderCell>
            <TableHeaderCell>{t('dashboard.apiKeys.table.key')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.apiKeys.table.upstreams')}</TableHeaderCell>
            <TableHeaderCell onClick={event => sort.toggleColumnSort(event, 'created')} sortDirection={sort.getSortDirection('created')} sortable>
              {t('dashboard.apiKeys.table.created')}
            </TableHeaderCell>
            <TableHeaderCell onClick={event => sort.toggleColumnSort(event, 'lastUsed')} sortDirection={sort.getSortDirection('lastUsed')} sortable>
              {t('dashboard.apiKeys.table.lastUsed')}
            </TableHeaderCell>
            <TableTrailingHeader>{t('dashboard.apiKeys.table.actions')}</TableTrailingHeader>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sort.sort(getRows()).map(({ item: key }) => {
            const copyTag = `key-${key.id}`;
            const selected = selection.isRowSelected(key.id);
            return <TableRow
              aria-selected={selected}
              key={key.id}
              onClick={event => { if (!disabled) selection.toggleRow(event, key.id); }}
              // The row is what the space bar reaches only while the row itself
              // holds focus; inside a cell the key belongs to the control there.
              onKeyDown={event => {
                if (disabled || event.key !== ' ' || event.target !== event.currentTarget) return;
                event.preventDefault();
                selection.toggleRow(event, key.id);
              }}
              tabIndex={0}
            >
              <TableSelectionCell
                checked={selected}
                radioIndicator={{ 'aria-label': t('dashboard.apiKeys.table.selectNamed', { name: key.name }) }}
                type="radio"
              />
              <TableCell className="overflow-hidden"><TableCellLayout truncate>{key.name}</TableCellLayout></TableCell>
              <TableCell className="overflow-hidden">
                <span className="flex items-center gap-1 min-w-0">
                  <TruncationTooltip content={key.key} relationship="label">
                    {measureRef => <code className="winui-focus-rect w-[144px] flex-none truncate" ref={measureRef} tabIndex={0}>{key.key}</code>}
                  </TruncationTooltip>
                  <span className="flex-none" {...stopRowSelection}><TooltipIconButton
                    disabled={disabled}
                    icon={copyOutcomeIcon(clipboard.outcomeFor(copyTag))}
                    label={copyLabel(clipboard.outcomeFor(copyTag), t('dashboard.apiKeys.actions.copy'))}
                    onClick={() => clipboard.copy(key.key, copyTag)}
                  /></span>
                </span>
              </TableCell>
              <TableCell className="overflow-hidden">
                <Tooltip content={upstreamsTitle(key, upstreamById, t)} relationship="description">
                  <TableCellLayout
                    truncate
                    className={`winui-focus-rect ${
                      !key.upstream_ids ? ''
                        : key.upstream_ids.length === 0 ? dangerText : s.accentText
                    }`}
                    tabIndex={0}
                  >
                    {upstreamsText(key, upstreamById, t)}
                  </TableCellLayout>
                </Tooltip>
              </TableCell>
              <TableCell>
                <Tooltip content={dateTime(key.created_at, locale)} relationship="description">
                  <span className="winui-focus-rect" tabIndex={0}>{shortDate(key.created_at, locale)}</span>
                </Tooltip>
              </TableCell>
              <TableCell>
                {key.last_used_at
                  ? <Tooltip content={dateTime(key.last_used_at, locale)} relationship="description">
                      <span className="winui-focus-rect" tabIndex={0}>
                        {relativeTime(key.last_used_at, locale, { now }) ?? shortDate(key.last_used_at, locale)}
                      </span>
                    </Tooltip>
                  : <span>{t('dashboard.apiKeys.table.never')}</span>}
              </TableCell>
              <TableCell>
                <TableActions>
                  <TooltipIconButton disabled={disabled} icon={<EditRegular />} label={t('dashboard.apiKeys.actions.editNamed', { name: key.name })} onClick={() => onEdit(key)} />
                  <TooltipIconButton disabled={disabled} icon={<ArrowClockwiseRegular />} label={t('dashboard.apiKeys.actions.rotateNamed', { name: key.name })} onClick={() => onRotate(key)} />
                  <TooltipIconButton danger disabled={disabled} icon={<DeleteRegular />} label={t('dashboard.apiKeys.actions.deleteNamed', { name: key.name })} onClick={() => onDelete(key)} />
                </TableActions>
              </TableCell>
            </TableRow>;
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

const upstreamsText = (
  key: ApiKey,
  upstreamById: Map<string, UpstreamOption>,
  t: TFunction,
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
  t: TFunction,
) => {
  if (!key.upstream_ids) return t('dashboard.apiKeys.upstreams.inheritsTitle');
  if (key.upstream_ids.length === 0) return t('dashboard.apiKeys.upstreams.none');
  return key.upstream_ids.map(id => upstreamById.get(id)?.name ?? id).join('\n');
};
