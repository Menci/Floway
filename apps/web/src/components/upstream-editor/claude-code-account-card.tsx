import { ArrowClockwiseRegular } from '@fluentui/react-icons';

import { shortAccountId } from './account-id';
import {
  accountStatus,
  actionableDisabledReason,
  type ClaudeCodeRecord,
  findCredential,
  quotaWindows,
  rawEntries,
  readProbeSnapshot,
  subscriptionLabel,
} from './claude-code-account';
import { quotaBarColor, WALL_CLOCK_REFRESH_MS } from './subscription-account-quota';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime, relativeTime } from '../../lib/format-time';
import { clampPercent, percentText } from '../../lib/percent';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { StatusBadge } from '../ui/status-badge';
import { TruncationTooltip } from '../ui/truncation-tooltip';
import { ProviderIcon } from '../upstreams/provider-badge';

const {
  Accordion, AccordionHeader, AccordionItem, AccordionPanel, Badge, Button,
  MessageBar, MessageBarBody, ProgressBar, Spinner, Text, Tooltip,
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
  const subscription = subscriptionLabel(account.subscriptionType);
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
        <Text block weight="semibold" truncate wrap={false}>{account.email ?? accountUuidShort}</Text>
        <div className="flex flex-wrap items-center gap-2">
          {credential?.tokenKind === 'setup-token' && <Tooltip content={t('dashboard.upstreamEditor.claudeCode.setupTokenHint')} relationship="description">
            <span className="winui-focus-rect inline-flex" tabIndex={0}>
              <StatusBadge tone="neutral">{t('dashboard.upstreamEditor.claudeCode.setupToken')}</StatusBadge>
            </span>
          </Tooltip>}
          {subscription && <StatusBadge tone="accent">{subscription}</StatusBadge>}
          {account.rateLimitTier && <Badge appearance="outline" size="large">{account.rateLimitTier}</Badge>}
          <TruncationTooltip content={account.accountUuid} relationship="description">
            {measureRef => <Text size={200} className="winui-focus-rect text-fui-fg3 font-mono mono-size-xs" ref={measureRef} tabIndex={0}>{accountUuidShort}</Text>}
          </TruncationTooltip>
          {account.email === null && <Tooltip content={t('dashboard.upstreamEditor.claudeCode.noEmailScopeHint')} relationship="description">
            <Text size={200} className="winui-focus-rect text-fui-fg3" tabIndex={0}>{t('dashboard.upstreamEditor.claudeCode.noEmailScope')}</Text>
          </Tooltip>}
        </div>
      </div>
      <StatusBadge tone={status.tone}>{statusLabel}</StatusBadge>
    </div>

    {status.tone === 'danger' && status.detail && <Text size={200} className="text-fui-fg2">{status.detail}</Text>}

    {lookup.kind === 'uuid-mismatch' && <MessageBar intent="error"><MessageBarBody>
      {t('dashboard.upstreamEditor.claudeCode.uuidMismatch', { accountUuid: lookup.expectedAccountUuid })}
    </MessageBarBody></MessageBar>}

    <div className="flex flex-wrap items-center justify-between gap-2">
      <Text size={200} className="text-fui-fg2">
        {windows.length ? t('dashboard.upstreamEditor.claudeCode.windows') : t('dashboard.upstreamEditor.claudeCode.noSnapshot')}
      </Text>
      <Button appearance="subtle" disabledFocusable={probing} icon={probing ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />} onClick={onRefreshQuota} size="small">
        {t('dashboard.upstreamEditor.claudeCode.refreshQuota')}
      </Button>
    </div>

    {windows.length > 0 && <div className="grid gap-3">
      {windows.map(row => {
        const percent = clampPercent(row.percent);
        return <div key={row.key} className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <Text size={200}>{t(`dashboard.upstreamEditor.claudeCode.window.${row.key}`)}</Text>
            <div className="flex items-baseline gap-2">
              <Text size={200} className="text-fui-fg2">{percentText(percent)}</Text>
              {row.status && <Text size={200} className="text-fui-fg3">{row.status}</Text>}
            </div>
          </div>
          <ProgressBar color={quotaBarColor(percent)} max={100} thickness="large" value={percent ?? undefined} />
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            {row.resetAt && <Text size={200} className="text-fui-fg3">
              {t('dashboard.upstreamEditor.claudeCode.resetsAt', { time: dateTime(row.resetAt, locale) })}
            </Text>}
            <Text size={200} className="text-fui-fg3">
              {t('dashboard.upstreamEditor.claudeCode.observed', { time: dateTime(row.fetchedAt, locale) })}
            </Text>
          </div>
        </div>;
      })}
    </div>}

    <div className="flex flex-wrap items-center gap-2 empty:hidden">
      {quota?.representativeClaim && <Badge appearance="outline" size="large">
        {t('dashboard.upstreamEditor.claudeCode.representative', { claim: quota.representativeClaim })}
      </Badge>}
      {quota?.overage?.status === 'allowed' && <StatusBadge tone="success">
        {t('dashboard.upstreamEditor.claudeCode.overageAllowed')}
      </StatusBadge>}
      {disabledReason && <StatusBadge tone="danger">
        {t('dashboard.upstreamEditor.claudeCode.disabledReason', { reason: disabledReason })}
      </StatusBadge>}
      {quota?.fallbackAvailable === false && <StatusBadge tone="warning">
        {t('dashboard.upstreamEditor.claudeCode.fallbackUnavailable')}
      </StatusBadge>}
    </div>

    {(headerRawEntries.length > 0 || probeExtraEntries.length > 0) && <Accordion collapsible>
      {headerRawEntries.length > 0 && <AccordionItem value="rate-limit">
        <AccordionHeader>{t('dashboard.upstreamEditor.claudeCode.rawRateLimit', { count: headerRawEntries.length })}</AccordionHeader>
        <AccordionPanel><EntryList entries={headerRawEntries} /></AccordionPanel>
      </AccordionItem>}
      {probeExtraEntries.length > 0 && <AccordionItem value="usage">
        <AccordionHeader>{t('dashboard.upstreamEditor.claudeCode.rawUsage', { count: probeExtraEntries.length })}</AccordionHeader>
        <AccordionPanel><EntryList entries={probeExtraEntries} /></AccordionPanel>
      </AccordionItem>}
    </Accordion>}

    <div className="flex flex-wrap gap-x-4 gap-y-1 border-0 border-t border-solid border-fui-divider pt-3">
      {credential?.stateUpdatedAt && <Text size={200} className="text-fui-fg3">
        {t('dashboard.upstreamEditor.claudeCode.stateUpdated', { time: dateTime(credential.stateUpdatedAt, locale) })}
      </Text>}
      {accessTokenExpiresAt !== null && <Text size={200} className="text-fui-fg3">
        {t('dashboard.upstreamEditor.claudeCode.tokenExpires', { time: relativeTime(accessTokenExpiresAt, locale, { now }) ?? dateTime(accessTokenExpiresAt, locale) })}
      </Text>}
    </div>
  </section>;
}

function EntryList({ entries }: { entries: [string, string][] }) {
  return <dl className="grid gap-1 m-0">
    {entries.map(([key, value]) => <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
      <TruncationTooltip content={key} relationship="label">
        {measureRef => <dt className="winui-focus-rect truncate font-mono mono-size-xs text-fui-fg3" ref={measureRef} tabIndex={0}>{key}</dt>}
      </TruncationTooltip>
      <TruncationTooltip content={value} relationship="label">
        {measureRef => <dd className="winui-focus-rect truncate font-mono mono-size-xs text-fui-fg2 m-0" ref={measureRef} tabIndex={0}>{value}</dd>}
      </TruncationTooltip>
    </div>)}
  </dl>;
}
