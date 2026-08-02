import { ArrowClockwiseRegular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';

import { shortAccountId } from './account-id';
import {
  accountStatus,
  actionableDisabledReason,
  type ClaudeCodeRecord,
  findCredential,
  formatSubscription,
  quotaWindows,
  rawEntries,
  readProbeSnapshot,
} from './claude-code-account';
import { quotaBarColor, WALL_CLOCK_REFRESH_MS } from './subscription-account-quota';
import { fluentComponents } from '../../fluent';
import { dateTime, relativeTime } from '../../lib/format-time';
import { clampPercent, percentText } from '../../lib/percent';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { StatusBadge } from '../ui/status-badge';
import { ProviderIcon } from '../upstreams/provider-badge';

const {
  Accordion, AccordionHeader, AccordionItem, AccordionPanel, Badge, Button,
  MessageBar, MessageBarBody, ProgressBar, Text, Tooltip,
} = fluentComponents;

export function ClaudeCodeAccountCard({ onRefreshQuota, probing, record }: {
  onRefreshQuota: () => void;
  probing: boolean;
  record: ClaudeCodeRecord;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const now = useNow(WALL_CLOCK_REFRESH_MS);
  const account = record.config.accounts[0];
  const lookup = findCredential(record);
  const credential = lookup.kind === 'present' ? lookup.credential : null;
  const quota = credential?.quotaSnapshot?.data ?? null;
  const probe = readProbeSnapshot(credential);
  const windows = quotaWindows(credential);
  const status = accountStatus(lookup, windows);
  const disabledReason = actionableDisabledReason(credential);

  const accountUuidShort = shortAccountId(account.accountUuid);
  const subscription = formatSubscription(account.subscriptionType, account.rateLimitTier);
  const headerRawEntries = rawEntries(quota?.raw);
  const probeExtraEntries = rawEntries(probe?.extras);
  const accessTokenExpiresAt = credential?.accessToken?.expiresAt ?? null;
  const statusLabel = status.reason === 'heavy'
    ? t('dashboard.upstreamEditor.claudeCode.status.heavy', { percent: status.percent })
    : t(`dashboard.upstreamEditor.claudeCode.status.${status.reason}`);

  return <section className="grid gap-4">
    <div className="flex items-start gap-3">
      <ProviderIcon kind="claude-code" className="h-8 w-8 shrink-0" />
      <div className="grid gap-1 min-w-0 flex-1">
        <Text weight="semibold" truncate>{account.email ?? accountUuidShort}</Text>
        <div className="flex flex-wrap items-center gap-2">
          {credential?.tokenKind === 'setup-token' && <Tooltip content={t('dashboard.upstreamEditor.claudeCode.setupTokenHint')} relationship="description">
            <span className="inline-flex" tabIndex={0}>
              <StatusBadge color="important">{t('dashboard.upstreamEditor.claudeCode.setupToken')}</StatusBadge>
            </span>
          </Tooltip>}
          {subscription && <StatusBadge color="brand">{subscription}</StatusBadge>}
          <Tooltip content={account.accountUuid} relationship="description">
            <Text size={200} className="text-fui-fg3 font-mono" tabIndex={0}>{accountUuidShort}</Text>
          </Tooltip>
          {account.email === null && <Tooltip content={t('dashboard.upstreamEditor.claudeCode.noEmailScopeHint')} relationship="description">
            <Text size={200} className="text-fui-fg3" tabIndex={0}>{t('dashboard.upstreamEditor.claudeCode.noEmailScope')}</Text>
          </Tooltip>}
        </div>
      </div>
      <StatusBadge color={status.tone}>{statusLabel}</StatusBadge>
    </div>

    {status.tone === 'danger' && status.detail && <Text size={200} className="text-fui-fg2">{status.detail}</Text>}

    {lookup.kind === 'uuid-mismatch' && <MessageBar intent="error"><MessageBarBody>
      {t('dashboard.upstreamEditor.claudeCode.uuidMismatch', { accountUuid: lookup.expectedAccountUuid })}
    </MessageBarBody></MessageBar>}

    <div className="flex flex-wrap items-center justify-between gap-2">
      <Text size={200} className="text-fui-fg2">
        {windows.length ? t('dashboard.upstreamEditor.claudeCode.windows') : t('dashboard.upstreamEditor.claudeCode.noSnapshot')}
      </Text>
      <Button appearance="subtle" disabledFocusable={probing} icon={<ArrowClockwiseRegular />} onClick={onRefreshQuota} size="small">
        {t('dashboard.upstreamEditor.claudeCode.refreshQuota')}
      </Button>
    </div>

    {windows.length > 0 && <div className="grid gap-3">
      {windows.map(row => {
        const percent = clampPercent(row.percent);
        return <div key={row.key} className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <Text size={200}>
              {t(`dashboard.upstreamEditor.claudeCode.window.${row.key}`)}
              <Tooltip content={t('dashboard.upstreamEditor.claudeCode.fetchedAt', { time: dateTime(row.fetchedAt, locale) })} relationship="description">
                <span className="ml-1.5 text-fui-fg3 uppercase text-[10px] tracking-wide" tabIndex={0}>
                  {t(`dashboard.upstreamEditor.claudeCode.source.${row.source}`)}
                </span>
              </Tooltip>
            </Text>
            <Text size={200} className="text-fui-fg2">
              {percentText(percent)}{row.status ? ` · ${row.status}` : ''}
            </Text>
          </div>
          <ProgressBar color={quotaBarColor(percent)} max={100} thickness="large" value={percent ?? undefined} />
          {row.resetAt && <Text size={200} className="text-fui-fg3">
            {t('dashboard.upstreamEditor.claudeCode.resetsAt', { time: dateTime(row.resetAt, locale) })}
          </Text>}
        </div>;
      })}
    </div>}

    <div className="flex flex-wrap items-center gap-2 empty:hidden">
      {quota?.representativeClaim && <Badge appearance="outline" size="large">
        {t('dashboard.upstreamEditor.claudeCode.representative', { claim: quota.representativeClaim })}
      </Badge>}
      {quota?.overage?.status === 'allowed' && <StatusBadge color="success">
        {t('dashboard.upstreamEditor.claudeCode.overageAllowed')}
      </StatusBadge>}
      {disabledReason && <StatusBadge color="danger">
        {t('dashboard.upstreamEditor.claudeCode.disabledReason', { reason: disabledReason })}
      </StatusBadge>}
      {quota?.fallbackAvailable === false && <StatusBadge color="warning">
        {t('dashboard.upstreamEditor.claudeCode.fallbackUnavailable')}
      </StatusBadge>}
    </div>

    {(headerRawEntries.length > 0 || probeExtraEntries.length > 0) && <Accordion collapsible>
      {headerRawEntries.length > 0 && <AccordionItem value="headers">
        <AccordionHeader>{t('dashboard.upstreamEditor.claudeCode.rawHeaders', { count: headerRawEntries.length })}</AccordionHeader>
        <AccordionPanel><EntryList entries={headerRawEntries} /></AccordionPanel>
      </AccordionItem>}
      {probeExtraEntries.length > 0 && <AccordionItem value="probe">
        <AccordionHeader>{t('dashboard.upstreamEditor.claudeCode.rawProbe', { count: probeExtraEntries.length })}</AccordionHeader>
        <AccordionPanel><EntryList entries={probeExtraEntries} /></AccordionPanel>
      </AccordionItem>}
    </Accordion>}

    <div className="flex flex-wrap gap-x-4 gap-y-1 border-0 border-t border-solid border-fui-stroke1 pt-3">
      {credential?.stateUpdatedAt && <Text size={200} className="text-fui-fg3">
        {t('dashboard.upstreamEditor.claudeCode.stateUpdated', { time: dateTime(credential.stateUpdatedAt, locale) })}
      </Text>}
      {accessTokenExpiresAt !== null && <Text size={200} className="text-fui-fg3">
        {t('dashboard.upstreamEditor.claudeCode.tokenExpires', { time: relativeTime(accessTokenExpiresAt, locale, { now }) ?? dateTime(accessTokenExpiresAt, locale) })}
      </Text>}
      {probe && <Text size={200} className="text-fui-fg3">
        {t('dashboard.upstreamEditor.claudeCode.probeFetched', { time: dateTime(probe.fetchedAt, locale) })}
      </Text>}
    </div>
  </section>;
}

function EntryList({ entries }: { entries: [string, string][] }) {
  return <dl className="grid gap-1 m-0">
    {entries.map(([key, value]) => <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
      <Tooltip content={key} relationship="label">
        <dt className="truncate font-mono mono-size-xs text-fui-fg3" tabIndex={0}>{key}</dt>
      </Tooltip>
      <Tooltip content={value} relationship="label">
        <dd className="truncate font-mono mono-size-xs text-fui-fg2 m-0" tabIndex={0}>{value}</dd>
      </Tooltip>
    </div>)}
  </dl>;
}
