import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, redirect, useSearchParams } from 'react-router';

import type { Route } from './+types/dashboard-monitor-requests';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type { ApiKey } from '../api/types';
import { getSessionToken } from '../auth/session';
import { RequestDetailPanel } from '../components/requests/request-detail';
import { RequestListPanel } from '../components/requests/request-list';
import { useDumpSubscription } from '../components/requests/use-dump-subscription';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { PageLoadingPanel } from '../components/ui/page-loading-panel';
import { Panel } from '../components/ui/panel';
import { fluentComponents } from '../fluent';

const { MessageBar, MessageBarBody, Text } = fluentComponents;

interface LoaderData {
  keys: ApiKey[] | null;
  error: string | null;
}

export async function clientLoader(): Promise<LoaderData> {
  if (!getSessionToken()) throw redirect('/');
  const result = await callApi<ApiKey[]>(() => api.api.keys.$get());
  return result.error
    ? { keys: null, error: result.error.message }
    : { keys: result.data.filter(key => key.dump_retention_seconds !== null), error: null };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Requests | Floway' }];
}

export default function DashboardMonitorRequests({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [keys, setKeys] = useState(loaderData.keys);
  const [keysError, setKeysError] = useState(loaderData.error);
  const requestedKeyId = searchParams.get('key');
  const selectedRecordId = searchParams.get('record');
  const selectedKeyId = keys?.some(key => key.id === requestedKeyId)
    ? requestedKeyId
    : keys?.[0]?.id ?? null;
  const subscription = useDumpSubscription(selectedKeyId);

  const updateSelection = useCallback((keyId: string, recordId?: string | null) => {
    const next = new URLSearchParams();
    next.set('key', keyId);
    if (recordId) next.set('record', recordId);
    setSearchParams(next, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    if (selectedKeyId && selectedKeyId !== requestedKeyId) updateSelection(selectedKeyId);
  }, [requestedKeyId, selectedKeyId, updateSelection]);

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
      {keysError && !keys ? (
        <MessageBar intent="error"><MessageBarBody>{keysError}</MessageBarBody></MessageBar>
      ) : keys?.length === 0 ? (
        <Panel className="!p-[28px] grid place-items-center text-center">
          <div className="grid justify-items-center gap-2 max-w-[480px]">
            <Text weight="semibold" className="!text-center">{t('dashboard.requests.noKeys')}</Text>
            <Text size={300} className="text-fui-fg3 !text-center">{t('dashboard.requests.noKeysDescription')}</Text>
            <Link to="/dashboard/services/api-keys" className="text-fui-fg2">{t('dashboard.requests.goToApiKeys')}</Link>
          </div>
        </Panel>
      ) : selectedKeyId && keys ? (
        <div className="min-h-0 overflow-x-auto [scrollbar-gutter:stable] p-1 -m-1">
          <div className="h-full min-w-[1080px] grid grid-cols-[minmax(700px,1fr)_360px] gap-3">
            <Panel className="!py-0 !block overflow-hidden min-w-0 h-full">
              <RequestDetailPanel keyId={selectedKeyId} recordId={selectedRecordId} />
            </Panel>
            <Panel className="!py-0 !block overflow-hidden min-w-0 h-full">
              <RequestListPanel
                apiKeys={keys}
                error={subscription.error ?? keysError}
                hasOlder={subscription.hasOlder}
                loading={subscription.loading}
                loadingOlder={subscription.loadingOlder}
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
      ) : (
        <PageLoadingPanel label={t('common.loading')} />
      )}
    </section>
  );
}
