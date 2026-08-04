import { DismissRegular } from '@fluentui/react-icons';
import { useCallback, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-monitor-requests';
import { requireDashboardSession } from './guards';
import { api, callApi } from '../api/client';
import type { ApiKey } from '../api/types';
import { RequestDetailPanel } from '../components/requests/detail';
import { refreshRequestKeys } from '../components/requests/key-refresh';
import { RequestListPanel } from '../components/requests/list';
import { collectStream, detectCollectKind, type CollectedStream } from '../components/requests/stream-render';
import { useDumpSubscription } from '../components/requests/use-dump-subscription';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyState, EmptyStateLine } from '../components/ui/empty-state';
import { PANE_GAP_CLASS } from '../components/ui/layout';
import { OpenLinkLabel } from '../components/ui/open-link-label';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { RouteLink } from '../components/ui/route-link';
import { usePollWhileVisible } from '../components/ui/use-poll-while-visible';
import { useRefresh } from '../components/ui/use-refresh';
import { fluentComponents } from '../fluent';
import { dashboardWorkspaceHandle } from '../lib/dashboard-route-handle';
import { useEntryRewrite } from '../lib/page-navigation';
import { useMediaQuery } from '../lib/use-media-query';
import type { DumpMetadata, DumpRecord } from '@floway-dev/gateway/dump-types';

export const handle = dashboardWorkspaceHandle;

const { Button, DrawerBody, DrawerHeader, DrawerHeaderTitle, OverlayDrawer } = fluentComponents;

