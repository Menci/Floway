import { ArrowResetRegular } from '@fluentui/react-icons';
import { useState } from 'react';

import { api, callApi } from '../../api/client';
import type { BackoffRow } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatCountdown } from '../../lib/format-duration';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { TruncationTooltip } from '../ui/truncation-tooltip';

const { Button, Text } = fluentComponents;

export function ProxyBackoffPanel({ backoffs, onReset, proxyId }: {
  backoffs: readonly BackoffRow[];
  onReset: () => void;
  proxyId: string;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const toasts = useOutcomeToasts();
  const nowSeconds = useNow(1000) / 1000;
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  // `>=` keeps a row visible through its expiry second, so the countdown's last
  // tick renders instead of the row vanishing before the delta reaches zero.
  const active = backoffs
    .filter(row => row.proxy_id === proxyId && row.expires_at >= nowSeconds)
    .toSorted((left, right) => left.expires_at - right.expires_at);

  if (active.length === 0) return null;

  const reset = async (upstreamId?: string) => {
    setResetError(null);
    setResetting(true);
    const handle = toasts.start(t('dashboard.proxy.toast.backoff.pending'));
    const { error } = await callApi(() => api.api.proxies[':id'].backoffs.reset.$post({
      param: { id: proxyId },
      json: upstreamId === undefined ? {} : { upstream_id: upstreamId },
    }));
    setResetting(false);
    if (error) {
      handle.settle();
      setResetError(error.message);
      return;
    }
    handle.succeed(t('dashboard.proxy.toast.backoff.success'));
    onReset();
  };

  return <section className="grid gap-2" aria-label={t('dashboard.proxy.backoff.title')}>
    <div className="flex items-center justify-between gap-2">
      <Text weight="semibold">{t('dashboard.proxy.backoff.title')}</Text>
      <Button appearance="subtle" disabledFocusable={resetting} icon={<ArrowResetRegular />} onClick={() => void reset()} size="small">
        {t('dashboard.proxy.backoff.resetAll')}
      </Button>
    </div>

    <ul className="m-0 grid gap-1 p-0 list-none">
      {active.map(row => {
        const remaining = row.expires_at - nowSeconds;
        return <li className="flex items-center gap-3 rounded-md bg-fui-bg2 px-3 py-2" key={`${row.proxy_id}:${row.upstream_id}`}>
          <TruncationTooltip content={row.upstream_id} relationship="label">
            {measureRef => <Text block size={200} className="winui-focus-rect min-w-0 flex-1 font-mono mono-size-xs" ref={measureRef} tabIndex={0} truncate wrap={false}>{row.upstream_id}</Text>}
          </TruncationTooltip>
          <Text size={200} className="text-fui-fg2">
            {remaining <= 0
              ? t('dashboard.proxy.backoff.expiring')
              : t('dashboard.proxy.backoff.remaining', { duration: formatCountdown(remaining, locale) })}
          </Text>
          <Text size={200} className="text-fui-fg3">{t('dashboard.proxy.backoff.failures', { count: row.fail_count })}</Text>
          {row.last_error && <TruncationTooltip content={row.last_error} relationship="label">
            {measureRef => <Text block size={200} className="winui-focus-rect max-w-[220px] text-fui-fg3" ref={measureRef} tabIndex={0} truncate wrap={false}>{row.last_error}</Text>}
          </TruncationTooltip>}
          <Button appearance="subtle" disabledFocusable={resetting} onClick={() => void reset(row.upstream_id)} size="small">
            {t('dashboard.proxy.backoff.reset')}
          </Button>
        </li>;
      })}
    </ul>

    {resetError && <OutcomeMessageBar onDismiss={() => setResetError(null)}>{resetError}</OutcomeMessageBar>}
  </section>;
}
