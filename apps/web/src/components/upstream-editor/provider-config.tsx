import {
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  ChevronDown12Regular,
  EyeOffRegular,
  EyeRegular,
  PlugConnectedRegular,
} from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { Controller, useFormContext, useWatch } from 'react-hook-form';

import { ChatGPTAccountCard } from './chatgpt-account-card';
import { ChatGPTImportForm } from './chatgpt-import';
import { ClaudeCodeAccountCard } from './claude-code-account-card';
import { CopilotQuotaCard } from './copilot-quota-card';
import { CustomIngressHeaderRules } from './custom-ingress-header-rules';
import type { UpstreamEditorValues } from './data';
import { isPersisted, previewRecord } from './data';
import { CHAT_ENDPOINT_KEYS, endpointOptionsFor, PATH_OVERRIDE_OPTIONS } from './endpoints';
import { KimiCodeUsageCard } from './kimi-code-usage-card';
import { OAuthCallbackImport } from './oauth-callback-import';
import { OllamaUsageCard } from './ollama-usage-card';
import { clearPkce } from './pkce';
import { EditorSection } from './section';
import { api, callApi } from '../../api/client';
import type { DeviceFlowStart, UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { errorMessage } from '../../lib/error-message';
import { ChoiceGroup } from '../ui/choice-group';
import { Input, Textarea } from '../ui/fluent-form-controls';
import { infoLabelSlot } from '../ui/info-label';
import { CHECKBOX_LIST_CLASS, TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { SecretInput } from '../ui/secret-input';
import { SwitchSetting } from '../ui/switch-setting';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { isOllamaCloudBaseUrl } from '../upstreams/ollama-usage';
import { ProviderIcon, providerLabel } from '../upstreams/provider-badge';
import type { UpstreamProviderKind } from '@floway-dev/provider/browser';

const {
  Button,
  Checkbox,
  Field,
  Link,
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
  Switch,
  Tab,
  TabList,
  Text,
} = fluentComponents;

// react-hook-form resolves a field path against the values type it is given,
// and the editor's `config` is a union across provider kinds, which has no
// member path to resolve. Each provider's own editor already holds a record of
// one kind, so it states that kind and gets its own config's paths and value
// types back.
type ValuesForKind<K extends UpstreamProviderKind> = Omit<UpstreamEditorValues, 'config'> & {
  config: Extract<UpstreamRecord, { kind: K }>['config'];
};

// OAuth 2.0 device flow slow_down increases the current polling interval by five seconds.
// https://www.rfc-editor.org/rfc/rfc8628#section-3.5
const DEVICE_FLOW_SLOW_DOWN_SECONDS = 5;

export function ProviderConfigSection({
  readOnly = false,
  modelsFetchReadOnly = readOnly,
  record,
  onPatch,
  onRefreshModels,
}: {
  readOnly?: boolean;
  modelsFetchReadOnly?: boolean;
  record: UpstreamRecord;
  onPatch: (patch: { config?: unknown; state?: unknown }, persisted?: boolean) => void;
  onRefreshModels: () => void;
}) {
  if (record.kind === 'custom') return <CustomConfig modelsFetchReadOnly={modelsFetchReadOnly} onRefreshModels={onRefreshModels} readOnly={readOnly} />;
  if (record.kind === 'azure') return <AzureConfig readOnly={readOnly} />;
  if (record.kind === 'ollama') return <OllamaConfig readOnly={readOnly} record={record} />;
  if (record.kind === 'kimi-code') return <KimiCodeConfig readOnly={readOnly} record={record} />;
  if (record.kind === 'copilot') return <CopilotConfig onPatch={onPatch} readOnly={readOnly} record={record} />;
  return <OAuthConfig onPatch={onPatch} readOnly={readOnly} record={record} />;
}

export function ApiPathsSection({ readOnly, record }: { readOnly: boolean; record: UpstreamRecord }) {
  if (record.kind !== 'custom') return null;
  return <CustomApiPaths readOnly={readOnly} />;
}

function CustomConfig({ modelsFetchReadOnly, onRefreshModels, readOnly }: { modelsFetchReadOnly: boolean; onRefreshModels: () => void; readOnly: boolean }) {
  const { t } = useTranslation();
  const { control } = useFormContext<ValuesForKind<'custom'>>();
  const fetchesCatalog = useWatch({ control, name: 'config.modelsFetch.enabled' });
  const modelsFetchAuthStyleLabel = (value: Extract<UpstreamRecord, { kind: 'custom' }>['config']['modelsFetch']['authStyle']) => {
    switch (value) {
    case 'bearer': return t('upstreams.editor.auth.bearer');
    case 'x-api-key': return 'x-api-key';
    case 'x-goog-api-key': return 'x-goog-api-key';
    }
  };
  const modelsFetchAuthStyle = useWatch({ control, name: 'config.modelsFetch.authStyle' });
  return (
    <div className="grid gap-4">
      <Field label={t('upstreams.editor.fields.baseUrl')}>
        <Controller
          control={control}
          name="config.baseUrl"
          render={({ field }) => (
            <Input
              className="font-mono"
              name={field.name}
              onBlur={field.onBlur}
              onChange={(_, data) => field.onChange(data.value)}
              placeholder="https://api.openai.com"
              readOnly={readOnly}
              ref={field.ref}
              value={field.value}
            />
          )}
        />
      </Field>
      <SecretField readOnly={readOnly} />
      <Controller control={control} name="config.modelsFetch.enabled" render={({ field }) => (
        <Switch
          checked={field.value}
          label={t('upstreams.editor.fields.fetchModels')}
          readOnly={modelsFetchReadOnly}
          onChange={(_, data) => {
            field.onChange(data.checked);
            if (data.checked) onRefreshModels();
          }}
        />
      )} />
      {fetchesCatalog && (
        <Field label={{
          className: '!w-full !max-w-full',
          children: <span className="flex w-full min-w-0 items-center justify-between gap-3">
            <span className="floway-control-label truncate">{t('upstreams.editor.fields.catalogPath')}</span>
            <Controller control={control} name="config.modelsFetch.authStyle" render={({ field }) => (
              <Menu
                // The trigger sits at the right edge of the field's label row,
                // so the menu opens from that edge rather than the left one.
                positioning={{ position: 'below', align: 'end' }}
                checkedValues={{ authStyle: [field.value] }}
                onCheckedValueChange={(_, data) => {
                  if (!modelsFetchReadOnly && data.checkedItems[0] !== undefined) field.onChange(data.checkedItems[0]);
                }}
              >
                <MenuTrigger disableButtonEnhancement>
                  <button
                    aria-label={t('upstreams.editor.fields.fetchModelsAuthStyle')}
                    className="winui-focus-rect floway-control-label inline-flex flex-none items-center gap-1.5 border-0 bg-transparent p-0 text-fui-fg1"
                    disabled={modelsFetchReadOnly}
                    type="button"
                  >
                    <span>{modelsFetchAuthStyleLabel(field.value)}</span>
                    <ChevronDown12Regular aria-hidden className="block flex-none" />
                  </button>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItemRadio name="authStyle" value="bearer">{t('upstreams.editor.auth.bearer')}</MenuItemRadio>
                    <MenuItemRadio name="authStyle" value="x-api-key">x-api-key</MenuItemRadio>
                    <MenuItemRadio name="authStyle" value="x-goog-api-key">x-goog-api-key</MenuItemRadio>
                  </MenuList>
                </MenuPopover>
              </Menu>
            )} />
          </span>,
        }}>
          <Controller control={control} name="config.modelsFetch.endpoint" render={({ field }) => <Input className="font-mono" name={field.name} onBlur={field.onBlur} onChange={(_, data) => field.onChange(data.value)} placeholder={modelsFetchAuthStyle === 'x-goog-api-key' ? '/v1beta/models' : '/v1/models'} readOnly={modelsFetchReadOnly} ref={field.ref} value={field.value ?? ''} />} />
        </Field>
      )}
      <CustomIngressHeaderRules readOnly={readOnly} />
    </div>
  );
}

function CustomApiPaths({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation();
  const { control } = useFormContext<ValuesForKind<'custom'>>();
  return (
    <div className="grid gap-4">
      <EndpointPicker readOnly={readOnly} />
      <EditorSection
        hint={t('upstreams.editor.pathOverridesHint')}
        level={3}
        title={t('upstreams.editor.fields.pathOverrides')}
      >
        <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
          {PATH_OVERRIDE_OPTIONS.map(({ label, path, defaultPath }) => (
            <Controller
              control={control}
              key={path}
              name={`config.pathOverrides.${path}`}
              render={({ field }) => (
                <Field className="min-w-0" label={{ children: <span className="block truncate" title={label}>{label}</span> }}>
                  <Input
                    className="!w-full font-mono"
                    name={field.name}
                    onBlur={field.onBlur}
                    onChange={(_, data) => field.onChange(data.value)}
                    placeholder={defaultPath}
                    readOnly={readOnly}
                    ref={field.ref}
                    value={field.value ?? ''}
                  />
                </Field>
              )}
            />
          ))}
        </div>
      </EditorSection>
    </div>
  );
}

function AzureConfig({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation();
  const { control } = useFormContext<ValuesForKind<'azure'>>();
  return <div className="grid gap-4">
    <Field label={t('upstreams.editor.fields.endpoint')}>
      <Controller control={control} name="config.endpoint" render={({ field }) => <Input className="font-mono" name={field.name} onBlur={field.onBlur} onChange={(_, data) => field.onChange(data.value)} placeholder="https://resource.openai.azure.com/openai/v1" readOnly={readOnly} ref={field.ref} value={field.value} />} />
    </Field>
    <SecretField readOnly={readOnly} />
  </div>;
}

function OllamaConfig({ readOnly, record }: { readOnly: boolean; record: Extract<UpstreamRecord, { kind: 'ollama' }> }) {
  const { t } = useTranslation();
  const { control, setValue } = useFormContext<ValuesForKind<'ollama'>>();
  const values = useWatch<UpstreamEditorValues>() as UpstreamEditorValues;
  const config = values.config as typeof record.config;

  // Typing the cloud endpoint answers the usage option for the operator. The
  // answer follows edits to the base URL rather than the rendered value, so
  // opening a saved upstream never overrides what it stored — and once the
  // operator works the switch themselves, it is theirs and the URL stops
  // moving it.
  const chosenByOperator = useRef(false);
  const lastBaseUrl = useRef(config.baseUrl);
  useEffect(() => {
    const previous = lastBaseUrl.current;
    lastBaseUrl.current = config.baseUrl;
    if (chosenByOperator.current || config.baseUrl === previous) return;
    const suggested = isOllamaCloudBaseUrl(config.baseUrl);
    if (config.cloudUsage !== suggested) setValue('config.cloudUsage', suggested, { shouldDirty: true });
  }, [config.baseUrl, config.cloudUsage, setValue]);

  // The card reads an account, so it needs both halves: the option, and a key
  // to authenticate with. The field carries the stored key, so the edited value
  // is the only answer.
  const keySet = Boolean(config.apiKey);
  return <div className="grid gap-4">
    <Field label={t('upstreams.editor.fields.baseUrl')}>
      <Controller control={control} name="config.baseUrl" render={({ field }) => <Input className="font-mono" name={field.name} onBlur={field.onBlur} onChange={(_, data) => field.onChange(data.value)} placeholder="https://ollama.com" readOnly={readOnly} ref={field.ref} value={field.value} />} />
    </Field>
    <SecretField readOnly={readOnly} />
    <Controller control={control} name="config.cloudUsage" render={({ field }) => (
      <SwitchSetting
        checked={field.value === true}
        description={t('upstreams.editor.ollama.cloudUsageHint')}
        disabled={readOnly}
        label={t('upstreams.editor.ollama.cloudUsage')}
        onChange={checked => {
          chosenByOperator.current = true;
          field.onChange(checked);
        }}
      />
    )} />
    {config.cloudUsage === true && keySet && <OllamaUsageCard readOnly={readOnly} record={record} probeRecord={previewRecord(record, values)} />}
  </div>;
}

function KimiCodeConfig({ readOnly, record }: { readOnly: boolean; record: Extract<UpstreamRecord, { kind: 'kimi-code' }> }) {
  const { t } = useTranslation();
  const { control } = useFormContext<ValuesForKind<'kimi-code'>>();
  const values = useWatch<UpstreamEditorValues>() as UpstreamEditorValues;
  const config = values.config as typeof record.config;
  const matchesStoredConnection = config.region === record.config.region && config.apiKey === record.config.apiKey;
  return <div className="grid gap-4">
    <Controller control={control} name="config.region" render={({ field }) => (
      <div className="flex items-center justify-between gap-3">
        <Text>{t('upstreams.editor.kimiCode.region')}</Text>
        <ChoiceGroup
          ariaLabel={t('upstreams.editor.kimiCode.region')}
          items={[
            { value: 'china', label: t('upstreams.editor.kimiCode.regions.china') },
            { value: 'overseas', label: t('upstreams.editor.kimiCode.regions.overseas') },
          ]}
          onChange={field.onChange}
          readOnly={readOnly}
          value={field.value}
        />
      </div>
    )} />
    <SecretField readOnly={readOnly} />
    {(readOnly || Boolean(config.apiKey?.trim())) && <KimiCodeUsageCard
      key={`${config.region}:${config.apiKey}`}
      readOnly={readOnly}
      record={readOnly || matchesStoredConnection ? record : { ...record, state: null }}
      probeRecord={previewRecord(record, values)}
    />}
  </div>;
}

function SecretField({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation();
  const { control } = useFormContext<ValuesForKind<'custom' | 'azure' | 'ollama' | 'kimi-code'>>();
  const [visible, setVisible] = useState(false);
  return <Field label={t('upstreams.editor.fields.apiKey')}>
    <Controller
      control={control}
      name="config.apiKey"
      render={({ field }) => (
        <SecretInput
          revealed={visible}
          value={field.value ?? ''}
          onBlur={field.onBlur}
          onChange={(_, data) => field.onChange(data.value)}
          placeholder="sk-..."
          readOnly={readOnly}
          contentAfter={
            <TooltipIconButton
              icon={visible ? <EyeOffRegular /> : <EyeRegular />}
              label={visible ? t('upstreams.editor.actions.hideSecret') : t('upstreams.editor.actions.showSecret')}
              onClick={() => setVisible(value => !value)}
            />
          }
        />
      )}
    />
  </Field>;
}

const endpointOptions = endpointOptionsFor(CHAT_ENDPOINT_KEYS);

function EndpointPicker({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation();
  const { control, getValues, setValue } = useFormContext<UpstreamEditorValues>();
  const config = useWatch({ control, name: 'config' });
  const customConfig = config as Extract<UpstreamRecord, { kind: 'custom' }>['config'];
  const value = customConfig.endpoints;
  return <EditorSection level={3} title={t('upstreams.editor.fields.defaultEndpoints')}>
    <div className={`grid ${CHECKBOX_LIST_CLASS}`}>
      {endpointOptions.map(({ key, label }) => {
        const selected = value[key] !== undefined;
        return <Checkbox
          key={key}
          checked={selected}
          label={label}
          readOnly={readOnly}
          onChange={(_, data) => {
            const latestConfig = getValues('config') as Extract<UpstreamRecord, { kind: 'custom' }>['config'];
            const next = { ...latestConfig.endpoints };
            if (data.checked) next[key] = {}; else delete next[key];
            setValue('config', { ...latestConfig, endpoints: next }, { shouldDirty: true });
          }} />;
      })}
    </div>
  </EditorSection>;
}

function ReadyToSaveHint({ kind }: { kind: UpstreamProviderKind }) {
  const { t } = useTranslation();
  return <OutcomeMessageBar intent="info" title={t('upstreams.editor.readyToSave.title')}>
    {t('upstreams.editor.readyToSave.description', { provider: providerLabel(kind) })}
  </OutcomeMessageBar>;
}

function CopilotConfig({ onPatch, readOnly, record }: {
  readOnly: boolean;
  record: Extract<UpstreamRecord, { kind: 'copilot' }>;
  onPatch: (patch: { config?: unknown; state?: unknown }, persisted?: boolean) => void;
}) {
  const { t } = useTranslation();
  const { control } = useFormContext<ValuesForKind<'copilot'>>();
  const values = useWatch<UpstreamEditorValues>();
  const config = values.config as typeof record.config;
  const githubHostEmpty = config.githubHost.trim() === '';
  const [flow, setFlow] = useState<DeviceFlowStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  // A tick that has already fired holds no timer id, so clearing the timer
  // cannot end the loop on its own; the recursion reads this after every await.
  const cancelled = useRef(false);
  const stop = () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; };

  const poll = async (deviceCode: string, interval: number, secondsLeft: number) => {
    const result = await callApi(() => api.api.upstreams.copilot.oauth['device-login'].poll.$post({
      json: { record: previewRecord(record, values as UpstreamEditorValues), deviceCode },
    }));
    if (cancelled.current) return;
    if (result.error) {
      // Only a reply that says nothing about the device code is worth
      // repeating; any other status carries GitHub's verdict on the code, and
      // `expired_token` and `access_denied` are terminal.
      // https://www.rfc-editor.org/rfc/rfc8628#section-3.5
      const transient = result.error.status === 0 || result.error.status === 502;
      if (!transient || secondsLeft <= 0) { setBusy(false); setFlow(null); setError(result.error.message); return; }
      timer.current = window.setTimeout(() => void pollRef.current(deviceCode, interval, secondsLeft - interval), interval * 1000);
      return;
    }
    if (result.data.status === 'complete') { setBusy(false); onPatch(result.data.patch, isPersisted(record)); return; }
    if (result.data.status === 'slow_down') {
      const next = interval + DEVICE_FLOW_SLOW_DOWN_SECONDS;
      timer.current = window.setTimeout(() => void pollRef.current(deviceCode, next, secondsLeft - next), next * 1000);
      return;
    }
    timer.current = window.setTimeout(() => void pollRef.current(deviceCode, interval, secondsLeft - interval), interval * 1000);
  };

  // A flow outlives the render that armed it — its code lives a quarter of an
  // hour, and the form goes on being edited meanwhile — so every tick must
  // enter the newest closure and send the upstream as it now reads.
  const pollRef = useRef(poll);
  // eslint-disable-next-line react-hooks/refs -- Carrying the newest render's request body to a loop that outlives the render that armed it.
  pollRef.current = poll;

  // Armed from `flow`, not from the click that opened one: the panel draws the
  // code, the link and the spinner from `flow` alone, so a remount must
  // re-schedule the tick rather than show a live code with nothing polling it.
  useEffect(() => {
    cancelled.current = false;
    if (flow) timer.current = window.setTimeout(() => void pollRef.current(flow.device_code, flow.interval, flow.expires_in - flow.interval), flow.interval * 1000);
    return () => { cancelled.current = true; stop(); };
  }, [flow]);

  const start = async () => {
    stop(); setBusy(true); setError(null);
    const result = await callApi(() => api.api.upstreams.copilot.oauth['device-login'].start.$post({
      json: { record: previewRecord(record, values as UpstreamEditorValues) },
    }));
    if (cancelled.current) return;
    if (result.error) { setBusy(false); setError(result.error.message); return; }
    setFlow(result.data);
  };

  return <div className="grid gap-3">
    <Field label={{ children: infoLabelSlot(t('upstreams.editor.copilot.githubHost'), t('upstreams.editor.copilot.githubHostHint')) }}>
      <Controller
        control={control}
        name="config.githubHost"
        render={({ field }) => <Input
          className="font-mono"
          name={field.name}
          onBlur={field.onBlur}
          onChange={(_, data) => field.onChange(data.value)}
          readOnly={readOnly || busy || flow !== null || Boolean(config.user.login)}
          ref={field.ref}
          required
          value={field.value}
        />}
      />
    </Field>
    {config.user.login
      ? <>
          <AccountSummary kind="copilot" title={config.user.name ?? config.user.login} subtitle={`${config.githubHost}/${config.user.login}`} />
          {isPersisted(record) ? <CopilotQuotaCard readOnly={readOnly} record={record} /> : !readOnly && <ReadyToSaveHint kind="copilot" />}
        </>
      : <>
          {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
          {!readOnly && (!flow ? <Button appearance="primary" disabled={githubHostEmpty} disabledFocusable={busy} icon={busy ? <Spinner size="tiny" /> : <PlugConnectedRegular />} onClick={() => void start()}>{t('upstreams.editor.copilot.connect')}</Button> : <>
            <Text size={200} className="text-fui-fg2">{t('upstreams.editor.copilot.deviceCode')}</Text>
            <code className="mono-display tracking-[0.25em] text-fui-fg1">{flow.user_code}</code>
            <Link href={flow.verification_uri} target="_blank" rel="noopener noreferrer">{flow.verification_uri}</Link>
            <Spinner className="justify-self-start" label={t('upstreams.editor.copilot.waiting')} labelPosition="after" size="tiny" />
          </>)}
        </>}
  </div>;
}

type OAuthKind = 'chatgpt' | 'claude-code';
function OAuthConfig({ onPatch, readOnly, record }: {
  readOnly: boolean;
  record: Extract<UpstreamRecord, { kind: OAuthKind }>;
  onPatch: (patch: { config?: unknown; state?: unknown }, persisted?: boolean) => void;
}) {
  const { t } = useTranslation();
  const { getValues } = useFormContext<UpstreamEditorValues>();
  const values = useWatch<UpstreamEditorValues>() as UpstreamEditorValues;
  const config = values.config as typeof record.config;
  const hasAccount = config.accounts.length > 0;
  const [refreshing, setRefreshing] = useState(false);

  const refreshCredential = async () => {
    setRefreshing(true);
    setError(null);
    const body = { record: previewRecord(record, values) };
    const result = record.kind === 'chatgpt'
      ? await callApi(() => api.api.upstreams.chatgpt.oauth.refresh.$post({ json: body }))
      : await callApi(() => api.api.upstreams['claude-code'].oauth.refresh.$post({ json: body }));
    setRefreshing(false);
    if (result.error) { setError(result.error.message); return; }
    onPatch(result.data.patch, isPersisted(record));
  };
  const [open, setOpen] = useState(!hasAccount);
  const [probing, setProbing] = useState(false);

  const probeQuota = async () => {
    setProbing(true);
    setError(null);
    const result = await callApi(() => api.api.upstreams['claude-code'].probe.$post({
      json: { record: previewRecord(record, values) },
    }));
    setProbing(false);
    if (result.error) { setError(result.error.message); return; }
    onPatch(result.data.patch, isPersisted(record));
  };
  const [tab, setTab] = useState('oauth');
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flowKind = tab === 'setup' ? 'setup-token' : 'oauth';

  // The credentials.json tab keeps its own submit: it posts the pasted
  // document verbatim to the claude-code oauth exchange, so the only local
  // validation is that the document parses as JSON.
  const submitJson = async () => {
    setBusy(true); setError(null);
    const editorRecord = previewRecord(record, values);
    let result;
    try {
      JSON.parse(json);
      result = await callApi(() => api.api.upstreams['claude-code'].oauth.exchange.$post({
        json: { record: editorRecord, credentials_json: json },
      }));
    } catch (err) {
      setBusy(false); setError(errorMessage(err)); return;
    }
    setBusy(false);
    if (result.error) { setError(result.error.message); return; }
    clearPkce(record.kind, flowKind);
    onPatch(result.data.patch, isPersisted(record));
    setOpen(false); setJson('');
  };

  return <div className="grid gap-4">
    {hasAccount && (record.kind === 'chatgpt'
      ? <ChatGPTAccountCard readOnly={readOnly} record={{ ...record, kind: 'chatgpt', config: config as Extract<UpstreamRecord, { kind: 'chatgpt' }>['config'], state: values.state as Extract<UpstreamRecord, { kind: 'chatgpt' }>['state'] }} />
      : <ClaudeCodeAccountCard
          onRefreshQuota={() => void probeQuota()}
          probing={probing}
          readOnly={readOnly}
          record={{ ...record, kind: 'claude-code', config: config as Extract<UpstreamRecord, { kind: 'claude-code' }>['config'], state: values.state as Extract<UpstreamRecord, { kind: 'claude-code' }>['state'] }}
        />)}
    {hasAccount && !readOnly && !isPersisted(record) && <ReadyToSaveHint kind={record.kind} />}
    {hasAccount && !readOnly && <div className="flex flex-wrap items-center gap-2">
      <Button appearance="primary" disabledFocusable={refreshing} icon={refreshing ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />} onClick={() => void refreshCredential()}>
        {t('upstreams.editor.oauth.refresh')}
      </Button>
      <Button onClick={() => setOpen(value => !value)}>{open ? t('common.cancel') : t('upstreams.editor.oauth.reimport')}</Button>
    </div>}
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    {open && !readOnly && (record.kind === 'chatgpt'
      ? <ChatGPTImportForm
          hasAccount={hasAccount}
          onImported={patch => { onPatch(patch, isPersisted(record)); setOpen(false); }}
          record={{ ...record, kind: 'chatgpt', config: config as Extract<UpstreamRecord, { kind: 'chatgpt' }>['config'], state: values.state as Extract<UpstreamRecord, { kind: 'chatgpt' }>['state'] }}
        />
      : <>
          <TabList aria-label={t('upstreams.editor.oauth.importMethod')} selectedValue={tab} onTabSelect={(_, data) => setTab(String(data.value))}>
            <Tab value="oauth">OAuth</Tab><Tab value="setup">Setup Token</Tab><Tab value="json">credentials.json</Tab>
          </TabList>
          {tab === 'json'
            ? <div className="grid gap-3">
                <Field label={t('upstreams.editor.oauth.credentialJson')}><Textarea className="font-mono" rows={8} value={json} onChange={(_, data) => setJson(data.value)} /></Field>
                <Button appearance="primary" disabledFocusable={busy} icon={busy ? <Spinner size="tiny" /> : <CheckmarkCircleRegular />} onClick={() => void submitJson()}>
                  {hasAccount ? t('upstreams.editor.oauth.reimport') : t('upstreams.editor.oauth.import')}
                </Button>
              </div>
            : <OAuthCallbackImport
                kind="claude-code"
                flowKind={flowKind}
                hasAccount={hasAccount}
                record={record}
                getValues={getValues}
                onImported={patch => { onPatch(patch, isPersisted(record)); setOpen(false); }}
              />}
        </>)}
  </div>;
}

function AccountSummary({ kind, subtitle, title }: { kind: UpstreamProviderKind; subtitle: string; title: string }) {
  return <div className="flex items-center gap-3 min-w-0">
    <ProviderIcon kind={kind} className="h-8 w-8" />
    <div className="grid gap-0.5 min-w-0"><Text block weight="semibold" truncate wrap={false}>{title}</Text><Text block size={200} className="text-fui-fg2" truncate wrap={false}>{subtitle}</Text></div>
  </div>;
}
