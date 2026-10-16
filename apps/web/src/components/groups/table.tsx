import { DeleteRegular, EditRegular } from '@fluentui/react-icons';

import type { ControlPlaneGroup } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime, shortDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { ResourceListEmptyState } from '../ui/resource-list';
import { ScrollArea } from '../ui/scroll-area';
import { TABLE_ACTIONS_WIDTH, TableActions, TableTrailingHeader } from '../ui/table-actions';
import { TableColumns } from '../ui/table-columns';
import { TooltipIconButton } from '../ui/tooltip-icon-button';

const { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Tooltip } = fluentComponents;

export function GroupsTable({ disabled, groups, onDelete, onEdit }: {
  disabled: boolean;
  groups: ControlPlaneGroup[];
  onDelete: (group: ControlPlaneGroup) => void;
  onEdit: (group: ControlPlaneGroup) => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  if (groups.length === 0) return <ResourceListEmptyState>{t('dashboard.groupsManagement.empty')}</ResourceListEmptyState>;
  return <ScrollArea axes="horizontal" className="min-w-0"><Table aria-label={t('dashboard.groupsManagement.table.label')} className="min-w-[560px]">
    <TableColumns widths={[null, null, null, TABLE_ACTIONS_WIDTH]} />
    <TableHeader><TableRow>
      <TableHeaderCell>{t('dashboard.groupsManagement.table.name')}</TableHeaderCell>
      <TableHeaderCell>{t('dashboard.groupsManagement.table.members')}</TableHeaderCell>
      <TableHeaderCell>{t('dashboard.groupsManagement.table.created')}</TableHeaderCell>
      <TableTrailingHeader>{t('dashboard.groupsManagement.table.actions')}</TableTrailingHeader>
    </TableRow></TableHeader>
    <TableBody>{groups.map(group => <TableRow key={group.id}>
      <TableCell>{group.name}</TableCell>
      <TableCell>{t('dashboard.groupsManagement.members.count', { count: group.memberIds.length })}</TableCell>
      <TableCell><Tooltip content={dateTime(group.createdAt, locale)} relationship="description"><span className="winui-focus-rect" tabIndex={0}>{shortDate(group.createdAt, locale)}</span></Tooltip></TableCell>
      <TableCell><TableActions>
        <TooltipIconButton disabled={disabled} icon={<EditRegular />} label={t('dashboard.groupsManagement.actions.edit')} onClick={() => onEdit(group)} />
        <TooltipIconButton danger disabled={disabled} icon={<DeleteRegular />} label={t('dashboard.groupsManagement.actions.delete')} onClick={() => onDelete(group)} />
      </TableActions></TableCell>
    </TableRow>)}</TableBody>
  </Table></ScrollArea>;
}
