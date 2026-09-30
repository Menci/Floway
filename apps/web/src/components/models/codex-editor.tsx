import { CodeBlockRegular } from '@fluentui/react-icons';
import { useState } from 'react';

import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Input, Switch, Textarea } from '../ui/fluent-form-controls';
import { JsonObjectDialog } from '../ui/json-object-dialog';
import { OptionalBooleanField, OptionalStringField } from '../ui/optional-field';
import { SettingsExpander } from '../ui/settings-card';
import type { CodexChatModelInfo } from '@floway-dev/protocols/common';
import { codexChatField } from '@floway-dev/provider/model-config';

const { Button, Field, Text } = fluentComponents;

// Selectors follow Codex's catalog contract; unknown catalog values remain
// visible and round-trip unchanged.
// https://github.com/openai/codex/blob/d42056091aded7feb1d88ac7e83972108b2aa478/codex-rs/protocol/src/openai_models.rs#L300-L360
const stringFields = [
  { key: 'shell_type', choices: ['unified_exec', 'disabled', 'shell_command'], nullable: false },
  { key: 'apply_patch_tool_type', choices: ['freeform'], nullable: true },
  { key: 'default_verbosity', choices: ['low', 'medium', 'high'], nullable: true },
  { key: 'default_reasoning_summary', choices: ['none', 'auto', 'concise', 'detailed'], nullable: false },
  { key: 'web_search_tool_type', choices: ['text', 'text_and_image'], nullable: false },
  { key: 'tool_mode', choices: ['direct', 'code_mode', 'code_mode_only'], nullable: true },
  { key: 'multi_agent_version', choices: ['disabled', 'v1', 'v2'], nullable: true },
  { key: 'multi_agent_reasoning_effort', choices: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], nullable: true },
] as const;
const booleanFields = ['use_responses_lite', 'supports_reasoning_effort_updates', 'supports_search_tool', 'include_skills_usage_instructions', 'include_plugin_usage_instructions', 'include_apps_usage_instructions'] as const;
// https://github.com/openai/codex/blob/d42056091aded7feb1d88ac7e83972108b2aa478/codex-rs/protocol/src/openai_models.rs#L389-L392
const DEFAULT_EFFECTIVE_CONTEXT_PERCENT = 95;
// https://github.com/openai/codex/blob/d42056091aded7feb1d88ac7e83972108b2aa478/codex-rs/models-manager/models.json#L15-L18
const DEFAULT_TRUNCATION_LIMIT = 10000;

