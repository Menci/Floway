import {
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  EyeOffRegular,
  EyeRegular,
  PlugConnectedRegular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Controller, useFormContext, useWatch } from 'react-hook-form';

import { ClaudeCodeAccountCard } from './claude-code-account-card';
import { CodexAccountCard } from './codex-account-card';
import { CopilotQuotaCard } from './copilot-quota-card';
import type { UpstreamEditorValues } from './data';
import { isPersisted, previewRecord } from './data';
import { CHAT_ENDPOINT_KEYS, endpointOptionsFor, PATH_OVERRIDE_PATHS } from './endpoints';
import { useMonoLabelClass } from './mono-label';
import { clearPkce, generatePkce, parseCallbackPaste, recallPkce, stashPkce } from './pkce';
import { EditorSection } from './section';
import { api, callApi } from '../../api/client';
import type { DeviceFlowStart, UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { errorMessage } from '../../lib/error-message';
import { Dropdown, Input, Textarea } from '../ui/fluent-form-controls';
import { CHECKBOX_LIST_CLASS, TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { OpenLinkLabel } from '../ui/open-link-label';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { SecretInput } from '../ui/secret-input';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { copyOutcomeIcon, useCopyLabel, useCopyToClipboard } from '../ui/use-copy-to-clipboard';
import { ProviderIcon, providerLabel } from '../upstreams/provider-badge';
import type { UpstreamProviderKind } from '@floway-dev/provider/model';

const {
  Button,
  Checkbox,
  Field,
  Link,
  Option,
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
  const { control, setValue } = useFormContext<ValuesForKind<'custom'>>();
  const authStyle = useWatch({ control, name: 'config.authStyle' });
  const fetchesCatalog = useWatch({ control, name: 'config.modelsFetch.enabled' });
  const authStyleLabel = (value: typeof authStyle) => {
    switch (value) {
    case 'bearer': return 'Bearer';
    case 'anthropic': return 'Anthropic';
    case 'none': return t('dashboard.upstreamEditor.auth.none');
    }
  };
  return (
    <div className="grid gap-4">
      <Field label={t('dashboard.upstreamEditor.fields.baseUrl')}>
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
              ref={field.ref}
              value={field.value}
            />
          )}
        />
      </Field>
      <Controller control={control} name="config.authStyle" render={({ field }) => (
        <Field label={t('dashboard.upstreamEditor.fields.authStyle')}>
          <Dropdown value={authStyleLabel(field.value)} selectedOptions={[field.value]} onOptionSelect={(_, data) => {
            field.onChange(data.optionValue);
            if (data.optionValue === 'none') setValue('config.apiKey', '', { shouldDirty: true });
          }}>
            <Option value="bearer">Bearer</Option>
            <Option value="anthropic">Anthropic</Option>
            <Option value="none">{t('dashboard.upstreamEditor.auth.none')}</Option>
          </Dropdown>
        </Field>
      )} />
      {authStyle !== 'none' && <SecretField secretSet={record.config.apiKeySet === true || Boolean(record.config.apiKey)} />}
      <Controller control={control} name="config.modelsFetch.enabled" render={({ field }) => (
        <Switch
          checked={field.value}
          label={t('dashboard.upstreamEditor.fields.fetchModels')}
          onChange={(_, data) => {
            field.onChange(data.checked);
            if (data.checked) onRefreshModels();
          }}
        />
      )} />
      {fetchesCatalog && (
        <Field label={t('dashboard.upstreamEditor.fields.catalogPath')}>
          <Controller control={control} name="config.modelsFetch.endpoint" render={({ field }) => <Input className="font-mono" name={field.name} onBlur={field.onBlur} onChange={(_, data) => field.onChange(data.value)} placeholder="/v1/models" ref={field.ref} value={field.value ?? ''} />} />
        </Field>
      )}
    </div>
  );
}

