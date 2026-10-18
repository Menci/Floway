import { DeleteRegular, EditRegular, KeyRegular } from '@fluentui/react-icons';

import { UserIdentity } from './identity';
import type { ControlPlaneGroup, ControlPlaneUser } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { GroupMemberships } from '../groups/memberships';
import { ResourceListEmptyState } from '../ui/resource-list';
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

  if (users.length === 0) {
    return <ResourceListEmptyState>{t('dashboard.users.empty')}</ResourceListEmptyState>;
  }

  return (
    <ScrollArea axes="horizontal" className="min-w-0">
      <Table aria-label={t('dashboard.users.table.label')} className="min-w-[820px]" style={{ tableLayout: 'auto' }}>
        <TableColumns widths={['22%', null, '40%', null, TABLE_ACTIONS_WIDTH]} />
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('dashboard.users.table.username')}</TableHeaderCell>
            <TableHeaderCell className="whitespace-nowrap">{t('dashboard.users.table.role')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.groups')}</TableHeaderCell>
            <TableHeaderCell className="whitespace-nowrap">{t('dashboard.users.table.upstreams')}</TableHeaderCell>
            <TableTrailingHeader><span className="sr-only">{t('dashboard.users.table.actions')}</span></TableTrailingHeader>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map(user => {
            const protectedUser = user.id === 1 || user.id === actorId;
            return (
              <TableRow key={user.id}>
                <TableCell><button className="winui-focus-rect floway-identity-action" disabled={disabled} onClick={() => onEdit(user)} type="button"><UserIdentity username={user.username} /></button></TableCell>
                <TableCell className="whitespace-nowrap">
                  <StatusBadge tone={user.isAdmin ? 'accent' : 'neutral'}>
                    {t(`dashboard.users.role.${user.isAdmin ? 'admin' : 'operator'}`)}
                  </StatusBadge>
                </TableCell>
                <TableCell><GroupMemberships groups={user.groupIds.map(id => groups.find(group => group.id === id)!)} /></TableCell>
                <TableCell className="whitespace-nowrap">
                  {user.upstreamIds === null
                    ? t('dashboard.users.upstreams.all')
                    : t('dashboard.users.upstreams.count', { count: user.upstreamIds.length })}
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
