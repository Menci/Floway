import { useTranslation } from 'react-i18next';

import { shortAccountId } from './account-id';
import { accountStatus, type CodexRecord, findCredential, latestCredits, quotaEntries } from './codex-account';
import { quotaBarColor, WALL_CLOCK_REFRESH_MS } from './subscription-account-quota';
import { fluentComponents } from '../../fluent';
import { dateTime } from '../../lib/format-time';
import { clampPercent, percentText } from '../../lib/percent';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { StatusBadge } from '../ui/status-badge';
import { ProviderIcon } from '../upstreams/provider-badge';

const { Badge, ProgressBar, Text, Tooltip } = fluentComponents;

export function CodexAccountCard({ record }: { record: CodexRecord }) {
  const { t } = useTranslation();
  const now = useNow(WALL_CLOCK_REFRESH_MS);
  const locale = useLocale();
  const account = record.config.accounts[0];
  const lookup = findCredential(record);
  const credential = lookup.kind === 'present' ? lookup.credential : null;
  const entries = quotaEntries(record.codex_quota, now);
  const credits = latestCredits(record.codex_quota);
  const status = accountStatus(lookup, entries);

  const statusLabel = status.reason === 'heavy'
    ? t('dashboard.upstreamEditor.codex.status.heavy', { percent: status.percent })
    : status.reason === 'rate-limited'
      ? t('dashboard.upstreamEditor.codex.status.rateLimited', { time: dateTime(status.until, locale) })
      : t(`dashboard.upstreamEditor.codex.status.${status.reason}`);

  return <section className="grid gap-4">
    <div className="flex items-start gap-3">
      <ProviderIcon kind="codex" className="h-8 w-8 shrink-0" />
      <div className="grid gap-1 min-w-0 flex-1">
        <Text block weight="semibold" truncate wrap={false}>{account.email}</Text>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge color="brand">{account.planType}</StatusBadge>
          {credits?.credits_has_credits === false
            ? <StatusBadge color="danger">{t('dashboard.upstreamEditor.codex.noCredits')}</StatusBadge>
            : credits?.credits_balance !== undefined && <Badge appearance="outline" size="large">
              {t('dashboard.upstreamEditor.codex.credits', { balance: credits.credits_balance })}
            </Badge>}
          <Tooltip content={account.chatgptAccountId} relationship="description">
            <Text size={200} className="text-fui-fg3 font-mono mono-size-xs" tabIndex={0}>{shortAccountId(account.chatgptAccountId)}</Text>
          </Tooltip>
        </div>
      </div>
      <StatusBadge color={status.tone}>{statusLabel}</StatusBadge>
    </div>

    {status.tone === 'danger' && status.detail && <Text size={200} className="text-fui-fg2">{status.detail}</Text>}

    {entries.length === 0
      ? <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.codex.noSnapshot')}</Text>
      : entries.map(entry => <section className="grid gap-3 border-0 border-t border-solid border-fui-divider py-3 first:border-t-0" key={entry.key}>
          <div className="flex items-baseline justify-between gap-3 min-w-0">
            <Tooltip content={entry.label} relationship="label">
              <Text block truncate weight="semibold" tabIndex={0} wrap={false}>{entry.label}</Text>
            </Tooltip>
            <Text size={200} className="text-fui-fg3 shrink-0 uppercase tracking-wide">{t('dashboard.upstreamEditor.codex.activeLimit')}</Text>
          </div>
          {entry.windows.map(item => {
            const percent = clampPercent(item.percent);
            return <div className="grid gap-1" key={item.key}>
              <div className="flex items-baseline justify-between gap-3">
                <Text size={200}>{t(`dashboard.upstreamEditor.codex.window.${item.key}`)}</Text>
                <div className="flex items-baseline gap-2">
                  <Text size={200} className="text-fui-fg2">{percentText(percent)}</Text>
                  {item.windowMinutes !== null && <Text size={200} className="text-fui-fg3">
                    {t('dashboard.upstreamEditor.codex.windowMinutes', { minutes: item.windowMinutes })}
                  </Text>}
                </div>
              </div>
              <ProgressBar color={quotaBarColor(percent)} max={100} thickness="large" value={percent ?? undefined} />
              {item.resetAt && <Text size={200} className="text-fui-fg3">
                {t('dashboard.upstreamEditor.codex.resetsAt', { time: dateTime(item.resetAt, locale) })}
              </Text>}
            </div>;
          })}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {entry.rateLimitedUntil && <Text size={200} className="text-fui-fg3">
              {t('dashboard.upstreamEditor.codex.rateLimitedUntil', { time: dateTime(entry.rateLimitedUntil, locale) })}
            </Text>}
            <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.codex.observed', { time: dateTime(entry.observedAt, locale) })}</Text>
          </div>
        </section>)}

    {credential?.state_updated_at && <Text size={200} className="text-fui-fg3 border-0 border-t border-solid border-fui-divider pt-3">
      {t('dashboard.upstreamEditor.codex.stateUpdated', { time: dateTime(credential.state_updated_at, locale) })}
    </Text>}
  </section>;
}