// `null` is a fetch that failed, distinct from an account that genuinely holds
// no key with dump retention: an empty list sends the operator off to create a
// key they may already have.
interface LoaderData {
  collected: CollectedStream | null;
  error: string | null;
  keys: ApiKey[] | null;
  record: DumpRecord | null;
  recordError: string | null;
  records: DumpMetadata[];
  recordsError: string | null;
  selectedKeyId: string | null;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs): Promise<LoaderData> {
  requireDashboardSession();
  const keysResult = await callApi(() => api.api.keys.$get());
  const keys = keysResult.data?.filter(key => key.dump_retention_seconds !== null) ?? null;
  const url = new URL(request.url);
  const requestedKeyId = url.searchParams.get('key');
  const selectedKeyId = keys === null
    ? null
    : keys.some(key => key.id === requestedKeyId) ? requestedKeyId : keys[0]?.id ?? null;
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

// The page holds its selection in the URL, so the list rows read their address
// from the same builder the selection is written with.
const selectionSearch = (keyId: string, recordId?: string | null): URLSearchParams => {
  const search = new URLSearchParams();
  search.set('key', keyId);
  if (recordId) search.set('record', recordId);
  return search;
};

export default function DashboardMonitorRequests({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const rewrite = useEntryRewrite();
  // Tied to the loader payload it came from: a navigation discards it rather than showing one route's keys under another's URL.
  const [replacement, setReplacement] = useState<{ source: LoaderData; keys: ApiKey[] | null; keysError: string | null; recordsError: string | null } | null>(null);
  const shown = replacement?.source === loaderData
    ? replacement
    : { source: loaderData, keys: loaderData.keys, keysError: loaderData.error, recordsError: loaderData.recordsError };
  const { keys, keysError } = shown;
  const narrow = useMediaQuery('(max-width: 1200px)');
  const selectedRecordId = searchParams.get('record');
  const selectedKeyId = loaderData.selectedKeyId;
  const subscription = useDumpSubscription(selectedKeyId, loaderData.records);

  const updateSelection = useCallback((keyId: string, recordId?: string | null) => {
    setSearchParams(selectionSearch(keyId, recordId), rewrite);
  }, [rewrite, setSearchParams]);

  const reloadKeys = useCallback((signal: AbortSignal) => refreshRequestKeys({
    currentKeys: keys,
    load: keySignal => callApi(() => api.api.keys.$get(undefined, { init: { signal: keySignal } })),
    onNavigate: nextSelectedKeyId => {
      const next = nextSelectedKeyId === null ? new URLSearchParams() : selectionSearch(nextSelectedKeyId);
      void navigate(`/dashboard/monitor/requests${next.size ? `?${next}` : ''}`, rewrite);
    },
    onUpdate: (nextKeys, error) => setReplacement(current => ({
      source: loaderData,
      keys: nextKeys,
      keysError: error,
      recordsError: current?.source === loaderData ? current.recordsError : loaderData.recordsError,
    })),
    selectedKeyId: loaderData.selectedKeyId,
    signal,
  }), [keys, loaderData, navigate, rewrite]);

  const { poll } = useRefresh(reloadKeys);
  usePollWhileVisible(poll);

  // One bar reports whichever of the three sources failed, so a dismissal clears all three.
  const dismissListError = () => {
    subscription.dismissError();
    setReplacement({ ...shown, keysError: null, recordsError: null });
  };

  return (
    <section className="h-full min-h-0 grid grid-rows-[auto_minmax(0,1fr)] gap-[18px] min-w-0">
      <DashboardPageHeader description={t('dashboard.pages.requests')} title={t('dashboard.nav.requests')} />
      {keysError && (keys === null || keys.length === 0) ? (
        <OutcomeMessageBar onDismiss={() => setReplacement({ ...shown, keysError: null })}>{keysError}</OutcomeMessageBar>
      ) : keys === null ? (
        <Panel className="!grid"><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel>
      ) : keys.length === 0 ? (
        <Panel className="!grid">
          <EmptyState
            action={<RouteLink to="/dashboard/services/api-keys">
              <OpenLinkLabel>{t('dashboard.requests.apiKeysLink')}</OpenLinkLabel>
            </RouteLink>}
            align="start"
            description={t('dashboard.requests.noKeysDescription')}
            title={t('dashboard.requests.noKeys')}
          />
        </Panel>
      ) : selectedKeyId ? narrow ? <>
        <Panel className="!block overflow-hidden min-w-0 h-full" padding="flush">
          <RequestListPanel
            addressOfRecord={recordId => `?${selectionSearch(selectedKeyId, recordId)}`}
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
        {/* Closing drops `record` from the URL at once, while Fluent slides the
            surface out, so the panel retains the record it was drawing until
            `unmountOnClose` fires. The retained record is no longer actionable,
            so it leaves `inert`; that attribute sits on an element of ours
            because Fluent forwards only its own allowlisted native props to a
            slot's DOM node. */}
        <OverlayDrawer onOpenChange={(_, data) => { if (!data.open) updateSelection(selectedKeyId); }} open={selectedRecordId !== null} position="end" size="full">
          <DrawerHeader>
            <DrawerHeaderTitle action={<Button appearance="subtle" aria-label={t('dashboard.requests.closeDetails')} icon={<DismissRegular />} onClick={() => updateSelection(selectedKeyId)} />}>
              {t('dashboard.requests.detailTitle')}
            </DrawerHeaderTitle>
          </DrawerHeader>
          <DrawerBody className="!p-0 min-h-0">
            <div className="h-full min-h-0" inert={selectedRecordId === null}>
              <RequestDetailPanel collected={loaderData.collected} error={loaderData.recordError} record={loaderData.record} recordId={selectedRecordId} retainLastRecord />
            </div>
          </DrawerBody>
        </OverlayDrawer>
      </> : (
        <div className={`h-full min-h-0 min-w-0 grid grid-cols-[minmax(0,1fr)_420px] ${PANE_GAP_CLASS}`}>
          <Panel className="!block overflow-hidden min-w-0 h-full" padding="flush">
            <RequestDetailPanel collected={loaderData.collected} error={loaderData.recordError} record={loaderData.record} recordId={selectedRecordId} retainLastRecord={false} />
          </Panel>
          <Panel className="!block overflow-hidden min-w-0 h-full" padding="flush">
            <RequestListPanel
              addressOfRecord={recordId => `?${selectionSearch(selectedKeyId, recordId)}`}
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
