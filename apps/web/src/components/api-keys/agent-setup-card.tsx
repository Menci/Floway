import { useMemo, useState } from 'react';

import {
  buildAgentClaudeSnippet,
  buildAgentCodexSnippet,
  codexUnixCredentialSnippet,
  codexWindowsCredentialSnippet,
  detectAgentSetupPlatform,
  type AgentSetupConfiguration,
  type AgentSetupLease,
  type AgentSetupPlatform,
} from './agent-setup';
import { modelOptions, rankAgentSetupModels, type ClaudePicker } from './agent-setup-models';
import { agentSetupCommand, useAgentSetup } from './use-agent-setup';
import type { ApiKey, ControlPlaneModel } from '../../api/types';
import claudeIconUrl from '../../assets/claude-color.svg';
import codexIconUrl from '../../assets/codex.svg';
import { fluentComponents } from '../../fluent';
import { Trans, useTranslation } from '../../i18n/translation';
import { filterModelOptions } from '../../lib/model-query';
import { CodeBlock } from '../ui/code-block';
import { Combobox, Dropdown, Switch } from '../ui/fluent-form-controls';
import { infoLabelSlot } from '../ui/info-label';
import { PANE_GAP_CLASS, SECTION_STACK_CLASS, TWO_COLUMN_FORM_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { SectionHeader } from '../ui/section-header';
import type { ClipboardCopy } from '../ui/use-copy-to-clipboard';

const { Button, Field, InfoButton, Option, Tab, TabList, Text } = fluentComponents;
type Agent = 'claude' | 'codex';
type Platform = AgentSetupPlatform;
// The option that stands for no override. Model overrides reject NUL at the
// gateway boundary, so this UI-only value cannot collide with an opaque model
// id.
const MODEL_DEFAULT = '\u0000default';
const FIELD_GRID_CLASS = `${TWO_COLUMN_FORM_CLASS} gap-3`;
const CLAUDE_MODEL_GRID_CLASS = 'grid gap-3 grid-cols-[repeat(5,minmax(0,1fr))] max-[1680px]:grid-cols-[repeat(3,minmax(0,1fr))] max-[1180px]:grid-cols-[repeat(2,minmax(0,1fr))] max-[680px]:grid-cols-[minmax(0,1fr)]';
// https://code.claude.com/docs/en/settings#available-settings
const claudeCleanupPeriods = [180, 365, 99999] as const satisfies readonly NonNullable<AgentSetupConfiguration['claudeCode']['cleanupPeriodDays']>[];
// Claude Code's effort is a closed setting rather than the open, upstream-owned
// string Codex takes, so the picker offers the levels the setup contract
// accepts and nothing else.
// https://docs.claude.com/en/docs/claude-code/settings
const claudeEffortLevels = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly NonNullable<AgentSetupConfiguration['claudeCode']['effortLevel']>[];

export function AgentSetupCard({ clipboard, initialApiKeyId, initialError, initialLease, models, selectedKey }: {
  initialApiKeyId: string | null;
  initialError: string | null;
  initialLease: AgentSetupLease | null;
  models: ControlPlaneModel[];
  clipboard: ClipboardCopy;
  selectedKey: ApiKey | null;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<'setup' | 'snippets'>('setup');
  const [agent, setAgent] = useState<Agent>('claude');
  const [platform, setPlatform] = useState<Platform>(() => detectAgentSetupPlatform(window.navigator.platform, window.navigator.userAgent));
  const setup = useAgentSetup(selectedKey?.id ?? null, initialLease, initialError, initialApiKeyId);

  const scripts = setup.lease?.scripts[agent];
  const scriptPath = platform === 'unix' ? scripts?.sh : scripts?.ps1;
  // Both shells comment with `#`, so an unavailable command says why inside the block it will occupy.
  const command = scriptPath
    ? agentSetupCommand(window.location.origin, scriptPath, platform)
    : `# ${t(selectedKey ? 'dashboard.apiKeys.agentSetup.commandPending' : 'dashboard.apiKeys.agentSetup.selectKey')}`;

  return <div className="grid gap-[14px] min-w-0">
    <SectionHeader level={2} title={t('dashboard.apiKeys.configuration.title')} actions={
      <TabList aria-label={t('dashboard.apiKeys.agentSetup.accessMethod')} onTabSelect={(_, data) => setView(data.value === 'snippets' ? 'snippets' : 'setup')} selectedValue={view} size="small">
        <Tab value="setup">{t('dashboard.apiKeys.agentSetup.setupTab')}</Tab>
        <Tab value="snippets">{t('dashboard.apiKeys.agentSetup.snippetsTab')}</Tab>
      </TabList>
    } />

    <div className={`grid ${PANE_GAP_CLASS} min-w-0 grid-cols-[190px_minmax(0,1fr)] max-[680px]:grid-cols-1`}>
      <nav className="grid content-start">
        <TabList aria-label={t('dashboard.apiKeys.agentSetup.agent')} onTabSelect={(_, data) => setAgent(data.value === 'codex' ? 'codex' : 'claude')} selectedValue={agent} vertical>
          <AgentTab icon={claudeIconUrl} label={t('dashboard.apiKeys.configuration.claudeCode')} value="claude" />
          <AgentTab icon={codexIconUrl} label={t('dashboard.apiKeys.configuration.codex')} value="codex" />
        </TabList>
      </nav>

      <div className="grid gap-4 min-w-0 content-start grid-cols-[minmax(0,1fr)]">
        {setup.noSelectableKey && <OutcomeMessageBar intent="info">{t('dashboard.apiKeys.agentSetup.noKey')}</OutcomeMessageBar>}
        {setup.terminated && <OutcomeMessageBar intent="warning">{t('dashboard.apiKeys.agentSetup.expired')}</OutcomeMessageBar>}
        {setup.createError && !setup.lease
          ? <OutcomeMessageBar
              action={<Button appearance="secondary" onClick={setup.retryCreate} size="small">{t('dashboard.apiKeys.agentSetup.retry')}</Button>}
              onDismiss={setup.dismissError}
            >{setup.createError}</OutcomeMessageBar>
          : setup.error && <OutcomeMessageBar onDismiss={setup.dismissError}>{setup.error}</OutcomeMessageBar>}

        <section className={SECTION_STACK_CLASS}>
          <SectionHeader level={3} title={t('dashboard.apiKeys.agentSetup.modelSelection')} />
          <AgentConfigurationFields agent={agent} configuration={setup.draft} models={models} onChange={setup.updateDraft} />
        </section>

        {view === 'snippets' && selectedKey
          ? <AgentConfigSnippets agent={agent} apiKey={selectedKey.key} configuration={setup.draft} clipboard={clipboard} onPlatformChange={setPlatform} platform={platform} />
          : view === 'snippets'
            ? <OutcomeMessageBar intent="info">{t('dashboard.apiKeys.agentSetup.selectKey')}</OutcomeMessageBar>
            : <div className="border-t border-t-solid border-fui-divider pt-4">
                <CodeBlock
                  code={command}
                  copyOutcome={clipboard.outcomeFor(`agent-setup-${agent}-${platform}`)}
                  disabled={!setup.canCopy}
                  header={<PlatformTabs onChange={setPlatform} platform={platform} />}
                  language={platform === 'unix' ? 'bash' : 'powershell'}
                  onCopy={() => setup.canCopy && clipboard.copy(command, `agent-setup-${agent}-${platform}`)}
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

function AgentConfigSnippets({ agent, apiKey, clipboard, configuration, onPlatformChange, platform }: {
  agent: Agent;
  apiKey: string;
  configuration: AgentSetupConfiguration;
  clipboard: ClipboardCopy;
  onPlatformChange: (platform: Platform) => void;
  platform: Platform;
}) {
  const { t } = useTranslation();
  const origin = window.location.origin;
  if (agent === 'claude') {
    const snippet = buildAgentClaudeSnippet(origin, apiKey, configuration.claudeCode);
    return <div className="grid gap-2 border-t border-t-solid border-fui-divider pt-4">
      <Text size={200} className="text-fui-fg2">
        <Trans components={{ path: <code className="font-mono mono-size-xs" /> }} i18nKey="dashboard.apiKeys.configuration.claudeHint" />
      </Text>
      <CodeBlock code={snippet} copyOutcome={clipboard.outcomeFor('agent-snippet-claude')} language="json" onCopy={() => clipboard.copy(snippet, 'agent-snippet-claude')} />
    </div>;
  }
  // Both snippets are one platform's pair -- the config's auth command reads the
  // file the credential snippet writes -- so one choice drives them and each
  // block carries the picker, whichever the reader reaches first.
  const config = buildAgentCodexSnippet(origin, configuration.codex, platform);
  const credential = platform === 'windows' ? codexWindowsCredentialSnippet(apiKey) : codexUnixCredentialSnippet(apiKey);
  const configTag = platform === 'windows' ? 'agent-snippet-codex-windows' : 'agent-snippet-codex-unix';
  const credentialTag = `${configTag}-token`;
  const tabs = <PlatformTabs onChange={onPlatformChange} platform={platform} />;
  return <div className="grid gap-3 border-t border-t-solid border-fui-divider pt-4">
    <Text size={200} className="text-fui-fg2">
      <Trans components={{ path: <code className="font-mono mono-size-xs" /> }} i18nKey={platform === 'windows' ? 'dashboard.apiKeys.configuration.codexConfigHintWindows' : 'dashboard.apiKeys.configuration.codexConfigHint'} />
    </Text>
    <CodeBlock code={config} copyOutcome={clipboard.outcomeFor(configTag)} header={tabs} language="toml" onCopy={() => clipboard.copy(config, configTag)} />
    <Text size={200} className="text-fui-fg2">{t('dashboard.apiKeys.configuration.codexAuthHint')}</Text>
    <CodeBlock code={credential} copyOutcome={clipboard.outcomeFor(credentialTag)} header={tabs} language={platform === 'windows' ? 'powershell' : 'bash'} onCopy={() => clipboard.copy(credential, credentialTag)} />
  </div>;
}

function AgentTab({ icon, label, value }: { icon: string; label: string; value: Agent }) {
  return <Tab value={value} icon={<img alt="" className="h-4 w-4" src={icon} />}>{label}</Tab>;
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
        <Dropdown
          selectedOptions={[configuration.claudeCode.effortLevel ?? MODEL_DEFAULT]}
          value={configuration.claudeCode.effortLevel ?? t('dashboard.apiKeys.agentSetup.modelDefault')}
          onOptionSelect={(_, data) => {
            if (data.optionValue === MODEL_DEFAULT) {
              patchClaude({ effortLevel: null });
              return;
            }
            const level = claudeEffortLevels.find(candidate => candidate === data.optionValue);
            if (level !== undefined) patchClaude({ effortLevel: level });
          }}
        >
          <Option value={MODEL_DEFAULT}>{t('dashboard.apiKeys.agentSetup.modelDefault')}</Option>
          {claudeEffortLevels.map(effort => <Option key={effort} value={effort}>{effort}</Option>)}
        </Dropdown>
      </Field>
    </div>
    <section className={SECTION_STACK_CLASS}>
      <SectionHeader level={4} title={t('dashboard.apiKeys.agentSetup.miscSettings')} />
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
          <Dropdown
            selectedOptions={[configuration.claudeCode.cleanupPeriodDays?.toString() ?? MODEL_DEFAULT]}
            value={configuration.claudeCode.cleanupPeriodDays === null ? t('dashboard.apiKeys.agentSetup.modelDefault') : t('dashboard.apiKeys.agentSetup.cleanupDays', { count: configuration.claudeCode.cleanupPeriodDays })}
            onOptionSelect={(_, data) => {
              if (data.optionValue === MODEL_DEFAULT) {
                patchClaude({ cleanupPeriodDays: null });
                return;
              }
              const period = claudeCleanupPeriods.find(candidate => candidate.toString() === data.optionValue);
              if (period !== undefined) patchClaude({ cleanupPeriodDays: period });
            }}
          >
            <Option value={MODEL_DEFAULT}>{t('dashboard.apiKeys.agentSetup.modelDefault')}</Option>
            {claudeCleanupPeriods.map(period => (
              <Option key={period} value={String(period)}>{t('dashboard.apiKeys.agentSetup.cleanupDays', { count: period })}</Option>
            ))}
          </Dropdown>
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
  // A Switch injects `htmlFor` into its label, so a button placed there toggles
  // the switch instead of running its own handler; the info button sits outside.
  return <span className="inline-flex items-center gap-1">
    <Switch
      checked={checked}
      label={label}
      onChange={(_, data) => onChange(data.checked)}
    />
    <InfoButton info={description} />
  </span>;
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
  const catalog = useMemo(() => modelOptions(models, family, picker), [family, models, picker]);
  // A pin the catalog no longer serves resolves to Default: the picker offers
  // what this gateway can serve today, and nothing else is choosable in it.
  const selected = catalog.find(option => option.value === value) ?? null;
  const defaultLabel = t('dashboard.apiKeys.agentSetup.modelDefault');
  const filtered = useMemo(() => filterModelOptions(catalog, query), [catalog, query]);
  const defaultVisible = query === '' || defaultLabel.toLocaleLowerCase().includes(query.toLocaleLowerCase());

  return <Field label={label}>
    <Combobox
      emptyMessage={t('dashboard.apiKeys.agentSetup.noModelMatches')}
      open={open}
      selectedOptions={[selected?.value ?? MODEL_DEFAULT]}
      value={open ? query : selected?.label ?? defaultLabel}
      onBlur={() => { setOpen(false); setQuery(''); }}
      onChange={event => setQuery(event.target.value)}
      onOpenChange={(_, data) => { setOpen(data.open); setQuery(''); }}
      onOptionSelect={(_, data) => {
        if (data.optionValue === MODEL_DEFAULT) onChange(null);
        else if (typeof data.optionValue === 'string' && catalog.some(option => option.value === data.optionValue)) onChange(data.optionValue);
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
    </Combobox>
  </Field>;
}
