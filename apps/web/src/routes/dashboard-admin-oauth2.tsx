import { useCallback, useState } from 'react';

import type { Route } from './+types/dashboard-admin-oauth2';
import { requireDashboardAdmin } from './guards';
import { api, callApi, callApiNoContent } from '../api/client';
import type { OAuth2Provider, OAuth2Settings } from '../api/types';
import { OAuth2ProviderDialog } from '../components/oauth2/dialog';
import { OAuth2ProviderList } from '../components/oauth2/list';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { Input } from '../components/ui/fluent-form-controls';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { ResourceListActions, ResourceListPanel } from '../components/ui/resource-list';
import { SectionHeader } from '../components/ui/section-header';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { useRefresh } from '../components/ui/use-refresh';
import { fluentComponents } from '../fluent';
import { useTranslation } from '../i18n/translation';

const { Button, Field, Spinner } = fluentComponents;

interface LoaderData {
  error: string | null;
  providers: OAuth2Provider[] | null;
  settings: OAuth2Settings | null;
}

const loadPageData = async (signal?: AbortSignal): Promise<LoaderData> => {
  const [settings, providers] = await Promise.all([
    callApi(() => api.api.oauth2.settings.$get(undefined, { init: { signal } })),
    callApi(() => api.api.oauth2.providers.$get(undefined, { init: { signal } })),
  ]);
  return {
    error: settings.error?.message ?? providers.error?.message ?? null,
    providers: providers.data ?? null,
    settings: settings.data ?? null,
  };
};

export async function clientLoader(): Promise<LoaderData> {
  await requireDashboardAdmin();
  return await loadPageData();
}

export default function DashboardAdminOAuth2({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [data, setData] = useState(loaderData);
  const [pageError, setPageError] = useState(loaderData.error);
  const [publicBaseUrl, setPublicBaseUrl] = useState(loaderData.settings?.public_base_url ?? '');
  const [savingSettings, setSavingSettings] = useState(false);
  const editorDialog = useDialogInvocation<OAuth2Provider | null>();
  const deleteDialog = useDialogInvocation<OAuth2Provider>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = useCallback(async (signal: AbortSignal) => {
    const next = await loadPageData(signal);
    if (signal.aborted) return;
    setData(next);
    setPageError(next.error);
    if (next.settings) setPublicBaseUrl(next.settings.public_base_url);
  }, []);
  const { refresh, refreshing } = useRefresh(reload);

  const saveSettings = async () => {
    if (savingSettings) return;
    setSavingSettings(true);
    setPageError(null);
    const handle = toasts.start(t('dashboard.oauth2.toast.settings.pending'));
    const result = await callApi(() => api.api.oauth2.settings.$put({
      json: { public_base_url: publicBaseUrl.trim() },
    }));
    setSavingSettings(false);
    if (result.error) {
      handle.settle();
      setPageError(result.error.message);
      return;
    }
    setData(current => ({ ...current, settings: result.data }));
    setPublicBaseUrl(result.data.public_base_url);
    handle.succeed(t('dashboard.oauth2.toast.settings.success'));
  };

  const openDeleteDialog = (provider: OAuth2Provider) => {
    setDeleteError(null);
    deleteDialog.open(provider);
  };

  const deleteProvider = async (provider: OAuth2Provider) => {
    setDeleting(true);
    setDeleteError(null);
    const handle = toasts.start(t('dashboard.oauth2.toast.delete.pending', { name: provider.display_name }));
    const result = await callApiNoContent(() => api.api.oauth2.providers[':id'].$delete({
      param: { id: provider.id },
    }));
    setDeleting(false);
    if (result.error) {
      handle.settle();
      setDeleteError(result.error.message);
      return;
    }
    deleteDialog.close();
    handle.succeed(t('dashboard.oauth2.toast.delete.success', { name: provider.display_name }));
    await refresh();
  };

  const loaded = data.settings !== null && data.providers !== null;

  return <section className="dashboard-page">
    <DashboardPageHeader
      actions={<ResourceListActions
        createDisabled={!loaded}
        createLabel={t('dashboard.oauth2.actions.create')}
        disabled={deleting}
        onCreate={() => editorDialog.open(null)}
        onRefresh={() => void refresh()}
        refreshLabel={t('dashboard.oauth2.actions.refresh')}
        refreshing={refreshing}
      />}
      description={t('dashboard.pages.oauth2')}
      title={t('dashboard.nav.oauth2')}
    />

    {pageError && <OutcomeMessageBar onDismiss={() => setPageError(null)}>{pageError}</OutcomeMessageBar>}

    {data.settings === null || data.providers === null
      ? <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel>
      : <>
          <Panel className={PANEL_STACK_CLASS}>
            <SectionHeader
              description={t('dashboard.oauth2.settings.description')}
              level={2}
              title={t('dashboard.oauth2.settings.title')}
            />
            <Field hint={t('dashboard.oauth2.settings.hint')} label={t('dashboard.oauth2.settings.publicBaseUrl')}>
              <Input
                className="font-mono"
                disabled={savingSettings}
                onChange={(_, value) => setPublicBaseUrl(value.value)}
                placeholder="https://floway.example.com"
                value={publicBaseUrl}
              />
            </Field>
            {data.settings.public_base_url === '' && <OutcomeMessageBar intent="warning">
              {t('dashboard.oauth2.settings.required')}
            </OutcomeMessageBar>}
            <div className="pt-1"><Button
              appearance="primary"
              disabledFocusable={savingSettings}
              icon={savingSettings ? <Spinner size="tiny" /> : undefined}
              onClick={() => void saveSettings()}
            >{t('dashboard.oauth2.settings.save')}</Button></div>
          </Panel>

          <ResourceListPanel>
            <OAuth2ProviderList
              disabled={refreshing || deleting}
              onDelete={openDeleteDialog}
              onEdit={editorDialog.open}
              providers={data.providers}
              publicBaseUrl={data.settings.public_base_url}
            />
          </ResourceListPanel>

          {editorDialog.invocation && <OAuth2ProviderDialog
            key={editorDialog.invocation.key}
            onOpenChange={open => { if (!open) editorDialog.close(); }}
            onSaved={refresh}
            open={editorDialog.isOpen}
            provider={editorDialog.invocation.value}
          />}

          {deleteDialog.invocation && <ConfirmDialog
            open={deleteDialog.isOpen}
            actionLabel={t('dashboard.oauth2.actions.delete')}
            busy={deleting}
            error={deleteError}
            key={deleteDialog.invocation.key}
            message={t('dashboard.oauth2.delete.message', { name: deleteDialog.invocation.value.display_name })}
            onConfirm={() => void deleteProvider(deleteDialog.invocation!.value)}
            onDismissError={() => setDeleteError(null)}
            onOpenChange={open => { if (!open) deleteDialog.close(); }}
            title={t('dashboard.oauth2.delete.title')}
          />}
        </>}
  </section>;
}
