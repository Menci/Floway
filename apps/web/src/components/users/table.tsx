import { DeleteRegular, EditRegular, KeyRegular } from '@fluentui/react-icons';

import type { ControlPlaneGroup, ControlPlaneUser } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime, shortDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { GroupBadge } from '../groups/badge';
import { Chip } from '../ui/chip';
import { ResourceListEmptyState } from '../ui/resource-list';
import { RowTitleButton } from '../ui/row-title';
import { ScrollArea } from '../ui/scroll-area';
import { StatusBadge } from '../ui/status-badge';
import { TABLE_ACTIONS_WIDTH, TableActions, TableTrailingHeader } from '../ui/table-actions';
import { TableColumns } from '../ui/table-columns';
import { TooltipIconButton } from '../ui/tooltip-icon-button';

const {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Tooltip,
  Avatar,
} = fluentComponents;

export function UsersTable({
  actorId,
  disabled,
  onDelete,
  onEdit,
  onResetPassword,
  users,
  groups,
}: {
  actorId: number;
  disabled: boolean;
  onDelete: (user: ControlPlaneUser) => void;
  onEdit: (user: ControlPlaneUser) => void;
  onResetPassword: (user: ControlPlaneUser) => void;
  users: ControlPlaneUser[];
  groups: ControlPlaneGroup[];
}) {
  const { t } = useTranslation();
  const locale = useLocale();

  if (users.length === 0) {
    return <ResourceListEmptyState>{t('dashboard.users.empty')}</ResourceListEmptyState>;
  }

  return (
    <ScrollArea axes="horizontal" className="min-w-0">
      <Table aria-label={t('dashboard.users.table.label')} className="min-w-[820px]">
        <TableColumns widths={['22%', '120px', null, '120px', '120px', TABLE_ACTIONS_WIDTH]} />
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('dashboard.users.table.username')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.role')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.groups')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.upstreams')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.created')}</TableHeaderCell>
            <TableTrailingHeader>{t('dashboard.users.table.actions')}</TableTrailingHeader>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map(user => {
            const protectedUser = user.id === 1 || user.id === actorId;
            return (
              <TableRow key={user.id}>
                <TableCell><div className="flex items-center gap-2 min-w-0">
                  <Avatar color="colorful" idForColor={user.username} name={user.username} size={24} />
                  <Tooltip content={user.username} relationship="label"><RowTitleButton onClick={() => onEdit(user)}>{user.username}</RowTitleButton></Tooltip>
                </div></TableCell>
                <TableCell>
                  <StatusBadge tone={user.isAdmin ? 'accent' : 'neutral'}>
                    {t(`dashboard.users.role.${user.isAdmin ? 'admin' : 'operator'}`)}
                  </StatusBadge>
                </TableCell>
                <TableCell><div className="flex items-center gap-1 min-w-0">
                  {user.groupIds.length === 0 && <span className="text-fui-fg3">{'\u2014'}</span>}
                  {user.groupIds.slice(0, 2).map(id => <span className="min-w-0 max-w-[160px] inline-flex" key={id}><GroupBadge group={groups.find(group => group.id === id)!} /></span>)}
                  {user.groupIds.length > 2 && <Tooltip content={groups.filter(group => user.groupIds.slice(2).includes(group.id)).map(group => group.name).join('\n')} relationship="description"><Chip className="winui-focus-rect flex-none" tabIndex={0}>{`+${user.groupIds.length - 2}`}</Chip></Tooltip>}
                </div></TableCell>
                <TableCell>
                  {user.upstreamIds === null
                    ? t('dashboard.users.upstreams.all')
                    : t('dashboard.users.upstreams.count', { count: user.upstreamIds.length })}
                </TableCell>
                <TableCell>
                  <Tooltip content={dateTime(user.createdAt, locale)} relationship="description">
                    <span className="winui-focus-rect" tabIndex={0}>
                      {shortDate(user.createdAt, locale)}
                    </span>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <TableActions>
                    <TooltipIconButton
                      disabled={disabled}
                      icon={<EditRegular />}
                      label={t('dashboard.users.actions.editNamed', { name: user.username })}
                      onClick={() => onEdit(user)}
                    />
                    <TooltipIconButton
                      disabled={disabled}
                      icon={<KeyRegular />}
                      label={t('dashboard.users.actions.resetPasswordNamed', { name: user.username })}
                      onClick={() => onResetPassword(user)}
                    />
                    <TooltipIconButton
                      danger
                      disabled={disabled || protectedUser}
                      icon={<DeleteRegular />}
                      label={t('dashboard.users.actions.deleteNamed', { name: user.username })}
                      onClick={() => onDelete(user)}
                    />
                  </TableActions>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}
