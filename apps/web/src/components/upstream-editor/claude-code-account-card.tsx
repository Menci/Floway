import { ArrowClockwiseRegular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';

import {
  accountStatus,
  actionableDisabledReason,
  type ClaudeCodeRecord,
  formatSubscription,
  lookUpCredential,
  quotaWindows,
  rawEntries,
  readProbeSnapshot,
} from './claude-code-account';
import { quotaBarColor } from './subscription-account-quota';
import { fluentComponents } from '../../fluent';
import { dateTime, relativeTime } from '../../lib/format-time';
import { clampPercent } from '../../lib/percent';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { ProviderIcon } from '../upstreams/provider-badge';

const {
  Accordion, AccordionHeader, AccordionItem, AccordionPanel, Badge, Button,
  MessageBar, MessageBarBody, ProgressBar, Text,
} = fluentComponents;

const TOKEN_EXPIRY_REFRESH_MS = 60_000;

export const ClaudeCodeAccountCard = ({ onRefreshQuota, probing, record }: {
  onRefreshQuota: () => void;
  probing: boolean;
  record: ClaudeCodeRecord;
}) => {
  const { t } = useTranslation();
  const locale = useLocale();
  // The access token expires on the wall clock rather than on any state
  // change, so the countdown has to re-evaluate on its own.
  const now = useNow(TOKEN_EXPIRY_REFRESH_MS);
  const account = record.config.accounts[0];
  const lookup = lookUpCredential(record);
  const credential = lookup.kind === 'present' ? lookup.credential : null;
  const quota = credential?.quotaSnapshot?.data ?? null;
  const probe = readProbeSnapshot(credential);
  const windows = quotaWindows(credential);
  const status = accountStatus(lookup, windows);
  const disabledReason = actionableDisabledReason(credential);

  const accountUuidShort = `${account.accountUuid.slice(0, 8)}…${account.accountUuid.slice(-6)}`;
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
          {credential?.tokenKind === 'setup-token' && <Badge appearance="tint" color="important" title={t('dashboard.upstreamEditor.claudeCode.setupTokenHint')}>
            {t('dashboard.upstreamEditor.claudeCode.setupToken')}
          </Badge>}
          {subscription && <Badge appearance="tint" color="brand">{subscription}</Badge>}
          <Text size={200} className="text-fui-fg3 font-mono" title={account.accountUuid}>{accountUuidShort}</Text>
          {account.email === null && <Text size={200} className="text-fui-fg3" title={t('dashboard.upstreamEditor.claudeCode.noEmailScopeHint')}>
            {t('dashboard.upstreamEditor.claudeCode.noEmailScope')}
          </Text>}
        </div>
      </div>
      <Badge appearance="tint" color={status.tone}>{statusLabel}</Badge>
    </div>

    {status.tone === 'danger' && status.detail && <Text size={200} className="text-fui-fg2">{status.detail}</Text>}

    {lookup.kind === 'uuid-mismatch' && <MessageBar intent="error"><MessageBarBody>
      {t('dashboard.upstreamEditor.claudeCode.uuidMismatch', { accountUuid: lookup.expectedAccountUuid })}
    </MessageBarBody></MessageBar>}

    <div className="flex flex-wrap items-center justify-between gap-2">
      <Text size={200} className="text-fui-fg2">
        {windows.length ? t('dashboard.upstreamEditor.claudeCode.windows') : t('dashboard.upstreamEditor.claudeCode.noSnapshot')}
      </Text>
      <Button appearance="subtle" disabled={probing} icon={<ArrowClockwiseRegular />} onClick={onRefreshQuota} size="small">
        {probing ? t('dashboard.upstreamEditor.claudeCode.probing') : t('dashboard.upstreamEditor.claudeCode.refreshQuota')}
      </Button>
    </div>

    {windows.length > 0 && <div className="grid gap-3">
      {windows.map(row => <div key={row.key} className="grid gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <Text size={200}>
            {t(`dashboard.upstreamEditor.claudeCode.window.${row.key}`)}
            <span className="ml-1.5 text-fui-fg3 uppercase text-[10px] tracking-wide" title={t('dashboard.upstreamEditor.claudeCode.fetchedAt', { time: dateTime(row.fetchedAt, locale) })}>
              {t(`dashboard.upstreamEditor.claudeCode.source.${row.source}`)}
            </span>
          </Text>
          <Text size={200} className="text-fui-fg2">
            {clampPercent(row.percent)}%{row.status ? ` · ${row.status}` : ''}
          </Text>
        </div>
        <ProgressBar color={quotaBarColor(row.percent)} max={100} thickness="large" value={clampPercent(row.percent)} />
        {row.resetAt && <Text size={200} className="text-fui-fg3">
          {t('dashboard.upstreamEditor.claudeCode.resetsAt', { time: dateTime(row.resetAt, locale) })}
        </Text>}
      </div>)}
    </div>}

    <div className="flex flex-wrap items-center gap-2 empty:hidden">
      {quota?.representativeClaim && <Badge appearance="outline">
        {t('dashboard.upstreamEditor.claudeCode.representative', { claim: quota.representativeClaim })}
      </Badge>}
      {quota?.overage?.status === 'allowed' && <Badge appearance="tint" color="success">
        {t('dashboard.upstreamEditor.claudeCode.overageAllowed')}
      </Badge>}
      {disabledReason && <Badge appearance="tint" color="danger">
        {t('dashboard.upstreamEditor.claudeCode.disabledReason', { reason: disabledReason })}
      </Badge>}
      {quota?.fallbackAvailable === false && <Badge appearance="tint" color="warning">
        {t('dashboard.upstreamEditor.claudeCode.fallbackUnavailable')}
      </Badge>}
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

    <div className="flex flex-wrap gap-x-4 gap-y-1 border-0 border-t border-solid border-fui-stroke2 pt-3">
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
};

const EntryList = ({ entries }: { entries: [string, string][] }) => <dl className="grid gap-1 m-0">
  {entries.map(([key, value]) => <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
    <dt className="truncate font-mono mono-size-xs text-xs text-fui-fg3" title={key}>{key}</dt>
    <dd className="truncate font-mono mono-size-xs text-xs text-fui-fg2 m-0" title={value}>{value}</dd>
  </div>)}
</dl>;
