import { GroupBadge, GroupTag } from './badge';
import type { ControlPlaneGroup } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { TagCombobox } from '../ui/tag-combobox';

const { Field, Text } = fluentComponents;

export function UserGroupsField({ disabled, groups, onChange, value }: {
  disabled: boolean;
  groups: ControlPlaneGroup[];
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
        <span className="inline-flex min-w-0"><GroupBadge group={group} /></span>
        <Text className="text-fui-fg2 flex-none" size={200}>{t('dashboard.groupsManagement.members.count', { count: group.memberIds.length })}</Text>
      </span>;
    }}
    renderTag={option => <GroupTag group={byId.get(option.value)!} key={option.value} />}
    value={value}
  /></Field>;
}
