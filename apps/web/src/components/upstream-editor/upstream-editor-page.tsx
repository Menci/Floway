import { ArrowLeftRegular, SaveRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useBlocker, useNavigate } from 'react-router';

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
import { authFetch, callApi } from '../../api/auth';
import { api } from '../../api/client';
import type { CustomRawModel, UpstreamModelConfig, UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Panel } from '../ui/panel';
import { ProviderBadge } from '../upstreams/provider-badge';
import { MODEL_PREFIX_MAX_LENGTH, MODEL_PREFIX_REGEX } from '@floway-dev/provider/model-prefix';

const {
  Button,
  MessageBar,
  MessageBarBody,
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
  const [discovered, setDiscovered] = useState<UpstreamModelConfig[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const allowNavigation = useRef(false);
  const initialValues = valuesFromRecord(data.record);
  const [savedBaseline, setSavedBaseline] = useState(() => comparableValues(initialValues));
  const form = useForm<UpstreamEditorValues>({
    defaultValues: initialValues,
    mode: 'onBlur',
  });
  const { control, getValues, handleSubmit, reset, setValue } = form;
  const name = useWatch({ control, name: 'name' });
  const currentValues = useWatch({ control }) as UpstreamEditorValues;
  const hasUnsavedChanges = comparableValues(currentValues) !== savedBaseline;

  const blocker = useBlocker(useCallback(
    () => hasUnsavedChanges && !allowNavigation.current,
    [hasUnsavedChanges],
  ));

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
    const result = await callApi<{ data: UpstreamModelConfig[] } | { data: CustomRawModel[] }>(() =>
      authFetch('/api/upstreams/list-models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ record: previewRecord(currentRecord, values) }),
      }));
    if (result.error) {
      setModelsLoading(false);
      setModelsError(result.error.message);
      return;
    }
    const endpoints = currentRecord.kind === 'custom' ? (values.config as typeof currentRecord.config).endpoints : {};
    setDiscovered(discoveredModelsFromResponse(currentRecord.kind, result.data.data, endpoints));
    if (currentRecord.id !== '') {
      const refreshed = await callApi<UpstreamRecord>(() => api.api.upstreams[':id'].$get({ param: { id: currentRecord.id } }));
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

  useEffect(() => {
    const currentRecord = data.record;
    const values = getValues();
    const canFetch = currentRecord.kind === 'custom'
      ? Boolean((values.config as Extract<UpstreamRecord, { kind: 'custom' }>['config']).baseUrl)
        && (values.config as Extract<UpstreamRecord, { kind: 'custom' }>['config']).modelsFetch.enabled
      : currentRecord.kind === 'ollama'
        ? Boolean((values.config as Extract<UpstreamRecord, { kind: 'ollama' }>['config']).baseUrl)
        : currentRecord.id !== '' && currentRecord.kind !== 'azure';
    if (canFetch) void refreshModelsFor(currentRecord);
  }, [data.record, getValues, refreshModelsFor]);

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
      ? await callApi<UpstreamRecord>(() => api.api.upstreams.$post({ json: createBody(record, values, data.nextSortOrder) }))
      : await callApi<UpstreamRecord>(() => api.api.upstreams[':id'].$patch({ param: { id: record.id }, json: updateBody(record, values) }));
    setSaving(false);
    if (result.error) { setSaveError(result.error.message); return; }
    let saved = result.data;
    if (data.mode === 'edit') {
      const full = await callApi<UpstreamRecord>(() => api.api.upstreams[':id'].$get({ param: { id: record.id } }));
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
  })();

  const leave = () => void navigate('/dashboard/providers/upstreams');

  return <FormProvider {...form}>
    <Toaster toasterId={toasterId} position="top-end" />
    <div className="grid grid-rows-[auto_auto_minmax(0,1fr)] gap-[14px] h-full min-h-0">
      <header className="flex items-center gap-3 min-w-0 px-1">
        <Button appearance="subtle" icon={<ArrowLeftRegular />} onClick={leave}>{t('dashboard.upstreamEditor.actions.back')}</Button>
        <ProviderBadge color={currentValues.color} kind={record.kind} />
        <Text size={500} weight="semibold" truncate className="min-w-0">{name || t('dashboard.upstreamEditor.new')}</Text>
        {hasUnsavedChanges && <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.unsaved')}</Text>}
        <div className="ml-auto flex items-center gap-2">
          <Button appearance="primary" disabled={saving} icon={saving ? <Spinner size="tiny" /> : <SaveRegular />} onClick={() => void submitForm()}>{saving ? t('dashboard.upstreamEditor.actions.saving') : t('dashboard.upstreamEditor.actions.save')}</Button>
        </div>
      </header>
      <div>{saveError && <MessageBar intent="error"><MessageBarBody>{saveError}</MessageBarBody></MessageBar>}</div>
      <div className="grid grid-cols-[380px_minmax(0,1fr)] gap-[18px] min-h-0 max-[1050px]:grid-cols-1 max-[1050px]:overflow-y-auto">
        <Panel className="min-h-0 overflow-hidden !p-0">
          <UpstreamConfigSidebar record={record} proxies={data.proxies} runtime={data.runtime} onPatch={applyProviderPatch} onRefreshModels={() => void refreshModels()} />
        </Panel>
        <Panel className="min-h-0 overflow-hidden !p-0">
          <UpstreamWorkspace record={record} flags={data.flags} discovered={discovered} loadingModels={modelsLoading} modelsError={modelsError} onRefreshModels={() => void refreshModels()} />
        </Panel>
      </div>
    </div>
    <ConfirmDialog
      actionLabel={t('dashboard.upstreamEditor.leave.stay')}
      cancelLabel={t('dashboard.upstreamEditor.leave.leave')}
      message={t('dashboard.upstreamEditor.leave.message')}
      onCancel={() => blocker.state === 'blocked' && blocker.proceed()}
      onConfirm={() => blocker.state === 'blocked' && blocker.reset()}
      onOpenChange={open => { if (!open && blocker.state === 'blocked') blocker.reset(); }}
      open={blocker.state === 'blocked'}
      title={t('dashboard.upstreamEditor.leave.title')}
    />
  </FormProvider>;
}

const comparableValues = (values: UpstreamEditorValues): string => JSON.stringify(values);
