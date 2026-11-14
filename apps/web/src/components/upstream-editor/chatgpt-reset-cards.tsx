import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, callApi } from '../../api/client';
import type { ChatGPTRateLimitResetCredit, ChatGPTRateLimitResetCredits } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { Panel } from '../ui/panel';
import { ResourceListActions } from '../ui/resource-list';
import { SectionHeader } from '../ui/section-header';
import { useDialogInvocation } from '../ui/use-dialog-invocation';
import { useRefresh } from '../ui/use-refresh';
import { chatgptResetCreditIsUsable, type ChatGPTRecord } from '../upstreams/chatgpt-account';
import { WALL_CLOCK_REFRESH_MS } from '../upstreams/subscription-quota';

const { Button, Text } = fluentComponents;

interface RedeemInvocation {
  credit: ChatGPTRateLimitResetCredit;
  idempotencyKey: string;
}

const outcomeKey = (code: string): 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit' | 'unknown' => {
  if (code === 'reset') return 'reset';
  if (code === 'already_redeemed') return 'alreadyRedeemed';
  if (code === 'nothing_to_reset') return 'nothingToReset';
  if (code === 'no_credit') return 'noCredit';
  return 'unknown';
};

const statusKey = (status: string): 'available' | 'expired' | 'redeemed' | 'redeeming' | null => {
  if (status === 'available' || status === 'expired' || status === 'redeemed' || status === 'redeeming') return status;
  return null;
};

