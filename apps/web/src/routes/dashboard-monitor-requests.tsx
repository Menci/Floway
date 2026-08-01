import { DismissRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, redirect, useNavigate, useSearchParams } from 'react-router';

import type { Route } from './+types/dashboard-monitor-requests';
import { api, callApi } from '../api/client';
import type { ApiKey } from '../api/types';
import { getSessionToken } from '../auth/session';
import { RequestDetailPanel } from '../components/requests/request-detail';
import { refreshRequestKeys } from '../components/requests/request-key-refresh';
import { RequestListPanel } from '../components/requests/request-list';
import { collectStream, detectCollectKind, type CollectedStream } from '../components/requests/stream-render';
import { useDumpSubscription } from '../components/requests/use-dump-subscription';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyState } from '../components/ui/empty-state';
import { PANE_GAP_CLASS } from '../components/ui/layout';
import { OpenLinkLabel } from '../components/ui/open-link-label';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { fluentComponents } from '../fluent';
import { dashboardWorkspaceHandle } from '../lib/dashboard-route-handle';
import { useMediaQuery } from '../lib/use-media-query';
import type { DumpMetadata, DumpRecord } from '@floway-dev/gateway/dump-types';

export const handle = dashboardWorkspaceHandle;

const { Button, DrawerBody, DrawerHeader, DrawerHeaderTitle, OverlayDrawer } = fluentComponents;

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
  // What the page shows, which starts as what the loader returned and is
  // replaced by a key refresh or by the operator dismissing a failure. It is
  // tied to the payload it came from, so a navigation that loads a new one
  // discards it rather than showing one route's keys under another's URL.
  const [replacement, setReplacement] = useState<{ source: LoaderData; keys: ApiKey[]; keysError: string | null; recordsError: string | null } | null>(null);
  const shown = replacement?.source === loaderData
    ? replacement
    : { source: loaderData, keys: loaderData.keys, keysError: loaderData.error, recordsError: loaderData.recordsError };
  const { keys, keysError } = shown;
  const narrow = useMediaQuery('(max-width: 1200px)');
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
    const controller = new AbortController();
    const refresh = () => refreshRequestKeys({
      currentKeys: keys,
      load: signal => callApi(() => api.api.keys.$get(undefined, { init: { signal } })),
      onNavigate: nextSelectedKeyId => {
        const next = new URLSearchParams();
        if (nextSelectedKeyId) next.set('key', nextSelectedKeyId);
        void navigate(`/dashboard/monitor/requests${next.size ? `?${next}` : ''}`, { replace: true });
      },
      onUpdate: (nextKeys, error) => setReplacement(current => ({
        source: loaderData,
        keys: nextKeys,
        keysError: error,
        recordsError: current?.source === loaderData ? current.recordsError : loaderData.recordsError,
      })),
      selectedKeyId: loaderData.selectedKeyId,
      signal: controller.signal,
    });
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      controller.abort();
      window.removeEventListener('focus', onFocus);
    };
  }, [keys, loaderData, navigate]);

  // The list's bar reports whichever of the three streams failed, so clearing
  // it has to clear all three: what the operator dismissed is the message, not
  // one of the sources behind it.
  const dismissListError = () => {
    subscription.dismissError();
    setReplacement({ ...shown, keysError: null, recordsError: null });
  };

  return (
    <section className="h-full min-h-0 grid grid-rows-[auto_minmax(0,1fr)] gap-[18px] min-w-0">
      <DashboardPageHeader description={t('dashboard.pages.requests')} title={t('dashboard.nav.requests')} />
      {keysError && keys.length === 0 ? (
        <OutcomeMessageBar onDismiss={() => setReplacement({ ...shown, keysError: null })}>{keysError}</OutcomeMessageBar>
      ) : keys.length === 0 ? (
        <Panel className="!grid">
          <EmptyState
            action={<Link className="text-fui-brand1 no-underline hover:underline" to="/dashboard/services/api-keys">
              <OpenLinkLabel>{t('dashboard.requests.goToApiKeys')}</OpenLinkLabel>
            </Link>}
            align="start"
            description={t('dashboard.requests.noKeysDescription')}
            title={t('dashboard.requests.noKeys')}
          />
        </Panel>
      ) : selectedKeyId ? narrow ? <>
        <Panel className="!block overflow-hidden min-w-0 h-full" padding="flush">
          <RequestListPanel
            apiKeys={keys}
            error={subscription.error ?? shown.recordsError ?? keysError}
            hasOlder={subscription.hasOlder}
            onDismissError={dismissListError}
            onKeyChange={keyId => updateSelection(keyId)}
            onLoadOlder={() => void subscription.loadOlder()}
            onRecordChange={recordId => updateSelection(selectedKeyId, recordId)}
            records={subscription.records}
            selectedKeyId={selectedKeyId}
            selectedRecordId={selectedRecordId}
          />
        </Panel>
        <OverlayDrawer onOpenChange={(_, data) => { if (!data.open) updateSelection(selectedKeyId); }} open={selectedRecordId !== null} position="end" size="full">
          <DrawerHeader>
            <DrawerHeaderTitle action={<Button appearance="subtle" aria-label={t('dashboard.requests.closeDetails')} icon={<DismissRegular />} onClick={() => updateSelection(selectedKeyId)} />}>
              {t('dashboard.requests.detailTitle')}
            </DrawerHeaderTitle>
          </DrawerHeader>
          <DrawerBody className="!p-0 min-h-0">
            <RequestDetailPanel collected={loaderData.collected} error={loaderData.recordError} record={loaderData.record} recordId={selectedRecordId} />
          </DrawerBody>
        </OverlayDrawer>
      </> : (
        <div className={`h-full min-h-0 min-w-0 grid grid-cols-[minmax(0,1fr)_420px] ${PANE_GAP_CLASS}`}>
          <Panel className="!block overflow-hidden min-w-0 h-full" padding="flush">
            <RequestDetailPanel collected={loaderData.collected} error={loaderData.recordError} record={loaderData.record} recordId={selectedRecordId} />
          </Panel>
          <Panel className="!block overflow-hidden min-w-0 h-full" padding="flush">
            <RequestListPanel
              apiKeys={keys}
              error={subscription.error ?? shown.recordsError ?? keysError}
              hasOlder={subscription.hasOlder}
              onDismissError={dismissListError}
              onKeyChange={keyId => updateSelection(keyId)}
              onLoadOlder={() => void subscription.loadOlder()}
              onRecordChange={recordId => updateSelection(selectedKeyId, recordId)}
              records={subscription.records}
              selectedKeyId={selectedKeyId}
              selectedRecordId={selectedRecordId}
            />
          </Panel>
        </div>
      ) : null}
    </section>
  );
}
