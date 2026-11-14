import { PersonRibbon16Regular } from '@fluentui/react-icons';

import { UserAvatar } from './avatar';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { TruncationTooltip } from '../ui/truncation-tooltip';

const { Tooltip } = fluentComponents;

export function UserIdentity({ isAdmin, username }: { isAdmin: boolean; username: string }) {
  const { t } = useTranslation();
  return <span className="floway-identity">
    <UserAvatar username={username} />
    <TruncationTooltip content={username} relationship="label">{ref => <span className="floway-identity-name truncate" ref={ref}>{username}</span>}</TruncationTooltip>
    {isAdmin && <Tooltip content={t('dashboard.users.role.admin')} relationship="label">
      <span aria-label={t('dashboard.users.role.admin')} className="floway-admin-indicator inline-flex flex-none text-fui-fg2" role="img"><PersonRibbon16Regular aria-hidden style={{ width: 16, height: 16 }} /></span>
    </Tooltip>}
  </span>;
}
