import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cloneAgentSetupConfiguration, defaultAgentSetupConfiguration, type AgentSetupConfiguration } from './agent-setup-contract';
import { applyLocalAgentSetupChanges } from './agent-setup-draft';
import { buildAgentModelOptions, rankAgentSetupModels, type ClaudePicker } from './agent-setup-models';
import { detectAgentSetupPlatform, type AgentSetupPlatform } from './agent-setup-platform';
import { codexUnixCredentialSnippet, codexWindowsCredentialSnippet } from './codex-credential-snippets';
import { agentSetupCommand, useAgentSetup } from './use-agent-setup';
import type { ApiKey, ControlPlaneModel } from '../../api/types';
import claudeIconUrl from '../../assets/claude-color.svg';
import codexIconUrl from '../../assets/codex.svg';
import { fluentComponents } from '../../fluent';
import { CodeBlock } from '../ui/code-block';
import { Combobox, Select } from '../ui/fluent-form-controls';

const { Button, Field, MessageBar, MessageBarBody, Option, Spinner, Switch, Tab, TabList, Text } = fluentComponents;
type Agent = 'claude' | 'codex';
type Platform = AgentSetupPlatform;
const NONE = '__floway_none__';
// Model overrides reject NUL at the gateway boundary, so these UI-only values
// cannot collide with an opaque model id.
const MODEL_DEFAULT = '\u0000default';
const NO_MODEL_MATCHES = '\u0000no-matches';
const SINGLE_FIELD_CLASS = 'w-full max-w-[420px]';
const claudeCleanupPeriods = [180, 365, 99999] as const satisfies readonly NonNullable<AgentSetupConfiguration['claudeCode']['cleanupPeriodDays']>[];

// Claude uses empty strings to suppress commit/PR attribution and false to
// suppress session links.
// Ref: https://code.claude.com/docs/en/settings#attribution-settings
const claudeAttributionOptOut = { commit: '', pr: '', sessionUrl: false } as const;

