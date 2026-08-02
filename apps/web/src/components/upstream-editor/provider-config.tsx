import {
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  EyeOffRegular,
  EyeRegular,
  PlugConnectedRegular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { ClaudeCodeAccountCard } from './claude-code-account-card';
import { CodexAccountCard } from './codex-account-card';
import { CopilotQuotaCard } from './copilot-quota-card';
import type { UpstreamEditorValues } from './editor-data';
import { previewRecord } from './editor-data';
import { useMonoLabelClass } from './mono-label';
import { clearPkce, generatePkce, parseCallbackPaste, recallPkce, stashPkce } from './pkce';
import { api, callApi } from '../../api/client';
import type {
  DeviceFlowStart,
  UpstreamProviderKind,
  UpstreamRecord,
} from '../../api/types';
import { fluentComponents } from '../../fluent';
import { errorMessage } from '../../lib/error-message';
import { Dropdown, Input, Textarea } from '../ui/fluent-form-controls';
import { TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { SecretInput } from '../ui/secret-input';
import { SectionHeader } from '../ui/section-header';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { copyOutcomeIcon, useCopyLabel, useCopyToClipboard } from '../ui/use-copy-to-clipboard';
import { ProviderIcon, providerLabel } from '../upstreams/provider-badge';

const {
  Button,
  Checkbox,
  Field,
  Link,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
  Switch,
  Tab,
  TabList,
  Text,
  Tooltip,
} = fluentComponents;

// OAuth 2.0 device flow slow_down increases the current polling interval by five seconds.
// https://www.rfc-editor.org/rfc/rfc8628#section-3.5
const DEVICE_FLOW_SLOW_DOWN_SECONDS = 5;

export function ProviderConfigSection({
  record,
  onPatch,
  onRefreshModels,
}: {
  record: UpstreamRecord;
  onPatch: (patch: { config?: unknown; state?: unknown }, persisted?: boolean) => void;
  onRefreshModels: () => void;
}) {
  if (record.kind === 'custom') return <CustomConfig record={record} onRefreshModels={onRefreshModels} />;
  if (record.kind === 'azure') return <AzureConfig record={record} />;
  if (record.kind === 'ollama') return <OllamaConfig record={record} />;
  if (record.kind === 'copilot') return <CopilotConfig record={record} onPatch={onPatch} />;
  return <OAuthConfig record={record} onPatch={onPatch} />;
}

export function ApiPathsSection({ record }: { record: UpstreamRecord }) {
  if (record.kind !== 'custom') return null;
  return <CustomApiPaths />;
}

function CustomConfig({ onRefreshModels, record }: { onRefreshModels: () => void; record: Extract<UpstreamRecord, { kind: 'custom' }> }) {
  const { t } = useTranslation();
  const { control, setValue } = useFormContext<UpstreamEditorValues>();
  const authStyle = useWatch({ control, name: 'config.authStyle' as never }) as string;
  const fetchesCatalog = Boolean(useWatch({ control, name: 'config.modelsFetch.enabled' as never }));
  const authStyleLabel = (value: unknown) => {
    if (value === 'bearer') return 'Bearer';
    if (value === 'anthropic') return 'Anthropic';
    if (value === 'none') return t('dashboard.upstreamEditor.auth.none');
    return '';
  };
  return (
    <div className="grid gap-4">
      <Field label={t('dashboard.upstreamEditor.fields.baseUrl')} required>
        <Controller
          control={control}
          name={'config.baseUrl' as never}
          render={({ field }) => (
            <Input
              value={typeof field.value === 'string' ? field.value : ''}
              onBlur={field.onBlur}
              onChange={(_, data) => field.onChange(data.value)}
              placeholder="https://api.openai.com"
            />
          )}
        />
      </Field>
      <Controller control={control} name={'config.authStyle' as never} render={({ field }) => (
        <Field label={t('dashboard.upstreamEditor.fields.authStyle')}>
          <Dropdown value={authStyleLabel(field.value)} selectedOptions={[String(field.value)]} onOptionSelect={(_, data) => {
            field.onChange(data.optionValue);
            if (data.optionValue === 'none') setValue('config.apiKey' as never, '' as never, { shouldDirty: true });
          }}>
            <Option value="bearer">Bearer</Option>
            <Option value="anthropic">Anthropic</Option>
            <Option value="none">{t('dashboard.upstreamEditor.auth.none')}</Option>
          </Dropdown>
        </Field>
      )} />
      {authStyle !== 'none' && <SecretField name="config.apiKey" secretSet={record.config.apiKeySet === true || Boolean(record.config.apiKey)} />}
      <Controller control={control} name={'config.modelsFetch.enabled' as never} render={({ field }) => (
        <Switch
          checked={Boolean(field.value)}
          label={t('dashboard.upstreamEditor.fields.fetchModels')}
          onChange={(_, data) => {
            field.onChange(data.checked);
            if (data.checked) onRefreshModels();
          }}
        />
      )} />
      {/* The path only answers a question the switch has asked. Off, there is
          nothing to fetch and the field would be configuring a call that is not
          made. */}
      {fetchesCatalog && (
        <Field label={t('dashboard.upstreamEditor.fields.catalogPath')}>
          <Controller control={control} name={'config.modelsFetch.endpoint' as never} render={({ field }) => <Input className="font-mono" name={field.name} onBlur={field.onBlur} onChange={(_, data) => field.onChange(data.value)} placeholder="/v1/models" ref={field.ref} value={typeof field.value === 'string' ? field.value : ''} />} />
        </Field>
      )}
    </div>
  );
}

function CustomApiPaths() {
  const { t } = useTranslation();
  const monoLabel = useMonoLabelClass();
  const idPrefix = useId();
  const { control } = useFormContext<UpstreamEditorValues>();
  return (
    <div className="grid gap-4">
      <EndpointPicker />
      <div
        aria-describedby={`${idPrefix}-hint`}
        aria-labelledby={`${idPrefix}-label`}
        className="grid gap-1.5"
        role="group"
      >
        <SectionHeader level={3} title={t('dashboard.upstreamEditor.fields.pathOverrides')} titleId={`${idPrefix}-label`} />
        <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
          {pathOverrideKeys.map(path => (
            <Controller
              control={control}
              key={path}
              name={`config.pathOverrides.${path}` as never}
              render={({ field }) => (
                <Field className="min-w-0" label={{ children: path, className: monoLabel }}>
                  <Input
                    className="!w-full font-mono"
                    placeholder={`/v1${path}`}
                    size="small"
                    value={typeof field.value === 'string' ? field.value : ''}
                    onChange={(_, data) => field.onChange(data.value)}
                  />
                </Field>
              )}
            />
          ))}
        </div>
        <Text id={`${idPrefix}-hint`} size={200} className="text-fui-fg2">
          {t('dashboard.upstreamEditor.pathOverridesHint')}
        </Text>
      </div>
    </div>
  );
}

function AzureConfig({ record }: { record: Extract<UpstreamRecord, { kind: 'azure' }> }) {
  const { t } = useTranslation();
  const { control } = useFormContext<UpstreamEditorValues>();
  return <div className="grid gap-4">
    <Field label={t('dashboard.upstreamEditor.fields.endpoint')} required>
      <Controller control={control} name={'config.endpoint' as never} render={({ field }) => <Input className="font-mono" name={field.name} onBlur={field.onBlur} onChange={(_, data) => field.onChange(data.value)} placeholder="https://resource.openai.azure.com/openai/v1" ref={field.ref} value={typeof field.value === 'string' ? field.value : ''} />} />
    </Field>
    <SecretField name="config.apiKey" secretSet={record.config.apiKeySet === true || Boolean(record.config.apiKey)} />
  </div>;
}

function OllamaConfig({ record }: { record: Extract<UpstreamRecord, { kind: 'ollama' }> }) {
  const { t } = useTranslation();
  const { control } = useFormContext<UpstreamEditorValues>();
  return <div className="grid gap-4">
    <Field label={t('dashboard.upstreamEditor.fields.baseUrl')} required>
      <Controller control={control} name={'config.baseUrl' as never} render={({ field }) => <Input className="font-mono" name={field.name} onBlur={field.onBlur} onChange={(_, data) => field.onChange(data.value)} placeholder="https://ollama.com" ref={field.ref} value={typeof field.value === 'string' ? field.value : ''} />} />
    </Field>
    <SecretField name="config.apiKey" secretSet={record.config.apiKeySet === true || Boolean(record.config.apiKey)} optional />
  </div>;
}

function SecretField({ name, optional, secretSet }: { name: string; optional?: boolean; secretSet: boolean }) {
  const { t } = useTranslation();
  const { control } = useFormContext<UpstreamEditorValues>();
  const [visible, setVisible] = useState(false);
  return <Field
    label={`${t('dashboard.upstreamEditor.fields.apiKey')}${optional ? ` (${t('dashboard.upstreamEditor.optional')})` : ''}`}
    hint={secretSet ? t('dashboard.upstreamEditor.secretKeep') : undefined}
  >
    <Controller
      control={control}
      name={name as never}
      render={({ field }) => (
        <SecretInput
          revealed={visible}
          value={typeof field.value === 'string' ? field.value : ''}
          onBlur={field.onBlur}
          onChange={(_, data) => field.onChange(data.value)}
          placeholder={secretSet ? '••••••••' : 'sk-...'}
          contentAfter={
            <Tooltip
              content={visible ? t('dashboard.upstreamEditor.actions.hideSecret') : t('dashboard.upstreamEditor.actions.showSecret')}
              relationship="label"
            >
              <Button
                appearance="subtle"
                aria-label={visible ? t('dashboard.upstreamEditor.actions.hideSecret') : t('dashboard.upstreamEditor.actions.showSecret')}
                icon={visible ? <EyeOffRegular /> : <EyeRegular />}
                onClick={() => setVisible(value => !value)}
                size="small"
              />
            </Tooltip>
          }
        />
      )}
    />
  </Field>;
}

const endpointOptions = [
  ['completions', '/completions'],
  ['chatCompletions', '/chat/completions'],
  ['responses', '/responses'],
  ['messages', '/messages'],
] as const;

const pathOverrideKeys = [
  '/completions',
  '/chat/completions',
  '/responses',
  '/messages',
  '/embeddings',
  '/alpha/search',
  '/images/generations',
  '/images/edits',
] as const;

function EndpointPicker() {
  const { t } = useTranslation();
  const monoLabel = useMonoLabelClass();
  const idPrefix = useId();
  const { control, getValues, setValue } = useFormContext<UpstreamEditorValues>();
  const config = useWatch({ control, name: 'config' });
  const customConfig = config as Extract<UpstreamRecord, { kind: 'custom' }>['config'];
  const value = customConfig.endpoints;
  return <div className="grid gap-1.5" role="group" aria-labelledby={`${idPrefix}-label`}>
    <SectionHeader level={3} title={t('dashboard.upstreamEditor.fields.defaultEndpoints')} titleId={`${idPrefix}-label`} />
    <div className="grid gap-1">
      {endpointOptions.map(([key, label]) => {
        const selected = value[key] !== undefined;
        return <Checkbox
          id={`${idPrefix}-${key}`}
          name={`default-endpoint-${key}`}
          key={key}
          checked={selected}
          label={{ children: label, className: monoLabel }}
          onChange={(_, data) => {
            const latestConfig = getValues('config') as Extract<UpstreamRecord, { kind: 'custom' }>['config'];
            const next = { ...latestConfig.endpoints };
            if (data.checked) next[key] = {}; else delete next[key];
            setValue('config', { ...latestConfig, endpoints: next }, { shouldDirty: true });
          }} />;
      })}
    </div>
  </div>;
}

// An upstream that has just been authorised but not yet saved has no id, and
// the catalog endpoint keys off one — so the panel says what the next step is
// rather than leaving an empty model list to be interpreted.
function ReadyToSaveHint({ kind }: { kind: UpstreamProviderKind }) {
  const { t } = useTranslation();
  return <MessageBar intent="info">
    <MessageBarBody>
      <MessageBarTitle>{t('dashboard.upstreamEditor.readyToSave.title')}</MessageBarTitle>
      {t('dashboard.upstreamEditor.readyToSave.description', { provider: providerLabel(kind) })}
    </MessageBarBody>
  </MessageBar>;
}

function CopilotConfig({ record, onPatch }: {
  record: Extract<UpstreamRecord, { kind: 'copilot' }>;
  onPatch: (patch: { config?: unknown; state?: unknown }, persisted?: boolean) => void;
}) {
  const { t } = useTranslation();
  const values = useWatch<UpstreamEditorValues>();
  const config = values.config as typeof record.config;
  const [flow, setFlow] = useState<DeviceFlowStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  // Between a tick firing and its reply landing the loop holds no timer id, so
  // clearing the timer cannot on its own end it: the reply would schedule the
  // next tick with nothing left to cancel it. The flag is what the recursion
  // reads after every await, and the mount branch re-arms it so StrictMode's
  // mount/unmount/mount does not leave a live component permanently stopped.
  const cancelled = useRef(false);
  const stop = () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; };
  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; stop(); };
  }, []);

  const poll = async (deviceCode: string, interval: number, secondsLeft: number) => {
    const result = await callApi(() => api.api.upstreams.copilot.oauth['device-login'].poll.$post({
      json: { record: previewRecord(record, values as UpstreamEditorValues), deviceCode },
    }));
    if (cancelled.current) return;
    if (result.error) {
      // Only a reply that says nothing about the device code is worth
      // repeating: no response at all, or an unhealthy GitHub/Copilot hop. Any
      // other status carries GitHub's verdict on the code itself, and
      // `expired_token` and `access_denied` are terminal — polling past either
      // one collects the same refusal for as long as the tab stays open.
      // https://www.rfc-editor.org/rfc/rfc8628#section-3.5
      const transient = result.error.status === 0 || result.error.status === 502;
      // The verdict is what normally ends the loop; `secondsLeft` bounds the
      // case where no verdict is ever reached, by spending the code's own
      // `expires_in` one scheduled tick at a time. Whatever failure outlives it
      // is the one the operator reads.
      if (!transient || secondsLeft <= 0) { setBusy(false); setFlow(null); setError(result.error.message); return; }
      timer.current = window.setTimeout(() => void poll(deviceCode, interval, secondsLeft - interval), interval * 1000);
      return;
    }
    if (result.data.status === 'complete') { setBusy(false); onPatch(result.data.patch, record.id !== ''); return; }
    if (result.data.status === 'slow_down') {
      const next = interval + DEVICE_FLOW_SLOW_DOWN_SECONDS;
      timer.current = window.setTimeout(() => void poll(deviceCode, next, secondsLeft - next), next * 1000);
      return;
    }
    timer.current = window.setTimeout(() => void poll(deviceCode, interval, secondsLeft - interval), interval * 1000);
  };
  const start = async () => {
    stop(); setBusy(true); setError(null);
    const result = await callApi(() => api.api.upstreams.copilot.oauth['device-login'].start.$post());
    if (cancelled.current) return;
    if (result.error) { setBusy(false); setError(result.error.message); return; }
    setFlow(result.data);
    const { device_code, expires_in, interval } = result.data;
    timer.current = window.setTimeout(() => void poll(device_code, interval, expires_in - interval), interval * 1000);
  };

  if (config.user.login) {
    return <div className="grid gap-3">
      <AccountSummary kind="copilot" title={config.user.name ?? config.user.login} subtitle={`@${config.user.login}`} />
      {record.id === '' ? <ReadyToSaveHint kind="copilot" /> : <CopilotQuotaCard record={record} />}
    </div>;
  }
  return <div className="grid gap-3">
    <Text size={300} className="text-fui-fg2">{t('dashboard.upstreamEditor.copilot.description')}</Text>
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    {!flow ? <Button appearance="primary" disabledFocusable={busy} icon={busy ? <Spinner size="tiny" /> : <PlugConnectedRegular />} onClick={() => void start()}>{t('dashboard.upstreamEditor.copilot.connect')}</Button> : <>
      <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.copilot.deviceCode')}</Text>
      <code className="mono-display tracking-[0.25em] text-fui-fg1">{flow.user_code}</code>
      <Link href={flow.verification_uri} target="_blank">{flow.verification_uri}</Link>
      <span className="inline-flex items-center gap-2 text-xs text-fui-fg2"><Spinner size="tiny" />{t('dashboard.upstreamEditor.copilot.waiting')}</span>
    </>}
  </div>;
}