export function CodexEditor({ error, maxContextWindowTokens, onChange, readOnly, value }: {
  error?: string;
  maxContextWindowTokens?: number;
  onChange: (value: CodexChatModelInfo | undefined) => void;
  readOnly: boolean;
  value: CodexChatModelInfo | undefined;
}) {
  const { t } = useTranslation();
  const [messagesOpen, setMessagesOpen] = useState(false);
  const profile = value ?? {};
  const patch = (next: Partial<CodexChatModelInfo>) => {
    if (readOnly) return;
    const updated = { ...profile, ...next };
    for (const key of Object.keys(updated) as (keyof CodexChatModelInfo)[]) if (updated[key] === undefined) delete updated[key];
    onChange(Object.keys(updated).length ? updated : undefined);
  };
  const updateMessages = (messages: NonNullable<CodexChatModelInfo['model_messages']>) =>
    patch({ model_messages: Object.keys(messages).length ? messages : undefined });
  const template = profile.model_messages?.instructions_template;
  const customInstructions = typeof template === 'string';
  const { instructions_template: _template, ...otherMessages } = profile.model_messages ?? {};
  const numbers = ['default_context_window_tokens', 'auto_compact_token_limit', 'effective_context_window_percent'] as const;
  return <>
    <SettingsExpander deferContent header={t('dashboard.upstreamEditor.models.codex.title')} revealOn={error !== undefined}>
      <div className="grid gap-4 min-w-0">
        {error !== undefined && <Field validationState="error" validationMessage={error} />}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          {numbers.map(key => <Field key={key} className="min-w-0" label={t(`dashboard.upstreamEditor.models.codex.${key}`)}>
            <Input readOnly={readOnly} type="number" min={1} max={key === 'effective_context_window_percent' ? 100 : key === 'default_context_window_tokens' ? maxContextWindowTokens : undefined} value={profile[key] == null ? '' : String(profile[key])} placeholder={t(profile[key] === null ? 'common.clientDefault' : 'common.undeclared')} onChange={(_, data) => {
              patch({ [key]: data.value === '' ? key === 'auto_compact_token_limit' ? null : undefined : Number(data.value) });
            }} />
          </Field>)}
        </div>
        {maxContextWindowTokens !== undefined && <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.models.codex.maximumContext', { tokens: String(maxContextWindowTokens) })}</Text>}
        {profile.default_context_window_tokens !== undefined && <Text size={200} className="text-fui-fg2">
          {t('dashboard.upstreamEditor.models.codex.contextPreview', { tokens: String(Math.floor(profile.default_context_window_tokens * (profile.effective_context_window_percent ?? DEFAULT_EFFECTIVE_CONTEXT_PERCENT) / 100)) })}
        </Text>}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          <OptionalStringField label={t('dashboard.upstreamEditor.models.codex.truncationMode')} readOnly={readOnly} value={profile.truncation_policy?.mode} choices={['tokens', 'bytes']} onChange={mode => patch({ truncation_policy: mode == null ? undefined : { mode: mode as 'tokens' | 'bytes', limit: profile.truncation_policy?.limit ?? DEFAULT_TRUNCATION_LIMIT } })} />
          {profile.truncation_policy !== undefined && <Field label={t('dashboard.upstreamEditor.models.codex.truncationLimit')}>
            <Input readOnly={readOnly} type="number" min={1} value={String(profile.truncation_policy.limit)} onChange={(_, data) => patch({ truncation_policy: { mode: profile.truncation_policy!.mode, limit: Number(data.value) } })} />
          </Field>}
          {stringFields.map(({ key, choices, nullable }) => <OptionalStringField key={key} label={t(`dashboard.upstreamEditor.models.codex.${key}`)} nullable={nullable} choices={choices} readOnly={readOnly} value={profile[key]} onChange={next => patch({ [key]: next })} />)}
          {booleanFields.map(key => <OptionalBooleanField key={key} label={t(`dashboard.upstreamEditor.models.codex.${key}`)} readOnly={readOnly} value={profile[key]} onChange={next => patch({ [key]: next })} />)}
        </div>
        <Switch readOnly={readOnly} checked={customInstructions} label={t('dashboard.upstreamEditor.models.codex.customInstructions')} onChange={(_, data) => {
          const messages = { ...profile.model_messages };
          if (data.checked) messages.instructions_template = ''; else delete messages.instructions_template;
          updateMessages(messages);
        }} />
        {customInstructions && <Field label={t('dashboard.upstreamEditor.models.codex.instructionsTemplate')}>
          <Textarea className="font-mono w-full" readOnly={readOnly} rows={8} value={template} onChange={(_, data) => updateMessages({ ...profile.model_messages, instructions_template: data.value })} />
        </Field>}
        <div><Button icon={<CodeBlockRegular />} onClick={() => setMessagesOpen(true)}>{t('dashboard.upstreamEditor.models.codex.otherMessages')}</Button></div>
      </div>
    </SettingsExpander>
    <JsonObjectDialog open={messagesOpen} onClose={() => setMessagesOpen(false)} readOnly={readOnly} title={t('dashboard.upstreamEditor.models.codex.otherMessages')} value={otherMessages} validate={sections => { codexChatField({ model_messages: sections }, 'Codex instructions'); }} onApply={sections => updateMessages({ ...(template === undefined ? {} : { instructions_template: template }), ...sections })} />
  </>;
}
