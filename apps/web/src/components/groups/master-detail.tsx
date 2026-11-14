import { DeleteRegular, DismissRegular, EditRegular, PersonAddRegular, SearchRegular } from '@fluentui/react-icons';
import { useState } from 'react';

import { GroupIdentity } from './identity';
import type { ControlPlaneGroup, ControlPlaneUser } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime, shortDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { ConfirmFlyout } from '../ui/confirm-flyout';
import { EmptyState } from '../ui/empty-state';
import { Input } from '../ui/fluent-form-controls';
import { Panel } from '../ui/panel';
import { ScrollArea } from '../ui/scroll-area';
import { TableActionsHeader } from '../ui/table-actions';
import { TableColumns } from '../ui/table-columns';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import type { DirectoryMember } from '../users/directory';
import { UserIdentity } from '../users/identity';

const { Button, List, ListItem, Popover, PopoverSurface, PopoverTrigger, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Tooltip, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  layout: {
    display: 'grid',
    gridTemplateColumns: 'minmax(220px, 280px) minmax(0, 1fr)',
    gap: 0,
    minHeight: '520px',
    alignItems: 'stretch',
    '@media (max-width: 760px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  navigation: {
    borderRight: '1px solid var(--winui-divider-stroke-default)',
    '@media (max-width: 760px)': { borderRightStyle: 'none', borderBottom: '1px solid var(--winui-divider-stroke-default)' },
  },
});

