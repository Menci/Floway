import { GroupIdentity } from './identity';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { FieldClearIcon } from '../ui/field-clear-icon';
import { TagCombobox } from '../ui/tag-combobox';
import type { DirectoryGroupOption } from '../users/directory';

const { Field, Tag, Text } = fluentComponents;

export function UserGroupsField({ disabled, groups, onChange, value }: {
  disabled: boolean;
  groups: readonly DirectoryGroupOption[];
  onChange: (ids: string[]) => void;
  value: string[];
}) {
  const { t } = useTranslation();
  const byId = new Map(groups.map(group => [String(group.id), group]));
  const label = t('dashboard.users.table.groups');
  return <Field label={label}><TagCombobox
    disabled={disabled}
    emptyMessage={t(groups.length === 0 ? 'dashboard.groupsManagement.empty' : value.length === groups.length ? 'dashboard.groupsManagement.allJoined' : 'dashboard.groupsManagement.noMatches')}
    label={label}
    onChange={onChange}
    options={groups.map(group => ({ value: String(group.id), label: group.name }))}
    placeholder={t('dashboard.groupsManagement.searchJoin')}
    renderOption={option => {
      const group = byId.get(option.value)!;
      return <span className="flex flex-1 items-center justify-between gap-3 min-w-0">
        <GroupIdentity group={group} />
        <Text className="text-fui-fg2 flex-none tabular-nums" size={200}>{t('dashboard.groupsManagement.members.count', { count: group.memberCount })}</Text>
      </span>;
    }}
    renderTag={option => <Tag
      appearance="outline"
      className="floway-identity-token max-w-full"
      disabled={disabled}
      dismissIcon={{ 'aria-label': t('dashboard.groupsManagement.actions.leave', { name: option.label }), children: <FieldClearIcon /> }}
      key={option.value}
      size="small"
      value={option.value}
    ><GroupIdentity group={byId.get(option.value)!} /></Tag>}
    value={value}
  /></Field>;
}
