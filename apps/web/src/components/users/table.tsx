import { DeleteRegular, EditRegular, KeyRegular } from '@fluentui/react-icons';

import type { ControlPlaneUser } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime, shortDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
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
  Tooltip,
} = fluentComponents;

export function UsersTable({
  actorId,
  disabled,
  onDelete,
  onEdit,
  onResetPassword,
  users,
}: {
  actorId: number;
  disabled: boolean;
  onDelete: (user: ControlPlaneUser) => void;
  onEdit: (user: ControlPlaneUser) => void;
  onResetPassword: (user: ControlPlaneUser) => void;
  users: ControlPlaneUser[];
}) {
  const { t } = useTranslation();
  const locale = useLocale();

  if (users.length === 0) {
    return <ResourceListEmptyState>{t('dashboard.users.empty')}</ResourceListEmptyState>;
  }

  return (
    <ScrollArea axes="horizontal" className="min-w-0">
      <Table aria-label={t('dashboard.users.table.label')} className="min-w-[720px]">
        <TableColumns widths={[null, null, null, null, TABLE_ACTIONS_WIDTH]} />
        <TableHeader>
          <TableRow>
            <TableHeaderCell>{t('dashboard.users.table.username')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.role')}</TableHeaderCell>
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
                {/* The one name column that wraps instead of trimming: a
                    username has no second line to reveal it and no tooltip, so
                    the row grows to hold it. */}
                <TableCell>{user.username}</TableCell>
                <TableCell>
                  <StatusBadge tone={user.isAdmin ? 'accent' : 'neutral'}>
                    {t(`dashboard.users.role.${user.isAdmin ? 'admin' : 'operator'}`)}
                  </StatusBadge>
                </TableCell>
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