function CustomApiPaths() {
  const { t } = useTranslation();
  const monoLabel = useMonoLabelClass();
  const { control } = useFormContext<ValuesForKind<'custom'>>();
  return (
    <div className="grid gap-4">
      <EndpointPicker />
      <EditorSection
        hint={t('dashboard.upstreamEditor.pathOverridesHint')}
        level={3}
        title={t('dashboard.upstreamEditor.fields.pathOverrides')}
      >
        <div className={`${TWO_COLUMN_FORM_CLASS} gap-3`}>
          {PATH_OVERRIDE_PATHS.map(path => (
            <Controller
              control={control}
              key={path}
              name={`config.pathOverrides.${path}`}
              render={({ field }) => (
                <Field className="min-w-0" label={{ children: path, className: monoLabel }}>
                  <Input
                    className="!w-full font-mono"
                    name={field.name}
                    onBlur={field.onBlur}
                    onChange={(_, data) => field.onChange(data.value)}
                    placeholder={`/v1${path}`}
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

function AzureConfig({ record }: { record: Extract<UpstreamRecord, { kind: 'azure' }> }) {
  const { t } = useTranslation();
  const { control } = useFormContext<ValuesForKind<'azure'>>();
  return <div className="grid gap-4">
    <Field label={t('dashboard.upstreamEditor.fields.endpoint')}>
      <Controller control={control} name="config.endpoint" render={({ field }) => <Input className="font-mono" name={field.name} onBlur={field.onBlur} onChange={(_, data) => field.onChange(data.value)} placeholder="https://resource.openai.azure.com/openai/v1" ref={field.ref} value={field.value} />} />
    </Field>
    <SecretField secretSet={record.config.apiKeySet === true || Boolean(record.config.apiKey)} />
  </div>;
}

function OllamaConfig({ record }: { record: Extract<UpstreamRecord, { kind: 'ollama' }> }) {
  const { t } = useTranslation();
  const { control } = useFormContext<ValuesForKind<'ollama'>>();
  return <div className="grid gap-4">
    <Field label={t('dashboard.upstreamEditor.fields.baseUrl')}>
      <Controller control={control} name="config.baseUrl" render={({ field }) => <Input className="font-mono" name={field.name} onBlur={field.onBlur} onChange={(_, data) => field.onChange(data.value)} placeholder="https://ollama.com" ref={field.ref} value={field.value} />} />
    </Field>
    <SecretField secretSet={record.config.apiKeySet === true || Boolean(record.config.apiKey)} optional />
  </div>;
}

function SecretField({ optional, secretSet }: { optional?: boolean; secretSet: boolean }) {
  const { t } = useTranslation();
  const { control } = useFormContext<ValuesForKind<'custom' | 'azure' | 'ollama'>>();
  const [visible, setVisible] = useState(false);
  return <Field
    label={`${t('dashboard.upstreamEditor.fields.apiKey')}${optional ? ` (${t('dashboard.upstreamEditor.optional')})` : ''}`}
    hint={secretSet ? t('dashboard.upstreamEditor.secretKeep') : undefined}
  >
    <Controller
      control={control}
      name="config.apiKey"
      render={({ field }) => (
        <SecretInput
          revealed={visible}
          value={field.value ?? ''}
          onBlur={field.onBlur}
          onChange={(_, data) => field.onChange(data.value)}
          placeholder={secretSet ? '••••••••' : 'sk-...'}
          contentAfter={
            <TooltipIconButton
              icon={visible ? <EyeOffRegular /> : <EyeRegular />}
              label={visible ? t('dashboard.upstreamEditor.actions.hideSecret') : t('dashboard.upstreamEditor.actions.showSecret')}
              onClick={() => setVisible(value => !value)}
            />
          }
        />
      )}
    />
  </Field>;
}

const endpointOptions = endpointOptionsFor(CHAT_ENDPOINT_KEYS);

function EndpointPicker() {
  const { t } = useTranslation();
  const monoLabel = useMonoLabelClass();
  const { control, getValues, setValue } = useFormContext<UpstreamEditorValues>();
  const config = useWatch({ control, name: 'config' });
  const customConfig = config as Extract<UpstreamRecord, { kind: 'custom' }>['config'];
  const value = customConfig.endpoints;
  return <EditorSection level={3} title={t('dashboard.upstreamEditor.fields.defaultEndpoints')}>
    <div className={`grid ${CHECKBOX_LIST_CLASS}`}>
      {endpointOptions.map(([key, label]) => {
        const selected = value[key] !== undefined;
        return <Checkbox
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
  </EditorSection>;
}

function ReadyToSaveHint({ kind }: { kind: UpstreamProviderKind }) {
  const { t } = useTranslation();
  return <OutcomeMessageBar intent="info" title={t('dashboard.upstreamEditor.readyToSave.title')}>
    {t('dashboard.upstreamEditor.readyToSave.description', { provider: providerLabel(kind) })}
  </OutcomeMessageBar>;
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
    const result = await callApi(() => api.api.upstreams.copilot.oauth['device-login'].start.$post());
    if (cancelled.current) return;
    if (result.error) { setBusy(false); setError(result.error.message); return; }
    setFlow(result.data);
  };

  if (config.user.login) {
    return <div className="grid gap-3">
      <AccountSummary kind="copilot" title={config.user.name ?? config.user.login} subtitle={`@${config.user.login}`} />
      {isPersisted(record) ? <CopilotQuotaCard record={record} /> : <ReadyToSaveHint kind="copilot" />}
    </div>;
  }
  return <div className="grid gap-3">
    <Text size={300} className="text-fui-fg2">{t('dashboard.upstreamEditor.copilot.description')}</Text>
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    {!flow ? <Button appearance="primary" disabledFocusable={busy} icon={busy ? <Spinner size="tiny" /> : <PlugConnectedRegular />} onClick={() => void start()}>{t('dashboard.upstreamEditor.copilot.connect')}</Button> : <>
      <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.copilot.deviceCode')}</Text>
      <code className="mono-display tracking-[0.25em] text-fui-fg1">{flow.user_code}</code>
      <Link href={flow.verification_uri} target="_blank" rel="noopener noreferrer">{flow.verification_uri}</Link>
      <Spinner label={t('dashboard.upstreamEditor.copilot.waiting')} labelPosition="after" size="tiny" />
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
  const [tab, setTab] = useState(record.kind === 'codex' ? 'json' : 'oauth');
  const [json, setJson] = useState('');
  const [callback, setCallback] = useState('');
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const { copy, outcomeFor } = useCopyToClipboard();
  const copyLabel = useCopyLabel();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flowKind = tab === 'setup' ? 'setup-token' : 'oauth';

  // Two authorize-url requests can be outstanding at once — a tab switch
  // supersedes one, and the effect below re-fires on every `record` identity
  // change. `stashPkce` writes one sessionStorage slot per (kind, flow kind),
  // so the verifier must belong to the URL the operator actually opened: the
  // generation is taken before the stash as well as before the URL, because a
  // round trip separates them and an older call could otherwise stash last.
  const generation = useRef(0);
  const prepare = useCallback(async () => {
    const mine = ++generation.current;
    setBusy(true); setError(null);
    const pkce = await generatePkce();
    if (generation.current !== mine) return;
    stashPkce(record.kind, flowKind, { verifier: pkce.verifier, state: pkce.state });
    const body = { record: previewRecord(record, getValues()), challenge: pkce.challenge, state: pkce.state };
    const result = record.kind === 'codex'
      ? await callApi(() => api.api.upstreams.codex.oauth['authorize-url'].$post({ json: body }))
      : tab === 'setup'
        ? await callApi(() => api.api.upstreams['claude-code']['setup-token']['authorize-url'].$post({ json: body }))
        : await callApi(() => api.api.upstreams['claude-code'].oauth['authorize-url'].$post({ json: body }));
    if (generation.current !== mine) return;
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
    onPatch(result.data.patch, isPersisted(record));
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
    {hasAccount && !isPersisted(record) && <ReadyToSaveHint kind={record.kind} />}
    {hasAccount && <div className="flex flex-wrap items-center gap-2">
      <Button appearance="primary" disabledFocusable={refreshing} icon={refreshing ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />} onClick={() => void refreshCredential()}>
        {t('dashboard.upstreamEditor.oauth.refresh')}
      </Button>
      <Button onClick={() => setOpen(value => !value)}>{open ? t('common.cancel') : t('dashboard.upstreamEditor.oauth.reimport')}</Button>
    </div>}
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    {open && <>
      <TabList aria-label={t('dashboard.upstreamEditor.oauth.importMethod')} selectedValue={tab} onTabSelect={(_, data) => { setTab(String(data.value)); setAuthorizeUrl(null); }}>
        {record.kind === 'codex' ? <><Tab value="json">auth.json</Tab><Tab value="oauth">OAuth</Tab></> : <><Tab value="oauth">OAuth</Tab><Tab value="setup">Setup Token</Tab><Tab value="json">credentials.json</Tab></>}
      </TabList>
      {tab === 'json' ? <Field label={t('dashboard.upstreamEditor.oauth.credentialJson')}><Textarea className="font-mono" rows={8} value={json} onChange={(_, data) => setJson(data.value)} /></Field> : <div className="grid gap-3">
        {busy && !authorizeUrl ? <Spinner label={t('dashboard.upstreamEditor.oauth.preparing')} /> : authorizeUrl && <div className="flex items-center gap-2 min-w-0"><Link href={authorizeUrl} target="_blank" rel="noopener noreferrer"><OpenLinkLabel>{t('dashboard.upstreamEditor.oauth.openAuthorize')}</OpenLinkLabel></Link><TooltipIconButton icon={copyOutcomeIcon(outcomeFor())} label={copyLabel(outcomeFor(), t('dashboard.upstreamEditor.oauth.copy'))} onClick={() => copy(authorizeUrl)} /></div>}
        <Field label={t('dashboard.upstreamEditor.oauth.callback')}><Textarea className="font-mono" rows={3} value={callback} onChange={(_, data) => setCallback(data.value)} /></Field>
      </div>}
      <Button appearance="primary" disabledFocusable={busy} icon={busy ? <Spinner size="tiny" /> : <CheckmarkCircleRegular />} onClick={() => void submit()}>{hasAccount ? t('dashboard.upstreamEditor.oauth.reimport') : t('dashboard.upstreamEditor.oauth.import')}</Button>
    </>}
  </div>;
}

function AccountSummary({ kind, subtitle, title }: { kind: UpstreamProviderKind; subtitle: string; title: string }) {
  return <div className="flex items-center gap-3 min-w-0">
    <ProviderIcon kind={kind} className="h-8 w-8" />
    <div className="grid gap-0.5 min-w-0"><Text block weight="semibold" truncate wrap={false}>{title}</Text><Text block size={200} className="text-fui-fg2" truncate wrap={false}>{subtitle}</Text></div>
  </div>;
}
