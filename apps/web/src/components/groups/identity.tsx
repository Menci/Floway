import { Link } from 'react-router';

import type { ControlPlaneGroup } from '../../api/types';
import { avatarColorForHue } from '../ui/avatar-hue';
import { IdentityAvatar } from '../ui/identity-avatar';
import { TruncationTooltip } from '../ui/truncation-tooltip';

export function GroupAvatar({ group }: { group: Pick<ControlPlaneGroup, 'name' | 'hue'> }) {
  return <IdentityAvatar aria-hidden className="floway-group-avatar" color={avatarColorForHue(group.hue)} name={group.name} shape="square" size={24} />;
}

export function GroupIdentity({ group }: { group: Pick<ControlPlaneGroup, 'name' | 'hue'> }) {
  return <span className="floway-identity">
    <GroupAvatar group={group} />
    <TruncationTooltip content={group.name} relationship="label">{ref => <span className="floway-identity-name truncate" ref={ref}>{group.name}</span>}</TruncationTooltip>
  </span>;
}

export function GroupIdentityLink({ group }: { group: Pick<ControlPlaneGroup, 'id' | 'name' | 'hue'> }) {
  return <Link className="winui-focus-rect floway-identity-action" to={`/dashboard/admin/users?tab=groups&group=${group.id}`}><GroupIdentity group={group} /></Link>;
}
