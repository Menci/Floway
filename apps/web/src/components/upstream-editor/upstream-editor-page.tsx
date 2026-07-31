import { SaveRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useBlocker, useNavigate } from 'react-router';

import { BackNavigationButton } from './back-navigation-button';
import { UpstreamConfigSidebar } from './config-sidebar';
import {
  createBody,
  discoveredModelsFromResponse,
  previewRecord,
  updateBody,
  valuesFromRecord,
  type UpstreamEditorLoaderData,
  type UpstreamEditorValues,
} from './editor-data';
import { modelsAreValid } from './model-detail';
import { UpstreamWorkspace } from './workspace';
import { callApi } from '../../api/auth';
import { api } from '../../api/client';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { PANE_GAP_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { Panel } from '../ui/panel';
import { useDialogInvocation } from '../ui/use-dialog-invocation';
import { MODEL_PREFIX_MAX_LENGTH, MODEL_PREFIX_REGEX } from '@floway-dev/provider/model-prefix';

const {
  Button,
  Spinner,
  Text,
  Toast,
  Toaster,
  ToastTitle,
  useToastController,
} = fluentComponents;

const saveToastFlashKey = 'floway-upstream-save-toast';

export function UpstreamEditorPage({ data }: { data: UpstreamEditorLoaderData }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toasterId = useId();
  const { dispatchToast } = useToastController(toasterId);
  const [record, setRecord] = useState(data.record);
  const [discovered, setDiscovered] = useState(data.discovered);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(data.modelsError);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const allowNavigation = useRef(false);
  const initialValues = valuesFromRecord(data.record);
  const [savedBaseline, setSavedBaseline] = useState(() => comparableValues(initialValues));
  const form = useForm<UpstreamEditorValues>({
    defaultValues: initialValues,
    mode: 'onBlur',
  });
  const { control, getValues, handleSubmit, reset, setValue, formState: { errors } } = form;
  const currentValues = useWatch({ control }) as UpstreamEditorValues;
  const hasUnsavedChanges = comparableValues(currentValues) !== savedBaseline || errors.color !== undefined;
  // `required` on the name is the only rule the form itself validates, and the
  // invalid branch of the submit reports the color error alone -- an empty name
  // rejects the submit with nothing said anywhere. A name that is only
  // whitespace clears that rule and reaches the handler's own message.
  const nameMissing = currentValues.name === '';

  const blocker = useBlocker(useCallback(
    () => hasUnsavedChanges && !allowNavigation.current,
    [hasUnsavedChanges],
  ));

  // The blocker owns whether the navigation is held; the dialog only follows
  // it. Following rather than rendering on `blocker.state` directly is what
  // keeps the surface mounted once the blocker has resolved, which is the only
  // way it gets to play its exit.
  const leaveDialog = useDialogInvocation<void>();
  const blocked = blocker.state === 'blocked';
  const [dialogFollowsBlocked, setDialogFollowsBlocked] = useState(blocked);
  if (dialogFollowsBlocked !== blocked) {
    setDialogFollowsBlocked(blocked);
    if (blocked) leaveDialog.open(); else leaveDialog.close();
  }

  const showSavedToast = useCallback(() => {
    dispatchToast(
      <Toast>
        <ToastTitle>{t('dashboard.upstreamEditor.toast.saved')}</ToastTitle>
      </Toast>,
      { intent: 'success' },
    );
  }, [dispatchToast, t]);

  useEffect(() => {
    if (sessionStorage.getItem(saveToastFlashKey) !== '1') return;
    sessionStorage.removeItem(saveToastFlashKey);
    showSavedToast();
  }, [showSavedToast]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  const refreshModelsFor = useCallback(async (currentRecord: UpstreamRecord) => {
    if (currentRecord.kind === 'azure') return;
    setModelsLoading(true);
    setModelsError(null);
    const values = getValues();
    const result = await callApi(() => api.api.upstreams['list-models'].$post({
      json: { record: previewRecord(currentRecord, values) },
    }));
    if (result.error) {
      setModelsLoading(false);
      setModelsError(result.error.message);
      return;
    }
    const endpoints = currentRecord.kind === 'custom' ? (values.config as typeof currentRecord.config).endpoints : {};
    setDiscovered(discoveredModelsFromResponse(result.data, endpoints));
    if (currentRecord.id !== '') {
      const refreshed = await callApi(() => api.api.upstreams[':id'].$get({ param: { id: currentRecord.id } }));
      if (refreshed.error) {
        setModelsError(refreshed.error.message);
      } else {
        setRecord(current => ({ ...current, modelsCache: refreshed.data.modelsCache } as UpstreamRecord));
      }
    }
    setModelsLoading(false);
  }, [getValues]);

  const refreshModels = useCallback(
    () => refreshModelsFor(record),
    [record, refreshModelsFor],
  );

  const applyProviderPatch = (patch: { config?: unknown; state?: unknown }, persisted = false) => {
    if (patch.config !== undefined) setValue('config', patch.config as UpstreamEditorValues['config'], { shouldDirty: !persisted });
    if (patch.state !== undefined) setValue('state', patch.state as UpstreamEditorValues['state'], { shouldDirty: !persisted });
    if (persisted) {
      setSavedBaseline(baseline => {
        const parsed = JSON.parse(baseline) as UpstreamEditorValues;
        if (patch.config !== undefined) parsed.config = patch.config as UpstreamEditorValues['config'];
        if (patch.state !== undefined) parsed.state = patch.state as UpstreamEditorValues['state'];
        return comparableValues(parsed);
      });
    }
    setRecord(current => ({ ...current, ...(patch.config !== undefined ? { config: patch.config } : {}), ...(patch.state !== undefined ? { state: patch.state } : {}) } as UpstreamRecord));
  };

  const submitForm = () => handleSubmit(async values => {
    if (!values.name.trim()) { setSaveError(t('dashboard.upstreamEditor.validation.name')); return; }
    if (values.modelPrefix && (!MODEL_PREFIX_REGEX.test(values.modelPrefix.prefix) || values.modelPrefix.prefix.length > MODEL_PREFIX_MAX_LENGTH || values.modelPrefix.addressable.length === 0)) { setSaveError(t('dashboard.upstreamEditor.validation.prefix')); return; }
    if (!modelsAreValid(values.manualModels)) { setSaveError(t('dashboard.upstreamEditor.validation.models')); return; }
    if (data.mode === 'create' && record.kind === 'copilot' && !(values.config as Extract<UpstreamRecord, { kind: 'copilot' }>['config']).githubToken) { setSaveError(t('dashboard.upstreamEditor.validation.copilot')); return; }
    if (data.mode === 'create' && (record.kind === 'codex' || record.kind === 'claude-code') && (values.config as Extract<UpstreamRecord, { kind: 'codex' | 'claude-code' }>['config']).accounts.length === 0) { setSaveError(t('dashboard.upstreamEditor.validation.credential')); return; }
    setSaving(true); setSaveError(null);
    const result = data.mode === 'create'
      ? await callApi(() => api.api.upstreams.$post({ json: createBody(record, values) }))
      : await callApi(() => api.api.upstreams[':id'].$patch({ param: { id: record.id }, json: updateBody(record, values) }));
    setSaving(false);
    if (result.error) { setSaveError(result.error.message); return; }
    let saved: UpstreamRecord = result.data;
    if (data.mode === 'edit') {
      const full = await callApi(() => api.api.upstreams[':id'].$get({ param: { id: record.id } }));
      if (!full.error) saved = full.data;
    }
    setRecord(saved);
    const savedValues = valuesFromRecord(saved);
    setSavedBaseline(comparableValues(savedValues));
    reset(savedValues);
    if (data.mode === 'create') {
      allowNavigation.current = true;
      sessionStorage.setItem(saveToastFlashKey, '1');
      void navigate(`/dashboard/providers/upstreams/${encodeURIComponent(saved.id)}`, { replace: true });
    } else {
      showSavedToast();
    }
  }, () => {
    if (errors.color) setSaveError(t('dashboard.upstreamEditor.validation.color'));
  })();

  const leave = () => void navigate('/dashboard/providers/upstreams');

  return <FormProvider {...form}>
    <Toaster toasterId={toasterId} position="top-end" />
    {/* A column rather than a row template: the error bar is only sometimes
        there, and a template that names a row for it leaves an empty one and a
        gap under everything else when it is not. */}
    <div className="flex flex-col gap-[14px] h-full min-h-0">
      <header className="flex items-center gap-3 min-w-0 px-1">
        <BackNavigationButton onClick={leave}>{t('dashboard.upstreamEditor.actions.back')}</BackNavigationButton>
        {hasUnsavedChanges && <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.unsaved')}</Text>}
        <div className="ml-auto flex items-center gap-2">
          <Button appearance="primary" disabled={saving || nameMissing} icon={saving ? <Spinner size="tiny" /> : <SaveRegular />} onClick={() => void submitForm()}>{saving ? t('dashboard.upstreamEditor.actions.saving') : t('dashboard.upstreamEditor.actions.save')}</Button>
        </div>
      </header>
      {saveError && <OutcomeMessageBar onDismiss={() => setSaveError(null)}>{saveError}</OutcomeMessageBar>}
      <div className={`grid grid-cols-[380px_minmax(0,1fr)] ${PANE_GAP_CLASS} min-h-0 min-w-0 flex-1 max-[1050px]:grid-cols-1`}>
        <Panel className="min-h-0 min-w-0 overflow-hidden" padding="flush">
          <UpstreamConfigSidebar
            catalogAvailable={modelsError === null}
            discovered={discovered}
            onPatch={applyProviderPatch}
            onRefreshModels={() => void refreshModels()}
            proxies={data.proxies}
            record={record}
            runtime={data.runtime}
          />
        </Panel>
        <Panel className="min-h-0 min-w-0 overflow-hidden" padding="flush">
          <UpstreamWorkspace record={record} discovered={discovered} loadingModels={modelsLoading} modelsError={modelsError} onRefreshModels={() => void refreshModels()} />
        </Panel>
      </div>
    </div>
    {leaveDialog.invocation && <ConfirmDialog
      open={leaveDialog.isOpen}
      actionLabel={t('dashboard.upstreamEditor.leave.leave')}
      cancelLabel={t('dashboard.upstreamEditor.leave.stay')}
      key={leaveDialog.invocation.key}
      message={t('dashboard.upstreamEditor.leave.message')}
      onCancel={() => blocker.state === 'blocked' && blocker.reset()}
      onConfirm={() => blocker.state === 'blocked' && blocker.proceed()}
      onOpenChange={open => { if (!open && blocker.state === 'blocked') blocker.reset(); }}
      title={t('dashboard.upstreamEditor.leave.title')}
    />}
  </FormProvider>;
}

const comparableValues = (values: UpstreamEditorValues): string => JSON.stringify(values);