export function AgentSetupCard({ copiedTag, copyFailedTag, models, onCopy, selectedKey }: {
  copiedTag: string | null;
  copyFailedTag: string | null;
  models: ControlPlaneModel[];
  onCopy: (text: string, tag: string) => void;
  selectedKey: ApiKey | null;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<'setup' | 'snippets'>('setup');
  const [agent, setAgent] = useState<Agent>('claude');
  const [platform, setPlatform] = useState<Platform>(() => typeof navigator === 'undefined'
    ? 'unix'
    : detectAgentSetupPlatform(navigator.platform, navigator.userAgent));
  const [localDraft, setLocalDraft] = useState(() => defaultAgentSetupConfiguration());
  const localDraftBaseline = useRef(cloneAgentSetupConfiguration(localDraft));
  const appliedLease = useRef<string | null>(null);
  const setup = useAgentSetup(selectedKey?.id ?? null);
  const setupDraft = setup.draft;
  const setupLease = setup.lease;
  const updateSetupDraft = setup.updateDraft;

  useEffect(() => {
    if (!selectedKey || !setupLease || !setupDraft) return;
    const leaseKey = `${selectedKey.id}:${setupLease.token}`;
    if (appliedLease.current === leaseKey) return;
    appliedLease.current = leaseKey;
    updateSetupDraft(current => applyLocalAgentSetupChanges(current, localDraft, localDraftBaseline.current, selectedKey.id));
    localDraftBaseline.current = cloneAgentSetupConfiguration(localDraft);
  }, [localDraft, selectedKey, setupDraft, setupLease, updateSetupDraft]);

  const activeDraft = selectedKey && setupDraft ? setupDraft : localDraft;
  const updateConfiguration = (update: (current: AgentSetupConfiguration) => AgentSetupConfiguration) => {
    if (selectedKey && setupDraft) updateSetupDraft(update);
    else setLocalDraft(current => update(cloneAgentSetupConfiguration(current)));
  };

  const scripts = setup.lease?.scripts[agent];
  const scriptPath = platform === 'unix' ? scripts?.sh : scripts?.ps1;
  const command = scriptPath
    ? agentSetupCommand(typeof window === 'undefined' ? 'http://localhost:5173' : window.location.origin, scriptPath, platform)
    : t('dashboard.apiKeys.agentSetup.commandPending');

  return <div className="grid gap-4 min-w-0">
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <TabList selectedValue={agent} onTabSelect={(_, data) => setAgent(data.value === 'codex' ? 'codex' : 'claude')}>
          <AgentTab icon={claudeIconUrl} label={t('dashboard.apiKeys.configuration.claudeCode')} value="claude" />
          <AgentTab icon={codexIconUrl} label={t('dashboard.apiKeys.configuration.codex')} value="codex" />
        </TabList>
        {setup.syncing && <span className="inline-flex h-8 items-center gap-2 text-fui-fg2 text-fui-base200"><Spinner size="tiny" />{t('dashboard.apiKeys.agentSetup.saving')}</span>}
      </div>
      <Field className="w-full max-w-[260px]" label={{ children: t('dashboard.apiKeys.agentSetup.accessMethod'), className: 'font-fui-semibold' }}>
        <Select value={view} onChange={(_, data) => setView(data.value === 'snippets' ? 'snippets' : 'setup')}>
          <option value="setup">{t('dashboard.apiKeys.agentSetup.setupTab')}</option>
          <option value="snippets">{t('dashboard.apiKeys.agentSetup.snippetsTab')}</option>
        </Select>
      </Field>
    </div>

    {!selectedKey && <MessageBar><MessageBarBody>{t('dashboard.apiKeys.agentSetup.selectKey')}</MessageBarBody></MessageBar>}
    {selectedKey && !setup.lease && !setup.createError && !setup.noSelectableKey && <span className="inline-flex items-center gap-2 text-fui-fg2"><Spinner size="tiny" />{t('dashboard.apiKeys.agentSetup.preparing')}</span>}
    {setup.noSelectableKey && <MessageBar><MessageBarBody>{t('dashboard.apiKeys.agentSetup.noKey')}</MessageBarBody></MessageBar>}
    {setup.terminated && <MessageBar intent="warning"><MessageBarBody>{t('dashboard.apiKeys.agentSetup.expired')}</MessageBarBody></MessageBar>}
    {setup.createError && !setup.lease
      ? <MessageBar intent="error"><MessageBarBody><span className="inline-flex items-center gap-2 flex-wrap">{setup.createError}<Button appearance="secondary" onClick={setup.retryCreate} size="small">{t('dashboard.apiKeys.agentSetup.retry')}</Button></span></MessageBarBody></MessageBar>
      : setup.error && <MessageBar intent="error"><MessageBarBody>{setup.error}</MessageBarBody></MessageBar>}

    <section className="grid gap-3">
      <Text as="h3" size={300} weight="semibold" className="!m-0">{t('dashboard.apiKeys.agentSetup.modelSelection')}</Text>
      <AgentConfigurationFields agent={agent} configuration={activeDraft} models={models} onChange={updateConfiguration} />
    </section>

    {view === 'snippets' && selectedKey
      ? <AgentConfigSnippets agent={agent} apiKey={selectedKey.key} configuration={activeDraft} copiedTag={copiedTag} copyFailedTag={copyFailedTag} onCopy={onCopy} onPlatformChange={setPlatform} platform={platform} />
      : view === 'snippets'
        ? <MessageBar><MessageBarBody>{t('dashboard.apiKeys.agentSetup.selectKey')}</MessageBarBody></MessageBar>
        : <div className="grid gap-3 border-t border-t-solid border-fui-stroke1 pt-4">
            <div className="flex items-end justify-between gap-3 flex-wrap">
              <Field className="min-w-[190px]" label={t('dashboard.apiKeys.agentSetup.platform')}>
                <Select value={platform} onChange={(_, data) => setPlatform(data.value === 'windows' ? 'windows' : 'unix')}>
                  <option value="unix">macOS / Linux</option>
                  <option value="windows">Windows</option>
                </Select>
              </Field>
              <Text size={200} className="text-fui-fg2">{t('dashboard.apiKeys.agentSetup.expires')}</Text>
            </div>
            <CodeBlock
              code={command}
              copied={copiedTag === `agent-setup-${agent}-${platform}`}
              copyFailed={copyFailedTag === `agent-setup-${agent}-${platform}`}
              disabled={!setup.canCopy}
              language={platform === 'unix' ? 'bash' : 'powershell'}
              onCopy={() => setup.canCopy && onCopy(command, `agent-setup-${agent}-${platform}`)}
            />
          </div>}
  </div>;
}

function AgentConfigSnippets({ agent, apiKey, configuration, copiedTag, copyFailedTag, onCopy, onPlatformChange, platform }: {
  agent: Agent;
  apiKey: string;
  configuration: AgentSetupConfiguration;
  copiedTag: string | null;
  copyFailedTag: string | null;
  onCopy: (text: string, tag: string) => void;
  onPlatformChange: (platform: Platform) => void;
  platform: Platform;
}) {
  const { t } = useTranslation();
  const origin = typeof window === 'undefined' ? 'http://localhost:5173' : window.location.origin;
  if (agent === 'claude') {
    const snippet = buildAgentClaudeSnippet(origin, apiKey, configuration.claudeCode);
    return <div className="grid gap-2 border-t border-t-solid border-fui-stroke1 pt-4">
      <Text size={200} className="text-fui-fg2">{t('dashboard.apiKeys.configuration.claudeHint')}</Text>
      <CodeBlock code={snippet} copied={copiedTag === 'agent-snippet-claude'} copyFailed={copyFailedTag === 'agent-snippet-claude'} language="json" onCopy={() => onCopy(snippet, 'agent-snippet-claude')} />
    </div>;
  }
  const config = buildAgentCodexSnippet(origin, configuration.codex);
  const unix = codexUnixCredentialSnippet(apiKey);
  const windows = codexWindowsCredentialSnippet(apiKey);
  const credential = platform === 'windows' ? windows : unix;
  const credentialTag = platform === 'windows' ? 'agent-snippet-codex-windows' : 'agent-snippet-codex-unix';
  return <div className="grid gap-3 border-t border-t-solid border-fui-stroke1 pt-4">
    <Text size={200} className="text-fui-fg2">{t('dashboard.apiKeys.configuration.codexConfigHint')}</Text>
    <CodeBlock code={config} copied={copiedTag === 'agent-snippet-codex'} copyFailed={copyFailedTag === 'agent-snippet-codex'} language="toml" onCopy={() => onCopy(config, 'agent-snippet-codex')} />
    <Field className="min-w-[190px] max-w-[260px]" label={t('dashboard.apiKeys.agentSetup.platform')}>
      <Select value={platform} onChange={(_, data) => onPlatformChange(data.value === 'windows' ? 'windows' : 'unix')}>
        <option value="unix">macOS / Linux</option>
        <option value="windows">Windows</option>
      </Select>
    </Field>
    <Text size={200} className="text-fui-fg2">
      {t(platform === 'windows' ? 'dashboard.apiKeys.configuration.codexWindowsAuthHint' : 'dashboard.apiKeys.configuration.codexAuthHint')}
    </Text>
    <CodeBlock code={credential} copied={copiedTag === credentialTag} copyFailed={copyFailedTag === credentialTag} language={platform === 'windows' ? 'powershell' : 'bash'} onCopy={() => onCopy(credential, credentialTag)} />
  </div>;
}

export const buildAgentClaudeSnippet = (
  origin: string,
  apiKey: string,
  settings: AgentSetupConfiguration['claudeCode'],
) => JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ...(settings.model ? { ANTHROPIC_MODEL: settings.model } : {}),
    ...(settings.defaultFableModel ? { ANTHROPIC_DEFAULT_FABLE_MODEL: settings.defaultFableModel } : {}),
    ...(settings.defaultOpusModel ? { ANTHROPIC_DEFAULT_OPUS_MODEL: settings.defaultOpusModel } : {}),
    ...(settings.defaultSonnetModel ? { ANTHROPIC_DEFAULT_SONNET_MODEL: settings.defaultSonnetModel } : {}),
    ...(settings.defaultHaikuModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: settings.defaultHaikuModel } : {}),
    ...(settings.modelDiscovery ? { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' } : {}),
  },
  ...(settings.effortLevel ? { effortLevel: settings.effortLevel } : {}),
  ...(settings.cleanupPeriodDays === null ? {} : { cleanupPeriodDays: settings.cleanupPeriodDays }),
  ...(settings.optOutAiAttribution ? { attribution: claudeAttributionOptOut } : {}),
}, null, 2);

