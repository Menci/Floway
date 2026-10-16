import { PeopleTeam16Regular } from '@fluentui/react-icons';

import type { ControlPlaneGroup } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { hueBadgeTone } from '../../lib/hue';
import { useBadgeHue } from '../ui/badge-hue';
import { Chip } from '../ui/chip';
import { TruncationTooltip } from '../ui/truncation-tooltip';

const { Tag } = fluentComponents;

export function GroupBadge({ group }: { group: Pick<ControlPlaneGroup, 'name' | 'hue'> }) {
  const hue = useBadgeHue(hueBadgeTone(group.hue));
  return <TruncationTooltip content={group.name} relationship="label">
    {measureRef => <Chip className={hue.className} icon={<PeopleTeam16Regular />} style={hue.style} textRef={measureRef}>{group.name}</Chip>}
  </TruncationTooltip>;
}

export function GroupTag({ disabled, group }: { disabled: boolean; group: ControlPlaneGroup }) {
  const { t } = useTranslation();
  const hue = useBadgeHue(hueBadgeTone(group.hue));
  return <Tag
    appearance="outline"
    className={`max-w-full ${hue.className}`}
    disabled={disabled}
    dismissIcon={{ 'aria-label': t('dashboard.groupsManagement.actions.leave', { name: group.name }) }}
    icon={<PeopleTeam16Regular />}
    primaryText={{ className: 'truncate !pb-0' }}
    shape="circular"
    size="small"
    style={disabled ? undefined : hue.style}
    value={String(group.id)}
  >{group.name}</Tag>;
}
