import { DeleteRegular, EditRegular, KeyRegular } from '@fluentui/react-icons';

import { UserIdentity } from './identity';
import type { ControlPlaneGroup, ControlPlaneUser } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime, shortDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { GroupMemberships } from '../groups/memberships';
import { ResourceListEmptyState } from '../ui/resource-list';
import { ScrollArea } from '../ui/scroll-area';
import { TABLE_ACTIONS_WIDTH, TableActions, TableActionsHeader } from '../ui/table-actions';
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
} = fluentComponents;

export function UsersTable({
  actorId,
  disabled,
  onDelete,
  onEdit,
  onResetPassword,
  users,
  groupsByUser,
}: {
  actorId: number;
  disabled: boolean;
  onDelete: (user: ControlPlaneUser) => void;
  onEdit: (user: ControlPlaneUser) => void;
  onResetPassword: (user: ControlPlaneUser) => void;
  users: ControlPlaneUser[];
  groupsByUser: ReadonlyMap<number, readonly ControlPlaneGroup[]>;
}) {
  const { t } = useTranslation();
  const locale = useLocale();

  if (users.length === 0) {
    return <ResourceListEmptyState>{t('dashboard.users.empty')}</ResourceListEmptyState>;
  }

  return (
    <ScrollArea axes="horizontal" className="min-w-0">
      <Table aria-label={t('dashboard.users.table.label')} className="min-w-[820px]" style={{ tableLayout: 'auto' }}>
        <TableColumns widths={['22%', null, '50%', TABLE_ACTIONS_WIDTH]} />
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('dashboard.users.table.username')}</TableHeaderCell>
            <TableHeaderCell className="whitespace-nowrap">{t('dashboard.users.table.created')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.groups')}</TableHeaderCell>
            <TableActionsHeader />
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map(user => {
            const protectedUser = user.id === 1 || user.id === actorId;
            return (
              <TableRow key={user.id}>
                <TableCell><button aria-description={user.isAdmin ? t('dashboard.users.role.admin') : undefined} aria-label={user.username} className="winui-focus-rect floway-identity-action" disabled={disabled} onClick={() => onEdit(user)} type="button"><UserIdentity isAdmin={user.isAdmin} username={user.username} /></button></TableCell>
                <TableCell className="whitespace-nowrap">
                  <Tooltip content={dateTime(user.createdAt, locale)} relationship="description">
                    <time className="winui-focus-rect floway-control-label whitespace-nowrap" dateTime={user.createdAt} tabIndex={0}>{shortDate(user.createdAt, locale)}</time>
                  </Tooltip>
                </TableCell>
                <TableCell><GroupMemberships groups={groupsByUser.get(user.id)!} /></TableCell>
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