export const buildAgentCodexSnippet = (origin: string, config: AgentSetupConfiguration['codex']) => [
  ...(config.model ? [`model = ${JSON.stringify(config.model)}`] : []),
  ...(config.reasoningEffort ? [`model_reasoning_effort = ${JSON.stringify(config.reasoningEffort)}`] : []),
  'model_provider = "floway"',
  'suppress_unstable_features_warning = true',
  '',
  '[model_providers.floway]',
  'name = "Floway"',
  `base_url = ${JSON.stringify(`${origin}/azure-api.codex`)}`,
  'auth = { command = "sh", args = ["-c", "cat \\"${CODEX_HOME:-$HOME/.codex}/floway-token\\""] } # Linux & macOS',
  '# auth = { command = "powershell", args = ["-NoProfile", "-Command", "$h = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME \'.codex\' }; [IO.File]::ReadAllText((Join-Path $h \'floway-token\'))"] } # Windows: uncomment and remove the line above',
  'wire_api = "responses"',
  'supports_websockets = true',
  'http_headers = { "x-openai-actor-authorization" = "1" }',
  '',
  '[features]',
  'apps = false',
  'standalone_web_search = true',
].join('\n');

function AgentTab({ icon, label, value }: { icon: string; label: string; value: Agent }) {
  return <Tab value={value}><span className="inline-flex items-center gap-2"><img alt="" className="h-4 w-4" src={icon} />{label}</span></Tab>;
}

