import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, redirect, useSearchParams } from 'react-router';

import type { Route } from './+types/dashboard-monitor-requests';
import { authFetch, callApi } from '../api/auth';
import { api } from '../api/client';
import type { ApiKey } from '../api/types';
import { getSessionToken } from '../auth/session';
import { RequestDetailPanel } from '../components/requests/request-detail';
import { RequestListPanel } from '../components/requests/request-list';
import { collectStream, detectCollectKind, type CollectedStream } from '../components/requests/stream-render';
import { useDumpSubscription } from '../components/requests/use-dump-subscription';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Panel } from '../components/ui/panel';
import { fluentComponents } from '../fluent';
import type { DumpMetadata, DumpRecord } from '@floway-dev/gateway/dump-types';

const { MessageBar, MessageBarBody, Text } = fluentComponents;

interface LoaderData {
  collected: CollectedStream | null;
  error: string | null;
  keys: ApiKey[];
  record: DumpRecord | null;
  recordError: string | null;
  records: DumpMetadata[];
  recordsError: string | null;
  selectedKeyId: string | null;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<LoaderData> {
  if (!getSessionToken()) throw redirect('/');
  const keysResult = await callApi<ApiKey[]>(() => api.api.keys.$get());
  const keys = keysResult.data?.filter(key => key.dump_retention_seconds !== null) ?? [];
  const url = new URL(request.url);
  const requestedKeyId = url.searchParams.get('key');
  const selectedKeyId = keys.some(key => key.id === requestedKeyId) ? requestedKeyId : keys[0]?.id ?? null;
  const recordId = url.searchParams.get('record');
  if (!selectedKeyId) {
    return { collected: null, error: keysResult.error?.message ?? null, keys, record: null, recordError: null, records: [], recordsError: null, selectedKeyId };
  }
  const [recordsResult, recordResult] = await Promise.all([
    callApi<{ records: DumpMetadata[] }>(() => authFetch(`/api/dump/keys/${encodeURIComponent(selectedKeyId)}/records?limit=100`)),
    recordId
      ? callApi<DumpRecord>(() => authFetch(`/api/dump/keys/${encodeURIComponent(selectedKeyId)}/records/${encodeURIComponent(recordId)}`))
      : Promise.resolve(null),
  ]);
  const record = recordResult?.data ?? null;
  const collectKind = record ? detectCollectKind(record.meta.path) : null;
  const streamEvents = record?.response.body.type === 'stream' ? record.response.body.events : [];
  const collected = collectKind && streamEvents.length ? await collectStream(collectKind, streamEvents) : null;
  return {
    collected,
    error: keysResult.error?.message ?? null,
    keys,
    record,
    recordError: recordResult?.error?.message ?? null,
    records: recordsResult.data?.records ?? [],
    recordsError: recordsResult.error?.message ?? null,
    selectedKeyId,
  };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Requests | Floway' }];
}

export default function DashboardMonitorRequests({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [keys, setKeys] = useState(loaderData.keys);
  const [keysError, setKeysError] = useState(loaderData.error);
  const selectedRecordId = searchParams.get('record');
  const selectedKeyId = keys.some(key => key.id === loaderData.selectedKeyId)
    ? loaderData.selectedKeyId
    : keys[0]?.id ?? null;
  const subscription = useDumpSubscription(selectedKeyId, loaderData.records);

  const updateSelection = useCallback((keyId: string, recordId?: string | null) => {
    const next = new URLSearchParams();
    next.set('key', keyId);
    if (recordId) next.set('record', recordId);
    setSearchParams(next, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    const refresh = async () => {
      const result = await callApi<ApiKey[]>(() => api.api.keys.$get());
      if (result.error) setKeysError(result.error.message);
      else {
        setKeys(result.data.filter(key => key.dump_retention_seconds !== null));
        setKeysError(null);
      }
    };
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return (
    <section className="h-full min-h-0 grid grid-rows-[auto_minmax(0,1fr)] gap-[18px] min-w-0">
      <DashboardPageHeader description={t('dashboard.pages.requests')} eyebrow={t('dashboard.groups.monitor')} title={t('dashboard.nav.requests')} />
      {keysError && keys.length === 0 ? (
        <MessageBar intent="error"><MessageBarBody>{keysError}</MessageBarBody></MessageBar>
      ) : keys.length === 0 ? (
        <Panel className="!p-[28px] grid place-items-center text-center">
          <div className="grid justify-items-center gap-2 max-w-[480px]">
            <Text weight="semibold" className="!text-center">{t('dashboard.requests.noKeys')}</Text>
            <Text size={300} className="text-fui-fg3 !text-center">{t('dashboard.requests.noKeysDescription')}</Text>
            <Link to="/dashboard/services/api-keys" className="text-fui-fg2">{t('dashboard.requests.goToApiKeys')}</Link>
          </div>
        </Panel>
      ) : selectedKeyId ? (
        <div className="min-h-0 overflow-x-auto [scrollbar-gutter:stable] p-1 -m-1">
          <div className="h-full min-w-[1080px] grid grid-cols-[minmax(700px,1fr)_360px] gap-3">
            <Panel className="!py-0 !block overflow-hidden min-w-0 h-full">
              <RequestDetailPanel collected={loaderData.collected} error={loaderData.recordError} record={loaderData.record} recordId={selectedRecordId} />
            </Panel>
            <Panel className="!py-0 !block overflow-hidden min-w-0 h-full">
              <RequestListPanel
                apiKeys={keys}
                error={subscription.error ?? loaderData.recordsError ?? keysError}
                hasOlder={subscription.hasOlder}
                loading={subscription.loading}
                onKeyChange={keyId => updateSelection(keyId)}
                onLoadOlder={() => void subscription.loadOlder()}
                onRecordChange={recordId => updateSelection(selectedKeyId, recordId)}
                records={subscription.records}
                selectedKeyId={selectedKeyId}
                selectedRecordId={selectedRecordId}
              />
            </Panel>
          </div>
        </div>
      ) : null}
    </section>
  );
}