export function GroupsMasterDetail({ disabled, groups, membersByGroup, onCreate, onDelete, onEdit, onMemberChange, onSelect, selectedId, users }: {
  disabled: boolean;
  groups: ControlPlaneGroup[];
  membersByGroup: ReadonlyMap<number, readonly DirectoryMember[]>;
  onCreate: () => void;
  onDelete: (group: ControlPlaneGroup) => void;
  onEdit: (group: ControlPlaneGroup) => void;
  onMemberChange: (group: ControlPlaneGroup, user: ControlPlaneUser, included: boolean) => Promise<string | null>;
  onSelect: (id: number) => void;
  selectedId: number | null;
  users: ControlPlaneUser[];
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  if (groups.length === 0) return <Panel><EmptyState action={<Button disabled={disabled} onClick={onCreate}>{t('dashboard.groupsManagement.actions.create')}</Button>} title={t('dashboard.groupsManagement.empty')} /></Panel>;
  const selected = groups.find(group => group.id === selectedId) ?? groups[0]!;
  return <Panel className={mergeClasses(styles.layout, 'overflow-hidden')} padding="flush">
    <nav aria-label={t('dashboard.users.table.groups')} className={mergeClasses(styles.navigation, 'p-1.5 min-w-0')}>
      <List
        aria-label={t('dashboard.users.table.groups')}
        className="grid content-start gap-0.5"
        onSelectionChange={(_, data) => { const id = data.selectedItems[0]; if (typeof id === 'number') onSelect(id); }}
        selectedItems={[selected.id]}
        selectionMode="single"
      >{groups.map(group => <ListItem
          aria-label={group.name}
          checkmark={null}
          className="!flex items-center justify-between gap-2 min-w-0"
          key={group.id}
          value={group.id}
        >
          <GroupIdentity group={group} />
          <Text className="text-fui-fg2 flex-none proportional-nums" size={200}>{membersByGroup.get(group.id)!.length}</Text>
        </ListItem>)}
      </List>
    </nav>
    <GroupDetails disabled={disabled} group={selected} key={selected.id} members={membersByGroup.get(selected.id)!} onDelete={onDelete} onEdit={onEdit} onMemberChange={onMemberChange} users={users} />
  </Panel>;
}

function GroupDetails({ disabled, group: selected, members, onDelete, onEdit, onMemberChange, users }: Pick<Parameters<typeof GroupsMasterDetail>[0], 'disabled' | 'onDelete' | 'onEdit' | 'onMemberChange' | 'users'> & { group: ControlPlaneGroup; members: readonly DirectoryMember[] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const memberIds = new Set(members.map(member => member.user.id));
  return <section className="grid content-start min-w-0">
    <header className="flex items-center justify-between gap-3 flex-wrap px-[var(--floway-panel-inset)] py-3 border-b border-b-solid border-b-[var(--winui-divider-stroke-default)]">
      <div className="grid gap-0.5 min-w-0">
        <GroupIdentity group={selected} />
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <Text className="floway-control-label text-fui-fg2" size={200}>{t('dashboard.groupsManagement.members.count', { count: members.length })}</Text>
          <Tooltip content={dateTime(selected.createdAt, locale)} relationship="description">
            <Text className="winui-focus-rect floway-control-label text-fui-fg2" size={200} tabIndex={0} wrap={false}><time dateTime={selected.createdAt}>{t('dashboard.groupsManagement.createdAt', { date: shortDate(selected.createdAt, locale) })}</time></Text>
          </Tooltip>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-none">
        <AddMember disabled={disabled} group={selected} onAdd={user => onMemberChange(selected, user, true)} users={users.filter(user => !memberIds.has(user.id))} />
        <TooltipIconButton disabled={disabled} icon={<EditRegular />} label={t('dashboard.groupsManagement.actions.edit')} onClick={() => onEdit(selected)} />
        <TooltipIconButton danger disabled={disabled} icon={<DeleteRegular />} label={t('dashboard.groupsManagement.actions.delete')} onClick={() => onDelete(selected)} />
      </div>
    </header>
    {members.length === 0 ? <EmptyState title={t('dashboard.groupsManagement.members.empty')} /> : <ScrollArea axes="horizontal" className="min-w-0">
      <Table aria-label={t('dashboard.groupsManagement.fields.members')} className="min-w-[520px]" style={{ tableLayout: 'auto' }}>
        <TableColumns widths={[null, null, '56px']} />
        <TableHeader><TableRow>
          <TableHeaderCell className="!pl-[var(--floway-panel-inset)]">{t('dashboard.users.table.username')}</TableHeaderCell>
          <TableHeaderCell className="whitespace-nowrap">{t('dashboard.groupsManagement.members.joined')}</TableHeaderCell>
          <TableActionsHeader />
        </TableRow></TableHeader>
        <TableBody>{members.map(({ user, createdAt: joinedAt }) => <TableRow className="h-11" key={user.id}>
          <TableCell className="!pl-[var(--floway-panel-inset)]"><UserIdentity isAdmin={user.isAdmin} username={user.username} /></TableCell>
          <TableCell className="whitespace-nowrap tabular-nums"><Tooltip content={dateTime(joinedAt, locale)} relationship="description"><time className="winui-focus-rect floway-control-label whitespace-nowrap" dateTime={joinedAt} tabIndex={0}>{shortDate(joinedAt, locale)}</time></Tooltip></TableCell>
          <TableCell><ConfirmFlyout
            actionLabel={t('dashboard.groupsManagement.remove.confirm')}
            disabled={disabled}
            icon={<DismissRegular />}
            message={t('dashboard.groupsManagement.remove.message', { username: user.username, group: selected.name })}
            onConfirm={() => onMemberChange(selected, user, false)}
            title={t('dashboard.groupsManagement.remove.title')}
            triggerLabel={t('dashboard.groupsManagement.actions.remove', { username: user.username })}
          /></TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </ScrollArea>}
  </section>;
}

function AddMember({ disabled, group, onAdd, users }: {
  disabled: boolean;
  group: ControlPlaneGroup;
  onAdd: (user: ControlPlaneUser) => Promise<string | null>;
  users: ControlPlaneUser[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const visible = users.filter(user => user.username.toLowerCase().includes(query.trim().toLowerCase()));
  return <Popover onOpenChange={(_, data) => { setOpen(data.open); setQuery(''); }} open={open} positioning={{ position: 'below', align: 'end' }} trapFocus>
    <PopoverTrigger disableButtonEnhancement><Button disabled={disabled} icon={<PersonAddRegular />}>{t('dashboard.groupsManagement.actions.add')}</Button></PopoverTrigger>
    <PopoverSurface aria-label={group.name} className="w-[min(320px,calc(100vw-32px))] !p-2 grid gap-1">
      <Input aria-label={t('dashboard.users.search')} autoComplete="off" autoFocus contentBefore={<SearchRegular />} onChange={(_, data) => setQuery(data.value)} placeholder={t('dashboard.users.search')} spellCheck={false} value={query} />
      <ScrollArea axes="vertical" className="max-h-[260px]">
        {visible.length === 0 && <Text className="text-fui-fg2 px-2 py-2" role="status">{t(users.length === 0 ? 'dashboard.groupsManagement.members.allAdded' : 'dashboard.groupsManagement.members.noMatches')}</Text>}
        <List aria-label={t('dashboard.groupsManagement.fields.members')} navigationMode="items">
          {visible.map(user => <ListItem aria-description={user.isAdmin ? t('dashboard.users.role.admin') : undefined} aria-label={user.username} aria-disabled={disabled} key={user.id} onAction={() => { if (!disabled) { setOpen(false); void onAdd(user); } }} value={user.id}><UserIdentity isAdmin={user.isAdmin} username={user.username} /></ListItem>)}
        </List>
      </ScrollArea>
    </PopoverSurface>
  </Popover>;
}
