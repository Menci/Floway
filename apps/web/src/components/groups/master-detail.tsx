import { DeleteRegular, DismissRegular, EditRegular, PersonAddRegular, SearchRegular } from '@fluentui/react-icons';
import { useState } from 'react';

import { GroupBadge } from './badge';
import type { ControlPlaneGroup, ControlPlaneUser } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { EmptyState } from '../ui/empty-state';
import { Input } from '../ui/fluent-form-controls';
import { Panel } from '../ui/panel';
import { ScrollArea } from '../ui/scroll-area';
import { StatusBadge } from '../ui/status-badge';
import { TableColumns } from '../ui/table-columns';
import { TooltipIconButton } from '../ui/tooltip-icon-button';

const { Avatar, Button, Popover, PopoverSurface, PopoverTrigger, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles, mergeClasses } = fluentComponents;

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

export function GroupsMasterDetail({ disabled, groups, onCreate, onDelete, onEdit, onMemberChange, onSelect, selectedId, users }: {
  disabled: boolean;
  groups: ControlPlaneGroup[];
  onCreate: () => void;
  onDelete: (group: ControlPlaneGroup) => void;
  onEdit: (group: ControlPlaneGroup) => void;
  onMemberChange: (group: ControlPlaneGroup, user: ControlPlaneUser, included: boolean) => Promise<void>;
  onSelect: (id: number) => void;
  selectedId: number | null;
  users: ControlPlaneUser[];
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  if (groups.length === 0) return <Panel><EmptyState action={<Button disabled={disabled} onClick={onCreate}>{t('dashboard.groupsManagement.actions.create')}</Button>} title={t('dashboard.groupsManagement.empty')} /></Panel>;
  const selected = groups.find(group => group.id === selectedId) ?? groups[0]!;
  const members = new Set(selected.memberIds);
  return <Panel className={mergeClasses(styles.layout, 'overflow-hidden')} padding="flush">
    <nav aria-label={t('dashboard.users.table.groups')} className={mergeClasses(styles.navigation, 'p-1.5 grid content-start gap-0.5 min-w-0')}>
      {groups.map(group => {
        const active = group.id === selected.id;
        return <button
          aria-current={active ? 'true' : undefined}
          className={`winui-focus-rect relative flex items-center justify-between gap-2 min-w-0 h-10 px-3 rounded-[var(--winui-control-corner-radius)] border-0 cursor-pointer text-left text-fui-fg1 ${active ? 'bg-[var(--winui-subtle-fill-secondary)]' : 'bg-transparent hover:bg-[var(--winui-subtle-fill-secondary)]'}`}
          key={group.id}
          onClick={() => onSelect(group.id)}
          type="button"
        >
          {active && <span aria-hidden className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[3px] rounded-full bg-[var(--winui-accent-fill-default)]" />}
          <span className="min-w-0 inline-flex"><GroupBadge group={group} /></span>
          <Text className="text-fui-fg2 flex-none tabular-nums" size={200}>{group.memberIds.length}</Text>
        </button>;
      })}
    </nav>
    <section className="grid content-start min-w-0">
      <header className="flex items-center justify-between gap-3 flex-wrap px-[var(--floway-panel-inset)] py-3 border-b border-b-solid border-b-[var(--winui-divider-stroke-default)]">
        <div className="grid gap-0.5 min-w-0">
          <Text className="break-words" size={400} weight="semibold">{selected.name}</Text>
          <Text className="text-fui-fg2" size={200}>{t('dashboard.groupsManagement.members.count', { count: selected.memberIds.length })}</Text>
        </div>
        <div className="flex items-center gap-1 flex-none">
          <AddMember disabled={disabled} group={selected} key={selected.id} onAdd={user => onMemberChange(selected, user, true)} users={users.filter(user => !members.has(user.id))} />
          <TooltipIconButton disabled={disabled} icon={<EditRegular />} label={t('dashboard.groupsManagement.actions.edit')} onClick={() => onEdit(selected)} />
          <TooltipIconButton danger disabled={disabled} icon={<DeleteRegular />} label={t('dashboard.groupsManagement.actions.delete')} onClick={() => onDelete(selected)} />
        </div>
      </header>
      {members.size === 0 ? <EmptyState title={t('dashboard.groupsManagement.members.empty')} /> : <ScrollArea axes="horizontal" className="min-w-0">
        <Table aria-label={t('dashboard.groupsManagement.fields.members')} className="min-w-[520px]">
          <TableColumns widths={[null, '120px', '120px', '56px']} />
          <TableHeader><TableRow>
            <TableHeaderCell className="!pl-[var(--floway-panel-inset)]">{t('dashboard.users.table.username')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.role')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.users.table.upstreams')}</TableHeaderCell>
            <TableHeaderCell><span className="sr-only">{t('dashboard.users.table.actions')}</span></TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>{users.filter(user => members.has(user.id)).map(user => <TableRow className="h-11" key={user.id}>
            <TableCell className="!pl-[var(--floway-panel-inset)]"><UserIdentity user={user} /></TableCell>
            <TableCell><StatusBadge tone={user.isAdmin ? 'accent' : 'neutral'}>{t(`dashboard.users.role.${user.isAdmin ? 'admin' : 'operator'}`)}</StatusBadge></TableCell>
            <TableCell>{user.upstreamIds === null ? t('dashboard.users.upstreams.all') : t('dashboard.users.upstreams.count', { count: user.upstreamIds.length })}</TableCell>
            <TableCell><TooltipIconButton disabled={disabled} icon={<DismissRegular />} label={t('dashboard.groupsManagement.actions.remove', { username: user.username })} onClick={() => void onMemberChange(selected, user, false)} /></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </ScrollArea>}
    </section>
  </Panel>;
}

export function UserIdentity({ user }: { user: ControlPlaneUser }) {
  return <div className="flex items-center gap-2 min-w-0">
    <Avatar color="colorful" idForColor={user.username} name={user.username} size={24} />
    <span className="truncate">{user.username}</span>
  </div>;
}

function AddMember({ disabled, group, onAdd, users }: {
  disabled: boolean;
  group: ControlPlaneGroup;
  onAdd: (user: ControlPlaneUser) => Promise<void>;
  users: ControlPlaneUser[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const visible = users.filter(user => user.username.toLowerCase().includes(query.trim().toLowerCase()));
  return <Popover onOpenChange={(_, data) => { setOpen(data.open); setQuery(''); }} open={open} positioning={{ position: 'below', align: 'end' }} trapFocus>
    <PopoverTrigger disableButtonEnhancement><Button disabled={disabled} icon={<PersonAddRegular />}>{t('dashboard.groupsManagement.actions.add')}</Button></PopoverTrigger>
    <PopoverSurface aria-label={group.name} className="w-[min(320px,calc(100vw-32px))] !p-2 grid gap-1">
      <Input aria-label={t('dashboard.users.search')} autoFocus contentBefore={<SearchRegular />} onChange={(_, data) => setQuery(data.value)} placeholder={t('dashboard.users.search')} value={query} />
      <div className="grid max-h-[260px] overflow-auto">
        {visible.length === 0 && <Text className="text-fui-fg2 px-2 py-2" role="status">{t(users.length === 0 ? 'dashboard.groupsManagement.members.allAdded' : 'dashboard.groupsManagement.members.noMatches')}</Text>}
        {visible.map(user => <Button appearance="subtle" className="!justify-start" disabled={disabled} key={user.id} onClick={() => { setOpen(false); void onAdd(user); }}><UserIdentity user={user} /></Button>)}
      </div>
    </PopoverSurface>
  </Popover>;
}