function AgentConfigurationFields({ agent, configuration, models, onChange }: {
  agent: Agent;
  configuration: AgentSetupConfiguration;
  models: ControlPlaneModel[];
  onChange: (update: (current: AgentSetupConfiguration) => AgentSetupConfiguration) => void;
}) {
  const { t } = useTranslation();
  const patchClaude = (patch: Partial<AgentSetupConfiguration['claudeCode']>) => onChange(current => ({ ...current, claudeCode: { ...current.claudeCode, ...patch } }));
  const patchCodex = (patch: Partial<AgentSetupConfiguration['codex']>) => onChange(current => ({ ...current, codex: { ...current.codex, ...patch } }));
  const codexModel = configuration.codex.model
    ? models.find(model => model.id === configuration.codex.model)
    : rankAgentSetupModels(models, { family: 'codex' })[0];
  const effortOptions = codexModel?.chat?.reasoning?.effort?.supported ?? [];

  if (agent === 'claude') return <div className="grid gap-5">
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3 max-[620px]:grid-cols-1">
        <ModelSelect label={t('dashboard.apiKeys.agentSetup.defaultModel')} models={models} family="claude" picker="default" value={configuration.claudeCode.model} onChange={model => patchClaude({ model })} />
        <Field label={t('dashboard.apiKeys.agentSetup.reasoningEffort')}>
          <Select value={configuration.claudeCode.effortLevel ?? NONE} onChange={(_, data) => patchClaude({ effortLevel: data.value === NONE ? null : data.value as NonNullable<AgentSetupConfiguration['claudeCode']['effortLevel']> })}>
            <option value={NONE}>{t('dashboard.apiKeys.agentSetup.modelDefault')}</option>
            {(['low', 'medium', 'high', 'xhigh'] as const).map(effort => <option key={effort} value={effort}>{effort}</option>)}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-4 gap-3 max-[980px]:grid-cols-2 max-[560px]:grid-cols-1">
        <ModelSelect label={t('dashboard.apiKeys.agentSetup.fableModel')} models={models} family="claude" picker="fable" value={configuration.claudeCode.defaultFableModel} onChange={model => patchClaude({ defaultFableModel: model })} />
        <ModelSelect label={t('dashboard.apiKeys.agentSetup.opusModel')} models={models} family="claude" picker="opus" value={configuration.claudeCode.defaultOpusModel} onChange={model => patchClaude({ defaultOpusModel: model })} />
        <ModelSelect label={t('dashboard.apiKeys.agentSetup.sonnetModel')} models={models} family="claude" picker="sonnet" value={configuration.claudeCode.defaultSonnetModel} onChange={model => patchClaude({ defaultSonnetModel: model })} />
        <ModelSelect label={t('dashboard.apiKeys.agentSetup.haikuModel')} models={models} family="claude" picker="haiku" value={configuration.claudeCode.defaultHaikuModel} onChange={model => patchClaude({ defaultHaikuModel: model })} />
      </div>
    </div>
    <section className="grid gap-3">
      <Text as="h4" size={300} weight="semibold" className="!m-0">{t('dashboard.apiKeys.agentSetup.miscSettings')}</Text>
      <SwitchSetting
        checked={configuration.claudeCode.modelDiscovery}
        description={t('dashboard.apiKeys.agentSetup.modelDiscoveryHint')}
        label={t('dashboard.apiKeys.agentSetup.modelDiscovery')}
        onChange={checked => patchClaude({ modelDiscovery: checked })}
      />
      <Field className={SINGLE_FIELD_CLASS} hint={t('dashboard.apiKeys.agentSetup.cleanupRetentionHint')} label={t('dashboard.apiKeys.agentSetup.cleanupRetention')}>
        <Select
          value={configuration.claudeCode.cleanupPeriodDays?.toString() ?? NONE}
          onChange={(_, data) => {
            if (data.value === NONE) {
              patchClaude({ cleanupPeriodDays: null });
              return;
            }
            const period = claudeCleanupPeriods.find(candidate => candidate.toString() === data.value);
            if (period !== undefined) patchClaude({ cleanupPeriodDays: period });
          }}
        >
          <option value={NONE}>{t('dashboard.apiKeys.agentSetup.modelDefault')}</option>
          {claudeCleanupPeriods.map(period => (
            <option key={period} value={period}>{t('dashboard.apiKeys.agentSetup.cleanupDays', { count: period })}</option>
          ))}
        </Select>
      </Field>
      <SwitchSetting
        checked={configuration.claudeCode.optOutAiAttribution}
        description={t('dashboard.apiKeys.agentSetup.optOutAiAttributionHint')}
        label={t('dashboard.apiKeys.agentSetup.optOutAiAttribution')}
        onChange={checked => patchClaude({ optOutAiAttribution: checked })}
      />
    </section>
  </div>;

  return <div className="grid grid-cols-2 gap-3 max-[620px]:grid-cols-1">
    <ModelSelect label={t('dashboard.apiKeys.agentSetup.defaultModel')} models={models} family="codex" picker="default" value={configuration.codex.model} onChange={model => patchCodex({ model })} />
    <Field label={t('dashboard.apiKeys.agentSetup.reasoningEffort')}>
      <Combobox freeform value={configuration.codex.reasoningEffort ?? ''} onChange={event => patchCodex({ reasoningEffort: event.target.value === '' ? null : event.target.value })} onOptionSelect={(_, data) => patchCodex({ reasoningEffort: data.optionText === '' || data.optionText === undefined ? null : data.optionText })}>
        {effortOptions.map(effort => <Option key={effort}>{effort}</Option>)}
      </Combobox>
    </Field>
  </div>;
}