export function ChatGPTResetCards({ onQuotaReset, record }: {
  onQuotaReset: () => void;
  record: ChatGPTRecord;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const now = useNow(WALL_CLOCK_REFRESH_MS);
  const [cards, setCards] = useState<ChatGPTRateLimitResetCredits | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ code: string; warning: string | null } | null>(null);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const redeemingRef = useRef(false);
  const redemptionKeys = useRef(new Map<string, string>());
  const dialog = useDialogInvocation<RedeemInvocation>();
  const envelope = useMemo(() => ({
    id: record.id,
    kind: 'chatgpt' as const,
    config: record.config,
    state: record.state,
    proxy_fallback_list: record.proxy_fallback_list,
  }), [record.config, record.id, record.proxy_fallback_list, record.state]);

  const { cancel: cancelLoad, refresh: load, refreshing: loading } = useRefresh(useCallback(async (signal: AbortSignal) => {
    setLoadError(null);
    const { data, error } = await callApi(() => api.api.upstreams.chatgpt['reset-credits'].$post(
      { json: { record: envelope } },
      { init: { signal } },
    ));
    if (signal.aborted) return;
    if (error) {
      setLoadError(t('dashboard.upstreamEditor.chatgpt.resetCards.loadError'));
      return;
    }
    setCards(data.reset_credits);
  }, [envelope, t]));

  useEffect(() => {
    if (record.id !== '' && !redeemingRef.current) void load();
  }, [load, record.id]);

  const redeem = async () => {
    const invocation = dialog.invocation?.value;
    if (!invocation || redeemingRef.current) return;
    redeemingRef.current = true;
    cancelLoad();
    setRedeeming(true);
    setRedeemError(null);
    try {
      const { data, error } = await callApi(() => api.api.upstreams.chatgpt['reset-credits'].consume.$post({
        json: {
          record: envelope,
          credit_id: invocation.credit.id,
          idempotency_key: invocation.idempotencyKey,
        },
      }));
      if (error) {
        setRedeemError(t('dashboard.upstreamEditor.chatgpt.resetCards.redeemError'));
        return;
      }
      setCards(data.reset_credits);
      if (data.outcome.code === 'nothing_to_reset') redemptionKeys.current.delete(invocation.credit.id);
      if (data.outcome.code === 'reset' || data.outcome.code === 'already_redeemed') onQuotaReset();
      setOutcome({ code: data.outcome.code, warning: data.refresh_error });
      dialog.close();
    } finally {
      redeemingRef.current = false;
      setRedeeming(false);
    }
  };

  const selected = dialog.invocation?.value.credit;
  const resultKey = outcome === null ? null : outcomeKey(outcome.code);

  return <section className="grid gap-3 border-0 border-t border-solid border-fui-divider pt-4">
    <SectionHeader
      level={3}
      title={t('dashboard.upstreamEditor.chatgpt.resetCards.title')}
      description={cards === null ? undefined : t('dashboard.upstreamEditor.chatgpt.resetCards.available', { count: cards.available_count })}
      actions={<ResourceListActions
        appearance="subtle"
        disabled={record.id === '' || dialog.isOpen || redeeming}
        onRefresh={() => void load()}
        refreshLabel={t('dashboard.upstreamEditor.chatgpt.resetCards.refresh')}
        refreshing={loading}
      />}
    />

    {cards?.credits.map(credit => {
      const usable = chatgptResetCreditIsUsable(credit, now);
      const knownStatus = credit.status === 'available' && credit.expires_at !== null && Date.parse(credit.expires_at) <= now
        ? 'expired'
        : statusKey(credit.status);
      return <Panel key={credit.id}>
        <div className="flex items-center justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <Text weight="semibold">{credit.title ?? t('dashboard.upstreamEditor.chatgpt.resetCards.defaultTitle')}</Text>
            {credit.description && <Text size={200} className="text-fui-fg2">{credit.description}</Text>}
          </div>
          <Button appearance={usable ? 'primary' : 'secondary'} className="shrink-0" disabled={!usable || loading || loadError !== null || redeeming} onClick={() => {
            cancelLoad();
            const idempotencyKey = redemptionKeys.current.get(credit.id) ?? crypto.randomUUID();
            redemptionKeys.current.set(credit.id, idempotencyKey);
            setRedeemError(null);
            dialog.open({ credit, idempotencyKey });
          }}>
            {usable
              ? t('dashboard.upstreamEditor.chatgpt.resetCards.useShort')
              : knownStatus === null ? credit.status : t(`dashboard.upstreamEditor.chatgpt.resetCards.status.${knownStatus}`)}
          </Button>
        </div>
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
          <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.chatgpt.resetCards.granted', { time: dateTime(credit.granted_at, locale) })}</Text>
          <Text size={200} className="ml-auto text-right text-fui-fg3">{credit.expires_at === null
            ? t('dashboard.upstreamEditor.chatgpt.resetCards.noExpiry')
            : t('dashboard.upstreamEditor.chatgpt.resetCards.expires', { time: dateTime(credit.expires_at, locale) })}</Text>
        </div>
      </Panel>;
    })}

    {cards !== null && cards.credits.length === 0 && !loading && !loadError && <Text size={200} className="text-fui-fg3">
      {t('dashboard.upstreamEditor.chatgpt.resetCards.empty')}
    </Text>}
    {loadError && <OutcomeMessageBar>{loadError}</OutcomeMessageBar>}
    {outcome && resultKey && <OutcomeMessageBar
      intent={resultKey === 'reset' || resultKey === 'alreadyRedeemed' ? 'success' : 'info'}
      onDismiss={() => setOutcome(null)}
    >
      <span>{resultKey === 'unknown'
        ? t('dashboard.upstreamEditor.chatgpt.resetCards.result.unknown', { code: outcome.code })
        : t(`dashboard.upstreamEditor.chatgpt.resetCards.result.${resultKey}`)}</span>
      {outcome.warning && <span>{t('dashboard.upstreamEditor.chatgpt.resetCards.refreshWarning')}</span>}
    </OutcomeMessageBar>}

    {dialog.invocation && selected && <ConfirmDialog
      key={dialog.invocation.key}
      actionIntent="primary"
      actionLabel={t('dashboard.upstreamEditor.chatgpt.resetCards.use')}
      busy={redeeming}
      error={redeemError}
      message={t('dashboard.upstreamEditor.chatgpt.resetCards.confirmMessage', { title: selected.title ?? t('dashboard.upstreamEditor.chatgpt.resetCards.defaultTitle') })}
      onConfirm={() => void redeem()}
      onDismissError={() => setRedeemError(null)}
      onExited={() => setRedeemError(null)}
      onOpenChange={open => { if (!open) dialog.close(); }}
      open={dialog.isOpen}
      title={t('dashboard.upstreamEditor.chatgpt.resetCards.confirmTitle')}
    />}
  </section>;
}
