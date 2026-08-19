import { DeleteRegular } from '@fluentui/react-icons';

import type { OAuth2Account } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { EmptyStateLine } from '../ui/empty-state';
import { SettingsCard } from '../ui/settings-card';

const { Button, Spinner, Tooltip } = fluentComponents;

export function OAuth2AccountList({ accounts, busyProvider, disabled, failed, onUnlink }: {
  accounts: OAuth2Account[] | null;
  busyProvider: string | null;
  disabled: boolean;
  failed: boolean;
  onUnlink: (account: OAuth2Account) => void;
}) {
  const { t } = useTranslation();

  if (accounts === null) {
    return failed ? null : <Spinner label={t('dashboard.oauth2.accounts.loading')} labelPosition="after" />;
  }
  if (accounts.length === 0) return <EmptyStateLine>{t('dashboard.oauth2.accounts.empty')}</EmptyStateLine>;

  return <div className="grid gap-2">
    {accounts.map(account => {
      const busy = busyProvider === account.provider_id;
      const button = <Button
        appearance="subtle"
        disabled={disabled}
        disabledFocusable={busy || !account.can_unlink}
        icon={busy ? <Spinner size="tiny" /> : <DeleteRegular />}
        onClick={account.can_unlink && !busy ? () => onUnlink(account) : undefined}
        type="button"
      >{t('dashboard.oauth2.accounts.unlink')}</Button>;
      return <SettingsCard
        action={account.can_unlink
          ? button
          : <Tooltip content={t('dashboard.oauth2.accounts.lastLogin')} relationship="description">{button}</Tooltip>}
        description={account.provider_login}
        header={account.provider_display_name}
        key={account.provider_id}
      />;
    })}
  </div>;
}
