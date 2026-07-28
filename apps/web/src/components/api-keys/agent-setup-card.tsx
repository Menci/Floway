import { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { cloneAgentSetupConfiguration, defaultAgentSetupConfiguration, type AgentSetupConfiguration, type AgentSetupLease } from './agent-setup-contract';
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
import { infoLabelSlot } from '../ui/info-label';

const { Button, Field, MessageBar, MessageBarBody, Option, Switch, Tab, TabList, Text } = fluentComponents;
type Agent = 'claude' | 'codex';
type Platform = AgentSetupPlatform;
const NONE = '__floway_none__';
// Model overrides reject NUL at the gateway boundary, so these UI-only values
// cannot collide with an opaque model id.
const MODEL_DEFAULT = '\u0000default';
const NO_MODEL_MATCHES = '\u0000no-matches';
const FIELD_GRID_CLASS = 'grid gap-3 grid-cols-[repeat(2,minmax(0,1fr))] max-[720px]:grid-cols-[minmax(0,1fr)]';
const CLAUDE_MODEL_GRID_CLASS = 'grid gap-3 grid-cols-[repeat(5,minmax(0,1fr))] max-[1680px]:grid-cols-[repeat(3,minmax(0,1fr))] max-[1180px]:grid-cols-[repeat(2,minmax(0,1fr))] max-[720px]:grid-cols-[minmax(0,1fr)]';
// cleanupPeriodDays is a numeric top-level Claude Code setting.
// https://code.claude.com/docs/en/settings#available-settings
const claudeCleanupPeriods = [180, 365, 99999] as const satisfies readonly NonNullable<AgentSetupConfiguration['claudeCode']['cleanupPeriodDays']>[];

// Claude uses empty strings to suppress commit/PR attribution and false to
// suppress session links.
// Ref: https://code.claude.com/docs/en/settings#attribution-settings
const claudeAttributionOptOut = { commit: '', pr: '', sessionUrl: false } as const;

export function AgentSetupCard({ copiedTag, copyFailedTag, initialApiKeyId, initialError, initialLease, models, onCopy, selectedKey }: {
  copiedTag: string | null;
  copyFailedTag: string | null;
  initialApiKeyId: string | null;
  initialError: string | null;
  initialLease: AgentSetupLease | null;
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
  const setup = useAgentSetup(selectedKey?.id ?? null, initialLease, initialError, initialApiKeyId);
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
  // Both shells comment with `#`, so a command that is not ready yet says why
  // inside the block it will occupy rather than above it.
  const command = scriptPath
    ? agentSetupCommand(typeof window === 'undefined' ? 'http://localhost:5173' : window.location.origin, scriptPath, platform)
    : `# ${t(selectedKey ? 'dashboard.apiKeys.agentSetup.commandPending' : 'dashboard.apiKeys.agentSetup.selectKey')}`;

  return <div className="grid gap-[14px] min-w-0">
    <div className="flex items-center gap-3 justify-between min-w-0 max-[900px]:flex-col max-[900px]:items-stretch">
      <Text as="h2" size={500} weight="semibold" className="!m-0 text-fui-fg1 leading-[1.25] min-w-0">
        {t('dashboard.apiKeys.configuration.title')}
      </Text>
      <TabList aria-label={t('dashboard.apiKeys.agentSetup.accessMethod')} onTabSelect={(_, data) => setView(data.value === 'snippets' ? 'snippets' : 'setup')} selectedValue={view} size="small">
        <Tab value="setup">{t('dashboard.apiKeys.agentSetup.setupTab')}</Tab>
        <Tab value="snippets">{t('dashboard.apiKeys.agentSetup.snippetsTab')}</Tab>
      </TabList>
    </div>

    <div className="grid gap-5 min-w-0 grid-cols-[190px_minmax(0,1fr)] max-[720px]:grid-cols-1">
      <nav className="grid content-start">
        <TabList aria-label={t('dashboard.apiKeys.agentSetup.agent')} onTabSelect={(_, data) => setAgent(data.value === 'codex' ? 'codex' : 'claude')} selectedValue={agent} vertical>
          <AgentTab icon={claudeIconUrl} label={t('dashboard.apiKeys.configuration.claudeCode')} value="claude" />
          <AgentTab icon={codexIconUrl} label={t('dashboard.apiKeys.configuration.codex')} value="codex" />
        </TabList>
      </nav>

      <div className="grid gap-4 min-w-0 content-start grid-cols-[minmax(0,1fr)]">
        {setup.noSelectableKey && <MessageBar><MessageBarBody>{t('dashboard.apiKeys.agentSetup.noKey')}</MessageBarBody></MessageBar>}
        {setup.terminated && <MessageBar intent="warning"><MessageBarBody>{t('dashboard.apiKeys.agentSetup.expired')}</MessageBarBody></MessageBar>}
        {setup.createError && !setup.lease
          ? <MessageBar intent="error"><MessageBarBody><span className="inline-flex items-center gap-2 flex-wrap">{setup.createError}<Button appearance="secondary" onClick={setup.retryCreate} size="small">{t('dashboard.apiKeys.agentSetup.retry')}</Button></span></MessageBarBody></MessageBar>
          : setup.error && <MessageBar intent="error"><MessageBarBody>{setup.error}</MessageBarBody></MessageBar>}

        <section className="grid gap-3">
          <Text as="h3" size={400} weight="semibold" className="!m-0">{t('dashboard.apiKeys.agentSetup.modelSelection')}</Text>
          <AgentConfigurationFields agent={agent} configuration={activeDraft} models={models} onChange={updateConfiguration} />
        </section>

        {view === 'snippets' && selectedKey
          ? <AgentConfigSnippets agent={agent} apiKey={selectedKey.key} configuration={activeDraft} copiedTag={copiedTag} copyFailedTag={copyFailedTag} onCopy={onCopy} onPlatformChange={setPlatform} platform={platform} />
          : view === 'snippets'
            ? <MessageBar><MessageBarBody>{t('dashboard.apiKeys.agentSetup.selectKey')}</MessageBarBody></MessageBar>
            : <div className="border-t border-t-solid border-fui-stroke1 pt-4">
                <CodeBlock
                  code={command}
                  copied={copiedTag === `agent-setup-${agent}-${platform}`}
                  copyFailed={copyFailedTag === `agent-setup-${agent}-${platform}`}
                  disabled={!setup.canCopy}
                  header={<PlatformTabs onChange={setPlatform} platform={platform} />}
                  language={platform === 'unix' ? 'bash' : 'powershell'}
                  onCopy={() => setup.canCopy && onCopy(command, `agent-setup-${agent}-${platform}`)}
                />
              </div>}

        {(selectedKey !== null || view === 'setup') && (
          <Text size={200} className="text-fui-fg2">
            {selectedKey && <>
              <Trans
                components={{ strong: <strong className="font-fui-semibold" /> }}
                i18nKey="dashboard.apiKeys.configuration.usingKey"
                values={{ name: selectedKey.name }}
              />
              {view === 'setup' && ' '}
            </>}
            {view === 'setup' && t('dashboard.apiKeys.agentSetup.expires')}
          </Text>
        )}
      </div>
    </div>
  </div>;
}

function PlatformTabs({ onChange, platform }: { onChange: (platform: Platform) => void; platform: Platform }) {
  const { t } = useTranslation();
  return <TabList
    aria-label={t('dashboard.apiKeys.agentSetup.platform')}
    onTabSelect={(_, data) => onChange(data.value === 'windows' ? 'windows' : 'unix')}
    selectedValue={platform}
    size="small"
  >
    <Tab value="unix">macOS / Linux</Tab>
    <Tab value="windows">Windows</Tab>
  </TabList>;
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
    <Text size={200} className="text-fui-fg2">
      {t(platform === 'windows' ? 'dashboard.apiKeys.configuration.codexWindowsAuthHint' : 'dashboard.apiKeys.configuration.codexAuthHint')}
    </Text>
    <CodeBlock code={credential} copied={copiedTag === credentialTag} copyFailed={copyFailedTag === credentialTag} header={<PlatformTabs onChange={onPlatformChange} platform={platform} />} language={platform === 'windows' ? 'powershell' : 'bash'} onCopy={() => onCopy(credential, credentialTag)} />
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

// JSON string literals are valid TOML basic strings, so JSON.stringify keeps
// opaque model values lossless. https://toml.io/en/v1.0.0#string
// x-openai-actor-authorization enables Codex-owned web search and image generation;
// command auth also enables live model refresh:
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/model-provider-info/src/lib.rs#L396-L408
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/ext/web-search/src/extension.rs#L41-L46
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/ext/image-generation/src/extension.rs#L38-L45
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/models-manager/src/manager.rs#L413-L415
// Apps is ChatGPT-only; standalone web search requires explicit warning suppression:
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L382-L384
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L901-L905
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L1393-L1439
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
    <div className={CLAUDE_MODEL_GRID_CLASS}>
      <ModelSelect label={t('dashboard.apiKeys.agentSetup.defaultModel')} models={models} family="claude" picker="default" value={configuration.claudeCode.model} onChange={model => patchClaude({ model })} />
      <ModelSelect label={t('dashboard.apiKeys.agentSetup.fableModel')} models={models} family="claude" picker="fable" value={configuration.claudeCode.defaultFableModel} onChange={model => patchClaude({ defaultFableModel: model })} />
      <ModelSelect label={t('dashboard.apiKeys.agentSetup.opusModel')} models={models} family="claude" picker="opus" value={configuration.claudeCode.defaultOpusModel} onChange={model => patchClaude({ defaultOpusModel: model })} />
      <ModelSelect label={t('dashboard.apiKeys.agentSetup.sonnetModel')} models={models} family="claude" picker="sonnet" value={configuration.claudeCode.defaultSonnetModel} onChange={model => patchClaude({ defaultSonnetModel: model })} />
      <ModelSelect label={t('dashboard.apiKeys.agentSetup.haikuModel')} models={models} family="claude" picker="haiku" value={configuration.claudeCode.defaultHaikuModel} onChange={model => patchClaude({ defaultHaikuModel: model })} />
      <Field label={t('dashboard.apiKeys.agentSetup.reasoningEffort')}>
        <Select value={configuration.claudeCode.effortLevel ?? NONE} onChange={(_, data) => patchClaude({ effortLevel: data.value === NONE ? null : data.value as NonNullable<AgentSetupConfiguration['claudeCode']['effortLevel']> })}>
          <option value={NONE}>{t('dashboard.apiKeys.agentSetup.modelDefault')}</option>
          {(['low', 'medium', 'high', 'xhigh'] as const).map(effort => <option key={effort} value={effort}>{effort}</option>)}
        </Select>
      </Field>
    </div>
    <section className="grid gap-3">
      <Text as="h4" size={300} weight="semibold" className="!m-0">{t('dashboard.apiKeys.agentSetup.miscSettings')}</Text>
      <SwitchSetting
        checked={configuration.claudeCode.modelDiscovery}
        description={t('dashboard.apiKeys.agentSetup.modelDiscoveryHint')}
        label={t('dashboard.apiKeys.agentSetup.modelDiscovery')}
        onChange={checked => patchClaude({ modelDiscovery: checked })}
      />
      <SwitchSetting
        checked={configuration.claudeCode.optOutAiAttribution}
        description={t('dashboard.apiKeys.agentSetup.optOutAiAttributionHint')}
        label={t('dashboard.apiKeys.agentSetup.optOutAiAttribution')}
        onChange={checked => patchClaude({ optOutAiAttribution: checked })}
      />
      <div className={FIELD_GRID_CLASS}>
        <Field label={{ children: infoLabelSlot(t('dashboard.apiKeys.agentSetup.cleanupRetention'), t('dashboard.apiKeys.agentSetup.cleanupRetentionHint')) }}>
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
      </div>
    </section>
  </div>;

  return <div className={FIELD_GRID_CLASS}>
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
  return <Switch
    checked={checked}
    label={{ children: infoLabelSlot(label, description) }}
    onChange={(_, data) => onChange(data.checked)}
  />;
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