function SwitchSetting({ checked, description, label, onChange }: {
  checked: boolean;
  description: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return <div className="grid gap-1">
    <Switch checked={checked} label={label} onChange={(_, data) => onChange(data.checked)} />
    <Text size={200} className="text-fui-fg2">{description}</Text>
  </div>;
}

function ModelSelect({ family, label, models, onChange, picker, value }: {
  family: 'claude' | 'codex';
  label: string;
  models: ControlPlaneModel[];
  onChange: (value: string | null) => void;
  picker: ClaudePicker;
  value: string | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const options = useMemo(() => modelOptions(models, family, picker), [family, models, picker]);
  const selected = options.find(option => option.value === value) ?? null;
  const defaultLabel = t('dashboard.apiKeys.agentSetup.modelDefault');
  const filtered = useMemo(() => filterModelOptions(options, query), [options, query]);
  const defaultVisible = query === '' || defaultLabel.toLocaleLowerCase().includes(query.toLocaleLowerCase());

  return <Field label={label}>
    <Combobox
      open={open}
      selectedOptions={[selected?.value ?? MODEL_DEFAULT]}
      value={open ? query : selected?.label ?? defaultLabel}
      onBlur={() => { setOpen(false); setQuery(''); }}
      onChange={event => setQuery(event.target.value)}
      onOpenChange={(_, data) => { setOpen(data.open); setQuery(''); }}
      onOptionSelect={(_, data) => {
        if (data.optionValue === MODEL_DEFAULT) onChange(null);
        else if (typeof data.optionValue === 'string' && options.some(option => option.value === data.optionValue)) onChange(data.optionValue);
        setOpen(false);
        setQuery('');
      }}
    >
      {defaultVisible && <Option value={MODEL_DEFAULT}>{defaultLabel}</Option>}
      {filtered.map(option => (
        <Option key={option.value} text={option.label} value={option.value}>
          <span className="font-mono truncate">{option.label}</span>
        </Option>
      ))}
      {!defaultVisible && filtered.length === 0 && (
        <Option disabled value={NO_MODEL_MATCHES}>{t('dashboard.apiKeys.agentSetup.noModelMatches')}</Option>
      )}
    </Combobox>
  </Field>;
}

interface ModelOption { value: string; label: string }

export const filterModelOptions = (options: readonly ModelOption[], query: string) => {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return options;
  return options.filter(option =>
    option.label.toLocaleLowerCase().includes(needle)
    || option.value.toLocaleLowerCase().includes(needle));
};

export const modelOptions = (models: ControlPlaneModel[], family: 'claude' | 'codex', picker: ClaudePicker) =>
  buildAgentModelOptions(models, family === 'claude' ? { family, picker } : { family })
    .map(option => ({ value: option.value, label: option.modelId }));
