import { useState } from 'react';

import { ChatGPTResetCards } from './chatgpt-reset-cards';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { useUserPreferences } from '../../lib/use-preferences';
import { StatusBadge } from '../ui/status-badge';
import { TruncationTooltip } from '../ui/truncation-tooltip';
import { shortAccountId } from '../upstreams/account-id';
import { accountStatus, type ChatGPTRecord, chatgptRenewable, findCredential, latestCredits, planLabel, quotaEntries } from '../upstreams/chatgpt-account';
import { ProviderIcon } from '../upstreams/provider-badge';
import { QuotaProgressRow } from '../upstreams/quota-progress-row';
import { WALL_CLOCK_REFRESH_MS } from '../upstreams/subscription-quota';

const { Badge, Text } = fluentComponents;

export function ChatGPTAccountCard({ readOnly = false, record }: { readOnly?: boolean; record: ChatGPTRecord }) {
  const { t } = useTranslation();
  const preferences = useUserPreferences();
  const now = useNow(WALL_CLOCK_REFRESH_MS);
  const locale = useLocale();
  const account = record.config.accounts[0];
  const lookup = findCredential(record);
  const credential = lookup.kind === 'present' ? lookup.credential : null;
  const [reset, setReset] = useState<{ accountId: string | null; at: number } | null>(null);
  const visibleQuota = reset?.accountId === account.chatgptAccountId
    ? Object.fromEntries(Object.entries(record.chatgpt_quota ?? {}).filter(([, snapshot]) => Date.parse(snapshot.observed_at) > reset.at))
    : record.chatgpt_quota;
  const entries = quotaEntries(visibleQuota, now);
  const credits = latestCredits(visibleQuota);
  const status = accountStatus(lookup, entries);

  const statusLabel = status.reason === 'heavy'
    ? t('dashboard.upstreamEditor.chatgpt.status.heavy', { percent: status.percent })
    : status.reason === 'rate-limited'
      ? t('dashboard.upstreamEditor.chatgpt.status.rateLimited', { time: dateTime(status.until, locale) })
      : t(`dashboard.upstreamEditor.chatgpt.status.${status.reason}`);

  const renewable = credential === null ? null : chatgptRenewable(credential);
  const accountId = account.chatgptAccountId;
  const expiresAt = credential?.accessToken?.expiresAt ?? null;
  const bearerLabel = expiresAt !== null
    ? t('dashboard.upstreamEditor.chatgpt.expires', { time: dateTime(new Date(expiresAt).toISOString(), locale) })
    : renewable === false
      ? t('dashboard.upstreamEditor.chatgpt.expiryUnknownAccessOnly')
      : t('dashboard.upstreamEditor.chatgpt.expiryUnknown');

  return <section className="grid gap-4">
    <div className="flex items-start gap-3">
      <ProviderIcon kind="chatgpt" className="h-8 w-8 shrink-0" />
      <div className="grid gap-1 min-w-0 flex-1">
        <Text block weight="semibold" truncate wrap={false}>{account.email ?? t('dashboard.upstreamEditor.chatgpt.unknownEmail')}</Text>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="accent">{planLabel(account) ?? t('dashboard.upstreamEditor.chatgpt.unknownPlan')}</StatusBadge>
          {renewable !== null && <StatusBadge tone={renewable ? 'success' : 'warning'}>
            {t(renewable ? 'dashboard.upstreamEditor.chatgpt.renewable' : 'dashboard.upstreamEditor.chatgpt.accessOnly')}
          </StatusBadge>}
          {credits?.credits_has_credits === false
            ? <StatusBadge tone="danger">{t('dashboard.upstreamEditor.chatgpt.noCredits')}</StatusBadge>
            : credits?.credits_balance !== undefined && <Badge appearance="outline" size="large">
              {t('dashboard.upstreamEditor.chatgpt.credits', { balance: credits.credits_balance })}
            </Badge>}
          {accountId === null
            ? <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.chatgpt.unknownAccountId')}</Text>
            : <TruncationTooltip content={accountId} relationship="description">
                {measureRef => <Text size={200} className="winui-focus-rect text-fui-fg3 font-mono mono-size-xs" ref={measureRef} tabIndex={0}>{shortAccountId(accountId)}</Text>}
              </TruncationTooltip>}
        </div>
      </div>
      <StatusBadge tone={status.tone}>{statusLabel}</StatusBadge>
    </div>

    {status.tone === 'danger' && status.detail && <Text size={200} className="text-fui-fg2">{status.detail}</Text>}

    {credential && <Text size={200} className="text-fui-fg3">{bearerLabel}</Text>}

    {entries.length === 0
      ? <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.chatgpt.noSnapshot')}</Text>
      : entries.map(entry => <section className="grid gap-3 border-0 border-t border-solid border-fui-divider py-3 first:border-t-0" key={entry.key}>
          <div className="flex items-baseline justify-between gap-3 min-w-0">
            <TruncationTooltip content={entry.label} relationship="label">
              {measureRef => <Text block className="winui-focus-rect" ref={measureRef} truncate weight="semibold" tabIndex={0} wrap={false}>{entry.label}</Text>}
            </TruncationTooltip>
            <Text size={200} className="text-fui-fg3 shrink-0 uppercase tracking-wide">{t('dashboard.upstreamEditor.chatgpt.activeLimit')}</Text>
          </div>
          {entry.windows.map(item => {
            return <QuotaProgressRow
              key={item.key}
              label={t(`dashboard.upstreamEditor.chatgpt.window.${item.key}`)}
              percent={item.percent}
              quotaDisplay={preferences.quotaDisplay}
              right={item.windowMinutes !== null && <Text size={200} className="text-fui-fg3">
                {t('dashboard.upstreamEditor.chatgpt.windowMinutes', { minutes: item.windowMinutes })}
              </Text>}
              footer={item.resetAt && <Text size={200} className="text-fui-fg3">
                {t('dashboard.upstreamEditor.chatgpt.resetsAt', { time: dateTime(item.resetAt, locale) })}
              </Text>}
            />;
          })}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {entry.rateLimitedUntil && <Text size={200} className="text-fui-fg3">
              {t('dashboard.upstreamEditor.chatgpt.rateLimitedUntil', { time: dateTime(entry.rateLimitedUntil, locale) })}
            </Text>}
            <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.chatgpt.observed', { time: dateTime(entry.observedAt, locale) })}</Text>
          </div>
        </section>)}

    {credential?.state_updated_at && <Text size={200} className="text-fui-fg3 border-0 border-t border-solid border-fui-divider pt-3">
      {t('dashboard.upstreamEditor.chatgpt.stateUpdated', { time: dateTime(credential.state_updated_at, locale) })}
    </Text>}

    {!readOnly && record.id !== '' && <ChatGPTResetCards
      key={`${record.id}:${account.chatgptAccountId}`}
      record={record}
      onQuotaReset={() => setReset({ accountId: account.chatgptAccountId, at: Date.now() })}
    />}
  </section>;
}
