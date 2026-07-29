import { ArrowClockwiseRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { callApi } from '../../api/auth';
import { api } from '../../api/client';
import type { CopilotQuotaSnapshot, UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';

const { Button, MessageBar, MessageBarBody, ProgressBar, Text } = fluentComponents;

// Copilot's own client derives premium-interaction usage from the on-demand
// `copilot_internal/user` snapshot:
// https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/chat/common/chatQuotaServiceImpl.ts#L83-L120
export const CopilotQuotaCard = ({ record }: { record: Extract<UpstreamRecord, { kind: 'copilot' }> }) => {
  const { t } = useTranslation();
  const [quota, setQuota] = useState<CopilotQuotaSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    const { data, error: failure } = await callApi(
      () => api.api.upstreams.copilot.quota.$post({ json: { record: { id: record.id, kind: 'copilot', config: record.config, state: record.state ?? null } } }),
    );
    setLoading(false);
    if (failure) {
      setError(failure.message);
      return;
    }
    setQuota(data ?? null);
  };

  const premium = quota?.quota_snapshots?.premium_interactions;
  const used = premium && !premium.unlimited && premium.entitlement > 0 ? Math.max(0, premium.entitlement - premium.remaining) : null;
  const usedFraction = premium && !premium.unlimited && premium.entitlement > 0 && used !== null
    ? Math.min(1, used / premium.entitlement)
    : null;

  return <section className="grid gap-2">
    <div className="flex items-center justify-between gap-3">
      <Text as="h3" size={300} weight="semibold" className="!m-0">{t('dashboard.upstreamEditor.copilot.quota.title')}</Text>
      <Button appearance="subtle" disabled={loading} icon={<ArrowClockwiseRegular />} onClick={() => void load()}>
        {loading
          ? t('dashboard.upstreamEditor.copilot.quota.loading')
          : quota
            ? t('dashboard.upstreamEditor.copilot.quota.refresh')
            : t('dashboard.upstreamEditor.copilot.quota.load')}
      </Button>
    </div>

    {premium && used !== null && usedFraction !== null && <div className="grid gap-1">
      <ProgressBar max={1} value={usedFraction} thickness="large" />
      <Text size={200} className="text-fui-fg2">
        {t('dashboard.upstreamEditor.copilot.quota.used', { used, entitlement: premium.entitlement })}
      </Text>
      {quota.quota_reset_date && <Text size={200} className="text-fui-fg3">
        {t('dashboard.upstreamEditor.copilot.quota.resets', { date: quota.quota_reset_date })}
      </Text>}
    </div>}

    {quota && (!premium || premium.unlimited) && <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.copilot.quota.unmetered')}</Text>}

    {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
  </section>;
};
