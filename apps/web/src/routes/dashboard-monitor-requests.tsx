import { DismissRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, redirect, useNavigate, useSearchParams } from 'react-router';

import type { Route } from './+types/dashboard-monitor-requests';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type { ApiKey } from '../api/types';
import { getSessionToken } from '../auth/session';
import { RequestDetailPanel } from '../components/requests/request-detail';
import { RequestListPanel } from '../components/requests/request-list';
import { collectStream, detectCollectKind, type CollectedStream } from '../components/requests/stream-render';
import { useDumpSubscription } from '../components/requests/use-dump-subscription';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Panel } from '../components/ui/panel';
import { ScrollArea } from '../components/ui/scroll-area';
import { fluentComponents } from '../fluent';
import { dashboardWorkspaceHandle } from '../lib/dashboard-route-handle';
import { useMediaQuery } from '../lib/use-media-query';
import type { DumpMetadata, DumpRecord } from '@floway-dev/gateway/dump-types';

export const handle = dashboardWorkspaceHandle;

const { Button, DrawerBody, DrawerHeader, DrawerHeaderTitle, MessageBar, MessageBarBody, OverlayDrawer, Text } = fluentComponents;

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
  const keysResult = await callApi(() => api.api.keys.$get());
  const keys = keysResult.data?.filter(key => key.dump_retention_seconds !== null) ?? [];
  const url = new URL(request.url);
  const requestedKeyId = url.searchParams.get('key');
  const selectedKeyId = keys.some(key => key.id === requestedKeyId) ? requestedKeyId : keys[0]?.id ?? null;
  const recordId = url.searchParams.get('record');
  if (!selectedKeyId) {
    return { collected: null, error: keysResult.error?.message ?? null, keys, record: null, recordError: null, records: [], recordsError: null, selectedKeyId };
  }
  const [recordsResult, recordResult] = await Promise.all([
    callApi(() => api.api.dump.keys[':keyId'].records.$get({ param: { keyId: selectedKeyId }, query: { limit: '100' } })),
    recordId
      ? callApi(() => api.api.dump.keys[':keyId'].records[':recordId'].$get({ param: { keyId: selectedKeyId, recordId } }))
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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [keyRefresh, setKeyRefresh] = useState<{ source: LoaderData; keys: ApiKey[]; error: string | null } | null>(null);
  const currentKeyRefresh = keyRefresh?.source === loaderData ? keyRefresh : null;
  const keys = currentKeyRefresh?.keys ?? loaderData.keys;
  const keysError = currentKeyRefresh?.error ?? loaderData.error;
  const [detailOpen, setDetailOpen] = useState(false);
  const narrow = useMediaQuery('(max-width: 900px)');
  const selectedRecordId = searchParams.get('record');
  const selectedKeyId = loaderData.selectedKeyId;
  const subscription = useDumpSubscription(selectedKeyId, loaderData.records);

  const updateSelection = useCallback((keyId: string, recordId?: string | null) => {
    const next = new URLSearchParams();
    next.set('key', keyId);
    if (recordId) next.set('record', recordId);
    setSearchParams(next, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    const refresh = async () => {
      const result = await callApi(() => api.api.keys.$get());
      if (result.error) setKeyRefresh({ source: loaderData, keys, error: result.error.message });
      else {
        const nextKeys = result.data.filter(key => key.dump_retention_seconds !== null);
        const nextSelectedKeyId = nextKeys.some(key => key.id === loaderData.selectedKeyId)
          ? loaderData.selectedKeyId
          : nextKeys[0]?.id ?? null;
        if (nextSelectedKeyId !== loaderData.selectedKeyId) {
          const next = new URLSearchParams();
          if (nextSelectedKeyId) next.set('key', nextSelectedKeyId);
          void navigate(`/dashboard/monitor/requests${next.size ? `?${next}` : ''}`, { replace: true });
          return;
        }
        setKeyRefresh({ source: loaderData, keys: nextKeys, error: null });
      }
    };
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [keys, loaderData, navigate]);

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
      ) : selectedKeyId ? narrow ? <>
        <Panel className="!py-0 !block overflow-hidden min-w-0 h-full">
          <RequestListPanel
            apiKeys={keys}
            error={subscription.error ?? loaderData.recordsError ?? keysError}
            hasOlder={subscription.hasOlder}
            onKeyChange={keyId => { setDetailOpen(false); updateSelection(keyId); }}
            onLoadOlder={() => void subscription.loadOlder()}
            onRecordChange={recordId => { updateSelection(selectedKeyId, recordId); setDetailOpen(true); }}
            records={subscription.records}
            selectedKeyId={selectedKeyId}
            selectedRecordId={selectedRecordId}
          />
        </Panel>
        <OverlayDrawer onOpenChange={(_, data) => setDetailOpen(data.open)} open={detailOpen && selectedRecordId !== null} position="end" size="full">
          <DrawerHeader>
            <DrawerHeaderTitle action={<Button appearance="subtle" aria-label={t('dashboard.requests.closeDetails')} icon={<DismissRegular />} onClick={() => setDetailOpen(false)} />}>
              {t('dashboard.requests.detailTitle')}
            </DrawerHeaderTitle>
          </DrawerHeader>
          <DrawerBody className="!p-0 min-h-0">
            <RequestDetailPanel collected={loaderData.collected} error={loaderData.recordError} record={loaderData.record} recordId={selectedRecordId} />
          </DrawerBody>
        </OverlayDrawer>
      </> : (
        <ScrollArea axes="horizontal" className="min-h-0 p-1 -m-1">
          <div className="h-full min-w-[1080px] grid grid-cols-[minmax(700px,1fr)_360px] gap-3">
            <Panel className="!py-0 !block overflow-hidden min-w-0 h-full">
              <RequestDetailPanel collected={loaderData.collected} error={loaderData.recordError} record={loaderData.record} recordId={selectedRecordId} />
            </Panel>
            <Panel className="!py-0 !block overflow-hidden min-w-0 h-full">
              <RequestListPanel
                apiKeys={keys}
                error={subscription.error ?? loaderData.recordsError ?? keysError}
                hasOlder={subscription.hasOlder}
                onKeyChange={keyId => updateSelection(keyId)}
                onLoadOlder={() => void subscription.loadOlder()}
                onRecordChange={recordId => updateSelection(selectedKeyId, recordId)}
                records={subscription.records}
                selectedKeyId={selectedKeyId}
                selectedRecordId={selectedRecordId}
              />
            </Panel>
          </div>
        </ScrollArea>
      ) : null}
    </section>
  );
}
