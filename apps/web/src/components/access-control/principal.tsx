import type { SlotRenderFunction } from '@fluentui/react-components';
import { PeopleRegular, PersonRegular } from '@fluentui/react-icons';
import { useRef, useState } from 'react';
import type { ComponentProps } from 'react';

import { parsePrincipal, principalKey, principalName } from './principals';
import type { ScopeExpressionData } from './scope-expression';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { GroupAvatar, GroupIdentity } from '../groups/identity';
import { Combobox } from '../ui/fluent-form-controls';
import { UserAvatar } from '../users/avatar';
import { UserIdentity } from '../users/identity';
import type { AccessPrincipal } from '@floway-dev/gateway/browser';

const { Option, OptionGroup } = fluentComponents;

export function PrincipalIdentity({ data, principal }: { data: ScopeExpressionData; principal: AccessPrincipal }) {
  const { t } = useTranslation();
  if (principal.kind === 'group') {
    const group = data.groups.find(group => group.id === principal.id);
    return group ? <GroupIdentity group={group} /> : <span className="floway-identity text-fui-fg2"><PeopleRegular />{t('dashboard.accessControl.scope.unknown', { id: String(principal.id) })}</span>;
  }
  const user = data.users.find(user => user.id === principal.id);
  return user ? <UserIdentity isAdmin={user.isAdmin} username={user.username} /> : <span className="floway-identity text-fui-fg2"><PersonRegular />{t('dashboard.accessControl.scope.unknown', { id: String(principal.id) })}</span>;
}

export function PrincipalPicker({ clearable = false, data, disabled = false, includeAll = false, label, onChange, value }: {
  clearable?: boolean;
  data: ScopeExpressionData;
  disabled?: boolean;
  includeAll?: boolean;
  label: string;
  onChange: (value: AccessPrincipal | null) => void;
  value: AccessPrincipal | null;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const needle = (query ?? '').trim().toLowerCase();
  const users = data.users.filter(user => user.username.toLowerCase().includes(needle));
  const groups = data.groups.filter(group => group.name.toLowerCase().includes(needle));
  const selected = value === null ? 'all' : principalKey(value);
  const present = value === null || (value.kind === 'user' ? data.users.some(user => user.id === value.id) : data.groups.some(group => group.id === value.id));
  const selectedLabel = value === null ? includeAll ? t('dashboard.accessControl.filters.allPrincipals') : ''
    : present ? principalName(value, data) : t('dashboard.accessControl.scope.unknown', { id: String(value.id) });
  const selectedGroup = value?.kind === 'group' ? data.groups.find(group => group.id === value.id) : undefined;
  const selectedUser = value?.kind === 'user' ? data.users.find(user => user.id === value.id) : undefined;
  const selectedAvatar = selectedGroup ? <GroupAvatar group={selectedGroup} /> : selectedUser ? <UserAvatar username={selectedUser.username} /> : null;
  const renderRoot: SlotRenderFunction<ComponentProps<'div'>> = (Component, props) => <Component {...props}>
    {value !== null && present && <span aria-hidden className="floway-principal-picker-avatar">{selectedAvatar}</span>}
    {props.children}
  </Component>;
  return <Combobox
    aria-label={label}
    autoComplete="off"
    className="w-full floway-principal-picker"
    clearAction={clearable && value !== null ? {
      label: t('dashboard.accessControl.filters.clearPrincipal'),
      onClear: () => { onChange(null); setQuery(null); setOpen(false); inputRef.current?.focus(); },
    } : undefined}
    disabled={disabled}
    emptyMessage={t('dashboard.accessControl.filters.noPrincipals')}
    listWidth="content"
    onChange={event => { setQuery(event.target.value); setOpen(true); }}
    onOpenChange={(_, event) => { setOpen(event.open); if (!event.open) setQuery(null); }}
    onOptionSelect={(_, event) => {
      if (!event.optionValue) return;
      onChange(event.optionValue === 'all' ? null : parsePrincipal(event.optionValue));
      setQuery(null);
      setOpen(false);
    }}
    open={open}
    ref={inputRef}
    root={{ children: renderRoot }}
    selectedOptions={[selected]}
    spellCheck={false}
    value={query ?? selectedLabel}
  >
    {includeAll && !needle && <Option value="all">{t('dashboard.accessControl.filters.allPrincipals')}</Option>}
    {users.length > 0 && <OptionGroup label={t('dashboard.users.tabs.users')}>
      {users.map(user => <Option key={user.id} text={user.username} value={`user:${user.id}`}><PrincipalIdentity data={data} principal={{ kind: 'user', id: user.id }} /></Option>)}
    </OptionGroup>}
    {groups.length > 0 && <OptionGroup label={t('dashboard.users.tabs.groups')}>
      {groups.map(group => <Option key={group.id} text={group.name} value={`group:${group.id}`}><PrincipalIdentity data={data} principal={{ kind: 'group', id: group.id }} /></Option>)}
    </OptionGroup>}
  </Combobox>;
}
