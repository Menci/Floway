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
import { ProviderBadge } from '../upstreams/provider-badge';

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
    <OutcomeMessageBar
      action={<Button disabledFocusable={resetting} icon={<ArrowResetRegular />} onClick={() => void reset()} size="small">
        {t('dashboard.proxy.backoff.resetAll')}
      </Button>}
      intent="warning"
    >
      {t('dashboard.proxy.backoff.summary', { count: active.length })}
    </OutcomeMessageBar>

    <ul className="m-0 min-w-0 list-none p-0">
      {active.map(row => {
        const remaining = row.expires_at - nowSeconds;
        return <li className="grid min-w-0 gap-1 border-0 border-t border-solid border-fui-divider py-3 first:border-t-0 first:pt-1 last:pb-1" key={`${row.proxy_id}:${row.upstream_id}`}>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
              <ProviderBadge label={row.upstream.name} upstream={row.upstream} />
              <div className="flex flex-wrap gap-x-3 text-fui-fg2 text-[12px] leading-4">
                <span className="tabular-nums">{t('dashboard.proxy.backoff.failures', { count: row.fail_count })}</span>
                <span className="tabular-nums">{remaining <= 0
                  ? t('dashboard.proxy.backoff.expiring')
                  : t('dashboard.proxy.backoff.remaining', { duration: formatCountdown(remaining, locale) })}</span>
              </div>
            </div>
            <Button className="flex-none" disabledFocusable={resetting} onClick={() => void reset(row.upstream_id)} size="small">
              {t('dashboard.proxy.backoff.reset')}
            </Button>
          </div>
          {row.last_error && <Text block className="font-mono" size={200}>{row.last_error}</Text>}
        </li>;
      })}
    </ul>

    {resetError && <OutcomeMessageBar onDismiss={() => setResetError(null)}>{resetError}</OutcomeMessageBar>}
  </section>;
}