type OAuthKind = 'codex' | 'claude-code';
function OAuthConfig({ record, onPatch }: {
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
    const result = record.kind === 'codex'
      ? await callApi(() => api.api.upstreams.codex.oauth.refresh.$post({ json: body }))
      : await callApi(() => api.api.upstreams['claude-code'].oauth.refresh.$post({ json: body }));
    setRefreshing(false);
    if (result.error) { setError(result.error.message); return; }
    onPatch(result.data.patch, record.id !== '');
  };
  const [open, setOpen] = useState(!hasAccount);
  const [probing, setProbing] = useState(false);

  // Quota probes make an upstream call only on operator request; the gateway
  // persists the resulting snapshot once the upstream exists.
  const probeQuota = async () => {
    setProbing(true);
    setError(null);
    const result = await callApi(() => api.api.upstreams['claude-code'].probe.$post({
      json: { record: previewRecord(record, values) },
    }));
    setProbing(false);
    if (result.error) { setError(result.error.message); return; }
    onPatch(result.data.patch, record.id !== '');
  };
  const [tab, setTab] = useState(record.kind === 'codex' ? 'json' : 'oauth');
  const [json, setJson] = useState('');
  const [callback, setCallback] = useState('');
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const { copy, outcomeFor } = useCopyToClipboard();
  const copyLabel = useCopyLabel();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flowKind = tab === 'setup' ? 'setup-token' : 'oauth';

  const prepare = useCallback(async () => {
    setBusy(true); setError(null);
    const pkce = await generatePkce();
    stashPkce(record.kind, flowKind, { verifier: pkce.verifier, state: pkce.state });
    const body = { record: previewRecord(record, getValues()), challenge: pkce.challenge, state: pkce.state };
    const result = record.kind === 'codex'
      ? await callApi(() => api.api.upstreams.codex.oauth['authorize-url'].$post({ json: body }))
      : tab === 'setup'
        ? await callApi(() => api.api.upstreams['claude-code']['setup-token']['authorize-url'].$post({ json: body }))
        : await callApi(() => api.api.upstreams['claude-code'].oauth['authorize-url'].$post({ json: body }));
    setBusy(false);
    if (result.error) { setError(result.error.message); return; }
    setAuthorizeUrl(result.data.authorize_url);
  }, [flowKind, getValues, record, tab]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Opening the panel starts an authorize-url request; the pending flag is the start of that work.
  useEffect(() => { if (open && tab !== 'json' && !authorizeUrl) void prepare(); }, [authorizeUrl, open, prepare, tab]);

  const submit = async () => {
    setBusy(true); setError(null);
    const editorRecord = previewRecord(record, values);
    let result;
    try {
      if (tab === 'json') {
        JSON.parse(json);
        result = record.kind === 'codex'
          ? await callApi(() => api.api.upstreams.codex.oauth.exchange.$post({
              json: { record: editorRecord, auth_json: json },
            }))
          : await callApi(() => api.api.upstreams['claude-code'].oauth.exchange.$post({
              json: { record: editorRecord, credentials_json: json },
            }));
      } else {
        const parsed = parseCallbackPaste(callback);
        const recalled = recallPkce(record.kind, flowKind, parsed.state);
        if (!recalled) throw new Error(t('dashboard.upstreamEditor.oauth.unrecognized'));
        result = record.kind === 'codex'
          ? await callApi(() => api.api.upstreams.codex.oauth.exchange.$post({
              json: { record: editorRecord, callback: { code: parsed.code, verifier: recalled.verifier } },
            }))
          : tab === 'setup'
            ? await callApi(() => api.api.upstreams['claude-code']['setup-token'].exchange.$post({
                json: { record: editorRecord, callback: { code: parsed.code, verifier: recalled.verifier, state: parsed.state } },
              }))
            : await callApi(() => api.api.upstreams['claude-code'].oauth.exchange.$post({
                json: { record: editorRecord, callback: { code: parsed.code, verifier: recalled.verifier, state: parsed.state } },
              }));
      }
    } catch (error) {
      setBusy(false); setError(errorMessage(error)); return;
    }
    setBusy(false);
    if (result.error) { setError(result.error.message); return; }
    clearPkce(record.kind, flowKind);
    onPatch(result.data.patch, record.id !== '');
    setOpen(false); setJson(''); setCallback(''); setAuthorizeUrl(null);
  };

  return <div className="grid gap-4">
    {hasAccount && (record.kind === 'codex'
      ? <CodexAccountCard record={{ ...record, kind: 'codex', config: config as Extract<UpstreamRecord, { kind: 'codex' }>['config'], state: values.state as Extract<UpstreamRecord, { kind: 'codex' }>['state'] }} />
      : <ClaudeCodeAccountCard
          onRefreshQuota={() => void probeQuota()}
          probing={probing}
          record={{ ...record, kind: 'claude-code', config: config as Extract<UpstreamRecord, { kind: 'claude-code' }>['config'], state: values.state as Extract<UpstreamRecord, { kind: 'claude-code' }>['state'] }}
        />)}
    {hasAccount && record.id === '' && <ReadyToSaveHint kind={record.kind} />}
    {hasAccount && <div className="flex flex-wrap items-center gap-2">
      <Button appearance="primary" disabledFocusable={refreshing} icon={refreshing ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />} onClick={() => void refreshCredential()}>
        {t('dashboard.upstreamEditor.oauth.refresh')}
      </Button>
      <Button appearance="secondary" onClick={() => setOpen(value => !value)}>{open ? t('common.cancel') : t('dashboard.upstreamEditor.oauth.reimport')}</Button>
    </div>}
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    {open && <>
      <TabList selectedValue={tab} onTabSelect={(_, data) => { setTab(String(data.value)); setAuthorizeUrl(null); }}>
        {record.kind === 'codex' ? <><Tab value="json">auth.json</Tab><Tab value="oauth">OAuth</Tab></> : <><Tab value="oauth">OAuth</Tab><Tab value="setup">Setup Token</Tab><Tab value="json">credentials.json</Tab></>}
      </TabList>
      {tab === 'json' ? <Field label={t('dashboard.upstreamEditor.oauth.credentialJson')}><Textarea rows={8} value={json} onChange={(_, data) => setJson(data.value)} className="font-mono" /></Field> : <div className="grid gap-3">
        {busy && !authorizeUrl ? <Spinner label={t('dashboard.upstreamEditor.oauth.preparing')} /> : authorizeUrl && <div className="flex items-center gap-2 min-w-0"><Link href={authorizeUrl} target="_blank" className="truncate">{t('dashboard.upstreamEditor.oauth.openAuthorize')}</Link><TooltipIconButton icon={copyOutcomeIcon(outcomeFor())} label={copyLabel(outcomeFor(), t('dashboard.upstreamEditor.oauth.copy'))} onClick={() => copy(authorizeUrl)} /></div>}
        <Field label={t('dashboard.upstreamEditor.oauth.callback')}><Textarea rows={3} value={callback} onChange={(_, data) => setCallback(data.value)} className="font-mono" /></Field>
      </div>}
      <Button appearance="primary" disabledFocusable={busy} icon={busy ? <Spinner size="tiny" /> : <CheckmarkCircleRegular />} onClick={() => void submit()}>{hasAccount ? t('dashboard.upstreamEditor.oauth.reimport') : t('dashboard.upstreamEditor.oauth.import')}</Button>
    </>}
  </div>;
}

function AccountSummary({ kind, subtitle, title }: { kind: UpstreamProviderKind; subtitle: string; title: string }) {
  return <div className="flex items-center gap-3 min-w-0">
    <ProviderIcon kind={kind} className="h-8 w-8" />
    <div className="grid gap-0.5 min-w-0"><Text weight="semibold" truncate>{title}</Text><Text size={200} className="text-fui-fg2" truncate>{subtitle}</Text></div>
  </div>;
}
