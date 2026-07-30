import { useTranslation } from 'react-i18next';

import { accountStatus, type CodexRecord, findCredential, latestCredits, quotaEntries, shortAccountId } from './codex-account';
import { fluentComponents } from '../../fluent';
import { dateTime } from '../../lib/format-time';
import { clampPercent } from '../../lib/percent';
import { useNow } from '../../lib/use-now';
import { ProviderIcon } from '../upstreams/provider-badge';

const { Badge, ProgressBar, Text } = fluentComponents;

const barColor = (percent: number) => percent >= 90 ? 'error' : percent >= 80 ? 'warning' : 'brand';

const QUOTA_REFRESH_MS = 60_000;

export const CodexAccountCard = ({ record }: { record: CodexRecord }) => {
  const { t } = useTranslation();
  // `ratelimited_until` expires on the wall clock rather than on any state
  // change, so the badge has to re-evaluate on its own.
  const now = useNow(QUOTA_REFRESH_MS);
  const account = record.config.accounts[0];
  const lookup = findCredential(record);
  const credential = lookup.kind === 'present' ? lookup.credential : null;
  const entries = quotaEntries(record.codex_quota, now);
  const credits = latestCredits(record.codex_quota);
  const status = accountStatus(lookup, entries);

  const statusLabel = status.reason === 'heavy'
    ? t('dashboard.upstreamEditor.codex.status.heavy', { percent: status.percent })
    : status.reason === 'rate-limited'
      ? t('dashboard.upstreamEditor.codex.status.rateLimited', { time: dateTime(status.until) })
      : t(`dashboard.upstreamEditor.codex.status.${status.reason}`);

  return <section className="grid gap-4">
    <div className="flex items-start gap-3">
      <ProviderIcon kind="codex" className="h-8 w-8 shrink-0" />
      <div className="grid gap-1 min-w-0 flex-1">
        <Text weight="semibold" truncate>{account.email}</Text>
        <div className="flex flex-wrap items-center gap-2">
          <Badge appearance="tint" color="brand">{account.planType}</Badge>
          {credits?.credits_has_credits === false
            ? <Badge appearance="tint" color="danger">{t('dashboard.upstreamEditor.codex.noCredits')}</Badge>
            : credits?.credits_balance !== undefined && <Badge appearance="outline">
              {t('dashboard.upstreamEditor.codex.credits', { balance: credits.credits_balance })}
            </Badge>}
          <Text size={200} className="text-fui-fg3 font-mono" title={account.chatgptAccountId}>{shortAccountId(account.chatgptAccountId)}</Text>
        </div>
      </div>
      <Badge appearance="tint" color={status.tone}>{statusLabel}</Badge>
    </div>

    {status.tone === 'danger' && 'detail' in status && status.detail && <Text size={200} className="text-fui-fg2">{status.detail}</Text>}

    {entries.length === 0
      ? <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.codex.noSnapshot')}</Text>
      : entries.map(entry => <section className="grid gap-3 border-0 border-t border-solid border-fui-stroke2 py-3 first:border-t-0" key={entry.key}>
          <div className="flex items-baseline justify-between gap-3 min-w-0">
            <Text truncate weight="semibold" title={entry.label}>{entry.label}</Text>
            <Text size={200} className="text-fui-fg3 shrink-0 uppercase tracking-wide">{t('dashboard.upstreamEditor.codex.activeLimit')}</Text>
          </div>
          {entry.windows.map(item => <div className="grid gap-1" key={item.key}>
            <div className="flex items-baseline justify-between gap-3">
              <Text size={200}>{t(`dashboard.upstreamEditor.codex.window.${item.key}`)}</Text>
              <Text size={200} className="text-fui-fg2">
                {clampPercent(item.percent)}%
                {item.windowMinutes !== null ? ` · ${t('dashboard.upstreamEditor.codex.windowMinutes', { minutes: item.windowMinutes })}` : ''}
              </Text>
            </div>
            <ProgressBar color={barColor(item.percent)} max={100} thickness="large" value={clampPercent(item.percent)} />
            {item.resetAt && <Text size={200} className="text-fui-fg3">
              {t('dashboard.upstreamEditor.codex.resetsAt', { time: dateTime(item.resetAt) })}
            </Text>}
          </div>)}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {entry.rateLimitedUntil && <Text size={200} className="text-fui-fg3">
              {t('dashboard.upstreamEditor.codex.rateLimitedUntil', { time: dateTime(entry.rateLimitedUntil) })}
            </Text>}
            <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.codex.observed', { time: dateTime(entry.observedAt) })}</Text>
          </div>
        </section>)}

    {credential?.state_updated_at && <Text size={200} className="text-fui-fg3 border-0 border-t border-solid border-fui-stroke2 pt-3">
      {t('dashboard.upstreamEditor.codex.stateUpdated', { time: dateTime(credential.state_updated_at) })}
    </Text>}
  </section>;
};
