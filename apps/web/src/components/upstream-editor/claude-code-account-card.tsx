import { ArrowClockwiseRegular } from '@fluentui/react-icons';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime, relativeTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { useUserPreferences } from '../../lib/use-preferences';
import { StatusBadge } from '../ui/status-badge';
import { TruncationTooltip } from '../ui/truncation-tooltip';
import { shortAccountId } from '../upstreams/account-id';
import {
  accountStatus,
  actionableDisabledReason,
  type ClaudeCodeRecord,
  findCredential,
  quotaWindows,
  rawEntries,
  readProbeSnapshot,
  subscriptionLabel,
} from '../upstreams/claude-code-account';
import { QuotaProgressRow } from '../upstreams/quota-progress-row';
import { WALL_CLOCK_REFRESH_MS } from '../upstreams/subscription-quota';
import { UpstreamKindIcon } from '../upstreams/upstream-kind-badge';

const {
  Accordion, AccordionHeader, AccordionItem, AccordionPanel, Badge, Button,
  MessageBar, MessageBarBody, Spinner, Text, Tooltip,
} = fluentComponents;

export function ClaudeCodeAccountCard({ onRefreshQuota, probing, readOnly = false, record }: {
  onRefreshQuota: () => void;
  probing: boolean;
  readOnly?: boolean | undefined;
  record: ClaudeCodeRecord;
}) {
  const { t } = useTranslation();
  const preferences = useUserPreferences();
  const locale = useLocale();
  const now = useNow(WALL_CLOCK_REFRESH_MS);
  const account = record.config.accounts[0];
  const lookup = findCredential(record);
  const credential = lookup.kind === 'present' ? lookup.credential : null;
  const quota = credential?.quotaSnapshot?.data ?? null;
  const probe = readProbeSnapshot(credential);
  const windows = quotaWindows(credential);
  const status = accountStatus(lookup, windows, now);
  const disabledReason = actionableDisabledReason(credential);

  const accountUuidShort = shortAccountId(account.accountUuid);
  const subscription = subscriptionLabel(account.subscriptionType);
  const headerRawEntries = rawEntries(quota?.raw);
  const probeExtraEntries = rawEntries(probe?.extras);
  const accessTokenExpiresAt = credential?.accessToken?.expiresAt ?? null;
  const statusLabel = status.reason === 'heavy'
    ? t('upstreams.editor.claudeCode.status.heavy', { percent: status.percent })
    : t(`upstreams.editor.claudeCode.status.${status.reason}`);

  return <section className="grid gap-4">
    <div className="flex items-start gap-3">
      <UpstreamKindIcon kind="claude-code" className="h-8 w-8 shrink-0" />
      <div className="grid gap-1 min-w-0 flex-1">
        <Text block weight="semibold" truncate wrap={false}>{account.email ?? accountUuidShort}</Text>
        <div className="flex flex-wrap items-center gap-2">
          {credential?.tokenKind === 'setup-token' && <Tooltip content={t('upstreams.editor.claudeCode.setupTokenHint')} relationship="description">
            <span className="winui-focus-rect inline-flex" tabIndex={0}>
              <StatusBadge tone="neutral">{t('upstreams.editor.claudeCode.setupToken')}</StatusBadge>
            </span>
          </Tooltip>}
          {subscription && <StatusBadge tone="accent">{subscription}</StatusBadge>}
          {account.rateLimitTier && <Badge appearance="outline" size="large">{account.rateLimitTier}</Badge>}
          <TruncationTooltip content={account.accountUuid} relationship="description">
            {measureRef => <Text size={200} className="winui-focus-rect text-fui-fg3 font-mono mono-size-xs" ref={measureRef} tabIndex={0}>{accountUuidShort}</Text>}
          </TruncationTooltip>
          {account.email === null && <Tooltip content={t('upstreams.editor.claudeCode.noEmailScopeHint')} relationship="description">
            <Text size={200} className="winui-focus-rect text-fui-fg3" tabIndex={0}>{t('upstreams.editor.claudeCode.noEmailScope')}</Text>
          </Tooltip>}
        </div>
      </div>
      <StatusBadge tone={status.tone}>{statusLabel}</StatusBadge>
    </div>

    {status.tone === 'danger' && status.detail && <Text size={200} className="text-fui-fg2">{status.detail}</Text>}

    {lookup.kind === 'uuid-mismatch' && <MessageBar intent="error"><MessageBarBody>
      {t('upstreams.editor.claudeCode.uuidMismatch', { accountUuid: lookup.expectedAccountUuid })}
    </MessageBarBody></MessageBar>}

    <div className="flex flex-wrap items-center justify-between gap-2">
      <Text size={200} className="text-fui-fg2">
        {windows.length ? t('upstreams.editor.claudeCode.windows') : t('upstreams.editor.claudeCode.noSnapshot')}
      </Text>
      {!readOnly && <Button appearance="subtle" disabledFocusable={probing} icon={probing ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />} onClick={onRefreshQuota} size="small">
        {t('upstreams.editor.claudeCode.refreshQuota')}
      </Button>}
    </div>

    {windows.length > 0 && <div className="grid gap-3">
      {windows.map(row => {
        return <QuotaProgressRow
          key={row.key}
          label={t(`upstreams.editor.claudeCode.window.${row.key}`)}
          percent={row.percent}
          quotaDisplay={preferences.quotaDisplay}
          right={row.status && <Text size={200} className="text-fui-fg3">{row.status}</Text>}
          footer={<div className="flex flex-wrap items-baseline justify-between gap-x-3">
            {row.resetAt && <Text size={200} className="text-fui-fg3">
              {t('upstreams.editor.claudeCode.resetsAt', { time: dateTime(row.resetAt, locale) })}
            </Text>}
            <Text size={200} className="text-fui-fg3">
              {t('upstreams.editor.claudeCode.observed', { time: dateTime(row.fetchedAt, locale) })}
            </Text>
          </div>}
        />;
      })}
    </div>}

    <div className="flex flex-wrap items-center gap-2 empty:hidden">
      {quota?.representativeClaim && <Badge appearance="outline" size="large">
        {t('upstreams.editor.claudeCode.representative', { claim: quota.representativeClaim })}
      </Badge>}
      {quota?.overage?.status === 'allowed' && <StatusBadge tone="success">
        {t('upstreams.editor.claudeCode.overageAllowed')}
      </StatusBadge>}
      {disabledReason && <StatusBadge tone="danger">
        {t('upstreams.editor.claudeCode.disabledReason', { reason: disabledReason })}
      </StatusBadge>}
      {quota?.fallbackAvailable === false && <StatusBadge tone="warning">
        {t('upstreams.editor.claudeCode.fallbackUnavailable')}
      </StatusBadge>}
    </div>

    {(headerRawEntries.length > 0 || probeExtraEntries.length > 0) && <Accordion collapsible>
      {headerRawEntries.length > 0 && <AccordionItem value="rate-limit">
        <AccordionHeader>{t('upstreams.editor.claudeCode.rawRateLimit', { count: headerRawEntries.length })}</AccordionHeader>
        <AccordionPanel><EntryList entries={headerRawEntries} /></AccordionPanel>
      </AccordionItem>}
      {probeExtraEntries.length > 0 && <AccordionItem value="usage">
        <AccordionHeader>{t('upstreams.editor.claudeCode.rawUsage', { count: probeExtraEntries.length })}</AccordionHeader>
        <AccordionPanel><EntryList entries={probeExtraEntries} /></AccordionPanel>
      </AccordionItem>}
    </Accordion>}

    <div className="flex flex-wrap gap-x-4 gap-y-1 border-0 border-t border-solid border-fui-divider pt-3">
      {credential?.stateUpdatedAt && <Text size={200} className="text-fui-fg3">
        {t('upstreams.editor.claudeCode.stateUpdated', { time: dateTime(credential.stateUpdatedAt, locale) })}
      </Text>}
      {accessTokenExpiresAt !== null && <Text size={200} className="text-fui-fg3">
        {t('upstreams.editor.claudeCode.tokenExpires', { time: relativeTime(accessTokenExpiresAt, locale, { now }) ?? dateTime(accessTokenExpiresAt, locale) })}
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
